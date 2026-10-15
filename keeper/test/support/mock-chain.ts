// A pretend chain for the pipeline tests: a TypeScript model of the four `breaks` instructions the pipeline
// sends (commit_pool, request_randomness, settle_randomness, claim_free_spot), following the Rust handlers
// line by line (programs/breaks/src/{lifecycle,draw,claims}.rs). It reads real instruction bytes with the real
// decoders, so the builders and the sequencing are exercised, but it is a MODEL: the program itself is only
// tested by the LiteSVM tests in CI.

import { equalBytes } from "../../src/draw/bytes.js";
import { freePosition } from "../../src/draw/draw.js";
import { verify } from "../../src/draw/tree.js";
import type { ChainClient, SendResult } from "../../src/pipeline/chain.js";
import {
  type BreakAccount,
  type BreaksConfigAccount,
  MAX_RANDOMNESS_ATTEMPTS,
  type Programs,
  type RequestState,
  type SpotAccount,
  breakAddress,
  configAddress,
  drawSeed,
  oraoNetworkState,
  requestAddress,
  requestId,
  spotAddress,
} from "../../src/solana/breaks.js";
import { Reader } from "../../src/solana/codec.js";
import { decodeNetworkState } from "../../src/solana/orao.js";
import { type Instruction, instructionDiscriminator } from "../../src/solana/instruction.js";
import { type Address, addressFromBytes, addressToBytes, associatedTokenAddress } from "../../src/solana/pubkey.js";
import { type TreasuryConfig, treasuryAddresses } from "../../src/solana/treasury.js";
import type { WalletReader } from "../../src/sweep/wallet.js";
import { encodeBreak, encodeBreaksConfig, encodeRequest, encodeSpot, encodeTokenAccount, encodeTreasuryConfig } from "./accounts.js";

/** What happens to the next `sendAndConfirm`. */
export type SendBehavior =
  /** Applied; answered `confirmed`. */
  | "ok"
  /** Never reaches the chain; answered `unknown` (a dropped transaction). */
  | "drop"
  /** Applied, but answered `unknown` (the confirmation timed out). */
  | "applied-unknown"
  /** Refused; answered `failed`. */
  | "fail";

class Revert extends Error {}

interface Request {
  client: Address;
  seed: Uint8Array;
  state: RequestState;
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

export class MockChain implements ChainClient, WalletReader {
  /** Chain clock, unix seconds. */
  public unixTime = 1_800_030_000n;
  public readonly breaks = new Map<bigint, BreakAccount>();
  public readonly spots = new Map<Address, SpotAccount>();
  private readonly requests = new Map<Address, Request>();
  private readonly behaviors: SendBehavior[] = [];
  public sendCalls = 0;
  /** Accounts that exist and hold some data (the buyer wallet's USDC account, for `fund_purchases`). */
  public readonly tokenAccounts = new Set<Address>();
  /** SOL held by wallets, in lamports. */
  public readonly solBalances = new Map<Address, bigint>();
  /** USDC token accounts by address: who owns them and what they hold. */
  public readonly usdc = new Map<Address, { owner: Address; amount: bigint }>();
  /** Any other account the test wants the chain to have (a token mint, say). */
  public readonly accounts = new Map<Address, Uint8Array>();
  /**
   * The treasury: the two buckets' vault balances and what is locked for breaks. Only `create_break` (which locks)
   * and `fund_purchases` (which pays out and unlocks) touch it, following programs/treasury/src/lib.rs.
   */
  public readonly treasury = {
    config: {
      admin: addressFromBytes(new Uint8Array(32).fill(0xd1)),
      usdcMint: addressFromBytes(new Uint8Array(32).fill(0xd2)),
      controller: addressFromBytes(new Uint8Array(32).fill(0xd3)),
      subsidyBps: 7_000,
      holderBps: 3_000,
      lockedSubsidy: 0n,
      lockedHolder: 0n,
      bump: 255,
    } as TreasuryConfig,
    subsidyVault: 0n,
    holderVault: 0n,
  };
  /** Every transaction that was applied, in order, by instruction name. */
  public readonly applied: string[] = [];

  constructor(
    private readonly programs: Programs,
    public config: BreaksConfigAccount,
  ) {}

