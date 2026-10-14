// The rules for starting a break, as pure functions: what the treasury must hold, how far the reserve is from that,
// and whether the break the keeper is configured to make is one the program accepts.

import type { BreaksConfigAccount } from "../solana/breaks.js";

export interface BreakTemplate {
  paidSpots: number;
  freeSpots: number;
  /** Micro-USDC. */
  spotPrice: bigint;
  /** The most one pack may cost, micro-USDC. */
  maxPackPrice: bigint;
  /** 32 bytes, committed for the whole break. */
  packMachine: Uint8Array;
  /** How long the sale (and the TWAB window) lasts. */
  windowSecs: bigint;
}

const U64_MAX = (1n << 64n) - 1n;

/**
 * What the treasury must have unlocked to create the break (programs/breaks `creation_locks`): every paid spot filled
 * (the subsidy bucket tops each up to the pack price) and every free spot drawn (the holder bucket pays a whole pack).
 */
export function worstCase(t: Pick<BreakTemplate, "paidSpots" | "freeSpots" | "spotPrice" | "maxPackPrice">): { subsidy: bigint; holder: bigint } {
  if (t.spotPrice > t.maxPackPrice) throw new RangeError("the spot price is above the maximum pack price");
  const subsidy = BigInt(t.paidSpots) * (t.maxPackPrice - t.spotPrice);
  const holder = BigInt(t.freeSpots) * t.maxPackPrice;
  if (subsidy > U64_MAX || holder > U64_MAX) throw new RangeError("the amounts do not fit in a u64");
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
  t: Pick<BreakTemplate, "paidSpots" | "freeSpots" | "spotPrice" | "maxPackPrice">,
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
  if (t.spotPrice <= 0n || t.maxPackPrice <= 0n) return "the prices must be above zero";
  if (t.spotPrice > t.maxPackPrice) return "the spot price is above the maximum pack price";
  if (t.windowSecs < config.minWindowSecs || t.windowSecs > config.maxWindowSecs) {
    return `the window of ${t.windowSecs} s is outside ${config.minWindowSecs}..${config.maxWindowSecs} s that the program allows`;
  }
  return undefined;
}
