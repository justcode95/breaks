// Building the transaction a wallet is asked to sign: a legacy Solana transaction with one fee payer, made from instructions.
// Written in the web package on its own and pinned to the bytes web3.js produces (the real serialization), including how
// accounts are merged and ordered. The wallet gets the transaction with its signature slots empty, signs it and sends it.

import { base58 } from "@scure/base";
import { concat } from "../draw/bytes";
import { type Address, addressToBytes } from "./address";
import type { AccountMeta, Instruction } from "./buy";

/** The most bytes a transaction may take on the wire. */
export const MAX_TRANSACTION_BYTES = 1232;

/** Solana's variable-length number: 7 bits at a time, the top bit says another byte follows. Used for every length in a transaction. */
export function compactU16(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new RangeError(`not a u16: ${n}`);
  const out: number[] = [];
  let rest = n;
  for (;;) {
    const low = rest & 0x7f;
    rest >>= 7;
    if (rest === 0) {
      out.push(low);
      return Uint8Array.from(out);
    }
    out.push(low | 0x80);
  }
}

interface Meta {
  pubkey: Address;
  signer: boolean;
  writable: boolean;
}

export interface BuiltTransaction {
  /** The part the signatures cover. */
  message: Uint8Array;
  /** The whole transaction with empty signature slots: what `solana:signAndSendTransaction` takes. */
  unsigned: Uint8Array;
  /** Who has to sign, in the order of the signature slots (the fee payer first). */
  signers: Address[];
}

/**
 * A legacy transaction for `instructions`, paid for by `feePayer`, valid until the blockhash expires. Accounts are merged (an
 * account named twice is a signer or writable if any use says so) and ordered the way Solana expects: signers before the rest,
 * writable before read-only, the fee payer first; instruction accounts in the order they are named, program ids after them.
 */
export function buildTransaction(a: { feePayer: Address; recentBlockhash: string; instructions: readonly Instruction[] }): BuiltTransaction {
  const blockhash = base58.decode(a.recentBlockhash);
  if (blockhash.length !== 32) throw new RangeError("a blockhash is 32 bytes");
  if (a.instructions.length === 0) throw new RangeError("a transaction needs an instruction");

  const raw: Meta[] = [{ pubkey: a.feePayer, signer: true, writable: true }];
  for (const ix of a.instructions) for (const m of ix.accounts) raw.push({ pubkey: m.pubkey, signer: m.signer, writable: m.writable });
  for (const ix of a.instructions) raw.push({ pubkey: ix.programId, signer: false, writable: false });

  const merged = new Map<Address, Meta>();
  for (const m of raw) {
    const known = merged.get(m.pubkey);
    if (known) {
      known.signer ||= m.signer;
      known.writable ||= m.writable;
    } else merged.set(m.pubkey, { ...m });
  }
  const rank = (m: Meta) => (m.signer ? 0 : 2) + (m.writable ? 0 : 1);
  // The fee payer went in first and is a writable signer, and the sort is stable, so it stays first and every group keeps the order its
  // accounts were named in.
  const ordered = [...merged.values()].sort((x, y) => rank(x) - rank(y));
  if (ordered.length > 255) throw new RangeError("too many accounts for one transaction");

  const signers = ordered.filter((m) => m.signer);
  const readonlySigned = signers.filter((m) => !m.writable).length;
  const readonlyUnsigned = ordered.filter((m) => !m.signer && !m.writable).length;
  const index = new Map(ordered.map((m, i) => [m.pubkey, i]));

  const compiled = a.instructions.map((ix) => {
    const programId = index.get(ix.programId) as number;
    const accounts = ix.accounts.map((m: AccountMeta) => index.get(m.pubkey) as number);
    return concat(Uint8Array.of(programId), compactU16(accounts.length), Uint8Array.from(accounts), compactU16(ix.data.length), ix.data);
  });

  const message = concat(
    Uint8Array.of(signers.length, readonlySigned, readonlyUnsigned),
    compactU16(ordered.length),
    ...ordered.map((m) => addressToBytes(m.pubkey)),
    blockhash,
    compactU16(compiled.length),
    ...compiled,
  );
  const unsigned = concat(compactU16(signers.length), new Uint8Array(64 * signers.length), message);
  if (unsigned.length > MAX_TRANSACTION_BYTES) throw new RangeError(`the transaction is ${unsigned.length} bytes, over the ${MAX_TRANSACTION_BYTES} a transaction may take`);
  return { message, unsigned, signers: signers.map((m) => m.pubkey) };
}
