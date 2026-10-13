// Legacy Solana transactions: compile instructions into a message, sign it, serialize it. Checked against
// @solana/web3.js in the tests (as an independent parser and verifier), because a transaction that is
// malformed in any way is rejected by every node and tells you nothing about why.

import { base58 } from "@scure/base";
import { concat } from "../draw/bytes.js";
import type { Instruction } from "./instruction.js";
import type { Signer } from "./keypair.js";
import { type Address, addressToBytes } from "./pubkey.js";

/** The size limit of a transaction packet, signatures included. */
export const MAX_TRANSACTION_SIZE = 1232;

export class MissingSignerError extends Error {
  constructor(readonly address: Address) {
    super(`the transaction needs a signature from ${address}, which is not a signer we hold`);
    this.name = "MissingSignerError";
  }
}

export class TransactionTooLargeError extends Error {
  constructor(readonly size: number) {
    super(`the transaction is ${size} bytes; the limit is ${MAX_TRANSACTION_SIZE}`);
    this.name = "TransactionTooLargeError";
  }
}

/** Solana's variable-length length prefix: 7 bits per byte, low bits first, high bit set when more follow. */
export function shortvec(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new RangeError(`not a shortvec length: ${n}`);
  const out: number[] = [];
  let rest = n;
  for (;;) {
    const byte = rest & 0x7f;
    rest >>= 7;
    if (rest === 0) {
      out.push(byte);
      break;
    }
    out.push(byte | 0x80);
  }
  return Uint8Array.from(out);
}

export interface CompiledMessage {
  /** The bytes that are signed. */
  bytes: Uint8Array;
  /** The accounts that must sign, in the order their signatures go. The fee payer is first. */
  signers: Address[];
}

interface KeyFlags {
  signer: boolean;
  writable: boolean;
}

/**
 * Builds a legacy message. Accounts are listed fee payer first, then signers (writable before read-only), then
 * the others (writable before read-only), each group in order of first use. An account used twice gets the
 * strongest flags of its uses; program ids are read-only unless an instruction also uses them otherwise.
 */
export function compileMessage(feePayer: Address, instructions: readonly Instruction[], recentBlockhash: string): CompiledMessage {
  const flags = new Map<Address, KeyFlags>();
  const touch = (key: Address, signer: boolean, writable: boolean) => {
    const known = flags.get(key);
    if (known) {
      known.signer ||= signer;
      known.writable ||= writable;
    } else {
      flags.set(key, { signer, writable });
    }
  };

  touch(feePayer, true, true);
  for (const ix of instructions) for (const a of ix.accounts) touch(a.pubkey, a.isSigner, a.isWritable);
  for (const ix of instructions) touch(ix.programId, false, false);

  const keys = [...flags.keys()];
  const group = (signer: boolean, writable: boolean) =>
    keys.filter((k) => k !== feePayer && flags.get(k)?.signer === signer && flags.get(k)?.writable === writable);
  const signersWritable = [feePayer, ...group(true, true)];
  const signersReadonly = group(true, false);
  const othersWritable = group(false, true);
  const othersReadonly = group(false, false);
  const ordered = [...signersWritable, ...signersReadonly, ...othersWritable, ...othersReadonly];
  if (ordered.length > 255) throw new RangeError(`too many accounts: ${ordered.length}`);

  const index = new Map(ordered.map((k, i) => [k, i] as const));
  const header = Uint8Array.of(signersWritable.length + signersReadonly.length, signersReadonly.length, othersReadonly.length);

  const compiled = instructions.map((ix) => {
    const programIdIndex = index.get(ix.programId) as number;
    const accountIndexes = Uint8Array.from(ix.accounts.map((a) => index.get(a.pubkey) as number));
    return concat(Uint8Array.of(programIdIndex), shortvec(accountIndexes.length), accountIndexes, shortvec(ix.data.length), ix.data);
  });

  const bytes = concat(
    header,
    shortvec(ordered.length),
    ...ordered.map(addressToBytes),
    addressToBytes(recentBlockhash),
    shortvec(instructions.length),
    ...compiled,
  );
  return { bytes, signers: [...signersWritable, ...signersReadonly] };
}

/** Signs a compiled message and serializes the transaction. Throws if a required signer is not among `signers`. */
export function signTransaction(message: CompiledMessage, signers: readonly Signer[]): { bytes: Uint8Array; signatures: Uint8Array[] } {
  const signatures = message.signers.map((address) => {
    const signer = signers.find((s) => s.address === address);
    if (!signer) throw new MissingSignerError(address);
    const signature = signer.sign(message.bytes);
    if (signature.length !== 64) throw new Error("a signature is 64 bytes");
    return signature;
  });
  const bytes = concat(shortvec(signatures.length), ...signatures, message.bytes);
  if (bytes.length > MAX_TRANSACTION_SIZE) throw new TransactionTooLargeError(bytes.length);
  return { bytes, signatures };
}

/** The text form of a signature, which is also the transaction's id. */
export const signatureToString = (signature: Uint8Array): string => base58.encode(signature);
