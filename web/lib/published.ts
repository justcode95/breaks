// Reads the lists the keeper publishes (docs/PUBLISHED.md) and checks each one against what the chain committed. A file is
// named by the root or the pool hash, so what comes back is only used when it hashes to that name: the host that served it
// is never trusted, and a wrong or altered file is refused and reported, not used.
//
// The hashing here is the web package's own (lib/draw, lib/twab), the same code the verify page uses, not the keeper's.

import { addressToBytes } from "./chain/address";
import type { BreakAccount } from "./chain/accounts";
import type { VerifyInput } from "./verify";
import { U64_MAX, toHex } from "./draw/bytes";
import { poolHash } from "./draw/pool";
import { DrawError, type Leaf, treeRoot } from "./draw/tree";
import { inputsHash } from "./twab/inputs";

/** The most a list may be: a list of tens of thousands of wallets is a few megabytes. */
export const MAX_BYTES = 25_000_000;
const TIMEOUT_MS = 30_000;

export type Fetched<T> = { ok: true; value: T } | { ok: false; kind: "missing" | "unreachable" | "invalid"; message: string };

interface Options {
  baseUrl: string;
  fetch?: typeof fetch;
  maxBytes?: number;
}

const HEX64 = /^[0-9a-f]{64}$/;

type Folder = "eligibility" | "pool" | "inputs";

/** The balance events are text, the two lists JSON. */
const EXTENSION: Record<Folder, string> = { eligibility: "json", pool: "json", inputs: "txt" };

