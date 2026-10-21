// Opening a wallet's usual token account for a mint: the associated token program's `CreateIdempotent`, which does nothing if the
// account is there already. Anyone can pay for it and the account is the owner's either way; the rent the payer puts in stays in
// the account. Byte for byte what the program's own interface crate builds (`spl.associated_token.create_idempotent` in
// programs/treasury/instruction-vectors.json).

import { ASSOCIATED_TOKEN_PROGRAM, type Address, SYSTEM_PROGRAM, TOKEN_PROGRAM, associatedTokenAddress } from "./address";
import type { Instruction } from "./buy";

/** The size of a token account of the token program: opening one costs the rent of this many bytes. */
export const TOKEN_ACCOUNT_BYTES = 165;

export function openTokenAccountInstruction(a: { payer: Address; owner: Address; mint: Address }): Instruction {
  return {
    programId: ASSOCIATED_TOKEN_PROGRAM,
    accounts: [
      { pubkey: a.payer, signer: true, writable: true },
      { pubkey: associatedTokenAddress(a.owner, a.mint), signer: false, writable: true },
      { pubkey: a.owner, signer: false, writable: false },
      { pubkey: a.mint, signer: false, writable: false },
      { pubkey: SYSTEM_PROGRAM, signer: false, writable: false },
      { pubkey: TOKEN_PROGRAM, signer: false, writable: false },
    ],
    data: Uint8Array.of(1),
  };
}
