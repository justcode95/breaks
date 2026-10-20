import { describe, expect, it } from "vitest";
import { createAssociatedTokenAccountIdempotent } from "../src/solana/associated-token.js";
import { ASSOCIATED_TOKEN_PROGRAM, associatedTokenAddress } from "../src/solana/pubkey.js";
import { addr } from "./support/chain.js";

// The layout of the associated token program's `CreateIdempotent`: the program ATokenGPv..., instruction 1, and these six accounts
// in this order. Also checked against the instruction the program's own interface crate builds (the vector
// `spl.associated_token.create_idempotent` in programs/treasury/instruction-vectors.json, in instructions.test.ts).
describe("createAssociatedTokenAccountIdempotent", () => {
  const payer = addr(1);
  const owner = addr(2);
  const mint = addr(3);

  it("is the program's instruction 1 with no other data", () => {
    const ix = createAssociatedTokenAccountIdempotent({ payer, owner, mint });
    expect(ix.programId).toBe("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
    expect(ix.programId).toBe(ASSOCIATED_TOKEN_PROGRAM);
    expect(ix.data).toEqual(Uint8Array.of(1));
  });

  it("lists the payer (signer, writable), the new account (writable), the owner, the mint, the system program and the token program", () => {
    const ix = createAssociatedTokenAccountIdempotent({ payer, owner, mint });
    expect(ix.accounts).toEqual([
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: associatedTokenAddress(owner, mint), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: "11111111111111111111111111111111", isSigner: false, isWritable: false },
      { pubkey: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", isSigner: false, isWritable: false },
    ]);
  });

  it("makes the account of the owner, not of the payer", () => {
    const a = createAssociatedTokenAccountIdempotent({ payer, owner, mint });
    const b = createAssociatedTokenAccountIdempotent({ payer: addr(9), owner, mint });
    expect(a.accounts[1]).toEqual(b.accounts[1]);
    expect(createAssociatedTokenAccountIdempotent({ payer, owner: addr(8), mint }).accounts[1]).not.toEqual(a.accounts[1]);
  });
});
