import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { base58 } from "@scure/base";
import { type Address, addressFromBytes } from "../lib/chain/address";
import { type Instruction, buySpotInstruction } from "../lib/chain/buy";
import { MAX_TRANSACTION_BYTES, buildTransaction, compactU16 } from "../lib/chain/transaction";
import { fromHex, toHex } from "../lib/draw/bytes";
import { decodeMessage, flagsOf, summary } from "./support/message";
import { fill } from "./support/wallet";

const vectors: { programs: { breaks: string }; cases: { name: string; inputs: Record<string, any> }[] } = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "programs", "breaks", "instruction-vectors.json"), "utf8"),
);
const BLOCKHASH = base58.encode(new Uint8Array(32).fill(9));

// Reference bytes produced by web3.js (`Transaction.compileMessage().serialize()` and `serialize({ requireAllSignatures: false })`),
// the real Solana serialization, for the same instructions and blockhash.
const BUY_MESSAGE =
  "0100040904040404040404040404040404040404040404040404040404040404040404047daadaa3d7053edf586065d40e87b517a95d0739e514af08be5ebe1ed9bb71c4c10bd567ecde4932f8f47442b5ccdd85b14a4190691d6b703e4fda43129288f6c4157e491fd12654527e23af386bfcc7458838ecd1b3e709761ac5761038ad5406060606060606060606060606060606060606060606060606060606060606060000000000000000000000000000000000000000000000000000000000000000754486bbae0654733d9066d6b0699891e48a58ae0f9a2057dbc85e642c77440ba491d90252ed916f3353060e96ba37b7f65f0c979c880a8cb3e906ffa65ea98b06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9090909090909090909090909090909090909090909090909090909090909090901060800070201040308050af09879fd5ffb35ee0300";
const MERGED_MESSAGE =
  "020102060101010101010101010101010101010101010101010101010101010101010101030303030303030303030303030303030303030303030303030303030303030302020202020202020202020202020202020202020202020202020202020202020404040404040404040404040404040404040404040404040404040404040404050505050505050505050505050505050505050505050505050505050505050506060606060606060606060606060606060606060606060606060606060606060909090909090909090909090909090909090909090909090909090909090909030403020001030102030503020304000401030109";

describe("compact lengths", () => {
  it("writes numbers 7 bits at a time, as Solana does", () => {
    const hex = (n: number) => toHex(compactU16(n));
    expect(hex(0)).toBe("00");
    expect(hex(1)).toBe("01");
    expect(hex(127)).toBe("7f");
    expect(hex(128)).toBe("8001");
    expect(hex(255)).toBe("ff01");
    expect(hex(256)).toBe("8002");
    expect(hex(16383)).toBe("ff7f");
    expect(hex(16384)).toBe("808001");
    expect(hex(65535)).toBe("ffff03");
  });

  it("refuses what does not fit in 16 bits", () => {
    for (const bad of [-1, 65536, 1.5, Number.NaN]) expect(() => compactU16(bad)).toThrow(RangeError);
  });
});

