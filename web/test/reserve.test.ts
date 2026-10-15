import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type BreakShape, type PackGroup, averagePackPrice, packTotals, reserveProgress, worstCase } from "../lib/chain/reserve";

const D = 1_000_000n;
const U64_MAX = (1n << 64n) - 1n;
const P = 25n * D; // the Rust unit tests' $25 pack
const S = 20n * D; // and $20 spot
const group = (machine: string, maxPrice: bigint, count: number): PackGroup => ({ machine, maxPrice, count });
/** A break of one machine at one price. */
const uniform = (paidSpots: number, freeSpots: number, spotPrice: bigint, pack: bigint): BreakShape => ({ paidSpots, freeSpots, spotPrice, packs: [group("m", pack, paidSpots + freeSpots)] });
/** 6 paid and 2 free spots at $20; four $10 packs, two $25 and two $50: $190, $23.75 on average. */
const mixed: BreakShape = { paidSpots: 6, freeSpots: 2, spotPrice: S, packs: [group("cheap", 10n * D, 4), group("mid", 25n * D, 2), group("top", 50n * D, 2)] };
/** 13 paid and 2 free spots; thirteen $250 packs and two $1,000 grails. */
const grails = (spot: bigint): BreakShape => ({ paidSpots: 13, freeSpots: 2, spotPrice: spot, packs: [group("filler", 250n * D, 13), group("grail", 1000n * D, 2)] });

describe("what a break needs from each bucket", () => {
  it("is what the program locks when it creates one, for packs at one price (the Rust unit tests' own examples)", () => {
    // programs/breaks/src/math.rs `creation_locks_cover_the_worst_case`.
    expect(worstCase(uniform(10, 2, S, P))).toEqual({ subsidy: 50_000_000n, holder: 50_000_000n });
    expect(worstCase(uniform(10, 2, P, P))).toEqual({ subsidy: 0n, holder: 50_000_000n });
    expect(worstCase(uniform(10, 0, S, P))).toEqual({ subsidy: 50_000_000n, holder: 0n });
  });

  it("pays the free spots at the average pack price and the rest of what the buyers do not pay from the subsidy bucket, for a mix", () => {
    // programs/breaks/src/math.rs `a_mixed_break_locks_by_the_average_pack_price` and the on-chain test of the same name.
    expect(worstCase(mixed)).toEqual({ subsidy: 22_500_000n, holder: 47_500_000n });
    expect(worstCase(grails(300n * D))).toEqual({ subsidy: 650n * D, holder: 700n * D });
    expect(worstCase(grails(250n * D))).toEqual({ subsidy: 1300n * D, holder: 700n * D });
    expect(worstCase(grails(350n * D))).toEqual({ subsidy: 0n, holder: 700n * D });
  });

  it("does not depend on the order the groups are written in", () => {
    expect(worstCase({ ...mixed, packs: [...mixed.packs].reverse() })).toEqual(worstCase(mixed));
  });

  it("rounds the average down, like the program", () => {
    // 10, 10, 10 and 11 micro-dollars: 41 in all, 10.25 on average, so 10; the subsidy bucket pays the other 41 − 30 − 10 = 1.
    const dust: BreakShape = { paidSpots: 3, freeSpots: 1, spotPrice: 10n, packs: [group("a", 10n, 3), group("b", 11n, 1)] };
    expect(averagePackPrice(dust)).toBe(10n);
    expect(worstCase(dust)).toEqual({ subsidy: 1n, holder: 10n });
    expect(() => worstCase({ ...dust, spotPrice: 11n })).toThrow("the spot price is above the average pack price");
  });

  it("knows what the packs cost in all and the average, which is the most a spot may cost", () => {
    expect(packTotals(mixed.packs)).toEqual({ total: 190n * D, count: 8 });
    expect(averagePackPrice(mixed)).toBe(23_750_000n);
    expect(averagePackPrice(uniform(10, 2, S, P))).toBe(P);
    expect(() => averagePackPrice({ packs: [] })).toThrow("the pack list is empty");
  });

  it("refuses a spot above the average pack price, a list that does not match the spots, and amounts that do not fit in 64 bits, as the program does", () => {
    expect(() => worstCase({ ...mixed, spotPrice: 23_750_001n })).toThrow("the spot price is above the average pack price");
    // At exactly the average the buyers pay for everything but the free spots: nothing is left for the subsidy bucket to top up
    // beyond rounding (190 − 6 × 23.75 − 2 × 23.75 = 0).
    expect(worstCase({ ...mixed, spotPrice: 23_750_000n })).toEqual({ subsidy: 0n, holder: 47_500_000n });
    expect(() => worstCase(uniform(1, 1, P + 1n, P))).toThrow("the spot price is above the average pack price");
    expect(() => worstCase({ ...mixed, paidSpots: 7 })).toThrow("the pack list has 8 packs for 9 spots");
    expect(() => worstCase({ ...mixed, packs: [] })).toThrow("the pack list has 0 packs for 8 spots");
    expect(() => worstCase({ paidSpots: 0, freeSpots: 0, spotPrice: 1n, packs: [] })).toThrow("the pack list has 0 packs for 0 spots");
    expect(() => worstCase(uniform(1, 1, 1n, U64_MAX))).toThrow("the amounts do not fit in a u64");
    // Right at the edge it still fits, down to the last unit: a list that costs exactly 2^64 − 1 is accepted and one unit more is not.
    expect(worstCase(uniform(1, 0, 1n, U64_MAX))).toEqual({ subsidy: U64_MAX - 1n, holder: 0n });
    expect(() => worstCase({ paidSpots: 1, freeSpots: 1, spotPrice: 1n, packs: [group("a", U64_MAX, 1), group("b", 1n, 1)] })).toThrow("the amounts do not fit in a u64");
    expect(worstCase({ paidSpots: 1, freeSpots: 1, spotPrice: 1n, packs: [group("huge", (1n << 63n) - 1n, 2)] })).toEqual({ subsidy: (1n << 63n) - 2n, holder: (1n << 63n) - 1n });
  });
});

