// The keeper's record of why each wallet is in or out of a break (`records/<inputs hash>.json`, docs/PUBLISHED.md): every
// wallet that held the token, its time-weighted average balance, its weight and its reason, with the minimum and the cap that
// were applied. The chain commits to no hash of the record itself, so the page checks it against everything that can be
// checked: the rules it states, the commitments on the break's account, the balance events (the averages are worked out
// again here) and the eligibility list. What is left as the keeper's word is the rules themselves and why an excluded wallet
// is excluded; the page shows both.
//
// This is the web package's own reading of the format, not the keeper's code: a verifier that shares code with what it
// checks is not independent.

import { addressToBytes, isOnCurve } from "../chain/address";
import { U64_MAX, compareBytes, toHex } from "../draw/bytes";
import { type Leaf, treeRoot } from "../draw/tree";
import type { ListedWallet } from "./weights";

export type Reason = { kind: "listed" } | { kind: "below-min" } | { kind: "off-curve" } | { kind: "excluded"; code: string };

export interface RecordRow {
  wallet: string;
  twab: bigint;
  weight: bigint;
  reason: Reason;
}

export interface EligibilityRecord {
  inputsHash: string;
  root: string;
  totalWeight: bigint;
  entryCount: number;
  window: { start: number; end: number };
  /** The minimum average balance to be on the list, and the most weight one wallet can have (none when there is no cap). */
  policy: { minTwab: bigint; cap?: bigint };
  /** Sorted by the wallets' 32 bytes. */
  wallets: RecordRow[];
}

const MAX_PROBLEMS = 20;
const HEX64 = /^[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9]\d*)$/;
/** An exclusion code is shown to people: a short name of letters, digits and a few signs, never anything a page could act on. */
export const CODE = /^[A-Za-z0-9_.-]{1,64}$/;

const ZERO_ROOT = "0".repeat(64);

/** Reads a record strictly: the format in docs/PUBLISHED.md and nothing else. Up to twenty problems, by wallet. */
export function parseRecord(text: string): { ok: true; record: EligibilityRecord } | { ok: false; errors: string[] } {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, errors: ["it is not JSON"] };
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return { ok: false, errors: ["it is not a JSON object"] };
  const d = doc as Record<string, unknown>;
  if (d.version !== 1 || d.kind !== "record") return { ok: false, errors: ["it is not a record of a version this page reads"] };

  const errors: string[] = [];
  const amount = (v: unknown, what: string): bigint | undefined => {
    if (typeof v === "string" && DECIMAL.test(v) && BigInt(v) <= U64_MAX) return BigInt(v);
    errors.push(`${what} is not a whole number from 0 to 18446744073709551615`);
    return undefined;
  };
  const hex = (v: unknown, what: string): string | undefined => {
    if (typeof v === "string" && HEX64.test(v)) return v;
    errors.push(`${what} is not 64 lowercase hex digits`);
    return undefined;
  };

  const inputsHash = hex(d.inputsHash, "the inputs hash");
  const root = hex(d.root, "the root");
  const totalWeight = amount(d.totalWeight, "the total weight");
  if (!Number.isSafeInteger(d.entryCount) || (d.entryCount as number) < 0) errors.push("the number of wallets is not a whole number");
  const w = d.window as Record<string, unknown> | null;
  const windowOk = typeof w === "object" && w !== null && Number.isSafeInteger(w.start) && Number.isSafeInteger(w.end) && (w.end as number) > (w.start as number);
  if (!windowOk) errors.push("the window is not two times in Unix seconds, the end after the start");
  const p = d.policy as Record<string, unknown> | null;
  let minTwab: bigint | undefined;
  let cap: bigint | undefined;
  if (typeof p !== "object" || p === null || Array.isArray(p)) errors.push("it states no rules (policy)");
  else {
    minTwab = amount(p.minTwab, "the minimum");
    if (p.capPerWallet !== undefined) cap = amount(p.capPerWallet, "the cap");
  }

  const wallets: RecordRow[] = [];
  if (!Array.isArray(d.wallets)) errors.push("it has no list of wallets");
  else {
    let previous: Uint8Array | undefined;
    for (const [i, raw] of d.wallets.entries()) {
      const at = `wallet ${i + 1}`;
      const r = raw as Record<string, unknown> | null;
      if (typeof r !== "object" || r === null || typeof r.wallet !== "string") {
        errors.push(`${at} is not a wallet with an average balance, a weight and a reason`);
        continue;
      }
      let bytes: Uint8Array;
      try {
        bytes = addressToBytes(r.wallet);
      } catch {
        errors.push(`${at} is not a Solana address`);
        continue;
      }
      if (previous && compareBytes(previous, bytes) >= 0) errors.push(`${at} (${r.wallet}) is out of order or listed twice: the wallets are sorted by their bytes`);
      previous = bytes;
      const twab = amount(r.twab, `the average balance of ${at}`);
      const weight = amount(r.weight, `the weight of ${at}`);
      const reason = reasonOf(r.reason);
      if (!reason) errors.push(`the reason of ${at} is not one this page knows (null, below_min_twab, off_curve or excluded:<code>)`);
      if (twab !== undefined && weight !== undefined && reason) wallets.push({ wallet: r.wallet, twab, weight, reason });
    }
  }

  if (errors.length > 0) return { ok: false, errors: errors.length > MAX_PROBLEMS ? [...errors.slice(0, MAX_PROBLEMS), `... and ${errors.length - MAX_PROBLEMS} more`] : errors };
  return {
    ok: true,
    record: {
      inputsHash: inputsHash as string,
      root: root as string,
      totalWeight: totalWeight as bigint,
      entryCount: d.entryCount as number,
      window: { start: (w as { start: number }).start, end: (w as { end: number }).end },
      policy: { minTwab: minTwab as bigint, ...(cap !== undefined ? { cap } : {}) },
      wallets,
    },
  };
}

