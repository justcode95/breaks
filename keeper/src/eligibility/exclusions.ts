// The exclusion list an eligibility list was made with: every wallet the planner left out on purpose when it built the list,
// with its public reason code. The record of a list (`records/<inputs hash>.json`) names only the excluded wallets that held
// the token; this is the whole list, so "the exclusion list is public" holds for every break, also for wallets that held
// nothing yet. The planner stores it when it builds the list, in its public form, and the publish job checks it against the
// record before it goes out (`checkExclusions`).
//
// The format, compact JSON with a newline at the end, entries sorted by the wallets' 32 bytes:
//   {"version":1,"kind":"exclusions","inputsHash":"<64 hex>","entries":[{"wallet":"<base58>","code":"<code>"}]}
// A code is what the website shows people, so it is a short name (1 to 64 letters, digits, `_`, `.` or `-`), the same rule the
// website applies to `excluded:<code>` in a record. The private note of an exclusion is never in it.

import { compareBytes, toHex } from "../draw/bytes.js";
import type { EligibilityRecord } from "../publish/record.js";
import { type Address, addressToBytes } from "../solana/pubkey.js";

export interface ExclusionList {
  /** The inputs hash of the list it was made with, as 64 hex digits: the name it is published under. */
  inputsHash: string;
  /** Sorted by the wallets' bytes, no wallet twice. */
  entries: { wallet: Address; code: string }[];
}

export const EXCLUSION_CODE = /^[A-Za-z0-9_.-]{1,64}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** What is wrong with one row of the exclusions table for the public list, or undefined when it can go out as it is. */
export function exclusionProblem(wallet: string, code: string): string | undefined {
  // Base58 has one way of writing 32 bytes, so an address that decodes is also written the one way the list compares.
  try {
    addressToBytes(wallet);
  } catch {
    return `${JSON.stringify(wallet)} is not a Solana address`;
  }
  if (!EXCLUSION_CODE.test(code)) return `the code of ${wallet}, ${JSON.stringify(code)}, is not 1 to 64 letters, digits, "_", "." or "-"`;
  return undefined;
}

/** The public document of an exclusion list (the bytes that are stored and published). The rows must pass `exclusionProblem`. */
export function exclusionsDocument(inputsHash: Uint8Array | string, exclusions: ReadonlyMap<Address, string>): string {
  const entries = [...exclusions].map(([wallet, code]) => ({ wallet, code, bytes: addressToBytes(wallet) })).sort((a, b) => compareBytes(a.bytes, b.bytes));
  return (
    JSON.stringify({
      version: 1,
      kind: "exclusions",
      inputsHash: typeof inputsHash === "string" ? inputsHash : toHex(inputsHash),
      entries: entries.map(({ wallet, code }) => ({ wallet, code })),
    }) + "\n"
  );
}

/** Reads a stored exclusion list strictly: only what `exclusionsDocument` writes. Throws, saying what is wrong. */
export function parseExclusions(body: string): ExclusionList {
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    throw new Error("the stored exclusion list is not JSON");
  }
  const d = doc as Record<string, unknown>;
  if (typeof d !== "object" || d === null || d.version !== 1 || d.kind !== "exclusions") throw new Error("the stored exclusion list is not an exclusion list of version 1");
  if (typeof d.inputsHash !== "string" || !HEX64.test(d.inputsHash)) throw new Error("the stored exclusion list has no valid inputs hash");
  if (!Array.isArray(d.entries)) throw new Error("the stored exclusion list has no entries");
  const entries = d.entries.map((e: unknown, i) => {
    const row = e as Record<string, unknown>;
    if (typeof row !== "object" || row === null || Object.keys(row).sort().join() !== "code,wallet" || typeof row.wallet !== "string" || typeof row.code !== "string") {
      throw new Error(`entry ${i + 1} of the stored exclusion list is not a wallet and a code`);
    }
    const problem = exclusionProblem(row.wallet, row.code);
    if (problem !== undefined) throw new Error(`entry ${i + 1} of the stored exclusion list: ${problem}`);
    return { wallet: row.wallet, code: row.code };
  });
  for (let i = 1; i < entries.length; i++) {
    if (compareBytes(addressToBytes((entries[i - 1] as { wallet: string }).wallet), addressToBytes((entries[i] as { wallet: string }).wallet)) >= 0) {
      throw new Error(`the stored exclusion list is not sorted by wallet, or has a wallet twice (entry ${i + 1})`);
    }
  }
  if (exclusionsDocument(d.inputsHash, new Map(entries.map((e) => [e.wallet, e.code]))) !== body) throw new Error("the stored exclusion list is not written the way the keeper writes it");
  return { inputsHash: d.inputsHash, entries };
}

/**
 * Throws, saying where, unless `list` is the exclusion list `record` was made with. Exclusion is the first rule
 * (`buildEligibility`), so every wallet in the record is excluded with the list's code exactly when the list names it; a wallet
 * the list names that is not in the record held none of the token, and that changes nothing. The record itself must already
 * have been checked against the chain and the balance events (`checkRecord`).
 */
export function checkExclusions(list: ExclusionList, record: EligibilityRecord): void {
  if (list.inputsHash !== record.inputsHash) throw new Error(`the stored exclusion list is for inputs hash ${list.inputsHash}, not the ${record.inputsHash} of its record`);
  const codes = new Map(list.entries.map((e) => [e.wallet, e.code]));
  for (const w of record.wallets) {
    const code = codes.get(w.wallet);
    const recorded = w.reason?.startsWith("excluded:") ? w.reason.slice("excluded:".length) : undefined;
    if (code !== recorded) {
      throw new Error(
        code === undefined
          ? `the record leaves ${w.wallet} out as "${recorded}", but the stored exclusion list does not name it`
          : recorded === undefined
            ? `the stored exclusion list names ${w.wallet} ("${code}"), but the record does not leave it out`
            : `the stored exclusion list gives ${w.wallet} the code "${code}", but the record says "${recorded}"`,
      );
    }
  }
}
