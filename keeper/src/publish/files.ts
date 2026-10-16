// The files a break's public lists are published as. Each file is named by the hash the chain commits to, so whoever
// reads one can check it against the chain and never has to trust the host: a list that does not hash to the name it was
// fetched under is not the list.
//
//   eligibility/<root>.json      root = the Merkle root committed in `commit_eligibility` (64 hex digits)
//   inputs/<inputs hash>.txt     inputs hash = the `inputs_hash` of `commit_eligibility`: the SHA-256 of this very text
//   pool/<pool hash>.json        pool hash = what `commit_pool` committed (64 hex digits)
//   records/<inputs hash>.json   every wallet's average balance, weight and reason, under the same inputs hash as the text it
//                                was computed from (the hash is a pointer here, not this file's own hash: see record.ts)
//   ledger/<pool hash>.json      every pack's price, purchase and card, and every spot's wallet, card and delivery, once all
//                                the cards are delivered (a pointer too: see ledger.ts)
//
// The bytes of a file are fixed by the data alone (compact JSON, a newline at the end, entries in the order the tree
// sorts them), so publishing the same list twice writes the same file. docs/PUBLISHED.md describes the formats.

import { hashv, toHex, utf8 } from "../draw/bytes.js";
import { sortedPool } from "../draw/pool.js";
import type { Leaf } from "../draw/tree.js";
import { addressFromBytes } from "../solana/pubkey.js";
import type { Ledger } from "./ledger.js";
import type { EligibilityRecord } from "./record.js";

export const FORMAT_VERSION = 1;

export interface PublishedFile {
  /** Relative to the publish directory; always `<folder>/<64 hex digits>.<json or txt>`. */
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

/**
 * Why each wallet is in or out of a break: every wallet that held the token, its time-weighted average balance, its weight and
 * its reason, with the minimum and the cap that were applied. Named by the inputs hash of the balance events it was computed
 * from, which the chain committed and which exists also when nobody was eligible.
 */
export function recordFile(r: EligibilityRecord): PublishedFile {
  return {
    path: `records/${r.inputsHash}.json`,
    body:
      JSON.stringify({
        version: FORMAT_VERSION,
        kind: "record",
        inputsHash: r.inputsHash,
        root: r.root,
        totalWeight: r.totalWeight.toString(),
        entryCount: r.entryCount,
        window: { start: r.window.start, end: r.window.end },
        policy: { minTwab: r.policy.minTwab.toString(), ...(r.policy.capPerWallet !== undefined ? { capPerWallet: r.policy.capPerWallet.toString() } : {}) },
        wallets: r.wallets.map((w) => ({ wallet: w.wallet, twab: w.twab.toString(), weight: w.weight.toString(), reason: w.reason })),
      }) + "\n",
  };
}

/**
 * The per-spot ledger of a delivered break: the buyer wallet (which paid for the packs, held the cards and sent them), each pack's price (null when the purchase was found in the wallet's history and
 * its price is not known), purchase transaction, card and proof reference (null when there is none), in the order of the
 * break's pack list; and each spot's wallet, card and delivery transaction (null when the card was found at the wallet without
 * a transfer of ours on record), paid spots in purchase order and then free spots in draw order. Named by the pool hash the
 * chain committed, the one thing a reader has that points to it.
 */
export function ledgerFile(l: Ledger): PublishedFile {
  return {
    path: `ledger/${l.poolHash}.json`,
    body:
      JSON.stringify({
        version: FORMAT_VERSION,
        kind: "ledger",
        poolHash: l.poolHash,
        buyer: l.buyer,
        packs: l.packs.map((p) => ({ index: p.index, price: p.price?.toString() ?? null, purchaseTx: p.purchaseTx, card: p.card, proof: p.proof ?? null })),
        spots: l.spots.map((s) => ({ kind: s.kind, index: s.index, wallet: s.wallet, card: s.card, deliveryTx: s.deliveryTx ?? null })),
      }) + "\n",
  };
}