function reasonOf(v: unknown): Reason | undefined {
  if (v === null) return { kind: "listed" };
  if (v === "below_min_twab") return { kind: "below-min" };
  if (v === "off_curve") return { kind: "off-curve" };
  if (typeof v === "string" && v.startsWith("excluded:") && CODE.test(v.slice("excluded:".length))) return { kind: "excluded", code: v.slice("excluded:".length) };
  return undefined;
}

/** The weight the rules give a wallet that is on the list: its average balance, or the cap when it is above it. */
export const ruleWeight = (twab: bigint, policy: EligibilityRecord["policy"]): bigint => (policy.cap !== undefined && twab > policy.cap ? policy.cap : twab);

export interface RecordCheck {
  /** Everything in the record that does not add up, in words; empty when it all does. At most twenty, then a count. */
  problems: string[];
  counts: { listed: number; belowMin: number; offCurve: number; excluded: number };
  /** The wallets that are out, biggest average balance first. */
  out: RecordRow[];
  /** Which checks could be made (the balance events and the list are optional). */
  checked: { twabs: boolean; list: boolean; chain: boolean };
}

export interface RecordContext {
  /** Every owner's average balance, worked out from the balance events, when they were given and could be read. */
  twabs?: ReadonlyMap<string, bigint>;
  /** The eligibility list, when it was given. */
  listed?: readonly ListedWallet[];
  /** What the break's account says, for the parts of it that were given. */
  chain?: { inputsHash?: string; root?: string; totalWeight?: bigint; entryCount?: number; window?: { start: bigint; end: bigint } };
}

const COUNT = { listed: "listed", "below-min": "belowMin", "off-curve": "offCurve", excluded: "excluded" } as const;

/**
 * What is wrong with one wallet's line, against the rules the record states, in the keeper's order: an exclusion first, then a
 * program's account, then the minimum. Empty when the line follows from the rules.
 */
export function rowProblems(r: RecordRow, policy: EligibilityRecord["policy"]): string[] {
  const problems: string[] = [];
  switch (r.reason.kind) {
    case "listed": {
      if (!isOnCurve(addressToBytes(r.wallet))) problems.push(`${r.wallet} is on the list, but it is a program's account (off the curve), which can never be a holder`);
      if (r.twab === 0n || r.twab < policy.minTwab) problems.push(`${r.wallet} is on the list with an average balance of ${r.twab}, below the minimum of ${policy.minTwab}`);
      else if (r.weight !== ruleWeight(r.twab, policy)) problems.push(`${r.wallet} is on the list with weight ${r.weight}, but the rules give ${ruleWeight(r.twab, policy)} for an average balance of ${r.twab}`);
      break;
    }
    case "below-min": {
      if (r.twab !== 0n && r.twab >= policy.minTwab) problems.push(`${r.wallet} is said to be below the minimum of ${policy.minTwab}, but its average balance is ${r.twab}`);
      if (!isOnCurve(addressToBytes(r.wallet))) problems.push(`${r.wallet} is said to be below the minimum, but it is a program's account (off the curve), which the rules leave out first`);
      break;
    }
    case "off-curve": {
      if (isOnCurve(addressToBytes(r.wallet))) problems.push(`${r.wallet} is said to be a program's account, but it is an ordinary key (on the curve)`);
      break;
    }
    case "excluded":
      break;
  }
  if (r.reason.kind !== "listed" && r.weight !== 0n) problems.push(`${r.wallet} is not on the list but has weight ${r.weight}`);
  return problems;
}