/** The text of `<base>/<folder>/<hash>.<json or txt>`, or why there is none. Only the hash is in the request. */
async function fetchFile(opts: Options, folder: Folder, hash: string): Promise<Fetched<string>> {
  // The name comes from the chain, as hex; refuse anything else rather than build an address from it.
  if (!HEX64.test(hash)) throw new RangeError("a published file is named by 64 lowercase hex digits");
  const url = `${opts.baseUrl}/${folder}/${hash}.${EXTENSION[folder]}`;
  const max = opts.maxBytes ?? MAX_BYTES;
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(url, { credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    return { ok: false, kind: "unreachable", message: `could not reach the host: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (res.status === 404) return { ok: false, kind: "missing", message: "there is no such file" };
  if (!res.ok) return { ok: false, kind: "unreachable", message: `the host answered ${res.status}` };
  const length = Number(res.headers.get("content-length"));
  if (Number.isFinite(length) && length > max) return { ok: false, kind: "invalid", message: `the file is larger than ${max} bytes` };
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    return { ok: false, kind: "unreachable", message: `the file could not be read: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (text.length > max) return { ok: false, kind: "invalid", message: `the file is larger than ${max} bytes` };
  return { ok: true, value: text };
}

const invalid = (message: string): Fetched<never> => ({ ok: false, kind: "invalid", message });

function parse(text: string): Record<string, unknown> | string {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : "it is not a JSON object";
  } catch {
    return "it is not JSON";
  }
}

export interface EligibilityList {
  /** `wallet weight` per line, what the verify page takes. */
  holders: string;
  entryCount: number;
  totalWeight: bigint;
}

export interface EligibilityExpected {
  /** The root committed on chain: 64 lowercase hex digits. */
  root: string;
  /** What the break's account says; the file must add up to the same. */
  totalWeight: bigint;
  entryCount: number;
}

/** The eligible wallets of a break, if the file for its root exists and hashes to that root. */
export async function fetchEligibility(opts: Options & { expected: EligibilityExpected }): Promise<Fetched<EligibilityList>> {
  const { expected } = opts;
  const got = await fetchFile(opts, "eligibility", expected.root);
  if (!got.ok) return got;
  const doc = parse(got.value);
  if (typeof doc === "string") return invalid(doc);
  if (doc.version !== 1 || doc.kind !== "eligibility") return invalid("it is not an eligibility list of a version this page reads");
  if (doc.root !== expected.root) return invalid("the root inside the file is not the root it is named after");
  if (!Array.isArray(doc.entries)) return invalid("it has no list of entries");

  const leaves: Leaf[] = [];
  const seen = new Set<string>();
  for (const [i, e] of doc.entries.entries()) {
    const entry = e as { wallet?: unknown; weight?: unknown } | null;
    if (typeof entry?.wallet !== "string" || typeof entry.weight !== "string") return invalid(`entry ${i + 1} is not a wallet and a weight`);
    let wallet: Uint8Array;
    try {
      wallet = addressToBytes(entry.wallet);
    } catch {
      return invalid(`entry ${i + 1} has a wallet that is not a Solana address`);
    }
    if (!/^\d+$/.test(entry.weight) || BigInt(entry.weight) === 0n || BigInt(entry.weight) > U64_MAX) return invalid(`entry ${i + 1} has a weight that is not a whole number from 1 to 18446744073709551615`);
    if (seen.has(entry.wallet)) return invalid(`entry ${i + 1}: ${entry.wallet} is listed twice`);
    seen.add(entry.wallet);
    leaves.push({ wallet, weight: BigInt(entry.weight) });
  }
  if (leaves.length === 0) return invalid("the list is empty, but a list was committed");

  let root: ReturnType<typeof treeRoot>;
  try {
    root = treeRoot(leaves);
  } catch (err) {
    // The tree is built from wallets in the order the keeper writes them; one that is not has not been written by it.
    if (err instanceof DrawError && err.code === "NotSortedOrDuplicate") return invalid("the wallets in it are not in the order the tree uses");
    if (err instanceof DrawError && err.code === "Overflow") return invalid("the weights in it add up to more than a 64-bit number");
    return invalid("it is not a list the tree can be built from");
  }
  if (toHex(root.hash) !== expected.root) return invalid(`the wallets in it hash to ${toHex(root.hash)}, not to the root that was committed`);
  if (root.sum !== expected.totalWeight) return invalid(`the weights in it add up to ${root.sum}, not to the ${expected.totalWeight} that was committed`);
  if (leaves.length !== expected.entryCount) return invalid(`it has ${leaves.length} wallets, not the ${expected.entryCount} that were committed`);
  if (doc.totalWeight !== root.sum.toString() || doc.entryCount !== leaves.length) return invalid("its own totals do not match its entries");

  const entries = doc.entries as { wallet: string; weight: string }[];
  return { ok: true, value: { holders: entries.map((e) => `${e.wallet} ${e.weight}`).join("\n"), entryCount: leaves.length, totalWeight: root.sum } };
}

export interface CardPool {
  /** One mint per line, what the verify page takes. */
  cards: string;
  count: number;
}

export interface PoolExpected {
  /** The pool hash committed on chain: 64 lowercase hex digits. */
  poolHash: string;
  /** What the break's account says. */
  poolSize: number;
}

/** The cards of a break, if the file for its pool hash exists and hashes to it. */
export async function fetchPool(opts: Options & { expected: PoolExpected }): Promise<Fetched<CardPool>> {
  const { expected } = opts;
  const got = await fetchFile(opts, "pool", expected.poolHash);
  if (!got.ok) return got;
  const doc = parse(got.value);
  if (typeof doc === "string") return invalid(doc);
  if (doc.version !== 1 || doc.kind !== "pool") return invalid("it is not a card pool of a version this page reads");
  if (doc.poolHash !== expected.poolHash) return invalid("the pool hash inside the file is not the one it is named after");
  if (!Array.isArray(doc.cards)) return invalid("it has no list of cards");

  const mints: Uint8Array[] = [];
  for (const [i, c] of doc.cards.entries()) {
    if (typeof c !== "string") return invalid(`card ${i + 1} is not a mint`);
    try {
      mints.push(addressToBytes(c));
    } catch {
      return invalid(`card ${i + 1} is not a Solana address`);
    }
  }
  let hash: string;
  try {
    hash = toHex(poolHash(mints));
  } catch (err) {
    return invalid(err instanceof Error ? err.message : String(err));
  }
  if (hash !== expected.poolHash) return invalid(`the cards in it hash to ${hash}, not to the pool hash that was committed`);
  if (mints.length !== expected.poolSize) return invalid(`it has ${mints.length} cards, not the ${expected.poolSize} that were committed`);
  return { ok: true, value: { cards: (doc.cards as string[]).join("\n"), count: mints.length } };
}

export interface InputsExpected {
  /** The `inputs_hash` committed on chain with the eligibility list: 64 lowercase hex digits. */
  inputsHash: string;
}

/** The balance events a break's weights were computed from, if the file for the committed hash exists and hashes to it. */
export async function fetchInputs(opts: Options & { expected: InputsExpected }): Promise<Fetched<{ text: string }>> {
  const got = await fetchFile(opts, "inputs", opts.expected.inputsHash);
  if (!got.ok) return got;
  // The record is the text itself: it is what the chain's hash was made from, so a text that hashes to it is the record.
  const hash = inputsHash(got.value);
  if (hash !== opts.expected.inputsHash) return invalid(`the text in it hashes to ${hash}, not to the inputs hash that was committed`);
  return { ok: true, value: { text: got.value } };
}

export interface PublishedLists {
  /** Set when the eligibility list was read and checked. */
  holders?: string;
  /** Set when the cards were read and checked. */
  cards?: string;
  /** Set when the balance events were read and they hash to the inputs hash on chain. */
  inputs?: string;
  /** What happened, in words, for the person to read. */
  notes: string[];
  /** What the person still has to paste, because it was needed and could not be read. */
  stillToPaste: string[];
}

const isZero = (bytes: Uint8Array) => bytes.every((b) => b === 0);

/**
 * What the verify page needs that is not on chain: the list once one is committed, the balance events its weights come from
 * (committed with it, also when the list is empty), the cards once the seed is final.
 */
export function whatIsNeeded(b: BreakAccount): { list: boolean; inputs: boolean; cards: boolean } {
  return {
    list: b.eligibilityCount > 0 && !isZero(b.eligibilityRoot),
    inputs: !isZero(b.eligibilityInputsHash),
    cards: (b.status === "Settled" || b.status === "Drawn") && !isZero(b.poolHash),
  };
}

/**
 * Reads what the verify page needs for `b` from the published files: the eligibility list once a list is committed, the
 * cards once the seed is final. A file that is missing, cannot be reached or does not hash to the chain's value is said in
 * words and not used; the person pastes it instead.
 */
export async function loadPublishedLists(opts: { baseUrl?: string; fetch?: typeof fetch; maxBytes?: number; break: BreakAccount }): Promise<PublishedLists> {
  const b = opts.break;
  const out: PublishedLists = { notes: [], stillToPaste: [] };
  const needed = whatIsNeeded(b);

  // Without a place to read from, the person pastes whatever is needed.
  if (opts.baseUrl === undefined) {
    if (needed.list) out.stillToPaste.push("the eligibility list");
    if (needed.inputs) out.stillToPaste.push(INPUTS_TO_PASTE);
    if (needed.cards) out.stillToPaste.push("the cards");
    return out;
  }
  const options: Options = { baseUrl: opts.baseUrl, ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}) };
  const host = new URL(opts.baseUrl).host;

  if (needed.list) {
    const r = await safely(() => fetchEligibility({ ...options, expected: { root: toHex(b.eligibilityRoot), totalWeight: b.eligibilityTotalWeight, entryCount: b.eligibilityCount } }));
    if (r.ok) {
      out.holders = r.value.holders;
      out.notes.push(`The eligibility list was read from ${host}: ${r.value.entryCount} ${r.value.entryCount === 1 ? "wallet" : "wallets"}, and it hashes to the root committed on chain.`);
    } else {
      out.stillToPaste.push("the eligibility list");
      out.notes.push(failure("eligibility list", host, r));
    }
  }

  if (needed.inputs) {
    const r = await safely(() => fetchInputs({ ...options, expected: { inputsHash: toHex(b.eligibilityInputsHash) } }));
    if (r.ok) {
      out.inputs = r.value.text;
      const events = Math.max(0, r.value.text.split("\n").length - 2);
      out.notes.push(`The balance events were read from ${host}: ${events} ${events === 1 ? "event" : "events"}, and they hash to the inputs hash committed on chain.`);
    } else {
      out.stillToPaste.push(INPUTS_TO_PASTE);
      out.notes.push(failure("balance events", host, r));
    }
  }

  if (needed.cards) {
    const r = await safely(() => fetchPool({ ...options, expected: { poolHash: toHex(b.poolHash), poolSize: b.poolSize } }));
    if (r.ok) {
      out.cards = r.value.cards;
      out.notes.push(`The cards were read from ${host}: ${r.value.count} ${r.value.count === 1 ? "card" : "cards"}, and they hash to the pool hash committed on chain.`);
    } else {
      out.stillToPaste.push("the cards");
      out.notes.push(failure("cards", host, r));
    }
  }
  return out;
}

