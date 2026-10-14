// Free-spot winners and card assignment (CLAUDE.md, "Draw algorithm"), pinned by the Rust vectors.

import { hashv, u16le, utf8 } from "./bytes";
import { DrawError, type Leaf } from "./tree";

const FREE_DOMAIN = utf8("breaks:free:v1");
const ITEMS_DOMAIN = utf8("breaks:items:v1");
const SEED_DOMAIN = utf8("breaks:seed:v1");

/** The draw's seed from ORAO's 64 bytes: `sha256("breaks:seed:v1" || randomness)`. */
export function seedFromRandomness(randomness: Uint8Array): Uint8Array {
  if (randomness.length !== 64) throw new RangeError("ORAO's randomness is 64 bytes");
  return hashv(SEED_DOMAIN, randomness);
}

/** First 16 bytes of a hash as a little-endian number, reduced modulo `modulus` (above zero). */
export function reduce(hash: Uint8Array, modulus: bigint): bigint {
  let n = 0n;
  for (let i = 15; i >= 0; i--) n = (n << 8n) | BigInt(hash[i] as number);
  return n % modulus;
}

/**
 * The position in `[0, totalWeight)` that decides free-spot winner `index`. `taken` holds the `[start, weight]` ranges
 * of the winners drawn before. Uniform over the weight that is still free, then mapped back to the full range by
 * skipping the taken ranges in ascending order of start.
 */
export function freePosition(seed: Uint8Array, index: number, totalWeight: bigint, taken: readonly (readonly [bigint, bigint])[]): bigint {
  const removed = taken.reduce((acc, [, w]) => acc + w, 0n);
  const remaining = totalWeight - removed;
  if (remaining <= 0n) throw new DrawError("NoRemainingWeight");

  let position = reduce(hashv(FREE_DOMAIN, seed, u16le(index)), remaining);
  for (const [start, weight] of [...taken].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    if (position >= start) position += weight;
  }
  return position;
}

export interface DrawnWinner {
  /** Position of the winner's leaf in the sorted leaves. */
  leafIndex: number;
  /** Start of the winner's range in `[0, total weight)`. */
  start: bigint;
  weight: bigint;
  /** The drawn position inside that range. */
  position: bigint;
}

/** The `k` free-spot winners for `seed`, drawn one after the other without replacement. */
export function drawFreeWinners(seed: Uint8Array, leaves: readonly Leaf[], k: number): DrawnWinner[] {
  const total = leaves.reduce((acc, l) => acc + l.weight, 0n);
  const taken: [bigint, bigint][] = [];
  const winners: DrawnWinner[] = [];
  for (let i = 0; i < k; i++) {
    const position = freePosition(seed, i, total, taken);
    let start = 0n;
    let found: DrawnWinner | undefined;
    for (const [leafIndex, leaf] of leaves.entries()) {
      if (position < start + leaf.weight) {
        found = { leafIndex, start, weight: leaf.weight, position };
        break;
      }
      start += leaf.weight;
    }
    if (!found) throw new DrawError("IndexOutOfRange");
    taken.push([found.start, found.weight]);
    winners.push(found);
  }
  return winners;
}

/**
 * Which card goes to which spot: Fisher-Yates from the back with a hash per step. Spot `s` gets the card at index
 * `perm[s]` of the pool sorted by mint.
 */
export function assignment(seed: Uint8Array, n: number): number[] {
  const perm = Array.from({ length: n }, (_, i) => i);
  for (let k = n - 1; k >= 1; k--) {
    const j = Number(reduce(hashv(ITEMS_DOMAIN, seed, u16le(k)), BigInt(k + 1)));
    const tmp = perm[k] as number;
    perm[k] = perm[j] as number;
    perm[j] = tmp;
  }
  return perm;
}
