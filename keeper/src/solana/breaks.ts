// Instruction builders, id derivations and account decoders for the `breaks` program.
// Every byte, account position and derived address is checked against programs/breaks/instruction-vectors.json,
// which the Rust tests generate from the program itself.

import { concat, equalBytes, hashv, u16le, u64le, utf8 } from "../draw/bytes.js";
import { Writer, accountReader } from "./codec.js";
import {
  type AccountMeta,
  type Instruction,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  instructionDiscriminator,
  programDataAddress,
  readonly,
  signer,
  signerMut,
  writable,
} from "./instruction.js";
import { type Address, addressToBytes, findProgramAddress } from "./pubkey.js";
import { treasuryAddresses } from "./treasury.js";

/** The two deployed programs. Their ids are placeholders until the devnet deployment. */
export interface Programs {
  breaks: Address;
  treasury: Address;
}

/** ORAO VRF: the same address on mainnet and devnet. */
export const ORAO_PROGRAM: Address = "VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y";

export const MAX_FREE_SPOTS = 16;
export const MAX_PROOF_STEPS = 40;

// ---------------------------------------------------------------- addresses

const pda = (programId: Address, ...seeds: Uint8Array[]): Address => findProgramAddress(seeds, programId).address;

export function configAddress(programs: Programs): Address {
  return pda(programs.breaks, utf8("config"));
}

/** The PDA that signs the treasury CPIs (the treasury's "controller"). */
export function treasuryAuthorityAddress(programs: Programs): Address {
  return pda(programs.breaks, utf8("treasury_authority"));
}

export function breakAddress(programs: Programs, breakId: bigint): Address {
  return pda(programs.breaks, utf8("break"), u64le(breakId));
}

/** The USDC token account that holds a break's paid spots. */
export function escrowAddress(programs: Programs, breakKey: Address): Address {
  return pda(programs.breaks, utf8("escrow"), addressToBytes(breakKey));
}

export function spotAddress(programs: Programs, breakKey: Address, index: number): Address {
  return pda(programs.breaks, utf8("spot"), addressToBytes(breakKey), u16le(index));
}

/** ORAO's request account for a seed. */
export function requestAddress(vrfProgram: Address, seed: Uint8Array): Address {
  return pda(vrfProgram, utf8("orao-vrf-randomness-request"), seed);
}

/** ORAO's network-state account (holds its fee settings). */
export function oraoNetworkState(vrfProgram: Address = ORAO_PROGRAM): Address {
  return pda(vrfProgram, utf8("orao-vrf-network-configuration"));
}

// ---------------------------------------------------------------- derivations

/** The seed handed to the VRF: commits to the break, the attempt, the eligibility root and the pool hash. */
export function requestId(breakKey: Address, attempt: number, eligibilityRoot: Uint8Array, poolHash: Uint8Array): Uint8Array {
  if (eligibilityRoot.length !== 32 || poolHash.length !== 32) throw new RangeError("root and pool hash are 32 bytes");
  return hashv(utf8("breaks:randomness:v1"), addressToBytes(breakKey), Uint8Array.of(attempt), eligibilityRoot, poolHash);
}

/** The seed of the draw: a hash of the 64 bytes the VRF answered with. */
export function drawSeed(answer: Uint8Array): Uint8Array {
  if (answer.length !== 64) throw new RangeError("the VRF answer is 64 bytes");
  return hashv(utf8("breaks:seed:v1"), answer);
}

// ---------------------------------------------------------------- instructions

function build(programId: Address, name: string, args: Writer | null, accounts: AccountMeta[]): Instruction {
  return { programId, accounts, data: concat(instructionDiscriminator(name), args ? args.finish() : new Uint8Array(0)) };
}

function treasuryCpiAccounts(programs: Programs) {
  const t = treasuryAddresses(programs.treasury);
  return { authority: treasuryAuthorityAddress(programs), ...t };
}

export interface InitializeParams {
  authority: Address;
  usdcMint: Address;
  admin: Address;
  keeper: Address;
  buyer: Address;
  minWindowSecs: bigint;
  maxWindowSecs: bigint;
  maxPaidSpots: number;
  maxFreeSpots: number;
  randomnessProgram: Address;
  randomnessTimeoutSecs: bigint;
}

