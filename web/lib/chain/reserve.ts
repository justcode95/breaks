// How far the treasury is from paying for the next break, as plain functions over numbers. The rule is the program's funding rule
// (programs/breaks `creation_locks`): to create a break the treasury must hold, unreserved, in the subsidy bucket the top-up of
// every paid spot (as if all of them sell) and in the holder bucket a whole pack for every free spot. The percent is the keeper's
// (keeper/src/scheduler/policy.ts `reserveProgress`, the number the X bot announces): the bucket furthest from its target decides,
// rounded down. All amounts are USDC base units (micro-dollars).

const U64_MAX = (1n << 64n) - 1n;

/** What the next break will be made like. The site is told this when it is built; it is not on chain until the break exists. */
export interface BreakShape {
  paidSpots: number;
  freeSpots: number;
  /** Micro-USDC. */
  spotPrice: bigint;
  /** The most one pack may cost, micro-USDC. */
  maxPackPrice: bigint;
}

export interface Buckets {
  subsidy: bigint;
  holder: bigint;
}

/** What each bucket must have unreserved for a break of this shape to be created. */
export function worstCase(s: BreakShape): Buckets {
  if (s.spotPrice > s.maxPackPrice) throw new RangeError("the spot price is above the maximum pack price");
  const subsidy = BigInt(s.paidSpots) * (s.maxPackPrice - s.spotPrice);
  const holder = BigInt(s.freeSpots) * s.maxPackPrice;
  if (subsidy > U64_MAX || holder > U64_MAX) throw new RangeError("the amounts do not fit in a u64");
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