describe("the transaction a wallet signs", () => {
  const buy = (): Instruction => {
    const v = vectors.cases.find((c) => c.name === "breaks.buy_spot") as { inputs: Record<string, any> };
    return buySpotInstruction({ program: vectors.programs.breaks, buyer: v.inputs.buyer, buyerUsdc: v.inputs.buyerUsdc, breakId: BigInt(v.inputs.breakId), index: v.inputs.index });
  };

  it("says the same as what web3.js builds for the buy_spot instruction", () => {
    const ix = buy();
    const tx = buildTransaction({ feePayer: ix.accounts[0]?.pubkey as Address, recentBlockhash: BLOCKHASH, instructions: [ix] });
    expect(summary(decodeMessage(tx.message))).toEqual(summary(decodeMessage(fromHex(BUY_MESSAGE))));
    // One empty signature slot, then the message.
    expect(toHex(tx.unsigned)).toBe(`01${"00".repeat(64)}${toHex(tx.message)}`);
    expect(tx.signers).toEqual([ix.accounts[0]?.pubkey]);
  });

  it("reads the reference bytes back as the Rust program's own instruction (so the reader and the reference agree with the program)", () => {
    const ix = buy();
    const ref = decodeMessage(fromHex(BUY_MESSAGE));
    expect(ref.instructions).toEqual([{ program: ix.programId, accounts: ix.accounts.map((a) => a.pubkey), data: toHex(ix.data) }]);
    const flags = flagsOf(ref);
    for (const a of ix.accounts) expect(flags.get(a.pubkey), a.pubkey).toEqual({ signer: a.signer, writable: a.writable });
    expect(flags.get(ix.programId)).toEqual({ signer: false, writable: false });
    expect(ref.blockhash).toBe(BLOCKHASH);
  });

  it("puts the fee payer first, then writable accounts, then read-only ones, each group in the order named, the program last", () => {
    const ix = buy();
    const m = decodeMessage(buildTransaction({ feePayer: ix.accounts[0]?.pubkey as Address, recentBlockhash: BLOCKHASH, instructions: [ix] }).message);
    const [buyer, config, brk, escrow, buyerUsdc, spot, token, system] = ix.accounts.map((a) => a.pubkey);
    expect(m.keys).toEqual([buyer, brk, escrow, buyerUsdc, spot, config, token, system, ix.programId]);
    expect([m.numSignatures, m.numReadonlySigned, m.numReadonlyUnsigned]).toEqual([1, 0, 4]);
  });

  it("merges an account named twice, orders signers and writable accounts first, and puts program ids after the accounts", () => {
    const [A, B, C, D, P, Q] = [1, 2, 3, 4, 5, 6].map(fill) as [Address, Address, Address, Address, Address, Address];
    const m = (pubkey: Address, signer: boolean, writable: boolean) => ({ pubkey, signer, writable });
    const tx = buildTransaction({
      feePayer: A,
      recentBlockhash: BLOCKHASH,
      instructions: [
        { programId: P, accounts: [m(B, false, false), m(A, false, false), m(C, true, false)], data: Uint8Array.of(1, 2, 3) },
        { programId: Q, accounts: [m(B, false, true), m(D, false, false), m(P, false, false)], data: new Uint8Array(0) },
        { programId: P, accounts: [m(D, false, true)], data: Uint8Array.of(9) },
      ],
    });
    // The same transaction web3.js builds says the same thing: A and C sign (C only read), B and D are written, P and Q only read.
    expect(summary(decodeMessage(tx.message))).toEqual(summary(decodeMessage(fromHex(MERGED_MESSAGE))));
    expect(decodeMessage(tx.message).keys).toEqual([A, C, B, D, P, Q]);
    expect(tx.signers).toEqual([A, C]);
    expect(toHex(tx.unsigned)).toBe(`02${"00".repeat(128)}${toHex(tx.message)}`);
  });

  it("has the fee payer sign even when no instruction names it", () => {
    const payer = fill(1);
    const tx = buildTransaction({ feePayer: payer, recentBlockhash: BLOCKHASH, instructions: [{ programId: fill(5), accounts: [], data: new Uint8Array(0) }] });
    expect(tx.signers).toEqual([payer]);
    // Header: 1 signer, none of them read-only; the program id is the only read-only unsigned account.
    expect(toHex(tx.message.slice(0, 3))).toBe("010001");
  });

  it("refuses a bad blockhash, no instructions, too many accounts and a transaction that is too big", () => {
    const ix: Instruction = { programId: fill(5), accounts: [], data: new Uint8Array(0) };
    expect(() => buildTransaction({ feePayer: fill(1), recentBlockhash: "abc", instructions: [ix] })).toThrow(RangeError);
    expect(() => buildTransaction({ feePayer: fill(1), recentBlockhash: base58.encode(new Uint8Array(31)), instructions: [ix] })).toThrow("a blockhash is 32 bytes");
    expect(() => buildTransaction({ feePayer: fill(1), recentBlockhash: BLOCKHASH, instructions: [] })).toThrow("needs an instruction");
    const many: Instruction = { programId: fill(5), accounts: Array.from({ length: 300 }, (_, i) => ({ pubkey: addressFromBytes(Uint8Array.from({ length: 32 }, (_, j) => (j === 0 ? i % 256 : j === 1 ? Math.floor(i / 256) + 1 : 7))), signer: false, writable: false })), data: new Uint8Array(0) };
    expect(() => buildTransaction({ feePayer: fill(1), recentBlockhash: BLOCKHASH, instructions: [many] })).toThrow("too many accounts");
    const big: Instruction = { programId: fill(5), accounts: [], data: new Uint8Array(MAX_TRANSACTION_BYTES) };
    expect(() => buildTransaction({ feePayer: fill(1), recentBlockhash: BLOCKHASH, instructions: [big] })).toThrow(/over the 1232 a transaction may take/);
  });

  it("counts every account once, program ids and the fee payer included, and stops at 255", () => {
    const accountsOf = (n: number): Instruction => ({
      programId: fill(5),
      accounts: Array.from({ length: n }, (_, i) => ({ pubkey: addressFromBytes(Uint8Array.from({ length: 32 }, (_, j) => (j === 0 ? i % 256 : j === 1 ? Math.floor(i / 256) + 1 : 7))), signer: false, writable: false })),
      data: new Uint8Array(0),
    });
    const build = (n: number) => buildTransaction({ feePayer: fill(1), recentBlockhash: BLOCKHASH, instructions: [accountsOf(n)] });
    // The fee payer and the program id make two more: 253 + 2 = 255 accounts is within the limit (and then too big for the wire),
    // 254 + 2 = 256 is one too many to number with a byte.
    expect(() => build(253)).toThrow(/over the 1232 a transaction may take/);
    expect(() => build(254)).toThrow("too many accounts");
  });

  it("takes exactly the biggest transaction allowed", () => {
    const base = buildTransaction({ feePayer: fill(1), recentBlockhash: BLOCKHASH, instructions: [{ programId: fill(5), accounts: [], data: new Uint8Array(0) }] }).unsigned.length;
    // Data length 0 uses a one-byte length; 128 bytes or more uses two, so fill up to the limit with a known overhead.
    const room = MAX_TRANSACTION_BYTES - base;
    const fits = buildTransaction({ feePayer: fill(1), recentBlockhash: BLOCKHASH, instructions: [{ programId: fill(5), accounts: [], data: new Uint8Array(room - 1) }] });
    expect(fits.unsigned.length).toBe(MAX_TRANSACTION_BYTES);
    expect(() => buildTransaction({ feePayer: fill(1), recentBlockhash: BLOCKHASH, instructions: [{ programId: fill(5), accounts: [], data: new Uint8Array(room) }] })).toThrow(RangeError);
  });
});