/** Only the program's upgrade authority can call this, once. */
export function initialize(programs: Programs, p: InitializeParams): Instruction {
  const args = new Writer()
    .address(p.admin)
    .address(p.keeper)
    .address(p.buyer)
    .i64(p.minWindowSecs)
    .i64(p.maxWindowSecs)
    .u16(p.maxPaidSpots)
    .u16(p.maxFreeSpots)
    .address(p.randomnessProgram)
    .i64(p.randomnessTimeoutSecs);
  return build(programs.breaks, "initialize", args, [
    signerMut(p.authority),
    readonly(programs.breaks),
    readonly(programDataAddress(programs.breaks)),
    writable(configAddress(programs)),
    readonly(treasuryAddresses(programs.treasury).config),
    readonly(p.usdcMint),
    readonly(SYSTEM_PROGRAM),
  ]);
}

function adminCall(programs: Programs, name: string, admin: Address, args: Writer): Instruction {
  return build(programs.breaks, name, args, [signer(admin), writable(configAddress(programs))]);
}

export const setKeeper = (programs: Programs, p: { admin: Address; keeper: Address }) =>
  adminCall(programs, "set_keeper", p.admin, new Writer().address(p.keeper));

export const setBuyer = (programs: Programs, p: { admin: Address; buyer: Address }) =>
  adminCall(programs, "set_buyer", p.admin, new Writer().address(p.buyer));

export const setPaused = (programs: Programs, p: { admin: Address; paused: boolean }) =>
  adminCall(programs, "set_paused", p.admin, new Writer().bool(p.paused));

export const setRandomness = (programs: Programs, p: { admin: Address; program: Address; timeoutSecs: bigint }) =>
  adminCall(programs, "set_randomness", p.admin, new Writer().address(p.program).i64(p.timeoutSecs));

export interface CreateBreakParams {
  keeper: Address;
  usdcMint: Address;
  breakId: bigint;
  paidSpots: number;
  freeSpots: number;
  spotPrice: bigint;
  maxPackPrice: bigint;
  /** The Collector Crypt machine / price tier, 32 bytes, committed for the whole break. */
  packMachine: Uint8Array;
  opensAt: bigint;
  closesAt: bigint;
}

/** `breakId` must be the config's `nextBreakId`. Locks the worst case in the treasury. */
export function createBreak(programs: Programs, p: CreateBreakParams): Instruction {
  const b = breakAddress(programs, p.breakId);
  const t = treasuryCpiAccounts(programs);
  const args = new Writer()
    .u16(p.paidSpots)
    .u16(p.freeSpots)
    .u64(p.spotPrice)
    .u64(p.maxPackPrice)
    .fixed(p.packMachine, 32)
    .i64(p.opensAt)
    .i64(p.closesAt);
  return build(programs.breaks, "create_break", args, [
    signerMut(p.keeper),
    writable(configAddress(programs)),
    writable(b),
    readonly(p.usdcMint),
    writable(escrowAddress(programs, b)),
    readonly(t.authority),
    writable(t.config),
    readonly(t.subsidyVault),
    readonly(t.holderVault),
    readonly(programs.treasury),
    readonly(TOKEN_PROGRAM),
    readonly(SYSTEM_PROGRAM),
  ]);
}

/** `index` must be the next free spot (`spotsSold`). */
export function buySpot(
  programs: Programs,
  p: { buyer: Address; buyerUsdc: Address; breakId: bigint; index: number },
): Instruction {
  const b = breakAddress(programs, p.breakId);
  return build(programs.breaks, "buy_spot", new Writer().u16(p.index), [
    signerMut(p.buyer),
    readonly(configAddress(programs)),
    writable(b),
    writable(escrowAddress(programs, b)),
    writable(p.buyerUsdc),
    writable(spotAddress(programs, b, p.index)),
    readonly(TOKEN_PROGRAM),
    readonly(SYSTEM_PROGRAM),
  ]);
}

