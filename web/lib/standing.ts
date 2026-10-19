// Where a wallet stands on the free-spot lists of the newest breaks, from the records the keeper publishes
// (`records/<inputs hash>.json`, docs/PUBLISHED.md). A record is used only once it states what the break's account commits
// (`fetchRecord`) and the wallets it puts on the list build that root (`listProblem`), so whether this wallet is on a list, and
// with what weight, is the chain's word. This wallet's own line must then follow from the rules the record states; its average
// balance, and the reason for a wallet that is out, stay the keeper's word (the verify page checks those against the balance
// events). Checking every wallet of every record, as the verify page does for one break, takes seconds for big lists, so only
// what concerns this wallet is checked here.

import type { BreakAccount } from "./chain/accounts";
import { type Address, addressFromBytes, addressToBytes } from "./chain/address";
import type { BreakRow } from "./chain/list";
import { freeSpotChance } from "./chance";
import { toHex } from "./draw/bytes";
import { drawFreeWinners } from "./draw/draw";
import { type Fetched, fetchRecord, safely } from "./published";
import { type EligibilityRecord, type Reason, listProblem, rowProblems } from "./twab/record";
import type { ListedWallet } from "./twab/weights";

/** How many of the newest breaks (not counting cancelled ones) are looked at. */
export const STANDING_BREAKS = 10;

export type Standing =
  | { kind: "listed"; twab: bigint; weight: bigint }
  | { kind: "out"; twab: bigint; reason: Exclude<Reason, { kind: "listed" }> }
  /** Not in the record at all: the wallet held none of the token before the sale ended. */
  | { kind: "absent" };

/** What the draw did, or will do, for a wallet on the list. */
export type FreeSpot =
  /** Recorded on the break as a winner. `position` counts from 1, in the order the winners were drawn. */
  | { kind: "won"; position: number }
  /** The seed is final and the page's own draw gives this wallet free spot `position`; it is not recorded yet. */
  | { kind: "wins"; position: number }
  /** Not a winner: the winners are all recorded (`recorded`), or the seed is final and the draw picks other wallets. */
  | { kind: "not-drawn"; recorded: boolean }
  /** The break has no free spots. */
  | { kind: "none" }
  /** Not drawn yet, but there are no more wallets on the list than free spots, so each gets one. */
  | { kind: "everyone" }
  /**
   * Not drawn yet (it is drawn once the cards are pulled and the randomness has come): the chance this wallet gets one of the
   * `draws` free spots, worked out from the weights on the list.
   */
  | { kind: "chance"; chance: number; draws: number };

export type BreakStanding = { number: number; break: BreakAccount } & (
  /** The sale is on or has just closed: the list is made afterwards. */
  | { kind: "not-yet" }
  | { kind: "standing"; standing: Standing; free?: FreeSpot; minTwab: bigint }
  | { kind: "unavailable"; why: "missing" | "unreachable" | "invalid" | "problem"; message: string }
);

/**
 * What the draw did or will do for `wallet`, which is on the list `listed` (the wallets of the committed tree, in its order, as a
 * checked record gives them). Once the seed is final the page draws the winners itself, and the winners already recorded on the
 * break must be the first of them, for every wallet's answer.
 */
