// The public record of a break's eligibility: every wallet that held the token, its time-weighted average balance, its weight
// and why it is in or out, with the rules that were applied (the minimum and the cap). The planner stores it when it builds the
// list (`listDocument`); this module reads that stored document and checks it before it is published.
//
// What the chain commits does not cover the record itself, so it is checked against everything it does cover: the record must
// be exactly what the keeper's own rules (`buildEligibility`) make of the committed balance events, with the record's stated
// policy and exclusions, and the wallets it calls eligible must rebuild the committed root, total weight and count. What is
// left as the keeper's word is the policy and why an excluded wallet is excluded; both are in the file for anyone to read.

import { equalBytes, fromHex, hashv, toHex, utf8 } from "../draw/bytes.js";
import { Tree } from "../draw/tree.js";
import { buildEligibility, type WeightPolicy } from "../eligibility/eligibility.js";
import { parseInputsText } from "../eligibility/inputs-text.js";
import type { Window } from "../eligibility/twab.js";
import type { BreakAccount } from "../solana/breaks.js";

export interface RecordRow {
  wallet: string;
  twab: bigint;
  weight: bigint;
  /** Null when the wallet is on the list; otherwise `below_min_twab`, `off_curve` or `excluded:<code>`. */
  reason: string | null;
}

export interface EligibilityRecord {
  inputsHash: string;
  root: string;
  totalWeight: bigint;
  entryCount: number;
  window: Window;
  policy: WeightPolicy;
  /** Sorted by the wallets' 32 bytes, as the planner stores them. */
  wallets: RecordRow[];
}

const HEX64 = /^[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9]\d*)$/;

/** Reads the document the planner stored (`listDocument`). Throws on anything that is not that shape. */
export function parseStoredRecord(body: string): EligibilityRecord {
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    throw new Error("the stored eligibility record is not JSON");
  }
  const bad = (what: string): never => {
    throw new Error(`the stored eligibility record has no valid ${what}`);
  };
  const d = doc as Record<string, unknown>;
  if (typeof d !== "object" || d === null || d.version !== 1) bad("version");
  const hex = (v: unknown, what: string) => (typeof v === "string" && HEX64.test(v) ? v : bad(what));
  const dec = (v: unknown, what: string) => (typeof v === "string" && DECIMAL.test(v) ? BigInt(v) : bad(what));
  const win = d.window as Record<string, unknown> | undefined;
  if (!win || !Number.isSafeInteger(win.start) || !Number.isSafeInteger(win.end)) bad("window");
  const policy = d.policy as Record<string, unknown> | undefined;
  if (!policy || typeof policy !== "object") bad("policy");
  if (!Number.isSafeInteger(d.entryCount) || (d.entryCount as number) < 0) bad("entry count");
  if (!Array.isArray(d.wallets)) bad("wallets");
  const wallets = (d.wallets as Record<string, unknown>[]).map((w, i): RecordRow => {
    const n = i + 1;
    if (typeof w !== "object" || w === null || typeof w.wallet !== "string" || w.wallet === "") bad(`wallet ${n}`);
    if (w.reason !== null && (typeof w.reason !== "string" || w.reason === "")) bad(`reason of wallet ${n}`);
    if ((w.reason === null) !== (w.eligible === true)) bad(`eligibility of wallet ${n}`);
    return { wallet: w.wallet as string, twab: dec(w.twab, `twab of wallet ${n}`), weight: dec(w.weight, `weight of wallet ${n}`), reason: w.reason as string | null };
  });
  return {
    inputsHash: hex(d.inputsHash, "inputs hash"),
    root: hex(d.root, "root"),
    totalWeight: dec(d.totalWeight, "total weight"),
    entryCount: d.entryCount as number,
    window: { start: (win as { start: number }).start, end: (win as { end: number }).end },
    policy: {
      minTwab: dec((policy as Record<string, unknown>).minTwab, "minimum"),
      ...((policy as Record<string, unknown>).capPerWallet !== undefined ? { capPerWallet: dec((policy as Record<string, unknown>).capPerWallet, "cap") } : {}),
    },
    wallets,
  };
}

/**
 * Throws, saying what differs, unless the record is exactly what the rules make of the committed balance events and agrees
 * with everything the break's account commits. `inputsText` is the stored balance-event text (already checked to hash to
 * the committed inputs hash by the caller or here).
 */
export function checkRecord(record: EligibilityRecord, inputsText: string, b: Pick<BreakAccount, "eligibilityRoot" | "eligibilityTotalWeight" | "eligibilityCount" | "eligibilityInputsHash" | "opensAt" | "closesAt">): void {
  const committed = toHex(b.eligibilityInputsHash);
  if (record.inputsHash !== committed) throw new Error(`the stored eligibility record is for inputs hash ${record.inputsHash}, not the ${committed} committed on chain`);
  // The same words as the balance events' own step, so a report that has both says it once.
  if (toHex(hashv(utf8(inputsText))) !== committed) throw new Error(`the stored record of the inputs does not hash to the inputs hash committed on chain (${committed})`);
  if (record.root !== toHex(b.eligibilityRoot) || record.totalWeight !== b.eligibilityTotalWeight || record.entryCount !== b.eligibilityCount) {
    throw new Error(
      `the stored eligibility record (root ${record.root}, ${record.entryCount} wallets, total ${record.totalWeight}) is not what was committed on chain (root ${toHex(b.eligibilityRoot)}, ${b.eligibilityCount} wallets, total ${b.eligibilityTotalWeight})`,
    );
  }
  if (BigInt(record.window.start) !== b.opensAt || BigInt(record.window.end) !== b.closesAt) {
    throw new Error(`the stored eligibility record measures ${record.window.start} to ${record.window.end}, not the break's window ${b.opensAt} to ${b.closesAt}`);
  }

  const { window, events } = parseInputsText(inputsText);
  if (window.start !== record.window.start || window.end !== record.window.end) throw new Error("the stored eligibility record and its balance events are for different windows");

  // The rules again, on the committed events, with what the record says the policy and the exclusions were.
  const exclusions = new Map<string, string>();
  for (const w of record.wallets) if (w.reason?.startsWith("excluded:")) exclusions.set(w.wallet, w.reason.slice("excluded:".length));
  const again = buildEligibility({ events, window, policy: record.policy, exclusions });
  const key = (r: RecordRow) => `${r.wallet} ${r.twab} ${r.weight} ${r.reason}`;
  const want = again.snapshot.map((s) => key({ wallet: s.wallet, twab: s.twab, weight: s.weight, reason: s.reason }));
  const have = record.wallets.map(key);
  const first = want.findIndex((k, i) => k !== have[i]);
  if (first !== -1 || want.length !== have.length) {
    const at = first === -1 ? Math.min(want.length, have.length) : first;
    throw new Error(`the stored eligibility record is not what the rules make of the committed balance events (first difference at wallet ${at + 1}: the rules give ${want[at] ?? "nothing"}, the record says ${have[at] ?? "nothing"})`);
  }

  const zero = new Uint8Array(32);
  const root = again.leaves.length === 0 ? zero : Tree.build(again.leaves).root.hash;
  if (!equalBytes(root, fromHex(record.root)) || again.totalWeight !== record.totalWeight || again.leaves.length !== record.entryCount) {
    throw new Error("the wallets the stored eligibility record calls eligible do not rebuild the committed root");
  }
}