  queueSend(...behaviors: SendBehavior[]) {
    this.behaviors.push(...behaviors);
  }

  /** ORAO's oracles answer a request. */
  fulfill(request: Address, answer: Uint8Array) {
    const r = this.requests.get(request);
    if (!r) throw new Error(`no request at ${request}`);
    r.state = { state: "fulfilled", randomness: answer };
  }

  requestAt(address: Address): Request | undefined {
    return this.requests.get(address);
  }

  /** The wallet's USDC account (the associated one), created with this much if it does not exist. */
  giveUsdc(owner: Address, amount: bigint): Address {
    const ata = associatedTokenAddress(owner, this.config.usdcMint);
    const have = this.usdc.get(ata);
    this.usdc.set(ata, { owner, amount: (have?.amount ?? 0n) + amount });
    return ata;
  }

  async lamports(address: Address): Promise<bigint> {
    return this.solBalances.get(address) ?? 0n;
  }

  async getAccountData(address: Address): Promise<Uint8Array | undefined> {
    const token = this.usdc.get(address);
    if (token) return encodeTokenAccount({ mint: this.config.usdcMint, owner: token.owner, amount: token.amount });
    if (address === configAddress(this.programs)) return encodeBreaksConfig(this.config);
    for (const [id, b] of this.breaks) if (address === breakAddress(this.programs, id)) return encodeBreak(b);
    const spot = this.spots.get(address);
    if (spot) return encodeSpot(spot);
    if (this.tokenAccounts.has(address)) return new Uint8Array(165);
    const t = treasuryAddresses(this.programs.treasury);
    if (address === t.config) return encodeTreasuryConfig({ ...this.treasury.config, usdcMint: this.config.usdcMint });
    if (address === t.subsidyVault) return encodeTokenAccount({ mint: this.config.usdcMint, owner: t.config, amount: this.treasury.subsidyVault });
    if (address === t.holderVault) return encodeTokenAccount({ mint: this.config.usdcMint, owner: t.config, amount: this.treasury.holderVault });
    const extra = this.accounts.get(address);
    if (extra) return extra;
    const request = this.requests.get(address);
    if (request) return encodeRequest(request.client, request.seed, request.state);
    return undefined;
  }

  async sendAndConfirm(instructions: Instruction[]): Promise<SendResult> {
    this.sendCalls++;
    const behavior = this.behaviors.shift() ?? "ok";
    const signature = `mock-tx-${this.sendCalls}`;
    if (behavior === "drop") return { outcome: "unknown", reason: "timeout", signature };
    if (behavior === "fail") return { outcome: "failed", reason: "mock: refused", signature };

    // All instructions or none, like a transaction.
    const snapshot = this.snapshot();
    try {
      const names = instructions.map((ix) => this.apply(ix));
      // Only what succeeded counts as applied.
      this.applied.push(...names);
    } catch (err) {
      this.restore(snapshot);
      if (err instanceof Revert) return { outcome: "failed", reason: err.message, signature };
      throw err;
    }
    return behavior === "applied-unknown" ? { outcome: "unknown", reason: "timeout", signature } : { outcome: "confirmed", signature };
  }

  private snapshot() {
    return {
      breaks: new Map([...this.breaks].map(([k, v]) => [k, structuredClone(v)] as const)),
      requests: new Map([...this.requests].map(([k, v]) => [k, structuredClone(v)] as const)),
      config: { ...this.config },
      usdc: new Map([...this.usdc].map(([k, v]) => [k, { ...v }] as const)),
      treasury: { config: { ...this.treasury.config }, subsidyVault: this.treasury.subsidyVault, holderVault: this.treasury.holderVault },
    };
  }

  private restore(s: ReturnType<MockChain["snapshot"]>) {
    this.breaks.clear();
    for (const [k, v] of s.breaks) this.breaks.set(k, v);
    this.requests.clear();
    for (const [k, v] of s.requests) this.requests.set(k, v);
    this.config = s.config;
    this.usdc.clear();
    for (const [k, v] of s.usdc) this.usdc.set(k, v);
    this.treasury.config = s.treasury.config;
    this.treasury.subsidyVault = s.treasury.subsidyVault;
    this.treasury.holderVault = s.treasury.holderVault;
  }

