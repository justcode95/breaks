import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { Message, Transaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { equalBytes } from "../src/draw/bytes.js";
import * as breaks from "../src/solana/breaks.js";
import type { Instruction } from "../src/solana/instruction.js";
import { loadSignerFromFile, signerFromSecretKey } from "../src/solana/keypair.js";
import { type Address, addressFromBytes } from "../src/solana/pubkey.js";
import {
  MAX_TRANSACTION_SIZE,
  MissingSignerError,
  TransactionTooLargeError,
  compileMessage,
  shortvec,
  signTransaction,
  signatureToString,
} from "../src/solana/transaction.js";
import { addr } from "./support/chain.js";

const seedOf = (n: number) => new Uint8Array(32).fill(n);
const keeper = signerFromSecretKey(seedOf(1));
const other = signerFromSecretKey(seedOf(2));
const blockhash = addr(9);
const PROGRAMS = { breaks: "8tmJjCG3D4TF7oPiPWNoaCjZ4pN2U4H237BSGVw2B8KU", treasury: "Bvq3U9fz2MiHkLH8u4zyt6T1bimxnaEuHkZhezNDT5R9" };

const ix = (programId: Address, accounts: Instruction["accounts"], data: number[] = [1, 2, 3]): Instruction => ({
  programId,
  accounts,
  data: Uint8Array.from(data),
});
const meta = (pubkey: Address, isSigner: boolean, isWritable: boolean) => ({ pubkey, isSigner, isWritable });

/** Parses our bytes with web3.js and checks that every instruction means exactly what we were asked for. */
function expectSameMeaning(messageBytes: Uint8Array, feePayer: Address, instructions: Instruction[]) {
  const parsed = Message.from(messageBytes);
  const keys = parsed.accountKeys.map((k) => k.toBase58());
  expect(keys[0]).toBe(feePayer);
  expect(new Set(keys).size).toBe(keys.length);

  // The strongest flags each account was used with.
  const want = new Map<string, { signer: boolean; writable: boolean }>([[feePayer, { signer: true, writable: true }]]);
  const merge = (k: string, signer: boolean, writable: boolean) => {
    const w = want.get(k) ?? { signer: false, writable: false };
    want.set(k, { signer: w.signer || signer, writable: w.writable || writable });
  };
  for (const i of instructions) for (const a of i.accounts) merge(a.pubkey, a.isSigner, a.isWritable);
  for (const i of instructions) merge(i.programId, false, false);
  expect([...keys].sort()).toEqual([...want.keys()].sort());
  for (const [i, k] of keys.entries()) {
    expect(parsed.isAccountSigner(i), `signer ${k}`).toBe(want.get(k)?.signer);
    expect(parsed.isAccountWritable(i), `writable ${k}`).toBe(want.get(k)?.writable);
  }

  expect(parsed.instructions).toHaveLength(instructions.length);
  for (const [n, compiled] of parsed.instructions.entries()) {
    const original = instructions[n] as Instruction;
    expect(keys[compiled.programIdIndex]).toBe(original.programId);
    expect(compiled.accounts.map((a) => keys[a])).toEqual(original.accounts.map((a) => a.pubkey));
    expect(Buffer.from(base58.decode(compiled.data))).toEqual(Buffer.from(original.data));
  }
  return parsed;
}

describe("shortvec", () => {
  it("matches the Solana encoding at its boundaries", () => {
    const enc = (n: number) => Array.from(shortvec(n));
    expect(enc(0)).toEqual([0]);
    expect(enc(127)).toEqual([0x7f]);
    expect(enc(128)).toEqual([0x80, 0x01]);
    expect(enc(255)).toEqual([0xff, 0x01]);
    expect(enc(16383)).toEqual([0xff, 0x7f]);
    expect(enc(16384)).toEqual([0x80, 0x80, 0x01]);
    expect(() => shortvec(-1)).toThrow();
    expect(() => shortvec(65536)).toThrow();
  });
});

describe("compileMessage", () => {
  it("puts the fee payer first and groups signers before the rest, writable before read-only", () => {
    const a = addr(20);
    const b = addr(21);
    const c = addr(22);
    const d = addr(23);
    const program = addr(30);
    const instructions = [ix(program, [meta(d, false, false), meta(c, false, true), meta(other.address, true, false), meta(b, false, true), meta(a, true, true)])];
    const { bytes, signers } = compileMessage(keeper.address, instructions, blockhash);
    const parsed = expectSameMeaning(bytes, keeper.address, instructions);
    expect(signers).toEqual([keeper.address, a, other.address]);
    expect(parsed.header).toEqual({ numRequiredSignatures: 3, numReadonlySignedAccounts: 1, numReadonlyUnsignedAccounts: 2 });
    expect(parsed.recentBlockhash).toBe(blockhash);
  });

  it("merges the flags of an account used twice and lists a program id once", () => {
    const shared = addr(40);
    const program = addr(41);
    const instructions = [
      ix(program, [meta(shared, false, false)]),
      ix(program, [meta(shared, false, true), meta(keeper.address, true, false)]),
      ix(addr(42), [meta(program, false, false)]),
    ];
    const { bytes } = compileMessage(keeper.address, instructions, blockhash);
    const parsed = expectSameMeaning(bytes, keeper.address, instructions);
    expect(parsed.accountKeys.filter((k) => k.toBase58() === program)).toHaveLength(1);
    expect(parsed.header.numRequiredSignatures).toBe(1);
  });

  it("works for an instruction that only uses the fee payer, and for no accounts at all", () => {
    const instructions = [ix(addr(50), [], [])];
    const { bytes } = compileMessage(keeper.address, instructions, blockhash);
    expectSameMeaning(bytes, keeper.address, instructions);
  });

  it("handles data and account lists past the one-byte length boundary", () => {
    const many = Array.from({ length: 130 }, (_, i) => meta(addr(100 + (i % 100)), false, i % 2 === 0));
    const instructions = [ix(addr(60), many.slice(0, 100), Array.from({ length: 300 }, (_, i) => i & 0xff))];
    const { bytes } = compileMessage(keeper.address, instructions, blockhash);
    expectSameMeaning(bytes, keeper.address, instructions);
  });

  it("refuses more than 255 accounts", () => {
    const accounts = Array.from({ length: 256 }, (_, i) => meta(addressFromBytes(Uint8Array.from({ length: 32 }, (_, j) => (j === 0 ? i : 7))), false, false));
    expect(() => compileMessage(keeper.address, [ix(addr(60), accounts)], blockhash)).toThrow(/too many accounts/);
  });

  it("compiles the program's own instructions into something web3.js reads the same way", () => {
    const instructions = [
      breaks.commitPool(PROGRAMS, { keeper: keeper.address, breakId: 7n, poolHash: seedOf(3), poolSize: 5 }),
      breaks.requestRandomness(PROGRAMS, {
        keeper: keeper.address,
        breakId: 7n,
        vrfProgram: breaks.ORAO_PROGRAM,
        vrfNetworkState: addr(0xa1),
        vrfTreasury: addr(0xa2),
        seed: seedOf(4),
        extra: [{ pubkey: addr(0xb1), writable: true }],
      }),
      breaks.claimFreeSpot(PROGRAMS, {
        payer: keeper.address,
        breakId: 7n,
        index: 1,
        wallet: addr(60),
        weight: 10n,
        proof: Array.from({ length: 14 }, () => ({ hash: seedOf(5), sum: 3n, siblingIsLeft: true })),
      }),
    ];
    for (const one of instructions) expectSameMeaning(compileMessage(keeper.address, [one], blockhash).bytes, keeper.address, [one]);
  });
});

describe("signTransaction", () => {
  const instructions = [ix(addr(70), [meta(addr(71), false, true)])];

  it("produces a transaction web3.js can read and whose signature verifies", () => {
    const message = compileMessage(keeper.address, instructions, blockhash);
    const tx = signTransaction(message, [keeper]);
    const parsed = Transaction.from(tx.bytes);
    expect(parsed.verifySignatures()).toBe(true);
    expect(parsed.signatures).toHaveLength(1);
    expect(parsed.signatures[0]?.publicKey.toBase58()).toBe(keeper.address);
    expect(signatureToString(tx.signatures[0] as Uint8Array)).toBe(base58.encode(parsed.signature as Buffer));
    expect(ed25519.verify(tx.signatures[0] as Uint8Array, message.bytes, ed25519.getPublicKey(seedOf(1)))).toBe(true);
  });

  it("signs for every required signer, in the order of the account list", () => {
    const two = [ix(addr(70), [meta(other.address, true, false)])];
    const message = compileMessage(keeper.address, two, blockhash);
    const tx = signTransaction(message, [other, keeper]);
    const parsed = Transaction.from(tx.bytes);
    expect(parsed.verifySignatures()).toBe(true);
    expect(parsed.signatures.map((s) => s.publicKey.toBase58())).toEqual([keeper.address, other.address]);
  });

  it("refuses to sign when a required signer is not ours", () => {
    const message = compileMessage(keeper.address, [ix(addr(70), [meta(addr(80), true, false)])], blockhash);
    expect(() => signTransaction(message, [keeper])).toThrow(MissingSignerError);
  });

  it("refuses a transaction that does not fit in a packet", () => {
    const big = [ix(addr(70), [], new Array(1200).fill(1))];
    expect(() => signTransaction(compileMessage(keeper.address, big, blockhash), [keeper])).toThrow(TransactionTooLargeError);
    const edge = [ix(addr(70), [], new Array(1000).fill(1))];
    const tx = signTransaction(compileMessage(keeper.address, edge, blockhash), [keeper]);
    expect(tx.bytes.length).toBeLessThanOrEqual(MAX_TRANSACTION_SIZE);
  });

  it("is deterministic: the same message gives the same signature", () => {
    const message = compileMessage(keeper.address, instructions, blockhash);
    expect(equalBytes(signTransaction(message, [keeper]).signatures[0] as Uint8Array, signTransaction(message, [keeper]).signatures[0] as Uint8Array)).toBe(true);
  });
});

describe("signers", () => {
  it("derives the address from a seed or from the 64-byte CLI format", () => {
    const seed = seedOf(7);
    const pub = ed25519.getPublicKey(seed);
    const a = signerFromSecretKey(seed);
    const b = signerFromSecretKey(new Uint8Array([...seed, ...pub]));
    expect(a.address).toBe(addressFromBytes(pub));
    expect(b.address).toBe(a.address);
  });

  it("refuses a 64-byte key whose halves do not match, and other lengths", () => {
    expect(() => signerFromSecretKey(new Uint8Array([...seedOf(7), ...seedOf(8)]))).toThrow(/does not belong/);
    expect(() => signerFromSecretKey(new Uint8Array(31))).toThrow(/32 or 64/);
  });

  it("reads a keypair file, and never puts the secret in an error", () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-key-"));
    const seed = seedOf(9);
    const file = join(dir, "key.json");
    writeFileSync(file, JSON.stringify([...seed, ...ed25519.getPublicKey(seed)]));
    expect(loadSignerFromFile(file).address).toBe(signerFromSecretKey(seed).address);

    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify([1, 2, 3, "SECRET-DO-NOT-LEAK"]));
    expect(() => loadSignerFromFile(bad)).toThrow(/not a keypair file/);
    try {
      loadSignerFromFile(bad);
    } catch (err) {
      expect(String(err)).not.toContain("SECRET-DO-NOT-LEAK");
    }
    expect(() => loadSignerFromFile(join(dir, "missing.json"))).toThrow(/could not read a keypair/);
    writeFileSync(join(dir, "text.json"), "not json SECRET-DO-NOT-LEAK");
    try {
      loadSignerFromFile(join(dir, "text.json"));
    } catch (err) {
      expect(String(err)).not.toContain("SECRET-DO-NOT-LEAK");
    }
  });
});
