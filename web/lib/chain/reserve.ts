// How far the treasury is from paying for the next break, as plain functions over numbers. The rule is the program's funding rule
// (programs/breaks `creation_locks`): to create a break the treasury must hold, unreserved, what the whole pack list needs as if
// every paid spot sold. A free spot is paid by the holder bucket at the average pack price (rounded down); the subsidy bucket pays
// the rest of what the packs cost beyond what the paid spots bring in. The percent is the keeper's (keeper/src/scheduler/policy.ts
// `reserveProgress`, the number the X bot announces): the bucket furthest from its target decides, rounded down. All amounts are
// USDC base units (micro-dollars). `docs/reserve-vectors.json`, made by the keeper's own functions, pins both to the same numbers.

const U64_MAX = (1n << 64n) - 1n;

/** Packs of one machine that may all cost up to the same price: one tier of the break's pack list. */
export interface PackGroup {
  /** The machine's name as the keeper's settings give it (text, or `0x` and 64 hex digits). Only shown, never sent anywhere. */
  machine: string;
  /** The most one pack from this machine may cost, micro-USDC. */
  maxPrice: bigint;
  /** How many of the break's packs come from it. */
  count: number;
}

/** What the next break will be made like. The site is told this when it is built; it is not on chain until the break exists. */
export interface BreakShape {
  paidSpots: number;
  freeSpots: number;
  /** Micro-USDC. */
  spotPrice: bigint;
  /** The packs of the break, cheapest first. The counts add up to `paidSpots + freeSpots`: one pack per spot. */
  packs: PackGroup[];
}

export interface Buckets {
  subsidy: bigint;
  holder: bigint;
}

/** What the packs of the list cost at most in all, and how many there are. */
export function packTotals(packs: readonly PackGroup[]): { total: bigint; count: number } {
  return { total: packs.reduce((sum, g) => sum + g.maxPrice * BigInt(g.count), 0n), count: packs.reduce((n, g) => n + g.count, 0) };
}

/** The average price of the break's packs, rounded down: what the holder bucket pays for a free spot, and the most a spot may cost. */
export function averagePackPrice(s: Pick<BreakShape, "packs">): bigint {
  const { total, count } = packTotals(s.packs);
  if (count === 0) throw new RangeError("the pack list is empty");
  return total / BigInt(count);
}

/** What each bucket must have unreserved for a break of this shape to be created. */
export function worstCase(s: BreakShape): Buckets {
  const spots = s.paidSpots + s.freeSpots;
  const { total, count } = packTotals(s.packs);
  if (spots === 0 || count !== spots) throw new RangeError(`the pack list has ${count} packs for ${spots} spots`);
  if (total > U64_MAX) throw new RangeError("the amounts do not fit in a u64");
  const average = total / BigInt(spots);
  if (s.spotPrice > average) throw new RangeError("the spot price is above the average pack price");
  const holder = BigInt(s.freeSpots) * average;
  const subsidy = total - BigInt(s.paidSpots) * s.spotPrice - holder;
  return { subsidy, holder };
}

export interface Reserve {
  required: Buckets;
  available: Buckets;
  /** What each bucket still lacks (zero when it has enough). */
  missing: Buckets;
  /** 0 to 100, rounded down: the bucket that is furthest from its target decides. */
  percent: number;
  /** Both buckets can cover the worst case, so the program would accept the break. */
  enough: boolean;
}

export function reserveProgress(shape: BreakShape, available: Buckets): Reserve {
  const required = worstCase(shape);
  const lack = (have: bigint, need: bigint) => (have >= need ? 0n : need - have);
  const missing = { subsidy: lack(available.subsidy, required.subsidy), holder: lack(available.holder, required.holder) };
  let percent = 100;
  for (const [have, need] of [[available.subsidy, required.subsidy], [available.holder, required.holder]] as const) {
    // A bucket the break needs nothing from is full (it has at least zero), so it never holds the percentage down.
    const p = have >= need ? 100 : Number((have * 100n) / need);
    percent = Math.min(percent, p);
  }
  return { required, available, missing, percent, enough: missing.subsidy === 0n && missing.holder === 0n };
}