/** Why the wallets the record calls eligible do not build the root, total and count it states, or nothing when they do. */
export function listProblem(record: EligibilityRecord): string | undefined {
  const listedRows = record.wallets.filter((r) => r.reason.kind === "listed" && r.weight > 0n);
  let built = { root: ZERO_ROOT, total: 0n };
  if (listedRows.length > 0) {
    try {
      const node = treeRoot(listedRows.map((r): Leaf => ({ wallet: addressToBytes(r.wallet), weight: r.weight })));
      built = { root: toHex(node.hash), total: node.sum };
    } catch {
      return "the wallets it calls eligible cannot be built into a tree (their weights add up to more than a 64-bit number)";
    }
  }
  if (built.root !== record.root || built.total !== record.totalWeight || listedRows.length !== record.entryCount) {
    return `the wallets it calls eligible build root ${built.root} with ${listedRows.length} wallets and total ${built.total}, not the root ${record.root} with ${record.entryCount} wallets and total ${record.totalWeight} it states`;
  }
  return undefined;
}

/** Checks a record against its own rules, the commitments, the balance events and the list. */
export function checkRecord(record: EligibilityRecord, ctx: RecordContext = {}): RecordCheck {
  const problems: string[] = [];
  const { policy } = record;
  const counts = { listed: 0, belowMin: 0, offCurve: 0, excluded: 0 };

  // Each wallet's reason against the rules the record states.
  for (const r of record.wallets) {
    counts[COUNT[r.reason.kind]]++;
    problems.push(...rowProblems(r, policy));
  }

  // The wallets it calls eligible must build the root, total and count it states.
  const listedRows = record.wallets.filter((r) => r.reason.kind === "listed" && r.weight > 0n);
  const built = listProblem(record);
  if (built) problems.push(built);

  // Its commitments against the break's account.
  const c = ctx.chain;
  if (c) {
    if (c.inputsHash !== undefined && c.inputsHash !== record.inputsHash) problems.push(`it is for inputs hash ${record.inputsHash}, not the ${c.inputsHash} committed on chain`);
    if (c.root !== undefined && c.root !== record.root) problems.push(`it states root ${record.root}, not the ${c.root} committed on chain`);
    if (c.totalWeight !== undefined && c.totalWeight !== record.totalWeight) problems.push(`it states a total weight of ${record.totalWeight}, not the ${c.totalWeight} committed on chain`);
    if (c.entryCount !== undefined && c.entryCount !== record.entryCount) problems.push(`it states ${record.entryCount} wallets on the list, not the ${c.entryCount} committed on chain`);
    if (c.window && (BigInt(record.window.start) !== c.window.start || BigInt(record.window.end) !== c.window.end)) {
      problems.push(`it measures from ${record.window.start} to ${record.window.end}, not over the break's window from ${c.window.start} to ${c.window.end}`);
    }
  }

  // Every average balance against the one worked out here, and the same wallets.
  if (ctx.twabs) {
    const seen = new Set<string>();
    for (const r of record.wallets) {
      seen.add(r.wallet);
      const twab = ctx.twabs.get(r.wallet);
      if (twab === undefined) problems.push(`${r.wallet} is in the record but has no balance events`);
      else if (twab !== r.twab) problems.push(`${r.wallet} has an average balance of ${twab} in the balance events, not the ${r.twab} the record says`);
    }
    for (const wallet of ctx.twabs.keys()) if (!seen.has(wallet)) problems.push(`${wallet} has balance events but is not in the record`);
  }

  // The wallets it calls eligible, with their weights, must be the list.
  if (ctx.listed) {
    const list = new Map(ctx.listed.map((l) => [l.wallet, l.weight]));
    for (const r of listedRows) {
      const weight = list.get(r.wallet);
      if (weight === undefined) problems.push(`${r.wallet} is on the list in the record but not in the eligibility list`);
      else if (weight !== r.weight) problems.push(`${r.wallet} has weight ${r.weight} in the record but ${weight} in the eligibility list`);
      list.delete(r.wallet);
    }
    for (const wallet of list.keys()) problems.push(`${wallet} is in the eligibility list but the record does not put it on the list`);
  }

  const out = record.wallets
    .filter((r) => r.reason.kind !== "listed")
    .sort((a, b) => (a.twab > b.twab ? -1 : a.twab < b.twab ? 1 : compareBytes(addressToBytes(a.wallet), addressToBytes(b.wallet))));
  return {
    problems: problems.length > MAX_PROBLEMS ? [...problems.slice(0, MAX_PROBLEMS), `... and ${problems.length - MAX_PROBLEMS} more`] : problems,
    counts,
    out,
    checked: { twabs: ctx.twabs !== undefined, list: ctx.listed !== undefined, chain: c !== undefined },
  };
}
