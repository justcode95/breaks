// "Verify this draw": recomputes a break's free-spot winners and card assignment from the published inputs.
//
// Everything here is plain functions over text, so the page is only a form around it and the same code can be tested
// against the Rust vectors. Nothing is fetched and nothing is trusted: the answer depends only on what is pasted in.
// What it can show is whether the winners and the assignment follow from the seed, the eligibility list and the pool;
// whether those inputs are the ones committed on chain is checked by comparing the root, the total weight, the count
// and the pool hash with the values on the break's account (the optional fields).

import { base58 } from "@scure/base";
import { U64_MAX, compareBytes, fromHex, toHex } from "./draw/bytes";
import { assignment, drawFreeWinners, seedFromRandomness } from "./draw/draw";
import { poolHash, sortedPool } from "./draw/pool";
import { DrawError, type Leaf, treeRoot } from "./draw/tree";

/** The most free spots a break can have (the winner list is stored in the break account). */
export const MAX_FREE_SPOTS = 16;
const MAX_ERRORS = 12;

export interface VerifyInput {
  /** 64 hex digits (the draw seed on the break's account) or 128 (ORAO's randomness; the seed is derived from it). */
  seed: string;
  /** One `wallet weight` per line. */
  holders: string;
  /** The break's number of free spots. */
  freeSpots: string;
  /** Wallets of the paid spots, one per line, in purchase order. */
  paidOwners: string;
  /** Mints of the cards in the pool, one per line, in any order. */
  cards: string;
  /** Values from the break's account to compare with; leave a field empty to skip it. */
  expected: { root: string; totalWeight: string; entryCount: string; poolHash: string };
  /**
   * The free-spot winners recorded on the break's account (when it was loaded from the chain). Each is compared with
   * the winner this draw gives at the same place. `complete` says the draw is finished (status `Drawn`), so that no
   * winner may be missing.
   */
  onChain?: { winners: { wallet: string; start: bigint; weight: bigint }[]; complete: boolean };
}

export interface Check {
  label: string;
  expected: string;
  actual: string;
  matches: boolean;
}

export interface Winner {
  /** 1 for the first drawn winner. */
  draw: number;
  wallet: string;
  weight: bigint;
  /** Where the winner's range starts in `[0, total weight)`. */
  start: bigint;
  /** The drawn position inside that range. */
  position: bigint;
}

export interface SpotCard {
  /** 1 for the first paid spot; free spots follow in draw order. */
  spot: number;
  kind: "paid" | "free";
  wallet: string;
  card: string;
}

export interface Verified {
  ok: true;
  seed: { hex: string; derived: boolean };
  eligibility: { root: string; totalWeight: bigint; entries: number };
  winners: Winner[];
  /** Present when cards were given. */
  poolHash?: string;
  /** Present when cards were given (there is one card per spot). */
  assignment?: SpotCard[];
  checks: Check[];
  /** Things worth saying that are not a match or a difference. */
  notes: string[];
}

export type VerifyResult = Verified | { ok: false; errors: string[] };

const ZERO_ROOT = "0".repeat(64);

interface Line {
  n: number;
  text: string;
}

/** Non-empty lines with their 1-based numbers; `#` starts a comment line. */
function linesOf(text: string): Line[] {
  return text
    .split(/\r?\n/)
    .map((t, i) => ({ n: i + 1, text: t.trim() }))
    .filter((l) => l.text !== "" && !l.text.startsWith("#"));
}

function address(s: string): Uint8Array | undefined {
  try {
    const bytes = base58.decode(s);
    return bytes.length === 32 ? bytes : undefined;
  } catch {
    return undefined;
  }
}

function hexOf(s: string, bytes: number): Uint8Array | undefined {
  const clean = s.replace(/\s+/g, "").replace(/^0x/i, "");
  return clean.length === bytes * 2 && /^[0-9a-f]+$/i.test(clean) ? fromHex(clean) : undefined;
}

