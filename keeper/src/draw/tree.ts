// Merkle sum tree over the eligible wallets. A TypeScript port of `draw-core/src/lib.rs`; the
// vectors in `draw-core/vectors.json` pin both implementations to the same bytes.

import { compareBytes, concat, equalBytes, hashv, U64_MAX, u64le } from "./bytes.js";

export type DrawErrorCode =
  | "Empty"
  | "NotSortedOrDuplicate"
  | "ZeroWeight"
  | "Overflow"
  | "ProofTooLong"
  | "NoRemainingWeight"
  | "IndexOutOfRange";

export class DrawError extends Error {
  constructor(public readonly code: DrawErrorCode) {
    super(code);
    this.name = "DrawError";
  }
}

export const LEAF_TAG = 0x00;
export const NODE_TAG = 0x01;
export const MAX_PROOF_LEN = 40;

export interface Leaf {
  /** 32 bytes. */
  wallet: Uint8Array;
  weight: bigint;
}

export interface Node {
  hash: Uint8Array;
  sum: bigint;
}

export interface ProofStep {
  sibling: Node;
  siblingIsLeft: boolean;
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
  const hash = hashv(Uint8Array.of(NODE_TAG), left.hash, u64le(left.sum), right.hash, u64le(right.sum));
  return { hash, sum };
}

export class Tree {
  private constructor(private readonly levels: Node[][]) {}

  /**
   * `leaves` must be sorted by wallet (strictly increasing) with weights above zero. An odd node
   * at the end of a level is carried up unchanged (duplicating it would count its weight twice).
   */
  static build(leaves: readonly Leaf[]): Tree {
    if (leaves.length === 0) throw new DrawError("Empty");
    for (let i = 1; i < leaves.length; i++) {
      if (compareBytes((leaves[i - 1] as Leaf).wallet, (leaves[i] as Leaf).wallet) >= 0) {
        throw new DrawError("NotSortedOrDuplicate");
      }
    }
    for (const l of leaves) {
      if (l.weight <= 0n) throw new DrawError("ZeroWeight");
      if (l.weight > U64_MAX) throw new DrawError("Overflow");
    }
    const levels: Node[][] = [leaves.map(leafNode)];
    for (;;) {
      const current = levels[levels.length - 1] as Node[];
      if (current.length <= 1) break;
      const next: Node[] = [];
      for (let i = 0; i < current.length; i += 2) {
        const left = current[i] as Node;
        const right = current[i + 1];
        next.push(right ? parent(left, right) : left);
      }
      levels.push(next);
    }
    return new Tree(levels);
  }

  get root(): Node {
    return (this.levels[this.levels.length - 1] as Node[])[0] as Node;
  }

  get leafCount(): number {
    return (this.levels[0] as Node[]).length;
  }

  /** Proof for the leaf at `index` (its position in the sorted leaves). */
  proof(index: number): ProofStep[] {
    if (!Number.isInteger(index) || index < 0 || index >= this.leafCount) throw new DrawError("IndexOutOfRange");
    let idx = index;
    const steps: ProofStep[] = [];
    for (const level of this.levels.slice(0, -1)) {
      const sibling = idx ^ 1;
      if (sibling < level.length) steps.push({ sibling: level[sibling] as Node, siblingIsLeft: sibling < idx });
      idx = Math.floor(idx / 2);
    }
    return steps;
  }
}

export interface Verified {
  /** The root the leaf and proof lead to; compare it with the committed root. */
  root: Node;
  /** Where the leaf's range starts: the sum of everything to its left. */
  start: bigint;
}

/** Recomputes the root from a leaf and its proof. The leaf then owns `[start, start + weight)`. */
export function verify(leaf: Leaf, proof: readonly ProofStep[]): Verified {
  if (proof.length > MAX_PROOF_LEN) throw new DrawError("ProofTooLong");
  if (leaf.weight <= 0n) throw new DrawError("ZeroWeight");
  let node = leafNode(leaf);
  let start = 0n;
  for (const step of proof) {
    if (step.siblingIsLeft) {
      start = checkedAdd(start, step.sibling.sum);
      node = parent(step.sibling, node);
    } else {
      node = parent(node, step.sibling);
    }
  }
  return { root: node, start };
}

export function sameNode(a: Node, b: Node): boolean {
  return a.sum === b.sum && equalBytes(a.hash, b.hash);
}

export { concat };
