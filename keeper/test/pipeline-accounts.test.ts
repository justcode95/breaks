import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fromHex, toHex } from "../src/draw/bytes.js";
import { decodeBreak, decodeBreaksConfig, decodeRequest, decodeSpot } from "../src/solana/breaks.js";
import { addr } from "./support/chain.js";
import { encodeBreak, encodeBreaksConfig, encodeRequest, encodeSpot } from "./support/accounts.js";

// The pretend chain stores accounts with these encoders, so they must produce exactly the bytes the Rust
// program writes: each sample from the Rust-generated vectors goes bytes → value → bytes unchanged.
const vectors = JSON.parse(readFileSync(new URL("../../programs/breaks/instruction-vectors.json", import.meta.url), "utf8")) as {
  cases: { name: string; inputs: { data?: string } }[];
};
const sample = (name: string) => fromHex(vectors.cases.find((c) => c.name === name)?.inputs.data as string);

describe("test account encoders", () => {
  it("Break round-trips the bytes the program wrote", () => {
    const bytes = sample("breaks.account.Break");
    expect(toHex(encodeBreak(decodeBreak(bytes)))).toBe(toHex(bytes));
  });

  it("BreaksConfig round-trips the bytes the program wrote", () => {
    const bytes = sample("breaks.account.BreaksConfig");
    expect(toHex(encodeBreaksConfig(decodeBreaksConfig(bytes)))).toBe(toHex(bytes));
  });

  it("Spot round-trips the bytes the program wrote", () => {
    const bytes = sample("breaks.account.Spot");
    expect(toHex(encodeSpot(decodeSpot(bytes)))).toBe(toHex(bytes));
  });

  it("ORAO request accounts match the bytes the real crate writes", () => {
    // The fixtures of the mock-orao tests: client [7; 32], seed [9; 32], randomness 0..64.
    const FULFILLED =
      "8befb8d7e356bfe20107070707070707070707070707070707070707070707070707070707070707070909090909090909090909090909090909090909090909090909090909090909000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f";
    const PENDING =
      "8befb8d7e356bfe2000707070707070707070707070707070707070707070707070707070707070707090909090909090909090909090909090909090909090909090909090909090900000000";
    const client = addr(7);
    const seed = new Uint8Array(32).fill(9);
    expect(toHex(encodeRequest(client, seed, { state: "fulfilled", randomness: Uint8Array.from({ length: 64 }, (_, i) => i) }))).toBe(FULFILLED);
    expect(toHex(encodeRequest(client, seed, { state: "pending" }))).toBe(PENDING);
    expect(decodeRequest(encodeRequest(client, seed, { state: "pending" }), seed)).toEqual({ state: "pending" });
  });
});