describe("how far the reserve is from paying for the next break", () => {
  const vectors = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "docs", "reserve-vectors.json"), "utf8")) as {
    version: number;
    cases: {
      name: string;
      paidSpots: number;
      freeSpots: number;
      spotPrice: string;
      packs: { machine: string; maxPrice: string; count: number }[];
      error?: string;
      required?: { subsidy: string; holder: string };
      rows?: { subsidy: string; holder: string; percent: number; enough: boolean }[];
    }[];
  };
  const shapeOf = (c: (typeof vectors.cases)[number]): BreakShape => ({
    paidSpots: c.paidSpots,
    freeSpots: c.freeSpots,
    spotPrice: BigInt(c.spotPrice),
    packs: c.packs.map((g) => ({ machine: g.machine, maxPrice: BigInt(g.maxPrice), count: g.count })),
  });

  it("is the keeper's answer for every case in docs/reserve-vectors.json, which the keeper's own functions made", () => {
    expect(vectors.version).toBe(1);
    expect(vectors.cases.length).toBeGreaterThan(15);
    let rows = 0;
    for (const c of vectors.cases) {
      const shape = shapeOf(c);
      if (c.error !== undefined) {
        // The keeper refuses the break, in the same words.
        expect(() => worstCase(shape), c.name).toThrow(c.error);
        expect(() => reserveProgress(shape, { subsidy: 0n, holder: 0n }), c.name).toThrow(c.error);
        continue;
      }
      expect(worstCase(shape), c.name).toEqual({ subsidy: BigInt((c.required as { subsidy: string }).subsidy), holder: BigInt((c.required as { holder: string }).holder) });
      for (const row of c.rows ?? []) {
        const r = reserveProgress(shape, { subsidy: BigInt(row.subsidy), holder: BigInt(row.holder) });
        expect({ percent: r.percent, enough: r.enough }, `${c.name}: ${row.subsidy} and ${row.holder}`).toEqual({ percent: row.percent, enough: row.enough });
        rows++;
      }
    }
    expect(rows).toBeGreaterThan(100);
  });

  it("is decided by the bucket furthest from its target, rounded down, and is 100 only when both have enough", () => {
    const s = uniform(10, 2, S, P);
    expect(reserveProgress(s, { subsidy: 0n, holder: 0n }).percent).toBe(0);
    expect(reserveProgress(s, { subsidy: 25_000_000n, holder: 40_000_000n }).percent).toBe(50);
    expect(reserveProgress(s, { subsidy: 49_999_999n, holder: 50_000_000n })).toMatchObject({ percent: 99, enough: false });
    expect(reserveProgress(s, { subsidy: 50_000_000n, holder: 50_000_000n })).toMatchObject({ percent: 100, enough: true });
    expect(reserveProgress(s, { subsidy: 900_000_000n, holder: 50_000_000n })).toMatchObject({ percent: 100, enough: true });
    // One bucket full does not make up for the other.
    expect(reserveProgress(s, { subsidy: 900_000_000n, holder: 0n })).toMatchObject({ percent: 0, enough: false });
  });

  it("measures a mix against what the whole list needs", () => {
    expect(reserveProgress(mixed, { subsidy: 22_500_000n, holder: 47_500_000n })).toMatchObject({ percent: 100, enough: true });
    expect(reserveProgress(mixed, { subsidy: 22_499_999n, holder: 47_500_000n })).toMatchObject({ percent: 99, enough: false });
    expect(reserveProgress(mixed, { subsidy: 22_500_000n, holder: 47_499_999n })).toMatchObject({ percent: 99, enough: false });
    expect(reserveProgress(mixed, { subsidy: 11_250_000n, holder: 47_500_000n })).toMatchObject({ percent: 50, enough: false });
  });

  it("ignores a bucket the break does not need anything from", () => {
    expect(reserveProgress(uniform(10, 2, P, P), { subsidy: 0n, holder: 25_000_000n })).toMatchObject({ percent: 50, enough: false });
    expect(reserveProgress(uniform(10, 0, S, P), { subsidy: 25_000_000n, holder: 0n })).toMatchObject({ percent: 50, enough: false });
    expect(reserveProgress(uniform(1, 0, P, P), { subsidy: 0n, holder: 0n })).toMatchObject({ percent: 100, enough: true });
  });

  it("says what each bucket still lacks, and nothing for one that has enough", () => {
    const s = uniform(10, 2, S, P);
    expect(reserveProgress(s, { subsidy: 20_000_000n, holder: 50_000_000n }).missing).toEqual({ subsidy: 30_000_000n, holder: 0n });
    expect(reserveProgress(s, { subsidy: 60_000_000n, holder: 1n }).missing).toEqual({ subsidy: 0n, holder: 49_999_999n });
    expect(reserveProgress(s, { subsidy: 50_000_000n, holder: 50_000_000n }).missing).toEqual({ subsidy: 0n, holder: 0n });
  });

  it("carries what it was given: the requirement and the available amounts", () => {
    const r = reserveProgress(uniform(10, 2, S, P), { subsidy: 7n, holder: 9n });
    expect(r.required).toEqual({ subsidy: 50_000_000n, holder: 50_000_000n });
    expect(r.available).toEqual({ subsidy: 7n, holder: 9n });
  });

  it("does not lose a micro-dollar to rounding on large amounts", () => {
    const big = uniform(48, 16, 1n, 10_000_000_000n);
    const need = worstCase(big);
    expect(reserveProgress(big, { subsidy: need.subsidy - 1n, holder: need.holder })).toMatchObject({ percent: 99, enough: false });
    expect(reserveProgress(big, need)).toMatchObject({ percent: 100, enough: true });
  });
});
