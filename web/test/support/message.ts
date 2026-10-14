// Reads a legacy Solana message back into its parts, so a test can compare two transactions by what they say (who signs, who is
// writable, which instruction touches which account) instead of by byte order, which Solana does not care about inside a group.

import { base58 } from "@scure/base";
import { type Address, addressFromBytes } from "../../lib/chain/address";
import { toHex } from "../../lib/draw/bytes";

export interface DecodedMessage {
  numSignatures: number;
  numReadonlySigned: number;
  numReadonlyUnsigned: number;
  keys: Address[];
  blockhash: string;
  instructions: { program: Address; accounts: Address[]; data: string }[];
}

export function decodeMessage(bytes: Uint8Array): DecodedMessage {
  let at = 0;
  const byte = () => {
    const b = bytes[at++];
    if (b === undefined) throw new RangeError("the message is cut short");
    return b;
  };
  const take = (n: number) => {
    if (at + n > bytes.length) throw new RangeError("the message is cut short");
    const out = bytes.slice(at, at + n);
    at += n;
    return out;
  };
  const compact = () => {
    let value = 0;
    for (let shift = 0; ; shift += 7) {
      const b = byte();
      value |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return value;
    }
  };
  const numSignatures = byte();
  const numReadonlySigned = byte();
  const numReadonlyUnsigned = byte();
  const keys = Array.from({ length: compact() }, () => addressFromBytes(take(32)));
  const blockhash = base58.encode(take(32));
  const instructions = Array.from({ length: compact() }, () => {
    const program = keys[byte()] as Address;
    const accounts = Array.from({ length: compact() }, () => keys[byte()] as Address);
    const data = toHex(take(compact()));
    return { program, accounts, data };
  });
  if (at !== bytes.length) throw new RangeError("the message has bytes left over");
  return { numSignatures, numReadonlySigned, numReadonlyUnsigned, keys, blockhash, instructions };
}

/** What each account is, as the header says: who signs and who may be written. */
export function flagsOf(m: DecodedMessage): Map<Address, { signer: boolean; writable: boolean }> {
  const out = new Map<Address, { signer: boolean; writable: boolean }>();
  m.keys.forEach((key, i) => {
    const signer = i < m.numSignatures;
    const readonly = signer ? i >= m.numSignatures - m.numReadonlySigned : i >= m.keys.length - m.numReadonlyUnsigned;
    out.set(key, { signer, writable: !readonly });
  });
  return out;
}

/** Everything a message says that matters, in an order-free form: two messages with the same summary do the same thing. */
export function summary(m: DecodedMessage) {
  return {
    feePayer: m.keys[0],
    blockhash: m.blockhash,
    numSignatures: m.numSignatures,
    flags: [...flagsOf(m).entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
    instructions: m.instructions,
  };
}
