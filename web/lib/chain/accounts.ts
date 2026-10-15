// The accounts of the breaks program, read in the browser. An independent decoder of the layouts in
// programs/breaks/src/state.rs; the Rust programs' own sample account bytes (instruction-vectors.json) pin it.

import { hashv, utf8 } from "../draw/bytes";
import { type Address, addressFromBytes } from "./address";

export const MAX_FREE_SPOTS = 16;

export type BreakStatus = "Open" | "Closed" | "EligibilityCommitted" | "Funded" | "PoolCommitted" | "RandomnessRequested" | "Settled" | "Drawn" | "Cancelled";

/** In the order of the program's enum, which is what the status byte means. */
const STATUSES: readonly BreakStatus[] = ["Open", "Closed", "EligibilityCommitted", "Funded", "PoolCommitted", "RandomnessRequested", "Settled", "Drawn", "Cancelled"];

export class Reader {
  private at = 0;
  private readonly view: DataView;
  constructor(private readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  private take(n: number): number {
    if (this.at + n > this.data.length) throw new RangeError("the account data is too short");
    const start = this.at;
    this.at += n;
    return start;
  }
  u8 = () => this.view.getUint8(this.take(1));
  u16 = () => this.view.getUint16(this.take(2), true);
  u32 = () => this.view.getUint32(this.take(4), true);
  u64 = () => this.view.getBigUint64(this.take(8), true);
  i64 = () => this.view.getBigInt64(this.take(8), true);
  bool(): boolean {
    const b = this.u8();
    if (b > 1) throw new RangeError(`not a bool: ${b}`);
    return b === 1;
  }
  fixed(n: number): Uint8Array {
    const start = this.take(n);
    return this.data.slice(start, start + n);
  }
  address = (): Address => addressFromBytes(this.fixed(32));
}

/** A reader after the 8-byte Anchor discriminator, which must be the one of `name`. */
export function accountReader(data: Uint8Array, name: string): Reader {
  const expected = hashv(utf8(`account:${name}`)).slice(0, 8);
  if (data.length < 8 || expected.some((b, i) => data[i] !== b)) throw new Error(`not a ${name} account (wrong discriminator)`);
  return new Reader(data.subarray(8));
}

export interface FreeWinner {
  wallet: Address;
  /** Where the winner's range starts in `[0, total weight)`. */
  start: bigint;
  weight: bigint;
}

export interface BreakAccount {
  id: bigint;
  status: BreakStatus;
  paidSpots: number;
  freeSpots: number;
  spotPrice: bigint;
  /** The most a pack can cost, committed when the break was created (USDC base units). */
  maxPackPrice: bigint;
  /** The 32 bytes naming the Collector Crypt machine / price tier, committed when the break was created. */
  packMachine: Uint8Array;
  opensAt: bigint;
  closesAt: bigint;
  spotsSold: number;
  eligibilityRoot: Uint8Array;
  eligibilityTotalWeight: bigint;
  eligibilityCount: number;
  poolSize: number;
  poolHash: Uint8Array;
  /** All zeros until the randomness has been settled. */
  seed: Uint8Array;
  seededAt: bigint;
  freeWinnerCount: number;
  /** Only the recorded winners (the first `freeWinnerCount` slots). */
  freeWinners: FreeWinner[];
}

export function decodeBreak(data: Uint8Array): BreakAccount {
  const r = accountReader(data, "Break");
  const id = r.u64();
  const statusIndex = r.u8();
  const status = STATUSES[statusIndex];
  if (!status) throw new RangeError(`unknown break status ${statusIndex}`);
  const paidSpots = r.u16();
  const freeSpots = r.u16();
  const spotPrice = r.u64();
  const maxPackPrice = r.u64();
  const packMachine = r.fixed(32);
  const opensAt = r.i64();
  const closesAt = r.i64();
  const spotsSold = r.u16();
  r.u64(); // locked subsidy
  r.u64(); // locked holder
  const eligibilityRoot = r.fixed(32);
  const eligibilityTotalWeight = r.u64();
  const eligibilityCount = r.u32();
  r.fixed(32); // inputs hash
  const poolSize = r.u16();
  r.u64(); // pack budget
  const poolHash = r.fixed(32);
  r.u8(); // randomness attempt
  r.fixed(32); // randomness request id
  r.i64(); // randomness requested at
  const seed = r.fixed(32);
  const seededAt = r.i64();
  const freeWinnerCount = r.u8();
  if (freeWinnerCount > MAX_FREE_SPOTS) throw new RangeError(`${freeWinnerCount} free winners recorded; at most ${MAX_FREE_SPOTS}`);
  const slots = Array.from({ length: MAX_FREE_SPOTS }, () => ({ wallet: r.address(), start: r.u64(), weight: r.u64() }));
  return {
    id,
    status,
    paidSpots,
    freeSpots,
    spotPrice,
    maxPackPrice,
    packMachine,
    opensAt,
    closesAt,
    spotsSold,
    eligibilityRoot,
    eligibilityTotalWeight,
    eligibilityCount,
    poolSize,
    poolHash,
    seed,
    seededAt,
    freeWinnerCount,
    freeWinners: slots.slice(0, freeWinnerCount),
  };
}

/** The size of a Spot account: the 8-byte account name, then break id, index, owner, price paid, refunded and bump. */
export const SPOT_ACCOUNT_BYTES = 60;
/** Where the owner starts in a Spot account: after the 8-byte name, the break id (8) and the index (2). */
export const SPOT_OWNER_OFFSET = 18;

export interface SpotAccount {
  breakId: bigint;
  index: number;
  owner: Address;
  paid: bigint;
  refunded: boolean;
}

export function decodeSpot(data: Uint8Array): SpotAccount {
  const r = accountReader(data, "Spot");
  return { breakId: r.u64(), index: r.u16(), owner: r.address(), paid: r.u64(), refunded: r.bool() };
}

export interface ConfigAccount {
  /** The wallet of the multisig that can pause the program. */
  admin: Address;
  /** The USDC mint the paid spots are bought with. */
  usdcMint: Address;
  /** The id the next break will get; the breaks that exist are `0 .. nextBreakId - 1`. */
  nextBreakId: bigint;
  /** While paused, no break is created and no spot is sold (refunds and cancelling still work). */
  paused: boolean;
}

export function decodeConfig(data: Uint8Array): ConfigAccount {
  const r = accountReader(data, "BreaksConfig");
  const admin = r.address();
  r.fixed(32 * 2); // keeper, buyer
  const usdcMint = r.address();
  r.fixed(32); // randomness program
  r.u64(); // randomness timeout
  const nextBreakId = r.u64();
  r.u64(); // minimum window
  r.u64(); // maximum window
  r.u16(); // most paid spots
  r.u16(); // most free spots
  const paused = r.bool();
  return { admin, usdcMint, nextBreakId, paused };
}
