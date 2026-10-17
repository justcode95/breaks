// The per-spot ledger of a delivered break (`ledger/<pool hash>.json`, docs/PUBLISHED.md): for every pack the keeper bought,
// its price, the purchase transaction and the card that came out; for every spot, the wallet, the card and the transaction that
// sent it there. The chain commits no hash of the ledger, so the page checks it against everything that is on chain, with its
// own code: the cards are the committed pool, each spot's wallet is the chain's (the paid spots' owners, the free winners on the
// break), each spot's card is the one the draw gives it from the seed, the buyer wallet is the one the program's config names,
// and no pack cost more than its own cap in the break's pack list. What stays the keeper's word is the transactions: the page
// links each one, to be looked up on chain.
//
// This is the web package's own reading of the format and its own draw, not the keeper's code.

import type { BreakAccount } from "./chain/accounts";
import { decodeConfig } from "./chain/accounts";
import { type Address, addressFromBytes, addressToBytes, configAddress, isAddress } from "./chain/address";
import type { Loaded } from "./chain/load";
import { getAccounts } from "./chain/rpc";
import { U64_MAX, toHex } from "./draw/bytes";
import { assignment } from "./draw/draw";
import { poolHash, sortedPool } from "./draw/pool";
import { type Fetched, fetchFile, safely } from "./published";

export interface LedgerPack {
  /** Its place in the break's pack list, from 0. */
  index: number;
  /** What it cost in micro-USDC; undefined when the purchase was found in the wallet's history and its price is not known. */
  price: bigint | undefined;
  purchaseTx: string;
  card: Address;
  proof: string | undefined;
}

export interface LedgerSpot {
  kind: "paid" | "free";
  /** Purchase order (paid) or draw order (free), from 0. */
  index: number;
  wallet: Address;
  card: Address;
  /** Undefined when the card was found at the wallet without a transfer on record. */
  deliveryTx: string | undefined;
}

export interface Ledger {
  poolHash: string;
  buyer: Address;
  packs: LedgerPack[];
  spots: LedgerSpot[];
}

const MAX_PROBLEMS = 20;
/** A break has at most 64 spots, so at most 64 packs and 64 spots. */
const MAX_ENTRIES = 64;
const HEX64 = /^[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9]\d*)$/;
/** A transaction or a proof reference is shown as text: printable characters without spaces, of a sensible length. */
const REFERENCE = /^[\x21-\x7e]{1,200}$/;

const capped = (problems: string[]) => (problems.length > MAX_PROBLEMS ? [...problems.slice(0, MAX_PROBLEMS), `... and ${problems.length - MAX_PROBLEMS} more`] : problems);

/** Reads a ledger strictly: the format in docs/PUBLISHED.md and nothing else. Up to twenty problems. */
export function parseLedger(text: string): { ok: true; ledger: Ledger } | { ok: false; errors: string[] } {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, errors: ["it is not JSON"] };
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return { ok: false, errors: ["it is not a JSON object"] };
  const d = doc as Record<string, unknown>;
  if (d.version !== 1 || d.kind !== "ledger") return { ok: false, errors: ["it is not a ledger of a version this page reads"] };

  const errors: string[] = [];
  const address = (v: unknown, what: string): Address => {
    if (typeof v === "string" && isAddress(v)) return v;
    errors.push(`${what} is not an address`);
    return "";
  };
  const reference = (v: unknown, what: string, nullable: boolean): string | undefined => {
    if (nullable && v === null) return undefined;
    if (typeof v === "string" && REFERENCE.test(v)) return v;
    errors.push(`${what} is not ${nullable ? "null or " : ""}a transaction or reference of 1 to 200 printable characters`);
    return undefined;
  };
  const list = (v: unknown, what: string): Record<string, unknown>[] => {
    if (!Array.isArray(v)) {
      errors.push(`${what} is not a list`);
      return [];
    }
    if (v.length > MAX_ENTRIES) {
      errors.push(`${what} has ${v.length} entries; a break has at most ${MAX_ENTRIES}`);
      return [];
    }
    return v.map((x, i) => {
      if (typeof x === "object" && x !== null && !Array.isArray(x)) return x as Record<string, unknown>;
      errors.push(`${what.replace(/s$/, "")} ${i + 1} is not an object`);
      return {};
    });
  };

  if (typeof d.poolHash !== "string" || !HEX64.test(d.poolHash)) errors.push("the pool hash is not 64 lowercase hex digits");
  const buyer = address(d.buyer, "the buyer wallet");

  const packs = list(d.packs, "packs").map((p, i): LedgerPack => {
    const n = `pack ${i + 1}`;
    if (p.index !== i) errors.push(`${n} has index ${JSON.stringify(p.index)}, not ${i}: the packs are in the order of the pack list`);
    let price: bigint | undefined;
    if (p.price !== null) {
      if (typeof p.price === "string" && DECIMAL.test(p.price) && BigInt(p.price) <= U64_MAX) price = BigInt(p.price);
      else errors.push(`${n}: the price is not null or a whole number of micro-USDC`);
    }
    return { index: i, price, purchaseTx: reference(p.purchaseTx, `${n}: the purchase transaction`, false) ?? "", card: address(p.card, `${n}: the card`), proof: reference(p.proof, `${n}: the proof`, true) };
  });

  const spots = list(d.spots, "spots").map((s, i): LedgerSpot => {
    const n = `spot ${i + 1}`;
    if (s.kind !== "paid" && s.kind !== "free") errors.push(`${n}: the kind is not "paid" or "free"`);
    if (typeof s.index !== "number" || !Number.isSafeInteger(s.index) || s.index < 0) errors.push(`${n}: the index is not a whole number from 0`);
    return {
      kind: s.kind === "free" ? "free" : "paid",
      index: typeof s.index === "number" ? s.index : -1,
      wallet: address(s.wallet, `${n}: the wallet`),
      card: address(s.card, `${n}: the card`),
      deliveryTx: reference(s.deliveryTx, `${n}: the delivery transaction`, true),
    };
  });

  if (errors.length > 0) return { ok: false, errors: capped(errors) };
  return { ok: true, ledger: { poolHash: d.poolHash as string, buyer, packs, spots } };
}

