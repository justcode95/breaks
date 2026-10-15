import { packMachineBytes } from "../../src/scheduler/machine.js";
import type { PackGroup } from "../../src/scheduler/policy.js";
import type { PackTier } from "../../src/solana/breaks.js";

/** A list with one tier for every pack: what a break made from the scheduler's single machine and price looks like. */
export function uniformPacks(machine: Uint8Array, maxPrice: bigint, spots: number): { tiers: PackTier[]; packs: number[] } {
  return { tiers: [{ machine, maxPrice }], packs: Array<number>(spots).fill(0) };
}

/** One group of `count` packs from one machine at one price: the break the scheduler made before it took a pack list. */
export function oneMachine(machine: string, maxPrice: bigint, count: number): PackGroup[] {
  return [{ machine: packMachineBytes(machine), maxPrice, count }];
}
