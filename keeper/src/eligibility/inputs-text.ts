// Reads back the balance-event text that `serializeInputs` writes (the record `inputs_hash` commits to). Used where the keeper
// must check something against exactly what it published, not against its database: a text is accepted only if writing its
// events again gives the same text, byte for byte, so whatever comes back is the published record and nothing else.

import { type BalanceEvent, type Window } from "./twab.js";
import { serializeInputs } from "./eligibility.js";

const HEADER = /^breaks:inputs:v1,(0|[1-9]\d*),(0|[1-9]\d*)$/;
const WHOLE = /^(0|[1-9]\d*)$/;
const SIGNED = /^(0|-?[1-9]\d*)$/;

/** The window and the events of a published balance-event text. Throws, naming the line, on anything it would not write itself. */
export function parseInputsText(text: string): { window: Window; events: BalanceEvent[] } {
  if (!text.endsWith("\n")) throw new Error("the balance-event text does not end with a line feed");
  const lines = text.slice(0, -1).split("\n");
  const header = HEADER.exec(lines[0] as string);
  if (!header) throw new Error("line 1: not a breaks:inputs:v1 header");
  const window = { start: Number(header[1]), end: Number(header[2]) };
  if (!Number.isSafeInteger(window.start) || !Number.isSafeInteger(window.end) || window.end <= window.start) {
    throw new Error("line 1: the window does not end after it starts");
  }

  const events = lines.slice(1).map((line, i): BalanceEvent => {
    const n = i + 2;
    const parts = line.split(",");
    if (parts.length !== 7) throw new Error(`line ${n}: ${parts.length} fields, not 7`);
    const [signature, slot, time, owner, tokenAccount, delta, balanceAfter] = parts as [string, string, string, string, string, string, string];
    if (signature === "" || owner === "" || tokenAccount === "") throw new Error(`line ${n}: an empty name`);
    if (!WHOLE.test(slot) || !WHOLE.test(time) || !WHOLE.test(balanceAfter) || !SIGNED.test(delta)) throw new Error(`line ${n}: not a whole number`);
    if (!Number.isSafeInteger(Number(time))) throw new Error(`line ${n}: the time is too large`);
    return { signature, slot: BigInt(slot), time: Number(time), owner, tokenAccount, delta: BigInt(delta), balanceAfter: BigInt(balanceAfter) };
  });

  // The order, and anything the patterns above let through that the writer would not have written, shows up here.
  if (serializeInputs(events, window) !== text) throw new Error("the balance-event text is not in the form the keeper writes it");
  return { window, events };
}