  private breakAt(address: Address): BreakAccount {
    for (const [id, b] of this.breaks) if (address === breakAddress(this.programs, id)) return b;
    throw new Revert(`unknown break account ${address}`);
  }

  private require(cond: boolean, reason: string): asserts cond {
    if (!cond) throw new Revert(reason);
  }

  // programs/treasury/src/lib.rs `deposit_fees` and math.rs `split`: the subsidy bucket gets floor(amount * bps / 10000),
  // the holder bucket the rest.
  private depositFees(ix: Instruction, args: Reader) {
    const key = (i: number) => (ix.accounts[i] as Instruction["accounts"][number]).pubkey;
    const t = treasuryAddresses(this.programs.treasury);
    const amount = args.u64();
    this.require(amount > 0n, "ZeroAmount");
    this.require(!!ix.accounts[0]?.isSigner, "AccountNotSigner");
    this.require(key(2) === t.config && key(3) === t.subsidyVault && key(4) === t.holderVault, "ConstraintSeeds");
    const from = this.usdc.get(key(1));
    this.require(!!from && from.owner === key(0), "ConstraintTokenOwner");
    this.require(from.amount >= amount, "InsufficientFunds");
    const toSubsidy = (amount * BigInt(this.treasury.config.subsidyBps)) / 10_000n;
    from.amount -= amount;
    this.treasury.subsidyVault += toSubsidy;
    this.treasury.holderVault += amount - toSubsidy;
  }

  private apply(ix: Instruction): string {
    if (ix.programId === this.programs.treasury) {
      const disc = hex(ix.data.subarray(0, 8));
      this.require(disc === hex(instructionDiscriminator("deposit_fees")), "the model only knows deposit_fees of the treasury program");
      this.depositFees(ix, new Reader(ix.data.subarray(8)));
      return "deposit_fees";
    }
    this.require(ix.programId === this.programs.breaks, `the model only knows the breaks and treasury programs, not ${ix.programId}`);
    const disc = hex(ix.data.subarray(0, 8));
    const args = new Reader(ix.data.subarray(8));
    const name = ["create_break", "close_break", "commit_eligibility", "fund_purchases", "commit_pool", "request_randomness", "settle_randomness", "claim_free_spot"].find(
      (n) => hex(instructionDiscriminator(n)) === disc,
    );
    if (!name) throw new Error(`the mock chain does not model instruction ${disc}`);
    switch (name) {
      case "create_break":
        this.createBreak(ix, args);
        break;
      case "close_break":
        this.closeBreak(ix);
        break;
      case "commit_eligibility":
        this.commitEligibility(ix, args);
        break;
      case "fund_purchases":
        this.fundPurchases(ix);
        break;
      case "commit_pool":
        this.commitPool(ix, args);
        break;
      case "request_randomness":
        this.requestRandomness(ix);
        break;
      case "settle_randomness":
        this.settleRandomness(ix);
        break;
      case "claim_free_spot":
        this.claimFreeSpot(ix, args);
        break;
    }
    return name;
  }

  private requireKeeper(ix: Instruction, index: number) {
    const keeper = ix.accounts[index];
    this.require(!!keeper?.isSigner && keeper.pubkey === this.config.keeper, "Unauthorized");
  }

