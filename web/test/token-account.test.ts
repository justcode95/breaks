import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ASSOCIATED_TOKEN_PROGRAM, associatedTokenAddress } from "../lib/chain/address";
import { TOKEN_ACCOUNT_BYTES, openTokenAccountInstruction } from "../lib/chain/token-account";
import { toHex } from "../lib/draw/bytes";
import { fill } from "./support/wallet";

interface Case {
  name: string;
  inputs: Record<string, any>;
  data?: string;
  outputs?: Record<string, any>;
  accounts?: { pubkey: string; signer: boolean; writable: boolean }[];
}
// Made by the treasury's Rust tests; this case by the associated token program's own interface crate.
const vectors: { cases: Case[] } = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "programs", "treasury", "instruction-vectors.json"), "utf8"));
const named = (n: string) => vectors.cases.find((c) => c.name === n) as Case;

describe("opening a wallet's token account", () => {
  it("is byte for byte the instruction the associated token program's own crate builds", () => {
    const v = named("spl.associated_token.create_idempotent");
    const ix = openTokenAccountInstruction({ payer: v.inputs.payer, owner: v.inputs.owner, mint: v.inputs.mint });
    expect(ix.programId).toBe(v.inputs.programId);
    expect(ix.programId).toBe(ASSOCIATED_TOKEN_PROGRAM);
    expect(toHex(ix.data)).toBe(v.data);
    expect(ix.accounts).toEqual(v.accounts);
  });

  it("opens the owner's account for that mint, whoever pays, and only the payer signs", () => {
    const ix = openTokenAccountInstruction({ payer: fill(1), owner: fill(2), mint: fill(3) });
    expect(ix.accounts[1]?.pubkey).toBe(associatedTokenAddress(fill(2), fill(3)));
    expect(openTokenAccountInstruction({ payer: fill(9), owner: fill(2), mint: fill(3) }).accounts[1]).toEqual(ix.accounts[1]);
    expect(openTokenAccountInstruction({ payer: fill(1), owner: fill(2), mint: fill(4) }).accounts[1]?.pubkey).not.toBe(ix.accounts[1]?.pubkey);
    expect(ix.accounts.filter((a) => a.signer).map((a) => a.pubkey)).toEqual([fill(1)]);
  });

  it("costs the rent of a token account: the size the token program's own account sample has", () => {
    expect(TOKEN_ACCOUNT_BYTES).toBe(named("spl.account.TokenAccount").inputs.data.length / 2);
  });
});
