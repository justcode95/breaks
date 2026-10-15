// The rules for starting a break, as pure functions: what the treasury must hold, how far the reserve is from that,
// and whether the break the keeper is configured to make is one the program accepts.

import { MAX_PACKS, MAX_TIERS, type BreaksConfigAccount, type PackTier } from "../solana/breaks.js";

/** Packs of one machine that may all cost up to the same price: one tier of the break's pack list. */
export interface PackGroup {
  /** 32 bytes naming the machine, committed for the whole break. */
  machine: Uint8Array;
  /** The most one pack from this machine may cost, micro-USDC. */
  maxPrice: bigint;
  /** How many of the break's packs come from it. */
  count: number;
}

export interface BreakTemplate {
  paidSpots: number;
  freeSpots: number;
  /** Micro-USDC. */
  spotPrice: bigint;
  /**
   * The packs of the break, cheapest first, as groups. The counts add up to `paidSpots + freeSpots`: one pack per spot.
   * The first `pool_size` packs are the ones bought, so a break that does not fill drops the most expensive.
   */
  packs: PackGroup[];
  /** How long the sale (and the TWAB window) lasts. */
  windowSecs: bigint;
}

const U64_MAX = (1n << 64n) - 1n;

/** The tiers and the tier of each pack, as `create_break` takes them. */
export function packListOf(t: Pick<BreakTemplate, "packs">): { tiers: PackTier[]; packs: number[] } {
  return {
    tiers: t.packs.map((g) => ({ machine: g.machine, maxPrice: g.maxPrice })),
    packs: t.packs.flatMap((g, tier) => Array<number>(g.count).fill(tier)),
  };
}

/** What the packs of the list cost at most in all, and how many there are. */
function listTotals(t: Pick<BreakTemplate, "packs">): { total: bigint; count: number } {
  return { total: t.packs.reduce((sum, g) => sum + g.maxPrice * BigInt(g.count), 0n), count: t.packs.reduce((n, g) => n + g.count, 0) };
}

/**
 * What the treasury must have unlocked to create the break (programs/breaks `creation_locks`): every paid spot filled, so
 * every pack in the list is bought. A free spot is paid by the holder bucket at the average pack price (rounded down) and
 * the subsidy bucket pays what the buyers do not: the sum of the prices less the paid spots at the spot price less the
 * free spots. The spot price may not be above the average pack price.
 */
export function worstCase(t: Pick<BreakTemplate, "paidSpots" | "freeSpots" | "spotPrice" | "packs">): { subsidy: bigint; holder: bigint } {
  const spots = t.paidSpots + t.freeSpots;
  const { total, count } = listTotals(t);
  if (spots === 0 || count !== spots) throw new RangeError(`the pack list has ${count} packs for ${spots} spots`);
  if (total > U64_MAX) throw new RangeError("the amounts do not fit in a u64");
  const average = total / BigInt(spots);
  if (t.spotPrice > average) throw new RangeError("the spot price is above the average pack price");
  const holder = BigInt(t.freeSpots) * average;
  const subsidy = total - BigInt(t.paidSpots) * t.spotPrice - holder;
  return { subsidy, holder };
}

/** What a bucket has that is not reserved for a break: the vault balance minus what is locked (never below zero). */
export const unlocked = (vault: bigint, locked: bigint): bigint => (locked > vault ? 0n : vault - locked);

export interface ReserveProgress {
  requiredSubsidy: bigint;
  requiredHolder: bigint;
  availableSubsidy: bigint;
  availableHolder: bigint;
  /** 0 to 100, rounded down: the bucket that is furthest from its target decides. */
  percent: number;
  /** Both buckets can cover the worst case, so `create_break` would be accepted. */
  enough: boolean;
}

export function reserveProgress(
  t: Pick<BreakTemplate, "paidSpots" | "freeSpots" | "spotPrice" | "packs">,
  available: { subsidy: bigint; holder: bigint },
): ReserveProgress {
  const need = worstCase(t);
  const enough = available.subsidy >= need.subsidy && available.holder >= need.holder;
  let percent = 100;
  for (const [have, required] of [[available.subsidy, need.subsidy], [available.holder, need.holder]] as const) {
    if (required === 0n) continue;
    const p = have >= required ? 100 : Number((have * 100n) / required);
    percent = Math.min(percent, p);
  }
  return {
    requiredSubsidy: need.subsidy,
    requiredHolder: need.holder,
    availableSubsidy: available.subsidy,
    availableHolder: available.holder,
    percent,
    enough,
  };
}

/** Why the program would refuse the configured break, or undefined if it would accept it (given the clock). */
export function templateProblem(t: BreakTemplate, config: BreaksConfigAccount): string | undefined {
  if (t.paidSpots < 1 || t.paidSpots > config.maxPaidSpots) return `paid spots ${t.paidSpots} is outside 1..${config.maxPaidSpots} that the program allows`;
  if (t.freeSpots < 0 || t.freeSpots > config.maxFreeSpots) return `free spots ${t.freeSpots} is outside 0..${config.maxFreeSpots} that the program allows`;
  if (t.spotPrice <= 0n) return "the spot price must be above zero";
  if (t.packs.length < 1 || t.packs.length > MAX_TIERS) return `the pack list has ${t.packs.length} groups; the program takes 1 to ${MAX_TIERS}`;
  if (t.packs.some((g) => g.maxPrice <= 0n)) return "the pack prices must be above zero";
  if (t.packs.some((g) => !Number.isInteger(g.count) || g.count < 1)) return "every group of packs needs at least one pack";
  const { total, count } = listTotals(t);
  if (count !== t.paidSpots + t.freeSpots) return `the packs add up to ${count} but the break has ${t.paidSpots + t.freeSpots} spots (paid and free): one pack per spot`;
  if (count > MAX_PACKS) return `${count} packs; a break has at most ${MAX_PACKS}`;
  if (t.packs.some((g, i) => i > 0 && g.maxPrice < (t.packs[i - 1] as PackGroup).maxPrice)) return "the packs are not listed cheapest first";
  const average = total / BigInt(count);
  if (t.spotPrice > average) return `the spot price is above the average pack price (${average}): a markup is not supported`;
  if (t.windowSecs < config.minWindowSecs || t.windowSecs > config.maxWindowSecs) {
    return `the window of ${t.windowSecs} s is outside ${config.minWindowSecs}..${config.maxWindowSecs} s that the program allows`;
  }
  return undefined;
}