  // programs/breaks/src/lifecycle.rs (`CreateBreak::handle`) and math.rs (`creation_locks`); the escrow account is not
  // modelled, but its rent is paid. The keeper pays the rent of the two accounts the instruction makes (the break, 1,073 bytes:
  // 8,358,960 lamports, and the USDC escrow, 165 bytes: 2,039,280) and the fee, and the system program refuses a payment that
  // leaves the keeper with less than an empty account needs (890,880). The numbers are written out here and not computed
  // with the keeper's own helper, so a wrong formula there is not repeated here.
  private createBreak(ix: Instruction, args: Reader) {
    this.requireKeeper(ix, 0);
    const paidSpots = args.u16();
    const freeSpots = args.u16();
    const spotPrice = args.u64();
    const maxPackPrice = args.u64();
    const packMachine = args.fixed(32);
    const opensAt = args.i64();
    const closesAt = args.i64();
    const key = (i: number) => (ix.accounts[i] as Instruction["accounts"][number]).pubkey;
    const t = treasuryAddresses(this.programs.treasury);

    this.require(key(1) === configAddress(this.programs), "ConstraintSeeds");
    const id = this.config.nextBreakId;
    // The break account is a PDA of the next id: an id that is no longer next is refused (this is what makes a resend safe).
    this.require(key(2) === breakAddress(this.programs, id), "ConstraintSeeds");
    this.require(key(3) === this.config.usdcMint, "ConstraintAddress");
    this.require(key(6) === t.config && key(7) === t.subsidyVault && key(8) === t.holderVault && key(9) === this.programs.treasury, "ConstraintSeeds");

    const paid = 8_358_960n + 2_039_280n + 5_000n;
    const held = this.solBalances.get(this.config.keeper) ?? 0n;
    this.require(held >= paid + 890_880n, "InsufficientFundsForRent");
    this.solBalances.set(this.config.keeper, held - paid);

    this.require(!this.config.paused, "Paused");
    this.require(paidSpots >= 1 && paidSpots <= this.config.maxPaidSpots && freeSpots <= this.config.maxFreeSpots, "InvalidSpotCounts");
    this.require(spotPrice > 0n && maxPackPrice > 0n, "InvalidPrice");
    const window = closesAt - opensAt;
    this.require(closesAt > this.unixTime && window >= this.config.minWindowSecs && window <= this.config.maxWindowSecs, "InvalidWindow");
    this.require(spotPrice <= maxPackPrice, "SpotPriceAboveMaxPackPrice");

    const lockSubsidy = BigInt(paidSpots) * (maxPackPrice - spotPrice);
    const lockHolder = BigInt(freeSpots) * maxPackPrice;
    // The funding rule (treasury lock_funds): each bucket must have that much unlocked.
    this.require(lockSubsidy <= this.treasury.subsidyVault - this.treasury.config.lockedSubsidy, "InsufficientAvailable");
    this.require(lockHolder <= this.treasury.holderVault - this.treasury.config.lockedHolder, "InsufficientAvailable");
    this.treasury.config.lockedSubsidy += lockSubsidy;
    this.treasury.config.lockedHolder += lockHolder;

    this.config.nextBreakId = id + 1n;
    this.breaks.set(id, {
      id,
      status: "Open",
      paidSpots,
      freeSpots,
      spotPrice,
      maxPackPrice,
      packMachine,
      opensAt,
      closesAt,
      spotsSold: 0,
      lockedSubsidy: lockSubsidy,
      lockedHolder: lockHolder,
      eligibilityRoot: new Uint8Array(32),
      eligibilityTotalWeight: 0n,
      eligibilityCount: 0,
      eligibilityInputsHash: new Uint8Array(32),
      poolSize: 0,
      packBudget: 0n,
      poolHash: new Uint8Array(32),
      randomnessAttempt: 0,
      randomnessRequestId: new Uint8Array(32),
      randomnessRequestedAt: 0n,
      seed: new Uint8Array(32),
      seededAt: 0n,
      freeWinnerCount: 0,
      freeWinners: Array.from({ length: 16 }, () => ({ wallet: "11111111111111111111111111111111", start: 0n, weight: 0n })),
      bump: 254,
      escrowBump: 253,
    });
  }

  // programs/breaks/src/lifecycle.rs
  private closeBreak(ix: Instruction) {
    const b = this.breakAt((ix.accounts[0] as Instruction["accounts"][number]).pubkey);
    this.require(b.status === "Open", "WrongStatus");
    this.require(this.unixTime >= b.closesAt, "TooEarlyToClose");
    b.status = "Closed";
  }

  private commitEligibility(ix: Instruction, args: Reader) {
    this.requireKeeper(ix, 0);
    const root = args.fixed(32);
    const totalWeight = args.u64();
    const entryCount = args.u32();
    const inputsHash = args.fixed(32);
    const b = this.breakAt((ix.accounts[2] as Instruction["accounts"][number]).pubkey);
    this.require(b.status === "Closed", "WrongStatus");
    this.require((totalWeight === 0n) === (entryCount === 0), "InvalidEligibility");
    b.eligibilityRoot = root;
    b.eligibilityTotalWeight = totalWeight;
    b.eligibilityCount = entryCount;
    b.eligibilityInputsHash = inputsHash;
    b.status = "EligibilityCommitted";
  }