/** Anyone can call this once `closesAt` has passed. */
export function closeBreak(programs: Programs, p: { breakId: bigint }): Instruction {
  return build(programs.breaks, "close_break", null, [writable(breakAddress(programs, p.breakId))]);
}

function keeperCall(programs: Programs, name: string, keeper: Address, breakId: bigint, args: Writer): Instruction {
  return build(programs.breaks, name, args, [
    signer(keeper),
    readonly(configAddress(programs)),
    writable(breakAddress(programs, breakId)),
  ]);
}

export function commitEligibility(
  programs: Programs,
  p: {
    keeper: Address;
    breakId: bigint;
    root: Uint8Array;
    totalWeight: bigint;
    entryCount: number;
    inputsHash: Uint8Array;
  },
): Instruction {
  const args = new Writer().fixed(p.root, 32).u64(p.totalWeight).u32(p.entryCount).fixed(p.inputsHash, 32);
  return keeperCall(programs, "commit_eligibility", p.keeper, p.breakId, args);
}

export function commitPool(
  programs: Programs,
  p: { keeper: Address; breakId: bigint; poolHash: Uint8Array; poolSize: number },
): Instruction {
  return keeperCall(programs, "commit_pool", p.keeper, p.breakId, new Writer().fixed(p.poolHash, 32).u16(p.poolSize));
}

/** Pays the pack budget to the configured buyer wallet. `buyerUsdc` must be that wallet's USDC account. */
export function fundPurchases(
  programs: Programs,
  p: { keeper: Address; breakId: bigint; buyerUsdc: Address },
): Instruction {
  const b = breakAddress(programs, p.breakId);
  const t = treasuryCpiAccounts(programs);
  return build(programs.breaks, "fund_purchases", null, [
    signer(p.keeper),
    readonly(configAddress(programs)),
    writable(b),
    writable(escrowAddress(programs, b)),
    writable(p.buyerUsdc),
    readonly(t.authority),
    writable(t.config),
    writable(t.subsidyVault),
    writable(t.holderVault),
    readonly(programs.treasury),
    readonly(TOKEN_PROGRAM),
  ]);
}

export interface RequestRandomnessParams {
  keeper: Address;
  breakId: bigint;
  /** Must be the configured randomness program. */
  vrfProgram: Address;
  vrfNetworkState: Address;
  /** ORAO's fee treasury (a field of its network state). */
  vrfTreasury: Address;
  /** The seed for this attempt: `requestId(...)` with the break's current attempt number. */
  seed: Uint8Array;
  /** The previous attempt's request account (to prove it was never answered), or the system program for the first. */
  previousRequest?: Address;
  /** ORAO's token-fee accounts, when it charges its fee in ORAO tokens. */
  extra?: { pubkey: Address; writable: boolean }[];
}

export function requestRandomness(programs: Programs, p: RequestRandomnessParams): Instruction {
  const extra = (p.extra ?? []).map((e) => (e.writable ? writable(e.pubkey) : readonly(e.pubkey)));
  return build(programs.breaks, "request_randomness", null, [
    signerMut(p.keeper),
    readonly(configAddress(programs)),
    writable(breakAddress(programs, p.breakId)),
    readonly(p.vrfProgram),
    writable(p.vrfNetworkState),
    writable(p.vrfTreasury),
    writable(requestAddress(p.vrfProgram, p.seed)),
    readonly(p.previousRequest ?? SYSTEM_PROGRAM),
    readonly(SYSTEM_PROGRAM),
    ...extra,
  ]);
}

/** Anyone can call this once the VRF has answered. `request` is the request account of the current attempt. */
export function settleRandomness(programs: Programs, p: { breakId: bigint; request: Address }): Instruction {
  return build(programs.breaks, "settle_randomness", null, [
    readonly(configAddress(programs)),
    writable(breakAddress(programs, p.breakId)),
    readonly(p.request),
  ]);
}

/** One step of a Merkle sum-tree proof, as the program takes it. */
export interface ProofStep {
  hash: Uint8Array;
  sum: bigint;
  siblingIsLeft: boolean;
}