export function freeSpotOf(b: BreakAccount, wallet: Address, listed: readonly ListedWallet[]): { ok: true; free: FreeSpot } | { ok: false; problem: string } {
  if (b.freeSpots === 0) return { ok: true, free: { kind: "none" } };
  const winner = b.freeWinners.findIndex((w) => w.wallet === wallet);
  const everyone = b.eligibilityCount <= b.freeSpots;
  if (b.status === "Settled") {
    const leaves = listed.map((l) => ({ wallet: addressToBytes(l.wallet), weight: l.weight }));
    const draws = Math.min(b.freeSpots, leaves.length);
    const drawn = drawFreeWinners(b.seed, leaves, draws).map((d) => ({ wallet: addressFromBytes((leaves[d.leafIndex] as { wallet: Uint8Array }).wallet), start: d.start, weight: d.weight }));
    for (const [i, r] of b.freeWinners.entries()) {
      const d = drawn[i];
      if (!d || d.wallet !== r.wallet || d.start !== r.start || d.weight !== r.weight) {
        return { ok: false, problem: `the chain recorded free-spot winner #${i + 1} as ${r.wallet}, but this page's draw from the seed and the list gives ${d?.wallet ?? "nobody"}` };
      }
    }
    if (winner >= 0) return { ok: true, free: { kind: "won", position: winner + 1 } };
    if (everyone) return { ok: true, free: { kind: "everyone" } };
    const position = drawn.findIndex((d) => d.wallet === wallet);
    return { ok: true, free: position >= 0 ? { kind: "wins", position: position + 1 } : { kind: "not-drawn", recorded: false } };
  }
  if (winner >= 0) return { ok: true, free: { kind: "won", position: winner + 1 } };
  if (b.status === "Drawn") return { ok: true, free: { kind: "not-drawn", recorded: true } };
  if (everyone) return { ok: true, free: { kind: "everyone" } };
  const index = listed.findIndex((l) => l.wallet === wallet);
  if (index < 0) return { ok: false, problem: "this wallet is not among the wallets of the list" };
  return { ok: true, free: { kind: "chance", chance: freeSpotChance(listed.map((l) => l.weight), index, b.freeSpots), draws: b.freeSpots } };
}

/**
 * Where `wallet` stands in a record that has already been checked against the chain (`fetchRecord`, `listProblem`): its own
 * line must follow from the record's rules, and agree with the winners the chain recorded on `b`.
 */
export function standingOf(record: EligibilityRecord, wallet: Address, b: BreakAccount): { ok: true; standing: Standing; free?: FreeSpot } | { ok: false; problem: string } {
  const row = record.wallets.find((r) => r.wallet === wallet);
  const winner = b.freeWinners.findIndex((w) => w.wallet === wallet);
  if (!row) {
    if (winner >= 0) return { ok: false, problem: "the chain recorded this wallet as a free-spot winner, but the record does not have it" };
    return { ok: true, standing: { kind: "absent" } };
  }
  const [problem] = rowProblems(row, record.policy);
  if (problem !== undefined) return { ok: false, problem };
  if (row.reason.kind !== "listed") {
    if (winner >= 0) return { ok: false, problem: "the chain recorded this wallet as a free-spot winner, but the record does not put it on the list" };
    return { ok: true, standing: { kind: "out", twab: row.twab, reason: row.reason } };
  }
  const won = b.freeWinners[winner];
  if (won && won.weight !== row.weight) return { ok: false, problem: `the chain recorded this wallet as a winner with weight ${won.weight}, but the record gives it ${row.weight}` };
  const listed = record.wallets.filter((r) => r.reason.kind === "listed" && r.weight > 0n).map((r) => ({ wallet: r.wallet, weight: r.weight }));
  const free = freeSpotOf(b, wallet, listed);
  if (!free.ok) return free;
  return { ok: true, standing: { kind: "listed", twab: row.twab, weight: row.weight }, free: free.free };
}

export interface StandingOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  owner: Address;
  /** Newest first, as the break list gives them. */
  rows: readonly BreakRow[];
  /**
   * Records already read and checked, so that reading the page again does not fetch them again. Only records that passed every
   * check are kept: a missing or wrong one is asked for again next time.
   */
  cache?: Map<string, EligibilityRecord>;
}

const isZero = (bytes: Uint8Array) => bytes.every((x) => x === 0);