/** Whatever goes wrong while reading a published file is a note for the person, never a failure to load the break. */
async function safely<T>(read: () => Promise<Fetched<T>>): Promise<Fetched<T>> {
  try {
    return await read();
  } catch (err) {
    return { ok: false, kind: "invalid", message: err instanceof Error ? err.message : String(err) };
  }
}

/** The balance events are optional for the draw itself: they only let the weights be checked. */
const INPUTS_TO_PASTE = "the balance events (to check the weights)";

function failure(what: string, host: string, r: Extract<Fetched<unknown>, { ok: false }>): string {
  const plural = what === "cards" || what === "balance events";
  switch (r.kind) {
    case "missing":
      return `The ${what} ${plural ? "are" : "is"} not published at ${host} (there is no file for this break's commitment), so paste ${plural ? "them" : "it"}.`;
    case "unreachable":
      return `The ${what} could not be read from ${host} (${r.message}), so paste ${plural ? "them" : "it"}.`;
    case "invalid":
      return `The file for the ${what} at ${host} is not what the chain committed to (${r.message}), so it was not used. Paste the ${what} instead.`;
  }
}

/** The address of a published file, for a link: only for a name that is 64 lowercase hex digits. */
export function publishedFileUrl(baseUrl: string, folder: Folder, hash: string): string | undefined {
  return HEX64.test(hash) ? `${baseUrl}/${folder}/${hash}.${EXTENSION[folder]}` : undefined;
}

