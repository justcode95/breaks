// Solana addresses in the browser: base58 and program-derived addresses (the same derivation as
// `Pubkey::find_program_address`, checked against addresses the Rust programs produced).

import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { hashv, u16le, u64le, utf8 } from "../draw/bytes";

export type Address = string;

export function addressToBytes(address: Address): Uint8Array {
  const bytes = base58.decode(address);
  if (bytes.length !== 32) throw new Error(`not a 32-byte address: ${address}`);
  return bytes;
}

export const addressFromBytes = (bytes: Uint8Array): Address => base58.encode(bytes);

/** Whether `text` is a Solana address (32 bytes, base58). */
export function isAddress(text: string): boolean {
  try {
    addressToBytes(text);
    return true;
  } catch {
    return false;
  }
}

/** True for ordinary keys, false for program-derived addresses (which no private key controls). */
function isOnCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.Point.fromBytes(bytes);
    return true;
  } catch {
    return false;
  }
}

const PDA_MARKER = utf8("ProgramDerivedAddress");

/** The highest bump that gives an address off the curve, as the runtime does. */
export function findProgramAddress(seeds: readonly Uint8Array[], programId: Address): Address {
  for (const s of seeds) if (s.length > 32) throw new Error("a seed is at most 32 bytes");
  const program = addressToBytes(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const candidate = hashv(...seeds, Uint8Array.of(bump), program, PDA_MARKER);
    if (!isOnCurve(candidate)) return addressFromBytes(candidate);
  }
  throw new Error("no valid bump");
}

// The accounts of the breaks program (seeds as in programs/breaks/src/lib.rs).
export const breakAddress = (program: Address, breakId: bigint): Address => findProgramAddress([utf8("break"), u64le(breakId)], program);
export const spotAddress = (program: Address, breakKey: Address, index: number): Address =>
  findProgramAddress([utf8("spot"), addressToBytes(breakKey), u16le(index)], program);
export const configAddress = (program: Address): Address => findProgramAddress([utf8("config")], program);
