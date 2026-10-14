import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fromHex, toHex } from "../src/draw/bytes.js";
import * as breaks from "../src/solana/breaks.js";
import { Reader, Writer } from "../src/solana/codec.js";
import type { Instruction } from "../src/solana/instruction.js";
import { decodeTokenAccount } from "../src/solana/token.js";
import * as treasury from "../src/solana/treasury.js";

// The Rust tests generate these files from the programs themselves (instruction data, account order and
// flags, derived addresses, account bytes). Everything below must reproduce them exactly.
interface Case {
  name: string;
  // biome-ignore lint/suspicious/noExplicitAny: JSON from the Rust tests
  inputs: Record<string, any>;
  data?: string;
  accounts?: { pubkey: string; signer: boolean; writable: boolean }[];
  // biome-ignore lint/suspicious/noExplicitAny: JSON from the Rust tests
  outputs?: Record<string, any>;
}
interface VectorFile {
  programs: Record<string, string>;
  cases: Case[];
}

const load = (path: string): VectorFile => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const treasuryVectors = load("../../programs/treasury/instruction-vectors.json");
const breaksVectors = load("../../programs/breaks/instruction-vectors.json");

const programs: breaks.Programs = {
  breaks: breaksVectors.programs.breaks as string,
  treasury: treasuryVectors.programs.treasury as string,
};
const big = (s: string) => BigInt(s);
const bytes = (s: string) => fromHex(s);

/** Turns decoded values into the JSON shape the vectors use: bigint as a string, bytes as hex. */
function plain(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return toHex(value);
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  return value;
}

function expectInstruction(ix: Instruction, c: Case, programId: string) {
  expect(ix.programId).toBe(programId);
  expect(toHex(ix.data)).toBe(c.data);
  expect(ix.accounts.map((a) => ({ pubkey: a.pubkey, signer: a.isSigner, writable: a.isWritable }))).toEqual(c.accounts);
}

type Builder = (i: Case["inputs"]) => Instruction;

const treasuryBuilders: Record<string, Builder> = {
  "treasury.initialize": (i) =>
    treasury.initialize(programs.treasury, {
      authority: i.authority,
      usdcMint: i.usdcMint,
      admin: i.admin,
      subsidyBps: i.subsidyBps,
      holderBps: i.holderBps,
    }),
  "treasury.deposit_fees": (i) =>
    treasury.depositFees(programs.treasury, {
      depositor: i.depositor,
      depositorUsdc: i.depositorUsdc,
      amount: big(i.amount),
    }),
  "treasury.set_split": (i) =>
    treasury.setSplit(programs.treasury, { admin: i.admin, subsidyBps: i.subsidyBps, holderBps: i.holderBps }),
  "treasury.set_controller": (i) =>
    treasury.setController(programs.treasury, { admin: i.admin, controller: i.controller }),
  "treasury.lock_funds": (i) =>
    treasury.lockFunds(programs.treasury, {
      controller: i.controller,
      subsidy: big(i.subsidy),
      holder: big(i.holder),
    }),
  "treasury.unlock_funds": (i) =>
    treasury.unlockFunds(programs.treasury, {
      controller: i.controller,
      subsidy: big(i.subsidy),
      holder: big(i.holder),
    }),
  "treasury.pay_from_locked": (i) =>
    treasury.payFromLocked(programs.treasury, {
      controller: i.controller,
      destination: i.destination,
      bucket: i.bucket,
      amount: big(i.amount),
    }),
};

