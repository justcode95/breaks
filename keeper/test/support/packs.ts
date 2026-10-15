import type { PackTier } from "../../src/solana/breaks.js";

/** A list with one tier for every pack: what a break made from the scheduler's single machine and price looks like. */
export function uniformPacks(machine: Uint8Array, maxPrice: bigint, spots: number): { tiers: PackTier[]; packs: number[] } {
  return { tiers: [{ machine, maxPrice }], packs: Array<number>(spots).fill(0) };
}
