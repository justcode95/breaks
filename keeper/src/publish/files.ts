// The files a break's public lists are published as. Each file is named by the hash the chain commits to, so whoever
// reads one can check it against the chain and never has to trust the host: a list that does not hash to the name it was
// fetched under is not the list.
//
//   eligibility/<root>.json      root = the Merkle root committed in `commit_eligibility` (64 hex digits)
//   inputs/<inputs hash>.txt     inputs hash = the `inputs_hash` of `commit_eligibility`: the SHA-256 of this very text
//   pool/<pool hash>.json        pool hash = what `commit_pool` committed (64 hex digits)
//
// The bytes of a file are fixed by the data alone (compact JSON, a newline at the end, entries in the order the tree
// sorts them), so publishing the same list twice writes the same file. docs/PUBLISHED.md describes the formats.

import { hashv, toHex, utf8 } from "../draw/bytes.js";
import { sortedPool } from "../draw/pool.js";
import type { Leaf } from "../draw/tree.js";
import { addressFromBytes } from "../solana/pubkey.js";

export const FORMAT_VERSION = 1;

export interface PublishedFile {
  /** Relative to the publish directory; always `<kind>/<64 hex digits>.json`. */
  path: string;
  body: string;
}

/** The eligible wallets and their weights: the leaves of the tree whose root `root` was committed on chain. */
export function eligibilityFile(root: Uint8Array, totalWeight: bigint, leaves: readonly Leaf[]): PublishedFile {
  const hex = toHex(root);
  return {
    path: `eligibility/${hex}.json`,
    body:
      JSON.stringify({
        version: FORMAT_VERSION,
        kind: "eligibility",
        root: hex,
        totalWeight: totalWeight.toString(),
        entryCount: leaves.length,
        entries: leaves.map((l) => ({ wallet: addressFromBytes(l.wallet), weight: l.weight.toString() })),
      }) + "\n",
  };
}

/**
 * The balance events the weights were computed from, exactly as `serializeInputs` wrote them. The name is the SHA-256 of the
 * text, so a file can never carry a name that is not its hash: whether that hash is the one the chain committed is for the
 * exporter to check.
 */
export function inputsFile(text: string): PublishedFile {
  return { path: `inputs/${toHex(hashv(utf8(text)))}.txt`, body: text };
}

/** The cards that were pulled, sorted by mint: the pool whose hash `hash` was committed on chain. */
export function poolFile(hash: Uint8Array, mints: readonly Uint8Array[]): PublishedFile {
  const hex = toHex(hash);
  return {
    path: `pool/${hex}.json`,
    body: JSON.stringify({ version: FORMAT_VERSION, kind: "pool", poolHash: hex, cards: sortedPool(mints).map(addressFromBytes) }) + "\n",
  };
}
