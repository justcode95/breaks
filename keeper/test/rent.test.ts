import { describe, expect, it } from "vitest";
import { RANDOMNESS_REQUEST_RENT } from "../src/app.js";
import {
  ACCOUNT_OVERHEAD_BYTES,
  BREAK_ACCOUNT_BYTES,
  LAMPORTS_PER_BYTE,
  RANDOMNESS_REQUEST_ACCOUNT_BYTES,
  SIGNATURE_FEE,
  TOKEN_ACCOUNT_BYTES,
  createBreakCost,
  rentExempt,
} from "../src/solana/rent.js";
import breaksVectors from "../../programs/breaks/instruction-vectors.json" with { type: "json" };
import treasuryVectors from "../../programs/treasury/instruction-vectors.json" with { type: "json" };

interface VectorCase {
  name: string;
  inputs: { data?: string };
}
const sizeOf = (file: { cases: unknown[] }, name: string): number => {
  const c = (file.cases as VectorCase[]).find((x) => x.name === name);
  if (!c?.inputs.data) throw new Error(`no sample account ${name}`);
  return c.inputs.data.length / 2;
};

describe("rent", () => {
  it("is what every Solana tool shows: 890,880 for an empty account, 2,039,280 for a token account, 2,282,880 for 200 bytes", () => {
    expect(rentExempt(0)).toBe(890_880n);
    expect(rentExempt(165)).toBe(2_039_280n);
    expect(rentExempt(200)).toBe(2_282_880n);
    expect(LAMPORTS_PER_BYTE).toBe(6_960n);
    expect(ACCOUNT_OVERHEAD_BYTES).toBe(128n);
  });

  it("grows by 6,960 lamports for every byte of data", () => {
    expect(rentExempt(1) - rentExempt(0)).toBe(6_960n);
    expect(rentExempt(1_000) - rentExempt(999)).toBe(6_960n);
  });

  it("uses the size of the Rust accounts: the break the program writes and the SPL token account it makes", () => {
    expect(BREAK_ACCOUNT_BYTES).toBe(sizeOf(breaksVectors, "breaks.account.Break"));
    expect(TOKEN_ACCOUNT_BYTES).toBe(sizeOf(treasuryVectors, "spl.account.TokenAccount"));
  });

  it("costs a new break the rent of its two accounts, the fee, and what a wallet must keep to stay valid", () => {
    expect(createBreakCost()).toEqual({ rent: 8_358_960n + 2_039_280n, fee: 5_000n, keep: 890_880n, total: 8_358_960n + 2_039_280n + 5_000n + 890_880n });
    expect(createBreakCost().total).toBe(11_294_120n); // 0.0113 SOL
    expect(rentExempt(BREAK_ACCOUNT_BYTES)).toBe(8_358_960n);
    expect(SIGNATURE_FEE).toBe(5_000n);
  });

  it("covers ORAO's request account, as measured on devnet (749 bytes), not a round guess", () => {
    expect(RANDOMNESS_REQUEST_ACCOUNT_BYTES).toBe(749);
    expect(RANDOMNESS_REQUEST_RENT).toBe(6_103_920n);
    expect(RANDOMNESS_REQUEST_RENT).toBe(rentExempt(749));
  });
});