/** One spot of a checked ledger, with the pack its card came out of. */
export interface LedgerRow {
  spot: LedgerSpot;
  /** The pack whose card the spot got (always found once the ledger is checked). */
  pack: LedgerPack | undefined;
}

export interface LedgerCheck {
  /** Everything that does not agree with the chain or the draw, in words; empty when it all does. */
  problems: string[];
  /** The spots in the ledger's order (paid in purchase order, then free in draw order), each with its pack. */
  rows: LedgerRow[];
  /** What the packs cost, of those whose price is known, and how many prices are not known. */
  cost: { known: bigint; unknown: number };
}

export interface LedgerChain {
  break: BreakAccount;
  /** The paid spots' owners, in purchase order, from their `Spot` accounts. */
  paidOwners: readonly Address[];
  /** The buyer wallet the program's config names. */
  buyer: Address;
}

/** Checks a ledger against the chain and the draw, with the page's own pool hash and Fisher–Yates. */
export function checkLedger(ledger: Ledger, chain: LedgerChain): LedgerCheck {
  const b = chain.break;
  const problems: string[] = [];
  if (b.status !== "Drawn") problems.push(`the break is ${b.status} on chain, not drawn, so no card can have gone to its spot yet`);
  const committed = toHex(b.poolHash);
  if (ledger.poolHash !== committed) problems.push(`it is for pool hash ${ledger.poolHash}, not the ${committed} committed on chain`);
  if (ledger.buyer !== chain.buyer) problems.push(`it names ${ledger.buyer} as the buyer wallet, but the program's config names ${chain.buyer}`);

  // The packs: exactly the pool, each within its own cap.
  if (ledger.packs.length !== b.poolSize) problems.push(`it lists ${ledger.packs.length} ${ledger.packs.length === 1 ? "pack" : "packs"}, but ${b.poolSize} were bought for this break`);
  for (const p of ledger.packs) {
    const tier = b.tiers[b.packs[p.index] ?? -1];
    if (!tier) problems.push(`pack ${p.index + 1} is not in the break's pack list`);
    else if (p.price !== undefined && p.price > tier.maxPrice) problems.push(`pack ${p.index + 1} cost ${p.price} micro-USDC, above its cap of ${tier.maxPrice}`);
  }
  let pool: Uint8Array[] | undefined;
  try {
    const mints = ledger.packs.map((p) => addressToBytes(p.card));
    if (toHex(poolHash(mints)) === committed) pool = sortedPool(mints);
    else problems.push("its cards are not the pool committed on chain");
  } catch {
    problems.push("a card appears in two packs");
  }

  // The spots: the chain's wallets, in the draw's order, each with the card the draw gives it.
  const owners = [...chain.paidOwners.map((wallet) => ({ kind: "paid" as const, wallet })), ...b.freeWinners.map((w) => ({ kind: "free" as const, wallet: w.wallet }))];
  if (ledger.spots.length !== owners.length) {
    problems.push(`it lists ${ledger.spots.length} ${ledger.spots.length === 1 ? "spot" : "spots"}, but the break has ${owners.length}: ${chain.paidOwners.length} paid and ${b.freeWinners.length} free`);
  }
  const perm = pool && pool.length === owners.length ? assignment(b.seed, pool.length) : undefined;
  owners.forEach((o, i) => {
    const s = ledger.spots[i];
    if (!s) return;
    const index = o.kind === "paid" ? i : i - chain.paidOwners.length;
    const name = `${o.kind} spot ${index + 1}`;
    if (s.kind !== o.kind || s.index !== index) problems.push(`spot ${i + 1} should be ${name}, but it says ${s.kind} spot ${s.index + 1}`);
    else if (s.wallet !== o.wallet) problems.push(`${name} names ${s.wallet}, but the chain's is ${o.wallet}`);
    else if (perm && pool) {
      const card = addressFromBytes(pool[perm[i] as number] as Uint8Array);
      if (s.card !== card) problems.push(`${name} got card ${s.card}, but the draw gives it ${card}`);
    }
  });

  const byCard = new Map(ledger.packs.map((p) => [p.card, p]));
  return {
    problems: capped(problems),
    rows: ledger.spots.map((spot) => ({ spot, pack: byCard.get(spot.card) })),
    cost: {
      known: ledger.packs.reduce((acc, p) => acc + (p.price ?? 0n), 0n),
      unknown: ledger.packs.filter((p) => p.price === undefined).length,
    },
  };
}

