// The pool of pulled cards and where each card goes.

import { compareBytes, concat, hashv, utf8 } from "./bytes.js";
import { assignment } from "./draw.js";

/** Cards in the order the draw uses: sorted by mint, so the order they were pulled in cannot matter. */
export function sortedPool(mints: readonly Uint8Array[]): Uint8Array[] {
  const sorted = [...mints].sort(compareBytes);
  for (let i = 1; i < sorted.length; i++) {
    if (compareBytes(sorted[i - 1] as Uint8Array, sorted[i] as Uint8Array) === 0) throw new Error("a card appears twice in the pool");
  }
  for (const m of sorted) if (m.length !== 32) throw new Error("a card mint is 32 bytes");
  return sorted;
}

/** `sha256("breaks:pool:v1" || mint_0 || mint_1 || ...)` over the sorted pool; goes on-chain in `commit_pool`. */
export function poolHash(mints: readonly Uint8Array[]): Uint8Array {
  return hashv(utf8("breaks:pool:v1"), concat(...sortedPool(mints)));
}

export interface SpotOwner {
  kind: "paid" | "free";
  /** Wallet that gets the card. */
  owner: string;
}

export interface SpotAssignment extends SpotOwner {
  /** Position of the spot: paid spots by purchase order, then free spots in draw order. */
  spot: number;
  /** Card mint that goes to this spot. */
  card: Uint8Array;
}

/**
 * Hands the cards out. `paidOwners` are the buyers in purchase order, `freeWinners` the wallets in
 * the order they were drawn. There must be exactly one card per spot.
 */
export function assignCards(
  seed: Uint8Array,
  poolMints: readonly Uint8Array[],
  paidOwners: readonly string[],
  freeWinners: readonly string[],
): SpotAssignment[] {
  const pool = sortedPool(poolMints);
  const spots: SpotOwner[] = [
    ...paidOwners.map((owner) => ({ kind: "paid" as const, owner })),
    ...freeWinners.map((owner) => ({ kind: "free" as const, owner })),
  ];
  if (spots.length !== pool.length) throw new Error(`${spots.length} spots but ${pool.length} cards`);
  const perm = assignment(seed, pool.length);
  return spots.map((s, spot) => ({ ...s, spot, card: pool[perm[spot] as number] as Uint8Array }));
}
