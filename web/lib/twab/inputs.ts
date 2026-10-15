// The record of the balance events a break's weights were computed from, as the keeper publishes it
// (docs/PUBLISHED.md, `inputs/<inputs hash>.txt`). Its SHA-256 is the `inputs_hash` the chain holds, so a text that hashes to
// that is the record, wherever it was fetched from. This file reads it strictly: a text that has been cut off, changed in
// transit or made by something else is refused with the line it went wrong at, never half-read.
//
//   breaks:inputs:v1,<window start>,<window end>
//   <signature>,<slot>,<time>,<owner>,<token account>,<delta>,<balance after>
//   ...
//
// Browser-safe: no Node modules. Written on its own, not shared with the keeper (a verifier that shares code with what it
// checks is not independent); the keeper's own output is what web/test/twab.test.ts reads it against.

import { U64_MAX, toHex, utf8 } from "../draw/bytes";
import { sha256 } from "@noble/hashes/sha2.js";

export const INPUTS_HEADER = "breaks:inputs:v1";

export interface InputEvent {
  signature: string;
  slot: bigint;
  /** Unix seconds: the block time of the slot. */
  time: number;
  /** The wallet that owns the token account. */
  owner: string;
  tokenAccount: string;
  /** The change in the token account's balance (negative for a withdrawal), in base units. */
  delta: bigint;
  /** The token account's balance right after, in base units. */
  balanceAfter: bigint;
}

export interface InputWindow {
  /** Unix seconds, included. */
  start: number;
  /** Unix seconds, excluded. */
  end: number;
}

export type ParsedInputs = { ok: true; window: InputWindow; events: InputEvent[] } | { ok: false; errors: string[] };

/** The SHA-256 of the text, as 64 hex digits: what `inputs_hash` on the break's account must equal. */
export const inputsHash = (text: string): string => toHex(sha256(utf8(text)));

const MAX_ERRORS = 20;
const NAME = /^[^\s,]+$/;
const COUNT = /^(?:0|[1-9]\d*)$/;
const SIGNED = /^(?:0|-?[1-9]\d*)$/;

/**
 * Reads the text. Every line is checked, up to twenty problems are reported (with the line number) and nothing is returned
 * unless the whole text is sound. The order of the events is not checked: the TWAB puts them in order itself, and the hash is
 * what ties the text to the chain.
 */
export function parseInputs(text: string): ParsedInputs {
  const errors: string[] = [];
  const fail = (line: number, message: string) => {
    if (errors.length < MAX_ERRORS) errors.push(`line ${line}: ${message}`);
  };

  if (text === "") return { ok: false, errors: ["the text is empty"] };
  if (text.includes("\r")) return { ok: false, errors: ["the text has carriage returns; the published text ends every line with a line feed only"] };
  // The text ends every line, the last too: a text that does not has been cut off.
  if (!text.endsWith("\n")) return { ok: false, errors: ["the text does not end with a line feed; it has probably been cut off"] };

  const lines = text.slice(0, -1).split("\n");
  const head = /^breaks:inputs:v1,(0|[1-9]\d*),(0|[1-9]\d*)$/.exec(lines[0] as string);
  let window: InputWindow | undefined;
  if (!head) {
    fail(1, `the first line must be "${INPUTS_HEADER},<window start>,<window end>" with the window in whole seconds`);
  } else {
    const start = Number(head[1]);
    const end = Number(head[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) fail(1, "the window is not a usable time");
    else if (end <= start) fail(1, "the window must end after it starts");
    else window = { start, end };
  }

  const events: InputEvent[] = [];
  for (let i = 1; i < lines.length; i++) {
    const n = i + 1;
    const fields = (lines[i] as string).split(",");
    if (fields.length !== 7) {
      fail(n, fields.length === 1 && fields[0] === "" ? "an empty line" : `an event has 7 fields separated by commas, this has ${fields.length}`);
      continue;
    }
    const [signature, slot, time, owner, tokenAccount, delta, balanceAfter] = fields as [string, string, string, string, string, string, string];
    let bad = false;
    const reject = (message: string) => {
      fail(n, message);
      bad = true;
    };
    for (const [field, value] of [["signature", signature], ["owner", owner], ["token account", tokenAccount]] as const) {
      if (!NAME.test(value)) reject(`the ${field} must be a name without spaces or commas`);
    }
    if (!COUNT.test(slot)) reject("the slot must be a whole number");
    if (!COUNT.test(time) || !Number.isSafeInteger(Number(time))) reject("the time must be whole seconds");
    if (!SIGNED.test(delta) || BigInt(delta) > U64_MAX || -BigInt(delta) > U64_MAX) reject("the change must be a whole number of base units (a u64 at most, with a minus sign for a withdrawal)");
    if (!COUNT.test(balanceAfter) || BigInt(balanceAfter) > U64_MAX) reject("the balance must be a whole number of base units, a u64 at most");
    if (!bad) events.push({ signature, slot: BigInt(slot), time: Number(time), owner, tokenAccount, delta: BigInt(delta), balanceAfter: BigInt(balanceAfter) });
  }

  if (errors.length > 0 || !window) {
    if (errors.length === MAX_ERRORS) errors.push("there may be more problems after these");
    return { ok: false, errors };
  }
  return { ok: true, window, events };
}