/** The ledger of a break, read from the published files, or why not. */
export async function fetchLedger(opts: { baseUrl: string; fetch?: typeof fetch; poolHash: string }): Promise<Fetched<Ledger>> {
  const got = await fetchFile({ baseUrl: opts.baseUrl, ...(opts.fetch ? { fetch: opts.fetch } : {}) }, "ledger", opts.poolHash);
  if (!got.ok) return got;
  const parsed = parseLedger(got.value);
  if (!parsed.ok) return { ok: false, kind: "invalid", message: parsed.errors[0] as string };
  if (parsed.ledger.poolHash !== opts.poolHash) return { ok: false, kind: "invalid", message: "the pool hash inside the file is not the one it is named after" };
  return { ok: true, value: parsed.ledger };
}

export type LedgerState =
  /** The break is not drawn yet: there is nothing to read. */
  | { kind: "not-drawn" }
  | { kind: "unavailable"; why: "missing" | "unreachable" | "invalid"; message: string }
  /** Read, and it does not agree with the chain or the draw: not shown. */
  | { kind: "wrong"; problems: string[] }
  | { kind: "checked"; ledger: Ledger; check: LedgerCheck };

export interface LedgerOptions {
  rpcUrl: string;
  breaksProgram: Address;
  baseUrl: string;
  fetch?: typeof fetch;
  loaded: Loaded;
}

/**
 * Reads a drawn break's ledger and the program's config (for the buyer wallet, at `finalized`) and checks the one against the
 * other and the break. Never throws: what goes wrong is said.
 */
export async function loadLedger(opts: LedgerOptions): Promise<LedgerState> {
  const b = opts.loaded.break;
  if (b.status !== "Drawn") return { kind: "not-drawn" };
  const [file, buyer] = await Promise.all([
    safely(() => fetchLedger({ baseUrl: opts.baseUrl, ...(opts.fetch ? { fetch: opts.fetch } : {}), poolHash: toHex(b.poolHash) })),
    readBuyer(opts),
  ]);
  if (!file.ok) return { kind: "unavailable", why: file.kind, message: file.message };
  if (!buyer.ok) return { kind: "unavailable", why: "unreachable", message: buyer.message };
  const check = checkLedger(file.value, { break: b, paidOwners: opts.loaded.paidOwners, buyer: buyer.buyer });
  return check.problems.length > 0 ? { kind: "wrong", problems: check.problems } : { kind: "checked", ledger: file.value, check };
}

async function readBuyer(opts: LedgerOptions): Promise<{ ok: true; buyer: Address } | { ok: false; message: string }> {
  try {
    const [account] = await getAccounts({ url: opts.rpcUrl, addresses: [configAddress(opts.breaksProgram)], ...(opts.fetch ? { fetch: opts.fetch } : {}) });
    if (!account) return { ok: false, message: "the program's config account, which names the buyer wallet, is missing" };
    if (account.owner !== opts.breaksProgram) return { ok: false, message: "the program's config account is not owned by the breaks program" };
    return { ok: true, buyer: decodeConfig(account.data).buyer };
  } catch (err) {
    return { ok: false, message: `the program's config could not be read: ${err instanceof Error ? err.message : String(err)}` };
  }
}
