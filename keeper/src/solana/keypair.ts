// The keeper's signing key. It is a hot wallet with limited powers (CLAUDE.md, guardrails): it can only
// advance the break state machine, never withdraw or change config. The secret is read from a file the
// operator controls, is never logged, and never appears in an error message.

import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import { equalBytes } from "../draw/bytes.js";
import { type Address, addressFromBytes } from "./pubkey.js";

export interface Signer {
  address: Address;
  sign(message: Uint8Array): Uint8Array;
}

/** From a 32-byte seed, or the 64 bytes (seed then public key) that the Solana CLI writes. */
export function signerFromSecretKey(secret: Uint8Array): Signer {
  if (secret.length !== 32 && secret.length !== 64) throw new Error("a secret key is 32 or 64 bytes");
  const seed = secret.slice(0, 32);
  const publicKey = ed25519.getPublicKey(seed);
  if (secret.length === 64 && !equalBytes(secret.subarray(32), publicKey)) {
    throw new Error("the public half of the key does not belong to its secret half");
  }
  return {
    address: addressFromBytes(publicKey),
    sign: (message) => ed25519.sign(message, seed),
  };
}

/** Reads a Solana CLI keypair file: a JSON array of 64 numbers. */
export function loadSignerFromFile(path: string): Signer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // Say which file, never what was in it.
    throw new Error(`could not read a keypair from ${path}`);
  }
  if (!Array.isArray(parsed) || !parsed.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    throw new Error(`${path} is not a keypair file (a JSON array of bytes)`);
  }
  return signerFromSecretKey(Uint8Array.from(parsed as number[]));
}
