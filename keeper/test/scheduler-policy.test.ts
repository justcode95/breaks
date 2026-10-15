import { describe, expect, it } from "vitest";
import { packMachineBytes, packMachineLabel } from "../src/scheduler/machine.js";
import { type BreakTemplate, type PackGroup, packListOf, reserveProgress, templateProblem, unlocked, worstCase } from "../src/scheduler/policy.js";
import type { BreaksConfigAccount } from "../src/solana/breaks.js";
import { addr } from "./support/chain.js";
import { oneMachine } from "./support/packs.js";

const SPOT = 20_000_000n;
const PACK = 25_000_000n;
const D = 1_000_000n;
/** A break of one machine at one price, with `paid` + `free` spots. */
const uniform = (paid: number, free: number, spot = SPOT, pack = PACK) => ({ paidSpots: paid, freeSpots: free, spotPrice: spot, packs: oneMachine("pokemon-25", pack, paid + free) });
const shape = uniform(10, 2);
const group = (machine: string, dollars: bigint, count: number): PackGroup => ({ machine: packMachineBytes(machine), maxPrice: dollars * D, count });
/** 6 paid and 2 free spots at $20; four $10 packs, two $25 and two $50: the mixed break of the Rust tests. */
const mixed = { paidSpots: 6, freeSpots: 2, spotPrice: SPOT, packs: [group("cheap", 10n, 4), group("mid", 25n, 2), group("top", 50n, 2)] };
/** 13 paid and 2 free spots; thirteen $250 packs and two $1,000 grails. */
const grails = { paidSpots: 13, freeSpots: 2, spotPrice: 300n * D, packs: [group("filler", 250n, 13), group("grail", 1000n, 2)] };

describe("worstCase", () => {
  it("tops up every paid spot to the pack price and pays a whole pack for every free spot, for packs at one price", () => {
    // The same numbers as `creation_locks_cover_the_worst_case` in programs/breaks/src/math.rs.
    expect(worstCase(shape)).toEqual({ subsidy: 50_000_000n, holder: 50_000_000n });
    expect(worstCase(uniform(10, 2, PACK))).toEqual({ subsidy: 0n, holder: 50_000_000n });
    expect(worstCase(uniform(10, 0))).toEqual({ subsidy: 50_000_000n, holder: 0n });
  });

  it("pays the free spots at the average pack price and the rest of what the buyers do not pay from the subsidy bucket, for a mix", () => {
    // The numbers of `a_mixed_break_locks_by_the_average_pack_price` in the Rust unit tests and the on-chain tests.
    expect(worstCase(mixed)).toEqual({ subsidy: 22_500_000n, holder: 47_500_000n });
    expect(worstCase(grails)).toEqual({ subsidy: 650n * D, holder: 700n * D });
    // At the average price (350) the buyers pay for everything but the free spots.
    expect(worstCase({ ...grails, spotPrice: 350n * D })).toEqual({ subsidy: 0n, holder: 700n * D });
  });

  it("rounds the average down, like the program", () => {
    // Prices of 10, 10, 10 and 11 micro-dollars: 41 in all, 10.25 on average, so 10. The holder bucket pays 1 × 10 and the
    // subsidy bucket the other 41 − 3 × 10 − 10 = 1 (the dust the program's `rounding_dust` test is about).
    const packs: PackGroup[] = [{ machine: packMachineBytes("a"), maxPrice: 10n, count: 3 }, { machine: packMachineBytes("b"), maxPrice: 11n, count: 1 }];
    expect(worstCase({ paidSpots: 3, freeSpots: 1, spotPrice: 10n, packs })).toEqual({ subsidy: 1n, holder: 10n });
    // And the spot price may be 10, the rounded average, but not 11.
    expect(() => worstCase({ paidSpots: 3, freeSpots: 1, spotPrice: 11n, packs })).toThrow(/above the average pack price/);
  });

  it("refuses a spot above the average pack price, a list that does not match the spots, and amounts that do not fit in a u64", () => {
    expect(() => worstCase({ ...mixed, spotPrice: 23_750_001n })).toThrow(/above the average pack price/);
    expect(() => worstCase({ ...shape, spotPrice: PACK + 1n })).toThrow(/above the average pack price/);
    expect(() => worstCase({ ...mixed, paidSpots: 7 })).toThrow(/pack list has 8 packs for 9 spots/);
    expect(() => worstCase({ ...mixed, packs: [] })).toThrow(/0 packs for 8 spots/);
    expect(() => worstCase({ ...uniform(1, 1, 1n, (1n << 64n) - 1n) })).toThrow(/u64/);
  });
});