const breaksBuilders: Record<string, Builder> = {
  "breaks.initialize": (i) =>
    breaks.initialize(programs, {
      authority: i.authority,
      usdcMint: i.usdcMint,
      admin: i.admin,
      keeper: i.keeper,
      buyer: i.buyer,
      minWindowSecs: big(i.minWindowSecs),
      maxWindowSecs: big(i.maxWindowSecs),
      maxPaidSpots: i.maxPaidSpots,
      maxFreeSpots: i.maxFreeSpots,
      randomnessProgram: i.randomnessProgram,
      randomnessTimeoutSecs: big(i.randomnessTimeoutSecs),
    }),
  "breaks.set_keeper": (i) => breaks.setKeeper(programs, { admin: i.admin, keeper: i.keeper }),
  "breaks.set_buyer": (i) => breaks.setBuyer(programs, { admin: i.admin, buyer: i.buyer }),
  "breaks.set_paused": (i) => breaks.setPaused(programs, { admin: i.admin, paused: i.paused }),
  "breaks.set_randomness": (i) =>
    breaks.setRandomness(programs, { admin: i.admin, program: i.program, timeoutSecs: big(i.timeoutSecs) }),
  "breaks.create_break": (i) =>
    breaks.createBreak(programs, {
      keeper: i.keeper,
      usdcMint: i.usdcMint,
      breakId: big(i.breakId),
      paidSpots: i.paidSpots,
      freeSpots: i.freeSpots,
      spotPrice: big(i.spotPrice),
      maxPackPrice: big(i.maxPackPrice),
      packMachine: bytes(i.packMachine),
      opensAt: big(i.opensAt),
      closesAt: big(i.closesAt),
    }),
  "breaks.buy_spot": (i) =>
    breaks.buySpot(programs, { buyer: i.buyer, buyerUsdc: i.buyerUsdc, breakId: big(i.breakId), index: i.index }),
  "breaks.close_break": (i) => breaks.closeBreak(programs, { breakId: big(i.breakId) }),
  "breaks.commit_eligibility": (i) =>
    breaks.commitEligibility(programs, {
      keeper: i.keeper,
      breakId: big(i.breakId),
      root: bytes(i.root),
      totalWeight: big(i.totalWeight),
      entryCount: i.entryCount,
      inputsHash: bytes(i.inputsHash),
    }),
  "breaks.commit_pool": (i) =>
    breaks.commitPool(programs, {
      keeper: i.keeper,
      breakId: big(i.breakId),
      poolHash: bytes(i.poolHash),
      poolSize: i.poolSize,
    }),
  "breaks.fund_purchases": (i) =>
    breaks.fundPurchases(programs, { keeper: i.keeper, breakId: big(i.breakId), buyerUsdc: i.buyerUsdc }),
  "breaks.request_randomness": (i) =>
    breaks.requestRandomness(programs, {
      keeper: i.keeper,
      breakId: big(i.breakId),
      vrfProgram: i.vrfProgram,
      vrfNetworkState: i.vrfNetworkState,
      vrfTreasury: i.vrfTreasury,
      seed: bytes(i.seed),
      previousRequest: i.previousRequest,
      extra: i.extra,
    }),
  "breaks.settle_randomness": (i) =>
    breaks.settleRandomness(programs, { breakId: big(i.breakId), request: i.request }),
  "breaks.claim_free_spot": (i) =>
    breaks.claimFreeSpot(programs, {
      payer: i.payer,
      breakId: big(i.breakId),
      index: i.index,
      wallet: i.wallet,
      weight: big(i.weight),
      proof: i.proof.map((s: { hash: string; sum: string; siblingIsLeft: boolean }) => ({
        hash: bytes(s.hash),
        sum: big(s.sum),
        siblingIsLeft: s.siblingIsLeft,
      })),
    }),
  "breaks.cancel_break": (i) => breaks.cancelBreak(programs, { admin: i.admin, breakId: big(i.breakId) }),
  "breaks.refund_spot": (i) =>
    breaks.refundSpot(programs, { breakId: big(i.breakId), index: i.index, ownerUsdc: i.ownerUsdc }),
};

type Decoder = (data: Uint8Array) => unknown;
const decoders: Record<string, Decoder> = {
  "treasury.account.Config": treasury.decodeTreasuryConfig,
  "spl.account.TokenAccount": decodeTokenAccount,
  "breaks.account.Break": breaks.decodeBreak,
  "breaks.account.BreaksConfig": breaks.decodeBreaksConfig,
  "breaks.account.Spot": breaks.decodeSpot,
};

