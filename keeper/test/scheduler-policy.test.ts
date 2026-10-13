import { describe, expect, it } from "vitest";
import { packMachineBytes, packMachineLabel } from "../src/scheduler/machine.js";
import { type BreakTemplate, reserveProgress, templateProblem, unlocked, worstCase } from "../src/scheduler/policy.js";
import type { BreaksConfigAccount } from "../src/solana/breaks.js";
import { addr } from "./support/chain.js";

const SPOT = 20_000_000n;
const PACK = 25_000_000n;
const shape = { paidSpots: 10, freeSpots: 2, spotPrice: SPOT, maxPackPrice: PACK };

describe("worstCase", () => {
  it("tops up every paid spot to the pack price and pays a whole pack for every free spot", () => {
    // The same numbers as `creation_locks_cover_the_worst_case` in programs/breaks/src/math.rs.
    expect(worstCase(shape)).toEqual({ subsidy: 50_000_000n, holder: 50_000_000n });
    expect(worstCase({ ...shape, spotPrice: PACK })).toEqual({ subsidy: 0n, holder: 50_000_000n });
    expect(worstCase({ ...shape, freeSpots: 0 })).toEqual({ subsidy: 50_000_000n, holder: 0n });
  });

  it("refuses a spot above the pack price and amounts that do not fit in a u64", () => {
    expect(() => worstCase({ ...shape, spotPrice: PACK + 1n })).toThrow(/above the maximum pack price/);
    expect(() => worstCase({ ...shape, spotPrice: 1n, maxPackPrice: (1n << 64n) - 1n })).toThrow(/u64/);
  });
});

describe("unlocked", () => {
  it("is what the vault holds beyond what is locked, never negative", () => {
    expect(unlocked(100n, 30n)).toBe(70n);
    expect(unlocked(100n, 100n)).toBe(0n);
    expect(unlocked(100n, 101n)).toBe(0n);
  });
});

describe("reserveProgress", () => {
  it("is enough exactly when both buckets cover the worst case", () => {
    expect(reserveProgress(shape, { subsidy: 50_000_000n, holder: 50_000_000n })).toMatchObject({ enough: true, percent: 100 });
    expect(reserveProgress(shape, { subsidy: 90_000_000n, holder: 99_000_000n })).toMatchObject({ enough: true, percent: 100 });
    expect(reserveProgress(shape, { subsidy: 49_999_999n, holder: 50_000_000n })).toMatchObject({ enough: false, percent: 99 });
    expect(reserveProgress(shape, { subsidy: 50_000_000n, holder: 49_999_999n })).toMatchObject({ enough: false, percent: 99 });
  });

  it("reports the bucket that is furthest from its target", () => {
    const p = reserveProgress(shape, { subsidy: 25_000_000n, holder: 40_000_000n });
    expect(p).toMatchObject({ percent: 50, enough: false, requiredSubsidy: 50_000_000n, requiredHolder: 50_000_000n, availableSubsidy: 25_000_000n, availableHolder: 40_000_000n });
    expect(reserveProgress(shape, { subsidy: 0n, holder: 0n }).percent).toBe(0);
  });

  it("ignores a bucket that needs nothing", () => {
    expect(reserveProgress({ ...shape, spotPrice: PACK }, { subsidy: 0n, holder: 25_000_000n })).toMatchObject({ percent: 50, enough: false });
    expect(reserveProgress({ ...shape, spotPrice: PACK, freeSpots: 0 }, { subsidy: 0n, holder: 0n })).toMatchObject({ percent: 100, enough: true });
  });
});