  // programs/breaks/src/lifecycle.rs and math.rs (`funding`); the USDC itself is not modelled
  private fundPurchases(ix: Instruction) {
    this.requireKeeper(ix, 0);
    this.require(!this.config.paused, "Paused");
    const b = this.breakAt((ix.accounts[2] as Instruction["accounts"][number]).pubkey);
    this.require(b.status === "EligibilityCommitted", "WrongStatus");
    const buyerUsdc = (ix.accounts[4] as Instruction["accounts"][number]).pubkey;
    this.require(buyerUsdc === associatedTokenAddress(this.config.buyer, this.config.usdcMint) && this.tokenAccounts.has(buyerUsdc), "ConstraintTokenOwner");
    const drawnFree = Math.min(b.freeSpots, b.eligibilityCount);
    const poolSize = b.spotsSold + drawnFree;
    this.require(poolSize > 0, "EmptyPool");
    b.poolSize = poolSize;
    b.packBudget = BigInt(poolSize) * b.maxPackPrice;
    // The pack budget leaves the treasury's locked funds and what was not needed is unlocked. A break that was not
    // created through `create_break` (the test fixtures) holds no locks and leaves the treasury alone.
    if (b.lockedSubsidy > 0n || b.lockedHolder > 0n) {
      const fromSubsidy = BigInt(b.spotsSold) * (b.maxPackPrice - b.spotPrice);
      const fromHolder = BigInt(drawnFree) * b.maxPackPrice;
      this.require(fromSubsidy <= b.lockedSubsidy && fromHolder <= b.lockedHolder, "InsufficientLocked");
      this.treasury.subsidyVault -= fromSubsidy;
      this.treasury.holderVault -= fromHolder;
      this.treasury.config.lockedSubsidy -= b.lockedSubsidy;
      this.treasury.config.lockedHolder -= b.lockedHolder;
    }
    b.lockedSubsidy = 0n;
    b.lockedHolder = 0n;
    b.status = "Funded";
  }

  private commitPool(ix: Instruction, args: Reader) {
    this.requireKeeper(ix, 0);
    const poolHash = args.fixed(32);
    const poolSize = args.u16();
    const b = this.breakAt((ix.accounts[2] as Instruction["accounts"][number]).pubkey);
    this.require(b.status === "Funded", "WrongStatus");
    this.require(poolSize === b.poolSize, "PoolSizeMismatch");
    b.poolHash = poolHash;
    b.status = "PoolCommitted";
  }

  // programs/breaks/src/draw.rs
  private requestRandomness(ix: Instruction) {
    this.requireKeeper(ix, 0);
    const [, , breakMeta, vrfProgram, networkStateMeta, treasuryMeta, requestMeta, previousMeta] = ix.accounts;
    const b = this.breakAt((breakMeta as Instruction["accounts"][number]).pubkey);
    const vrf = this.config.randomnessProgram;
    this.require((vrfProgram as Instruction["accounts"][number]).pubkey === vrf, "InvalidRandomnessRecord");

    // What ORAO's own `request_v2` checks: the network state is its PDA, and the treasury is the one that state names
    // (the SOL treasury, or the token treasury when a token fee is configured). Only when the test gave the chain a state.
    const networkStateAddress = oraoNetworkState(vrf);
    const networkState = this.accounts.get(networkStateAddress);
    if (networkState) {
      this.require((networkStateMeta as Instruction["accounts"][number]).pubkey === networkStateAddress, "ConstraintSeeds");
      const state = decodeNetworkState(networkState);
      const given = (treasuryMeta as Instruction["accounts"][number]).pubkey;
      this.require(given === state.treasury || given === state.tokenFee?.treasury, "UnknownTreasuryGiven");
    }

    let attempt: number;
    if (b.status === "PoolCommitted") {
      attempt = 0;
    } else if (b.status === "RandomnessRequested") {
      this.require(this.unixTime >= b.randomnessRequestedAt + this.config.randomnessTimeoutSecs, "RequestNotTimedOut");
      const previous = this.requests.get((previousMeta as Instruction["accounts"][number]).pubkey);
      this.require(!!previous && equalBytes(previous.seed, b.randomnessRequestId), "InvalidRandomnessRecord");
      this.require(previous.state.state === "pending", "AlreadyFulfilled");
      this.require(b.randomnessAttempt + 1 < MAX_RANDOMNESS_ATTEMPTS, "TooManyAttempts");
      this.require(
        (previousMeta as Instruction["accounts"][number]).pubkey === requestAddress(vrf, b.randomnessRequestId),
        "InvalidRandomnessRecord",
      );
      attempt = b.randomnessAttempt + 1;
    } else {
      throw new Revert("WrongStatus");
    }

    const seed = requestId(breakAddress(this.programs, b.id), attempt, b.eligibilityRoot, b.poolHash);
    const expected = requestAddress(vrf, seed);
    this.require((requestMeta as Instruction["accounts"][number]).pubkey === expected, "InvalidRandomnessRecord");

    b.randomnessAttempt = attempt;
    b.randomnessRequestId = seed;
    b.randomnessRequestedAt = this.unixTime;
    b.status = "RandomnessRequested";
    // Someone may already have asked ORAO for exactly this seed; then the request is adopted. Otherwise ORAO creates it.
    if (!this.requests.has(expected)) {
      this.requests.set(expected, { client: this.config.keeper, seed, state: { state: "pending" } });
    }
  }

