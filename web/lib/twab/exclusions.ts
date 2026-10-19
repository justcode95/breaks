// The exclusion list a break's eligibility list was made with (`exclusions/<inputs hash>.json`, docs/PUBLISHED.md): every wallet
// the keeper left out on purpose, with its code, also those that held none of the token (a record names only the ones that
// did). The chain commits no hash of it; it is filed under the break's inputs hash and checked against the record: exclusion is
// the first rule the keeper applies, so every wallet of the record must be left out with the list's code exactly when the list
// names it. Why a wallet is on the list stays the keeper's word.
//
// This is the web package's own reading of the format, not the keeper's code: a verifier that shares code with what it checks
// is not independent.

import { addressToBytes } from "../chain/address";
import { compareBytes } from "../draw/bytes";
import { CODE, type EligibilityRecord } from "./record";

export interface ExclusionList {
  inputsHash: string;
  /** Sorted by the wallets' 32 bytes. A code is a short name of letters, digits and a few signs, never markup. */
  entries: { wallet: string; code: string }[];
}

const MAX_PROBLEMS = 20;
const HEX64 = /^[0-9a-f]{64}$/;

const capped = (errors: string[]) => (errors.length > MAX_PROBLEMS ? [...errors.slice(0, MAX_PROBLEMS), `... and ${errors.length - MAX_PROBLEMS} more`] : errors);

/** Reads an exclusion list strictly: the format in docs/PUBLISHED.md and nothing else. Up to twenty problems, by entry. */
export function parseExclusions(text: string): { ok: true; list: ExclusionList } | { ok: false; errors: string[] } {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, errors: ["it is not JSON"] };
  }
  const d = doc as Record<string, unknown> | null;
  if (d === null || d.version !== 1 || d.kind !== "exclusions") return { ok: false, errors: ["it is not an exclusion list of a version this page reads"] };

  const errors: string[] = [];
  const inputsHash = typeof d.inputsHash === "string" && HEX64.test(d.inputsHash) ? d.inputsHash : undefined;
  if (inputsHash === undefined) errors.push("the inputs hash is not 64 lowercase hex digits");
  const entries: ExclusionList["entries"] = [];
  if (!Array.isArray(d.entries)) errors.push("it has no list of entries");
  else {
    let previous: Uint8Array | undefined;
    for (const [i, raw] of d.entries.entries()) {
      const at = `entry ${i + 1}`;
      const e = raw as Record<string, unknown> | null;
      if (typeof e !== "object" || e === null || Object.keys(e).sort().join() !== "code,wallet" || typeof e.wallet !== "string" || typeof e.code !== "string") {
        errors.push(`${at} is not a wallet and a code`);
        continue;
      }
      let bytes: Uint8Array;
      try {
        bytes = addressToBytes(e.wallet);
      } catch {
        errors.push(`${at} is not a Solana address`);
        continue;
      }
      if (previous && compareBytes(previous, bytes) >= 0) errors.push(`${at} (${e.wallet}) is out of order or listed twice: the wallets are sorted by their bytes`);
      previous = bytes;
      if (!CODE.test(e.code)) {
        errors.push(`the code of ${at} is not 1 to 64 letters, digits, "_", "." or "-"`);
        continue;
      }
      entries.push({ wallet: e.wallet, code: e.code });
    }
  }
  if (errors.length > 0) return { ok: false, errors: capped(errors) };
  return { ok: true, list: { inputsHash: inputsHash as string, entries } };
}

export interface ExclusionsCheck {
  /** Everything that does not add up, in words; empty when it all does. At most twenty, then a count. */
  problems: string[];
  /** How many of its wallets the record has (they held the token), and how many it does not (they held none). */
  held: number;
  notHeld: number;
  /** Which comparisons could be made with what was given. */
  checked: { record: boolean; chain: boolean };
}

/**
 * The list against what else is known: the inputs hash the chain committed, and the record of the same list, whose excluded
 * wallets must be exactly the ones the list names that held the token, with the list's codes.
 */
export function checkExclusions(list: ExclusionList, ctx: { record?: EligibilityRecord; inputsHash?: string }): ExclusionsCheck {
  const problems: string[] = [];
  if (ctx.inputsHash !== undefined && list.inputsHash !== ctx.inputsHash) problems.push(`it is for inputs hash ${list.inputsHash}, not the ${ctx.inputsHash} committed on chain`);
  const codes = new Map(list.entries.map((e) => [e.wallet, e.code]));
  let held = 0;
  if (ctx.record) {
    const r = ctx.record;
    if (list.inputsHash !== r.inputsHash) problems.push(`it is for inputs hash ${list.inputsHash}, but the record is for ${r.inputsHash}`);
    for (const w of r.wallets) {
      const code = codes.get(w.wallet);
      if (code !== undefined) held++;
      const recorded = w.reason.kind === "excluded" ? w.reason.code : undefined;
      if (code === recorded) continue;
      problems.push(
        code === undefined
          ? `the record leaves ${w.wallet} out on purpose (${recorded}), but this list does not name it`
          : recorded === undefined
            ? `this list names ${w.wallet} (${code}), but the record does not leave it out on purpose`
            : `this list gives ${w.wallet} the code ${code}, but the record says ${recorded}`,
      );
    }
  }
  return {
    problems: capped(problems),
    held,
    notHeld: ctx.record ? list.entries.length - held : 0,
    checked: { record: ctx.record !== undefined, chain: ctx.inputsHash !== undefined },
  };
}

/** Whether a wallet of the list held the token: it did if the record has it. Undefined without a record. */
export const heldBy = (record: EligibilityRecord | undefined): ((wallet: string) => boolean | undefined) => {
  if (!record) return () => undefined;
  const held = new Set(record.wallets.map((w) => w.wallet));
  return (wallet) => held.has(wallet);
};