export function verifyDraw(input: VerifyInput): VerifyResult {
  const errors: string[] = [];
  const fail = (message: string) => {
    errors.push(message);
  };

  // The seed.
  let seed: Uint8Array | undefined;
  let derived = false;
  const seedText = input.seed.replace(/\s+/g, "").replace(/^0x/i, "");
  if (seedText === "") {
    fail("Seed: paste the draw seed (64 hex digits) or ORAO's randomness (128 hex digits).");
  } else if (hexOf(seedText, 32)) {
    seed = hexOf(seedText, 32);
  } else if (hexOf(seedText, 64)) {
    seed = seedFromRandomness(hexOf(seedText, 64) as Uint8Array);
    derived = true;
  } else {
    fail(`Seed: expected 64 hex digits (the seed) or 128 (ORAO's randomness), got ${seedText.length} characters or something that is not hex.`);
  }

  // The number of free spots.
  let freeSpots = 0;
  if (!/^\d+$/.test(input.freeSpots.trim()) || Number(input.freeSpots.trim()) > MAX_FREE_SPOTS) {
    fail(`Free spots: a whole number from 0 to ${MAX_FREE_SPOTS}.`);
  } else {
    freeSpots = Number(input.freeSpots.trim());
  }

  // The eligible holders.
  const leaves: Leaf[] = [];
  const seenAt = new Map<string, number>();
  for (const line of linesOf(input.holders)) {
    const parts = line.text.split(/[\s,;]+/).filter((p) => p !== "");
    if (parts.length !== 2) {
      fail(`Holders, line ${line.n}: expected "wallet weight", got ${parts.length} fields.`);
      continue;
    }
    const [walletText, weightText] = parts as [string, string];
    const wallet = address(walletText);
    if (!wallet) {
      fail(`Holders, line ${line.n}: "${walletText.slice(0, 50)}" is not a Solana address (32 bytes, base58).`);
      continue;
    }
    if (!/^\d+$/.test(weightText) || BigInt(weightText) === 0n || BigInt(weightText) > U64_MAX) {
      fail(`Holders, line ${line.n}: the weight "${weightText.slice(0, 30)}" must be a whole number from 1 to 18446744073709551615.`);
      continue;
    }
    const before = seenAt.get(walletText);
    if (before !== undefined) {
      fail(`Holders, line ${line.n}: ${walletText} is already on line ${before}; a wallet can be listed once.`);
      continue;
    }
    seenAt.set(walletText, line.n);
    leaves.push({ wallet, weight: BigInt(weightText) });
  }
  leaves.sort((a, b) => compareBytes(a.wallet, b.wallet));

  // The paid spots and the pool.
  const paid: { wallet: string }[] = [];
  for (const line of linesOf(input.paidOwners)) {
    if (!address(line.text)) fail(`Paid spots, line ${line.n}: "${line.text.slice(0, 50)}" is not a Solana address.`);
    else paid.push({ wallet: line.text });
  }
  const mints: Uint8Array[] = [];
  const mintTexts: string[] = [];
  const cardLines = linesOf(input.cards);
  for (const line of cardLines) {
    const mint = address(line.text);
    if (!mint) fail(`Cards, line ${line.n}: "${line.text.slice(0, 50)}" is not a Solana address.`);
    else {
      mints.push(mint);
      mintTexts.push(line.text);
    }
  }
  if (new Set(mintTexts).size !== mintTexts.length) fail("Cards: a card appears more than once.");

  // What the program commits to, to compare with.
  const wanted: Check[] = [];
  const e = input.expected;
  const want = {
    root: e.root.trim() === "" ? undefined : hexOf(e.root, 32),
    pool: e.poolHash.trim() === "" ? undefined : hexOf(e.poolHash, 32),
  };
  if (e.root.trim() !== "" && !want.root) fail("Expected root: 64 hex digits.");
  if (e.poolHash.trim() !== "" && !want.pool) fail("Expected pool hash: 64 hex digits.");
  if (e.totalWeight.trim() !== "" && (!/^\d+$/.test(e.totalWeight.trim()) || BigInt(e.totalWeight.trim()) > U64_MAX)) fail("Expected total weight: a whole number.");
  if (e.entryCount.trim() !== "" && !/^\d+$/.test(e.entryCount.trim())) fail("Expected entry count: a whole number.");

  if (errors.length > 0 || !seed) return refuse(errors);

  // The eligibility commitment (an empty list is a zero root, as the keeper commits it).
  let root = ZERO_ROOT;
  let totalWeight = 0n;
  if (leaves.length > 0) {
    try {
      const r = treeRoot(leaves);
      root = toHex(r.hash);
      totalWeight = r.sum;
    } catch (err) {
      return refuse([err instanceof DrawError && err.code === "Overflow" ? "Holders: the weights add up to more than 18446744073709551615." : `Holders: ${String(err)}`]);
    }
  }

  const winners = drawFreeWinners(seed, leaves, Math.min(freeSpots, leaves.length)).map((w, i): Winner => ({
    draw: i + 1,
    wallet: base58.encode((leaves[w.leafIndex] as Leaf).wallet),
    weight: w.weight,
    start: w.start,
    position: w.position,
  }));

  let pool: string | undefined;
  let assigned: SpotCard[] | undefined;
  if (mints.length > 0) {
    pool = toHex(poolHash(mints));
    // One card per spot: the paid spots, then the free winners.
    const spots = paid.length + winners.length;
    if (spots !== mints.length) {
      return refuse([`Pool: ${paid.length} paid spots + ${winners.length} free winners make ${spots} spots, but ${mints.length} cards were given. There is one card per spot.`]);
    }
    const sorted = sortedPool(mints);
    const perm = assignment(seed, sorted.length);
    const owners = [...paid.map((p) => ({ kind: "paid" as const, wallet: p.wallet })), ...winners.map((w) => ({ kind: "free" as const, wallet: w.wallet }))];
    assigned = owners.map((o, i) => ({ spot: i + 1, kind: o.kind, wallet: o.wallet, card: base58.encode(sorted[perm[i] as number] as Uint8Array) }));
  }

  // Both sides are canonical here: hashes are re-encoded as lowercase hex and numbers as plain decimal.
  const same = (label: string, expected: string, actual: string) => wanted.push({ label, expected, actual, matches: expected === actual });
  if (want.root) same("Eligibility root", toHex(want.root), root);
  if (e.totalWeight.trim() !== "") same("Total weight", BigInt(e.totalWeight.trim()).toString(), totalWeight.toString());
  if (e.entryCount.trim() !== "") same("Eligible wallets", BigInt(e.entryCount.trim()).toString(), String(leaves.length));
  if (want.pool) {
    if (pool) same("Pool hash", toHex(want.pool), pool);
    else wanted.push({ label: "Pool hash", expected: toHex(want.pool), actual: "no cards given", matches: false });
  }

  const notes: string[] = [];
  // Asking before the list is pasted is the usual way to see "differs" for the root: say why.
  if (leaves.length === 0 && wanted.some((c) => ["Eligibility root", "Total weight", "Eligible wallets"].includes(c.label) && !c.matches)) {
    notes.push("The eligibility list is empty, so these inputs commit to the zero root: paste the published list to compare it.");
  }
  const recorded = input.onChain?.winners ?? [];
  for (const [i, r] of recorded.entries()) {
    const label = `Winner ${i + 1} recorded on chain`;
    const w = winners[i];
    if (w) same(label, `${r.wallet} · range starts at ${r.start} · weight ${r.weight}`, `${w.wallet} · range starts at ${w.start} · weight ${w.weight}`);
    else wanted.push({ label, expected: `${r.wallet} · range starts at ${r.start} · weight ${r.weight}`, actual: "no such winner in this draw", matches: false });
  }
  if (input.onChain) {
    if (input.onChain.complete) same("Winners recorded on chain", String(recorded.length), String(winners.length));
    else if (recorded.length < winners.length) notes.push(`Only ${recorded.length} of ${winners.length} winners are recorded on the break so far; the rest are claimed one at a time.`);
  }

  return {
    ok: true,
    seed: { hex: toHex(seed), derived },
    eligibility: { root, totalWeight, entries: leaves.length },
    winners,
    ...(pool ? { poolHash: pool } : {}),
    ...(assigned ? { assignment: assigned } : {}),
    checks: wanted,
    notes,
  };
}

function refuse(errors: string[]): VerifyResult {
  const shown = errors.slice(0, MAX_ERRORS);
  if (errors.length > shown.length) shown.push(`... and ${errors.length - shown.length} more.`);
  return { ok: false, errors: shown };
}