const values: Record<string, (i: Case["inputs"]) => Record<string, unknown>> = {
  "breaks.request_id": (i) => ({
    requestId: breaks.requestId(i.break, i.attempt, bytes(i.eligibilityRoot), bytes(i.poolHash)),
  }),
  "breaks.draw_seed": (i) => ({ seed: breaks.drawSeed(bytes(i.answer)) }),
};

function check(file: VectorFile, programId: string, builders: Record<string, Builder>) {
  for (const c of file.cases) {
    const build = builders[c.name];
    const decode = decoders[c.name];
    const value = values[c.name];
    // A case the TypeScript side does not know about fails here, so the two sides cannot drift apart.
    if (!build && !decode && !value) throw new Error(`no TypeScript counterpart for the vector "${c.name}"`);
    const label = `${c.name} (${JSON.stringify(c.inputs).slice(0, 80)})`;
    it(label, () => {
      if (build) expectInstruction(build(c.inputs), c, programId);
      else if (decode) expect(plain(decode(bytes(c.inputs.data)))).toEqual(c.outputs);
      else if (value) expect(plain(value(c.inputs))).toEqual(c.outputs);
    });
  }
}

describe("treasury instructions and accounts match the Rust program", () => {
  check(treasuryVectors, programs.treasury, treasuryBuilders);
});

describe("breaks instructions, ids and accounts match the Rust program", () => {
  check(breaksVectors, programs.breaks, breaksBuilders);

  it("covers every builder", () => {
    const used = new Set(breaksVectors.cases.map((c) => c.name));
    for (const name of Object.keys(breaksBuilders)) expect(used.has(name), `${name} has no vector`).toBe(true);
    const usedTreasury = new Set(treasuryVectors.cases.map((c) => c.name));
    for (const name of Object.keys(treasuryBuilders)) expect(usedTreasury.has(name), `${name} has no vector`).toBe(true);
  });
});

describe("account decoding refuses the wrong thing", () => {
  const configCase = breaksVectors.cases.find((c) => c.name === "breaks.account.BreaksConfig") as Case;
  const spotCase = breaksVectors.cases.find((c) => c.name === "breaks.account.Spot") as Case;

  it("rejects an account of another type", () => {
    expect(() => breaks.decodeSpot(bytes(configCase.inputs.data))).toThrow(/wrong discriminator/);
    expect(() => breaks.decodeBreaksConfig(bytes(spotCase.inputs.data))).toThrow(/wrong discriminator/);
  });

  it("rejects data that is too short", () => {
    expect(() => breaks.decodeSpot(bytes(spotCase.inputs.data).subarray(0, 20))).toThrow();
    expect(() => breaks.decodeSpot(new Uint8Array(3))).toThrow();
  });

  it("rejects an unknown break status", () => {
    const b = bytes((breaksVectors.cases.find((c) => c.name === "breaks.account.Break") as Case).inputs.data);
    b[16] = 9; // discriminator (8) + id (8) = the status byte
    expect(() => breaks.decodeBreak(b)).toThrow(/unknown break status/);
  });
});

describe("claim_free_spot", () => {
  const base = { payer: "11111111111111111111111111111112", breakId: 1n, index: 0, wallet: "11111111111111111111111111111112", weight: 1n };
  const step = { hash: new Uint8Array(32), sum: 1n, siblingIsLeft: false };

  it("accepts a proof of 40 steps and refuses 41", () => {
    expect(() => breaks.claimFreeSpot(programs, { ...base, proof: Array(40).fill(step) })).not.toThrow();
    expect(() => breaks.claimFreeSpot(programs, { ...base, proof: Array(41).fill(step) })).toThrow(/at most 40/);
  });

  it("refuses a hash that is not 32 bytes", () => {
    expect(() => breaks.claimFreeSpot(programs, { ...base, proof: [{ ...step, hash: new Uint8Array(31) }] })).toThrow();
  });
});

