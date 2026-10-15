// The SPL token account layout (the token program's `Account`, 165 bytes; Token-2022 accounts start the same way).

import { base58 } from "@scure/base";
import type { Address } from "./pubkey.js";

const ACCOUNT_LEN = 165;

export interface TokenAccount {
  mint: Address;
  owner: Address;
  /** Balance in the token's base units. */
  amount: bigint;
}

/** Reads `mint` (offset 0), `owner` (32) and `amount` (64) of a token account. */
export function decodeTokenAccount(data: Uint8Array): TokenAccount {
  if (data.length < ACCOUNT_LEN) throw new RangeError(`a token account is at least ${ACCOUNT_LEN} bytes, got ${data.length}`);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    mint: base58.encode(data.subarray(0, 32)),
    owner: base58.encode(data.subarray(32, 64)),
    amount: view.getBigUint64(64, true),
  };
}

export interface Mint {
  /** Total supply in base units. */
  supply: bigint;
  decimals: number;
  initialized: boolean;
}

/** Reads a mint (the token program's `Mint`, 82 bytes; Token-2022 mints start the same way): supply at 36, decimals at 44, initialized at 45. */
export function decodeMint(data: Uint8Array): Mint {
  if (data.length < 82) throw new RangeError(`a token mint is at least 82 bytes, got ${data.length}`);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { supply: view.getBigUint64(36, true), decimals: data[44] as number, initialized: data[45] === 1 };
}
