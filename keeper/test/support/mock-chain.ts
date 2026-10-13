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
  requestAddress,
  requestId,
  spotAddress,
} from "../../src/solana/breaks.js";
import { Reader } from "../../src/solana/codec.js";
import { type Instruction, instructionDiscriminator } from "../../src/solana/instruction.js";
import { type Address, addressToBytes } from "../../src/solana/pubkey.js";
import { encodeBreak, encodeBreaksConfig, encodeRequest, encodeSpot } from "./accounts.js";

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

export class MockChain implements ChainClient {
  /** Chain clock, unix seconds. */
  public unixTime = 1_800_030_000n;
  public readonly breaks = new Map<bigint, BreakAccount>();
  public readonly spots = new Map<Address, SpotAccount>();
  private readonly requests = new Map<Address, Request>();
  private readonly behaviors: SendBehavior[] = [];
  public sendCalls = 0;
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

  async getAccountData(address: Address): Promise<Uint8Array | undefined> {
    if (address === configAddress(this.programs)) return encodeBreaksConfig(this.config);
    for (const [id, b] of this.breaks) if (address === breakAddress(this.programs, id)) return encodeBreak(b);
    const spot = this.spots.get(address);
    if (spot) return encodeSpot(spot);
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
      for (const ix of instructions) this.apply(ix);
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
    };
  }

  private restore(s: ReturnType<MockChain["snapshot"]>) {
    this.breaks.clear();
    for (const [k, v] of s.breaks) this.breaks.set(k, v);
    this.requests.clear();
    for (const [k, v] of s.requests) this.requests.set(k, v);
  }

  private breakAt(address: Address): BreakAccount {
    for (const [id, b] of this.breaks) if (address === breakAddress(this.programs, id)) return b;
    throw new Revert(`unknown break account ${address}`);
  }

  private require(cond: boolean, reason: string): asserts cond {
    if (!cond) throw new Revert(reason);
  }

  private apply(ix: Instruction) {
    this.require(ix.programId === this.programs.breaks, `the model only knows the breaks program, not ${ix.programId}`);
    const disc = hex(ix.data.subarray(0, 8));
    const args = new Reader(ix.data.subarray(8));
    const name = ["commit_pool", "request_randomness", "settle_randomness", "claim_free_spot"].find(
      (n) => hex(instructionDiscriminator(n)) === disc,
    );
    if (!name) throw new Error(`the mock chain does not model instruction ${disc}`);
    this.applied.push(name);
    switch (name) {
      case "commit_pool":
        return this.commitPool(ix, args);
      case "request_randomness":
        return this.requestRandomness(ix);
      case "settle_randomness":
        return this.settleRandomness(ix);
      case "claim_free_spot":
        return this.claimFreeSpot(ix, args);
    }
  }

  private requireKeeper(ix: Instruction, index: number) {
    const keeper = ix.accounts[index];
    this.require(!!keeper?.isSigner && keeper.pubkey === this.config.keeper, "Unauthorized");
  }

  // programs/breaks/src/lifecycle.rs
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
    const [, , breakMeta, vrfProgram, , , requestMeta, previousMeta] = ix.accounts;
    const b = this.breakAt((breakMeta as Instruction["accounts"][number]).pubkey);
    const vrf = this.config.randomnessProgram;
    this.require((vrfProgram as Instruction["accounts"][number]).pubkey === vrf, "InvalidRandomnessRecord");

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