/** Which fields of the verify form hold text that was read from the published files (and not typed or pasted). */
export interface Provenance {
  holders: boolean;
  inputs: boolean;
  cards: boolean;
}

export const NOT_PUBLISHED: Provenance = { holders: false, inputs: false, cards: false };

/**
 * The form after a break was loaded. What the chain gave replaces the chain-backed fields. The list and the cards
 * come from the published files when they were read; otherwise what a person pasted stays, but text that an earlier
 * load read from the published files belongs to another break and is cleared, so it cannot be mistaken for this one's.
 */
export function applyLoad(
  prev: VerifyInput,
  provenance: Provenance,
  loaded: { patch: Partial<VerifyInput>; onChain: NonNullable<VerifyInput["onChain"]> },
  published: Pick<PublishedLists, "holders" | "inputs" | "cards"> | undefined,
): { input: VerifyInput; provenance: Provenance } {
  const input: VerifyInput = { ...prev, ...loaded.patch, onChain: loaded.onChain };
  if (published?.holders !== undefined) input.holders = published.holders;
  else if (provenance.holders) input.holders = "";
  if (published?.inputs !== undefined) input.inputs = published.inputs;
  else if (provenance.inputs) input.inputs = "";
  if (published?.cards !== undefined) input.cards = published.cards;
  else if (provenance.cards) input.cards = "";
  return { input, provenance: { holders: published?.holders !== undefined, inputs: published?.inputs !== undefined, cards: published?.cards !== undefined } };
}
