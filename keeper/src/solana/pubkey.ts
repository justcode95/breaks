// Solana addresses: base58, "is this a real key or a program-derived address", and PDA derivation.

import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { concat, hashv, utf8 } from "../draw/bytes.js";

export type Address = string;

export function addressToBytes(address: Address): Uint8Array {
  const bytes = base58.decode(address);
  if (bytes.length !== 32) throw new Error(`not a 32-byte address: ${address}`);
  return bytes;
}

export function addressFromBytes(bytes: Uint8Array): Address {
  if (bytes.length !== 32) throw new Error("an address is 32 bytes");
  return base58.encode(bytes);
}

/** True for ordinary keys, false for program-derived addresses (which no private key controls). */
export function isOnCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.Point.fromBytes(bytes);
    return true;
  } catch {
    return false;
  }
}

const PDA_MARKER = utf8("ProgramDerivedAddress");

/** Same derivation as `Pubkey::find_program_address`: the highest bump that gives an off-curve address. */
export function findProgramAddress(seeds: readonly Uint8Array[], programId: Address): { address: Address; bump: number } {
  if (seeds.length > 16) throw new Error("at most 16 seeds");
  for (const s of seeds) if (s.length > 32) throw new Error("a seed is at most 32 bytes");
  const program = addressToBytes(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const candidate = hashv(...seeds, Uint8Array.of(bump), program, PDA_MARKER);
    if (!isOnCurve(candidate)) return { address: addressFromBytes(candidate), bump };
  }
  throw new Error("no valid bump");
}

export { concat };