describe("templateProblem", () => {
  const config: BreaksConfigAccount = {
    admin: addr(2),
    keeper: addr(3),
    buyer: addr(4),
    usdcMint: addr(5),
    randomnessProgram: addr(6),
    randomnessTimeoutSecs: 3_600n,
    nextBreakId: 0n,
    minWindowSecs: 21_600n,
    maxWindowSecs: 86_400n,
    maxPaidSpots: 20,
    maxFreeSpots: 6,
    paused: false,
    bump: 255,
  };
  const template: BreakTemplate = { ...shape, packMachine: packMachineBytes("pokemon-25"), windowSecs: 43_200n };

  it("accepts a break the program accepts, including the limits themselves", () => {
    expect(templateProblem(template, config)).toBeUndefined();
    expect(templateProblem({ ...template, paidSpots: 20, freeSpots: 6, windowSecs: 21_600n }, config)).toBeUndefined();
    expect(templateProblem({ ...template, paidSpots: 1, freeSpots: 0, windowSecs: 86_400n }, config)).toBeUndefined();
  });

  it("names what the program would refuse", () => {
    expect(templateProblem({ ...template, paidSpots: 0 }, config)).toMatch(/paid spots 0/);
    expect(templateProblem({ ...template, paidSpots: 21 }, config)).toMatch(/paid spots 21/);
    expect(templateProblem({ ...template, freeSpots: 7 }, config)).toMatch(/free spots 7/);
    expect(templateProblem({ ...template, spotPrice: PACK + 1n }, config)).toMatch(/above the maximum pack price/);
    expect(templateProblem({ ...template, spotPrice: 0n }, config)).toMatch(/above zero/);
    expect(templateProblem({ ...template, windowSecs: 21_599n }, config)).toMatch(/window/);
    expect(templateProblem({ ...template, windowSecs: 86_401n }, config)).toMatch(/window/);
  });
});

describe("pack machine labels", () => {
  it("zero-pads a text label to 32 bytes and reads it back", () => {
    const bytes = packMachineBytes("pokemon-25");
    expect(bytes).toHaveLength(32);
    expect(Buffer.from(bytes.subarray(0, 10)).toString()).toBe("pokemon-25");
    expect([...bytes.subarray(10)].every((b) => b === 0)).toBe(true);
    expect(packMachineLabel(bytes)).toBe("pokemon-25");
  });

  it("takes a raw 32-byte id as 0x and 64 hex digits", () => {
    const hex = `0x${"ab".repeat(32)}`;
    expect(packMachineBytes(hex)).toEqual(new Uint8Array(32).fill(0xab));
    expect(packMachineLabel(new Uint8Array(32).fill(0xab))).toBe(hex);
  });

  it("refuses a label that is empty, too long or has a control character", () => {
    expect(() => packMachineBytes("")).toThrow(/empty/);
    expect(() => packMachineBytes("x".repeat(33))).toThrow(/at most 32/);
    expect(() => packMachineBytes("ab\ncd")).toThrow(/control character/);
    expect(() => packMachineBytes("0x1234")).toThrow(/looks like a hex id/);
    expect(() => packMachineBytes(`0x${"ab".repeat(31)}`)).toThrow(/looks like a hex id/);
    expect(packMachineBytes("x".repeat(32))).toHaveLength(32);
  });

  it("shows text that starts with 0x as hex, so that it is never read back as a truncated id", () => {
    const bytes = packMachineBytes("pokemon");
    bytes.set(Buffer.from("0xzz"), 0);
    bytes.fill(0, 4);
    expect(packMachineLabel(bytes)).toBe(`0x${Buffer.from(bytes).toString("hex")}`);
  });

  it("always reads back the bytes it was given: text as text, anything else as hex", () => {
    let seed = 12345;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    for (let i = 0; i < 300; i++) {
      const bytes = new Uint8Array(32);
      const used = next() % 33;
      for (let j = 0; j < used; j++) bytes[j] = next() % (i % 2 === 0 ? 256 : 128);
      const label = packMachineLabel(bytes);
      expect(packMachineBytes(label), `bytes ${Buffer.from(bytes).toString("hex")} -> ${label}`).toEqual(bytes);
    }
  });
});