describe("ORAO request account", () => {
  // Bytes written by the real orao-solana-vrf 0.7.0 crate for client [7; 32], seed [9; 32], randomness 0..64
  // (the same fixtures the mock-orao tests use).
  const FULFILLED =
    "8befb8d7e356bfe20107070707070707070707070707070707070707070707070707070707070707070909090909090909090909090909090909090909090909090909090909090909000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f";
  const PENDING =
    "8befb8d7e356bfe2000707070707070707070707070707070707070707070707070707070707070707090909090909090909090909090909090909090909090909090909090909090900000000";
  const seed = new Uint8Array(32).fill(9);

  it("reads a fulfilled request", () => {
    const r = breaks.decodeRequest(fromHex(FULFILLED), seed);
    expect(r.state).toBe("fulfilled");
    if (r.state === "fulfilled") expect(Array.from(r.randomness)).toEqual(Array.from({ length: 64 }, (_, i) => i));
  });

  it("reads a pending request", () => {
    expect(breaks.decodeRequest(fromHex(PENDING), seed)).toEqual({ state: "pending" });
  });

  it("refuses another seed, another account type, a short or a blank answer", () => {
    expect(() => breaks.decodeRequest(fromHex(FULFILLED), new Uint8Array(32).fill(8))).toThrow(/another seed/);
    const wrongType = fromHex(FULFILLED);
    wrongType[0] = (wrongType[0] as number) ^ 1;
    expect(() => breaks.decodeRequest(wrongType, seed)).toThrow(/not an ORAO request/);
    expect(() => breaks.decodeRequest(fromHex(FULFILLED).subarray(0, 100), seed)).toThrow(/too short/);
    const blank = fromHex(FULFILLED);
    blank.fill(0, 73, 137);
    expect(() => breaks.decodeRequest(blank, seed)).toThrow(/blank/);
    const badTag = fromHex(FULFILLED);
    badTag[8] = 2;
    expect(() => breaks.decodeRequest(badTag, seed)).toThrow(/unknown request state/);
  });
});

describe("Borsh writer and reader", () => {
  it("round-trips every type", () => {
    const addr = "11111111111111111111111111111112";
    const bytes = new Uint8Array(32).fill(7);
    const w = new Writer()
      .u8(255)
      .u16(65535)
      .u32(4294967295)
      .u64(18446744073709551615n)
      .i64(-9223372036854775808n)
      .bool(true)
      .fixed(bytes, 32)
      .address(addr)
      .vec([1, 2, 3], (wr, n) => wr.u8(n))
      .finish();
    const r = new Reader(w);
    expect([r.u8(), r.u16(), r.u32(), r.u64(), r.i64(), r.bool()]).toEqual([255, 65535, 4294967295, 18446744073709551615n, -9223372036854775808n, true]);
    expect(Array.from(r.fixed(32))).toEqual(Array.from(bytes));
    expect(r.address()).toBe(addr);
    expect(r.u32()).toBe(3);
    expect([r.u8(), r.u8(), r.u8()]).toEqual([1, 2, 3]);
    expect(r.remaining).toBe(0);
  });

  it("refuses out-of-range values and reading past the end", () => {
    expect(() => new Writer().u8(256)).toThrow();
    expect(() => new Writer().u16(-1)).toThrow();
    expect(() => new Writer().u32(2 ** 32)).toThrow();
    expect(() => new Writer().u64(-1n)).toThrow();
    expect(() => new Writer().u64(1n << 64n)).toThrow();
    expect(() => new Writer().i64(1n << 63n)).toThrow();
    expect(() => new Writer().fixed(new Uint8Array(3), 4)).toThrow();
    expect(() => new Reader(new Uint8Array(1)).u16()).toThrow(/too short/);
    expect(() => new Reader(Uint8Array.of(2)).bool()).toThrow(/not a bool/);
  });
});