/** Where `owner` stands on the lists of the newest breaks that are not cancelled. Never throws: what goes wrong is said per break. */
export async function loadStandings(opts: StandingOptions): Promise<BreakStanding[]> {
  const rows = opts.rows.filter((r) => r.break.status !== "Cancelled").slice(0, STANDING_BREAKS);
  // The records are all asked for at once. Checking one takes a moment for a big list (it is hashed into a tree), so the checks
  // run one break at a time with a pause before each, which lets the page draw and take clicks in between.
  const fetched = rows.map(({ break: b }) => (hasRecord(b) ? fetchFor(opts, b) : undefined));
  const out: BreakStanding[] = [];
  for (const [i, { number, break: b }] of rows.entries()) {
    const at = { number, break: b };
    const got = fetched[i];
    if (b.status === "Open" || b.status === "Closed") out.push({ ...at, kind: "not-yet" });
    else if (!got) out.push({ ...at, kind: "unavailable", why: "problem", message: "no balance-event hash was committed for this break, so it has no record" });
    else out.push(await standingFor(opts, at, await got));
  }
  return out;
}

const hasRecord = (b: BreakAccount) => b.status !== "Open" && b.status !== "Closed" && !isZero(b.eligibilityInputsHash);

type Got = Fetched<{ record: EligibilityRecord; key: string; checked: boolean }>;

/** The record of `b` as the host serves it, once it states the chain's commitments (`fetchRecord`), or one kept from before. */
async function fetchFor(opts: StandingOptions, b: BreakAccount): Promise<Got> {
  const expected = {
    inputsHash: toHex(b.eligibilityInputsHash),
    root: toHex(b.eligibilityRoot),
    totalWeight: b.eligibilityTotalWeight,
    entryCount: b.eligibilityCount,
    window: { start: b.opensAt, end: b.closesAt },
  };
  const key = [expected.inputsHash, expected.root, expected.totalWeight, expected.entryCount, expected.window.start, expected.window.end].join(":");
  const hit = opts.cache?.get(key);
  if (hit) return { ok: true, value: { record: hit, key, checked: true } };
  const got = await safely(() => fetchRecord({ baseUrl: opts.baseUrl, ...(opts.fetch ? { fetch: opts.fetch } : {}), expected }));
  return got.ok ? { ok: true, value: { record: got.value.record, key, checked: false } } : got;
}

/** The standing in a fetched record, after checking that its listed wallets build the committed root (once per record). */
async function standingFor(opts: StandingOptions, at: { number: number; break: BreakAccount }, got: Got): Promise<BreakStanding> {
  if (!got.ok) return { ...at, kind: "unavailable", why: got.kind, message: got.message };
  const { record, key } = got.value;
  try {
    if (!got.value.checked) {
      await pause();
      const problem = listProblem(record);
      if (problem !== undefined) return { ...at, kind: "unavailable", why: "invalid", message: problem };
      opts.cache?.set(key, record);
    }
    const s = standingOf(record, opts.owner, at.break);
    if (!s.ok) return { ...at, kind: "unavailable", why: "problem", message: s.problem };
    return { ...at, kind: "standing", standing: s.standing, ...(s.free ? { free: s.free } : {}), minTwab: record.policy.minTwab };
  } catch (err) {
    return { ...at, kind: "unavailable", why: "problem", message: err instanceof Error ? err.message : String(err) };
  }
}

/** Gives the page a turn: a timer, not a microtask, so drawing and input can run. */
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Changes whenever something that decides the standings changes: which breaks, their stage, their list and their winners. */
export function standingsKey(owner: Address, rows: readonly BreakRow[]): string {
  return [owner, ...rows.map((r) => `${r.number}:${r.break.status}:${toHex(r.break.eligibilityInputsHash)}:${r.break.freeWinners.length}`)].join("|");
}

/**
 * The minimum average balance of the newest list whose record was read and checked, with that break's number: what the last
 * list asked of a wallet. The minimum is the keeper's setting, so a later list may ask for another.
 */
export function lastMinimum(standings: readonly BreakStanding[]): { number: number; minTwab: bigint } | undefined {
  const s = standings.find((x) => x.kind === "standing");
  return s?.kind === "standing" ? { number: s.number, minTwab: s.minTwab } : undefined;
}
