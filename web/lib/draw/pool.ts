// The pool of pulled cards, as the program commits to it.

import { compareBytes, concat, hashv, utf8 } from "./bytes";

/** Cards in the order the draw uses: sorted by mint, so the order they were pulled in cannot matter. */
export function sortedPool(mints: readonly Uint8Array[]): Uint8Array[] {
  const sorted = [...mints].sort(compareBytes);
  for (let i = 1; i < sorted.length; i++) {
    if (compareBytes(sorted[i - 1] as Uint8Array, sorted[i] as Uint8Array) === 0) throw new Error("a card appears twice in the pool");
  }
  for (const m of sorted) if (m.length !== 32) throw new Error("a card mint is 32 bytes");
  return sorted;
}

/** `sha256("breaks:pool:v1" || mint_0 || mint_1 || ...)` over the sorted pool; what `commit_pool` stores on chain. */
export function poolHash(mints: readonly Uint8Array[]): Uint8Array {
  return hashv(utf8("breaks:pool:v1"), concat(...sortedPool(mints)));
}
