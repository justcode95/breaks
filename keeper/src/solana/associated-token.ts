// The associated token program's `CreateIdempotent`: makes a wallet's usual token account for a mint, and does nothing if it
// already exists. Anyone can pay for it. Layout from the program's interface (instruction 1; payer, account, owner, mint, system
// program, token program), pinned to the instruction the interface crate itself builds (`spl.associated_token.create_idempotent` in
// programs/treasury/instruction-vectors.json).

import {
  type Instruction,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  readonly,
  signerMut,
  writable,
} from "./instruction.js";
import { ASSOCIATED_TOKEN_PROGRAM, type Address, associatedTokenAddress } from "./pubkey.js";

export function createAssociatedTokenAccountIdempotent(p: { payer: Address; owner: Address; mint: Address }): Instruction {
  return {
    programId: ASSOCIATED_TOKEN_PROGRAM,
    accounts: [
      signerMut(p.payer),
      writable(associatedTokenAddress(p.owner, p.mint)),
      readonly(p.owner),
      readonly(p.mint),
      readonly(SYSTEM_PROGRAM),
      readonly(TOKEN_PROGRAM),
    ],
    data: Uint8Array.of(1),
  };
}
