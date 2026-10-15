// The accounts of Solana's upgradeable program loader, enough to say who can replace a deployed program.
//
// A deployed program is two accounts. The program account (owned by the loader, `executable`) holds only the address of
// its program-data account; the program-data account holds the slot of the last deploy, who may upgrade the program (none
// once it is made immutable) and then the program's code. The loader writes both with bincode: a little-endian u32 tag, then
// the fields, an `Option<Pubkey>` as one byte (0 or 1) and, for 1, the 32 bytes.
//
//   tag 2  Program     { programdata_address: Pubkey }                          36 bytes
//   tag 3  ProgramData { slot: u64, upgrade_authority_address: Option<Pubkey> } 45 bytes, then the ELF

import { base58 } from "@scure/base";
import type { Address } from "./pubkey.js";

/** How many bytes of a program-data account hold the metadata (the code starts after them). */
export const PROGRAM_DATA_METADATA_BYTES = 45;
/** The size of a program account. */
export const PROGRAM_ACCOUNT_BYTES = 36;

const tag = (data: Uint8Array): number => new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true);

/** The program-data account a program account points at. Throws if the bytes are not a program account. */
export function decodeProgramAccount(data: Uint8Array): { programData: Address } {
  if (data.length < PROGRAM_ACCOUNT_BYTES || tag(data) !== 2) throw new Error("not an upgradeable-loader program account");
  return { programData: base58.encode(data.subarray(4, 36)) };
}

export interface ProgramData {
  /** The slot of the last deploy. */
  slot: bigint;
  /** Who may replace the program, or undefined if nobody can any more. */
  upgradeAuthority?: Address;
}

/** The metadata at the start of a program-data account (the first 45 bytes are enough). Throws on anything else. */
export function decodeProgramData(data: Uint8Array): ProgramData {
  if (data.length < PROGRAM_DATA_METADATA_BYTES || tag(data) !== 3) throw new Error("not an upgradeable-loader program-data account");
  const slot = new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(4, true);
  const option = data[12];
  if (option === 0) return { slot };
  if (option !== 1) throw new Error("the upgrade authority is neither present nor absent");
  return { slot, upgradeAuthority: base58.encode(data.subarray(13, 45)) };
}
