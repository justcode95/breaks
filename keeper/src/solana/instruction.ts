// What every builder returns: a program, an ordered account list with flags, and the data bytes.
// It is the same shape as a Solana instruction, so any transaction library can send it.

import { hashv, utf8 } from "../draw/bytes.js";
import { type Address, addressToBytes, findProgramAddress } from "./pubkey.js";

export interface AccountMeta {
  pubkey: Address;
  isSigner: boolean;
  isWritable: boolean;
}

export interface Instruction {
  programId: Address;
  accounts: AccountMeta[];
  data: Uint8Array;
}

/** A signer that pays or changes state. */
export const signerMut = (pubkey: Address): AccountMeta => ({ pubkey, isSigner: true, isWritable: true });
/** A signer whose account is not written. */
export const signer = (pubkey: Address): AccountMeta => ({ pubkey, isSigner: true, isWritable: false });
export const writable = (pubkey: Address): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
export const readonly = (pubkey: Address): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });

/** Anchor: the first 8 bytes of `sha256("global:<instruction name in snake_case>")`. */
export function instructionDiscriminator(name: string): Uint8Array {
  return hashv(utf8(`global:${name}`)).slice(0, 8);
}

/** Anchor: the first 8 bytes of `sha256("account:<AccountName>")`, the start of every account's data. */
export function accountDiscriminator(name: string): Uint8Array {
  return hashv(utf8(`account:${name}`)).slice(0, 8);
}

/** Well-known programs. */
export const SYSTEM_PROGRAM: Address = "11111111111111111111111111111111";
export const TOKEN_PROGRAM: Address = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const UPGRADEABLE_LOADER: Address = "BPFLoaderUpgradeab1e11111111111111111111111";

/** The program-data account of an upgradeable program (what `initialize` checks the upgrade authority against). */
export function programDataAddress(programId: Address): Address {
  return findProgramAddress([addressToBytes(programId)], UPGRADEABLE_LOADER).address;
}