/** Anyone can call this; winners are claimed in order (`index` 0, 1, ...). */
export function claimFreeSpot(
  programs: Programs,
  p: { payer: Address; breakId: bigint; index: number; wallet: Address; weight: bigint; proof: readonly ProofStep[] },
): Instruction {
  if (p.proof.length > MAX_PROOF_STEPS) throw new RangeError(`a proof is at most ${MAX_PROOF_STEPS} steps`);
  const args = new Writer()
    .u8(p.index)
    .address(p.wallet)
    .u64(p.weight)
    .vec(p.proof, (w, step) => w.fixed(step.hash, 32).u64(step.sum).bool(step.siblingIsLeft));
  return build(programs.breaks, "claim_free_spot", args, [signer(p.payer), writable(breakAddress(programs, p.breakId))]);
}

/** Admin only, before the break is funded. Releases the locked treasury funds. */
export function cancelBreak(programs: Programs, p: { admin: Address; breakId: bigint }): Instruction {
  const t = treasuryCpiAccounts(programs);
  return build(programs.breaks, "cancel_break", null, [
    signer(p.admin),
    readonly(configAddress(programs)),
    writable(breakAddress(programs, p.breakId)),
    readonly(t.authority),
    writable(t.config),
    readonly(t.subsidyVault),
    readonly(t.holderVault),
    readonly(programs.treasury),
  ]);
}

/** Anyone can call this on a cancelled break; the money goes to the spot's owner, `ownerUsdc`. */
export function refundSpot(
  programs: Programs,
  p: { breakId: bigint; index: number; ownerUsdc: Address },
): Instruction {
  const b = breakAddress(programs, p.breakId);
  return build(programs.breaks, "refund_spot", null, [
    readonly(b),
    writable(escrowAddress(programs, b)),
    writable(spotAddress(programs, b, p.index)),
    writable(p.ownerUsdc),
    readonly(TOKEN_PROGRAM),
  ]);
}

// ---------------------------------------------------------------- accounts

export type BreakStatus =
  | "Open"
  | "Closed"
  | "EligibilityCommitted"
  | "Funded"
  | "PoolCommitted"
  | "RandomnessRequested"
  | "Settled"
  | "Drawn"
  | "Cancelled";

const STATUSES: readonly BreakStatus[] = [
  "Open",
  "Closed",
  "EligibilityCommitted",
  "Funded",
  "PoolCommitted",
  "RandomnessRequested",
  "Settled",
  "Drawn",
  "Cancelled",
];

export interface FreeWinner {
  wallet: Address;
  start: bigint;
  weight: bigint;
}

export interface BreakAccount {
  id: bigint;
  status: BreakStatus;
  paidSpots: number;
  freeSpots: number;
  spotPrice: bigint;
  maxPackPrice: bigint;
  packMachine: Uint8Array;
  opensAt: bigint;
  closesAt: bigint;
  spotsSold: number;
  lockedSubsidy: bigint;
  lockedHolder: bigint;
  eligibilityRoot: Uint8Array;
  eligibilityTotalWeight: bigint;
  eligibilityCount: number;
  eligibilityInputsHash: Uint8Array;
  poolSize: number;
  packBudget: bigint;
  poolHash: Uint8Array;
  randomnessAttempt: number;
  randomnessRequestId: Uint8Array;
  randomnessRequestedAt: bigint;
  seed: Uint8Array;
  seededAt: bigint;
  freeWinnerCount: number;
  /** All 16 slots; only the first `freeWinnerCount` are meaningful. */
  freeWinners: FreeWinner[];
  bump: number;
  escrowBump: number;
}

