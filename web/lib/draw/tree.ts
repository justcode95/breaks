// Merkle sum tree over the eligible wallets (CLAUDE.md, "Draw algorithm"). A separate TypeScript implementation of
// `draw-core/src/lib.rs`: the vectors in `draw-core/vectors.json` pin it to the same bytes as the Rust crate that the
// program runs and as the keeper's port.

import { compareBytes, equalBytes, hashv, U64_MAX, u64le } from "./bytes";

export type DrawErrorCode = "Empty" | "NotSortedOrDuplicate" | "ZeroWeight" | "Overflow" | "NoRemainingWeight" | "IndexOutOfRange";

export class DrawError extends Error {
  constructor(public readonly code: DrawErrorCode) {
    super(code);
    this.name = "DrawError";
  }
}

export const LEAF_TAG = 0x00;
export const NODE_TAG = 0x01;

export interface Leaf {
  /** 32 bytes. */
  wallet: Uint8Array;
  weight: bigint;
}

export interface Node {
  hash: Uint8Array;
  sum: bigint;
}

function checkedAdd(a: bigint, b: bigint): bigint {
  const sum = a + b;
  if (sum > U64_MAX) throw new DrawError("Overflow");
  return sum;
}

/** `H(0x00 || wallet || weight_le)`; the sum of a leaf is its weight. */
export function leafNode(leaf: Leaf): Node {
  return { hash: hashv(Uint8Array.of(LEAF_TAG), leaf.wallet, u64le(leaf.weight)), sum: leaf.weight };
}

/** `H(0x01 || left.hash || left.sum_le || right.hash || right.sum_le)`, sum = left + right. */
export function parent(left: Node, right: Node): Node {
  const sum = checkedAdd(left.sum, right.sum);
  return { hash: hashv(Uint8Array.of(NODE_TAG), left.hash, u64le(left.sum), right.hash, u64le(right.sum)), sum };
}

/**
 * The root of the tree over `leaves`, which must be sorted by wallet (strictly increasing) with weights above zero.
 * An odd node at the end of a level is carried up unchanged (duplicating it would count its weight twice).
 */
export function treeRoot(leaves: readonly Leaf[]): Node {
  if (leaves.length === 0) throw new DrawError("Empty");
  for (let i = 1; i < leaves.length; i++) {
    if (compareBytes((leaves[i - 1] as Leaf).wallet, (leaves[i] as Leaf).wallet) >= 0) throw new DrawError("NotSortedOrDuplicate");
  }
  for (const l of leaves) {
    if (l.weight <= 0n) throw new DrawError("ZeroWeight");
    if (l.weight > U64_MAX) throw new DrawError("Overflow");
  }
  let level: Node[] = leaves.map(leafNode);
  while (level.length > 1) {
    const next: Node[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i] as Node;
      const right = level[i + 1];
      next.push(right ? parent(left, right) : left);
    }
    level = next;
  }
  return level[0] as Node;
}

export function sameNode(a: Node, b: Node): boolean {
  return a.sum === b.sum && equalBytes(a.hash, b.hash);
}