  private settleRandomness(ix: Instruction) {
    const [, breakMeta, requestMeta] = ix.accounts;
    const b = this.breakAt((breakMeta as Instruction["accounts"][number]).pubkey);
    this.require(b.status === "RandomnessRequested", "WrongStatus");
    const vrf = this.config.randomnessProgram;
    this.require(
      (requestMeta as Instruction["accounts"][number]).pubkey === requestAddress(vrf, b.randomnessRequestId),
      "InvalidRandomnessRecord",
    );
    const request = this.requests.get((requestMeta as Instruction["accounts"][number]).pubkey);
    this.require(!!request && equalBytes(request.seed, b.randomnessRequestId), "InvalidRandomnessRecord");
    this.require(request.state.state === "fulfilled", "RandomnessNotFulfilled");
    b.seed = drawSeed(request.state.randomness);
    b.seededAt = this.unixTime;
    b.status = b.poolSize - b.spotsSold === 0 ? "Drawn" : "Settled";
  }

  // programs/breaks/src/claims.rs
  private claimFreeSpot(ix: Instruction, args: Reader) {
    const index = args.u8();
    const wallet = args.address();
    const weight = args.u64();
    const n = args.u32();
    const proof = Array.from({ length: n }, () => ({ sibling: { hash: args.fixed(32), sum: args.u64() }, siblingIsLeft: args.bool() }));
    const b = this.breakAt((ix.accounts[1] as Instruction["accounts"][number]).pubkey);
    this.require(b.status === "Settled", "WrongStatus");
    this.require(index === b.freeWinnerCount && index < b.poolSize - b.spotsSold, "WrongClaimIndex");

    const taken = b.freeWinners.slice(0, index).map((w) => [w.start, w.weight] as const);
    const position = freePosition(b.seed, index, b.eligibilityTotalWeight, taken);
    const verified = verify({ wallet: addressToBytes(wallet), weight }, proof);
    this.require(equalBytes(verified.root.hash, b.eligibilityRoot) && verified.root.sum === b.eligibilityTotalWeight, "InvalidProof");
    this.require(verified.start <= position && position < verified.start + weight, "NotTheDrawnWinner");
    this.require(!b.freeWinners.slice(0, index).some((w) => w.wallet === wallet), "WinnerAlreadyDrawn");

    b.freeWinners[index] = { wallet, start: verified.start, weight };
    b.freeWinnerCount += 1;
    if (b.freeWinnerCount === b.poolSize - b.spotsSold) b.status = "Drawn";
  }

  /** Records a paid spot for a break, as `buy_spot` would have. */
  addSpot(s: SpotAccount) {
    const b = this.breaks.get(s.breakId);
    if (!b) throw new Error("no such break");
    this.spots.set(spotAddress(this.programs, breakAddress(this.programs, s.breakId), s.index), s);
  }
}