export function decodeBreak(data: Uint8Array): BreakAccount {
  const r = accountReader(data, "Break");
  const id = r.u64();
  const statusIndex = r.u8();
  const status = STATUSES[statusIndex];
  if (!status) throw new RangeError(`unknown break status ${statusIndex}`);
  return {
    id,
    status,
    paidSpots: r.u16(),
    freeSpots: r.u16(),
    spotPrice: r.u64(),
    maxPackPrice: r.u64(),
    packMachine: r.fixed(32),
    opensAt: r.i64(),
    closesAt: r.i64(),
    spotsSold: r.u16(),
    lockedSubsidy: r.u64(),
    lockedHolder: r.u64(),
    eligibilityRoot: r.fixed(32),
    eligibilityTotalWeight: r.u64(),
    eligibilityCount: r.u32(),
    eligibilityInputsHash: r.fixed(32),
    poolSize: r.u16(),
    packBudget: r.u64(),
    poolHash: r.fixed(32),
    randomnessAttempt: r.u8(),
    randomnessRequestId: r.fixed(32),
    randomnessRequestedAt: r.i64(),
    seed: r.fixed(32),
    seededAt: r.i64(),
    freeWinnerCount: r.u8(),
    freeWinners: Array.from({ length: MAX_FREE_SPOTS }, () => ({
      wallet: r.address(),
      start: r.u64(),
      weight: r.u64(),
    })),
    bump: r.u8(),
    escrowBump: r.u8(),
  };
}

export interface BreaksConfigAccount {
  admin: Address;
  keeper: Address;
  buyer: Address;
  usdcMint: Address;
  randomnessProgram: Address;
  randomnessTimeoutSecs: bigint;
  nextBreakId: bigint;
  minWindowSecs: bigint;
  maxWindowSecs: bigint;
  maxPaidSpots: number;
  maxFreeSpots: number;
  paused: boolean;
  bump: number;
}

export function decodeBreaksConfig(data: Uint8Array): BreaksConfigAccount {
  const r = accountReader(data, "BreaksConfig");
  return {
    admin: r.address(),
    keeper: r.address(),
    buyer: r.address(),
    usdcMint: r.address(),
    randomnessProgram: r.address(),
    randomnessTimeoutSecs: r.i64(),
    nextBreakId: r.u64(),
    minWindowSecs: r.i64(),
    maxWindowSecs: r.i64(),
    maxPaidSpots: r.u16(),
    maxFreeSpots: r.u16(),
    paused: r.bool(),
    bump: r.u8(),
  };
}

export interface SpotAccount {
  breakId: bigint;
  index: number;
  owner: Address;
  paid: bigint;
  refunded: boolean;
  bump: number;
}

export function decodeSpot(data: Uint8Array): SpotAccount {
  const r = accountReader(data, "Spot");
  return {
    breakId: r.u64(),
    index: r.u16(),
    owner: r.address(),
    paid: r.u64(),
    refunded: r.bool(),
    bump: r.u8(),
  };
}

// ---------------------------------------------------------------- ORAO request account

export type RequestState = { state: "pending" } | { state: "fulfilled"; randomness: Uint8Array };

const REQUEST_ACCOUNT_DISCRIMINATOR = Uint8Array.of(139, 239, 184, 215, 227, 86, 191, 226);
const TAG_OFFSET = 8;
const SEED_OFFSET = 41;
const RANDOMNESS_OFFSET = SEED_OFFSET + 32;

/**
 * Reads the bytes of an ORAO request account, with the same checks as the program: right account type, right
 * seed, and a fulfilled answer that is not blank. Throws on anything else.
 */
export function decodeRequest(data: Uint8Array, expectedSeed: Uint8Array): RequestState {
  if (data.length < SEED_OFFSET + 32 + 4 || !equalBytes(data.subarray(0, 8), REQUEST_ACCOUNT_DISCRIMINATOR)) {
    throw new Error("not an ORAO request account");
  }
  if (!equalBytes(data.subarray(SEED_OFFSET, SEED_OFFSET + 32), expectedSeed)) {
    throw new Error("the request is for another seed");
  }
  const tag = data[TAG_OFFSET];
  if (tag === 0) return { state: "pending" };
  if (tag === 1) {
    if (data.length < RANDOMNESS_OFFSET + 64) throw new Error("a fulfilled request is too short");
    const randomness = data.slice(RANDOMNESS_OFFSET, RANDOMNESS_OFFSET + 64);
    if (randomness.every((b) => b === 0)) throw new Error("the answer is blank");
    return { state: "fulfilled", randomness };
  }
  throw new Error(`unknown request state ${tag}`);
}