describe("packListOf", () => {
  it("lists the tiers as they are and the tier of each pack, one per spot", () => {
    const { tiers, packs } = packListOf(mixed);
    expect(tiers.map((t) => [packMachineLabel(t.machine), t.maxPrice])).toEqual([["cheap", 10n * D], ["mid", 25n * D], ["top", 50n * D]]);
    expect(packs).toEqual([0, 0, 0, 0, 1, 1, 2, 2]);
    expect(packListOf(shape).packs).toEqual(Array(12).fill(0));
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
    expect(reserveProgress(uniform(10, 2, PACK), { subsidy: 0n, holder: 25_000_000n })).toMatchObject({ percent: 50, enough: false });
    expect(reserveProgress(uniform(10, 0, PACK), { subsidy: 0n, holder: 0n })).toMatchObject({ percent: 100, enough: true });
  });

  it("measures a mix against what the whole list needs", () => {
    expect(reserveProgress(mixed, { subsidy: 22_500_000n, holder: 47_500_000n })).toMatchObject({ enough: true, percent: 100, requiredSubsidy: 22_500_000n, requiredHolder: 47_500_000n });
    expect(reserveProgress(mixed, { subsidy: 22_499_999n, holder: 47_500_000n })).toMatchObject({ enough: false, percent: 99 });
    expect(reserveProgress(mixed, { subsidy: 11_250_000n, holder: 47_500_000n })).toMatchObject({ enough: false, percent: 50 });
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
  const template: BreakTemplate = { ...shape, windowSecs: 43_200n };
  const mixedTemplate: BreakTemplate = { ...mixed, windowSecs: 43_200n };

  it("accepts a break the program accepts, including the limits themselves", () => {
    expect(templateProblem(template, config)).toBeUndefined();
    expect(templateProblem({ ...uniform(20, 6), windowSecs: 21_600n }, config)).toBeUndefined();
    expect(templateProblem({ ...uniform(1, 0), windowSecs: 86_400n }, config)).toBeUndefined();
    expect(templateProblem(mixedTemplate, config)).toBeUndefined();
    // A spot at exactly the average pack price, and a list of exactly 8 groups.
    expect(templateProblem({ ...mixedTemplate, spotPrice: 23_750_000n }, config)).toBeUndefined();
    const eight = Array.from({ length: 8 }, (_, i) => group(`m${i}`, BigInt(30 + i), 1));
    expect(templateProblem({ paidSpots: 6, freeSpots: 2, spotPrice: 30n * D, packs: eight, windowSecs: 43_200n }, config)).toBeUndefined();
  });

  it("names what the program would refuse", () => {
    expect(templateProblem({ ...uniform(0, 2), windowSecs: 43_200n }, config)).toMatch(/paid spots 0/);
    expect(templateProblem({ ...uniform(21, 2), windowSecs: 43_200n }, config)).toMatch(/paid spots 21/);
    expect(templateProblem({ ...uniform(10, 7), windowSecs: 43_200n }, config)).toMatch(/free spots 7/);
    expect(templateProblem({ ...template, spotPrice: 0n }, config)).toMatch(/spot price must be above zero/);
    expect(templateProblem({ ...template, windowSecs: 21_599n }, config)).toMatch(/window/);
    expect(templateProblem({ ...template, windowSecs: 86_401n }, config)).toMatch(/window/);
  });

  it("names what the program would refuse about the pack list", () => {
    expect(templateProblem({ ...template, spotPrice: PACK + 1n }, config)).toMatch(/above the average pack price \(25000000\)/);
    expect(templateProblem({ ...mixedTemplate, spotPrice: 23_750_001n }, config)).toMatch(/above the average pack price \(23750000\)/);
    expect(templateProblem({ ...template, packs: [] }, config)).toMatch(/0 groups; the program takes 1 to 8/);
    const nine = Array.from({ length: 9 }, (_, i) => group(`m${i}`, BigInt(30 + i), 1));
    expect(templateProblem({ ...template, paidSpots: 7, freeSpots: 2, packs: nine }, config)).toMatch(/9 groups; the program takes 1 to 8/);
    expect(templateProblem({ ...mixedTemplate, packs: [group("a", 0n, 8)] }, config)).toMatch(/pack prices must be above zero/);
    expect(templateProblem({ ...mixedTemplate, packs: [group("a", 10n, 8), group("b", 20n, 0)] }, config)).toMatch(/at least one pack/);
    expect(templateProblem({ ...mixedTemplate, packs: [group("a", 10n, 8), group("b", 20n, 1.5)] }, config)).toMatch(/at least one pack/);
    expect(templateProblem({ ...mixedTemplate, packs: [group("a", 10n, 4), group("b", 25n, 2), group("c", 50n, 1)] }, config)).toMatch(/packs add up to 7 but the break has 8 spots/);
    expect(templateProblem({ ...mixedTemplate, packs: [...mixed.packs, group("d", 60n, 1)] }, config)).toMatch(/packs add up to 9 but the break has 8 spots/);
    expect(templateProblem({ ...mixedTemplate, packs: [group("top", 50n, 2), group("mid", 25n, 2), group("cheap", 10n, 4)] }, config)).toMatch(/not listed cheapest first/);
  });

  it("names a list of more than 64 packs, if the program's limits were ever raised that far", () => {
    const big = { ...config, maxPaidSpots: 65_535, maxFreeSpots: 16 };
    expect(templateProblem({ ...uniform(60, 5, 10n * D, 10n * D), windowSecs: 43_200n }, big)).toMatch(/65 packs; a break has at most 64/);
    expect(templateProblem({ ...uniform(60, 4, 10n * D, 10n * D), windowSecs: 43_200n }, big)).toBeUndefined();
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
