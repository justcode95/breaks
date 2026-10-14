// The Collector Crypt machine / price tier of a break is committed on-chain as 32 bytes. Until Phase 0 shows what
// identifies a machine, it is configured as a short text label (up to 32 UTF-8 bytes, zero-padded on-chain) or, for a
// raw 32-byte id, as `0x` and 64 hex digits. The database keeps the same text.

import { fromHex, toHex } from "../draw/bytes.js";

const RAW = /^0x[0-9a-fA-F]{64}$/;
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

/** The 32 bytes committed on-chain for a machine label. */
export function packMachineBytes(label: string): Uint8Array {
  if (RAW.test(label)) return fromHex(label.slice(2));
  // "0x..." that is not a whole 32-byte id is most likely a truncated one: refuse it rather than commit it as text.
  if (/^0x/i.test(label)) throw new RangeError("the pack machine looks like a hex id but is not 0x followed by exactly 64 hex digits");
  const text = encoder.encode(label);
  if (text.length === 0) throw new RangeError("the pack machine is empty");
  if (text.length > 32) throw new RangeError(`the pack machine label is ${text.length} bytes; at most 32 (or 0x and 64 hex digits)`);
  if (text.some((b) => b < 0x20 || b === 0x7f)) throw new RangeError("the pack machine label has a control character");
  const bytes = new Uint8Array(32);
  bytes.set(text, 0);
  return bytes;
}

/** The label for 32 on-chain bytes: the text if they are one (padded with zeros), otherwise `0x` and hex. */
export function packMachineLabel(bytes: Uint8Array): string {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end -= 1;
  const used = bytes.subarray(0, end);
  if (used.length > 0) {
    try {
      const text = decoder.decode(used);
      // Plain text only, so that `packMachineBytes(label)` gives back exactly these bytes.
      if (!/^0x/i.test(text) && ![...used].some((b) => b < 0x20 || b === 0x7f)) return text;
    } catch {
      // not text
    }
  }
  return `0x${toHex(bytes)}`;
}
