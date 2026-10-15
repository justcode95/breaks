import { describe, expect, it } from "vitest";
import { type BreakShape, reserveProgress, worstCase } from "../lib/chain/reserve";

const P = 25_000_000n; // the Rust unit tests' $25 pack
const S = 20_000_000n; // and $20 spot
const shape = (paidSpots: number, freeSpots: number, spotPrice: bigint, maxPackPrice: bigint): BreakShape => ({ paidSpots, freeSpots, spotPrice, maxPackPrice });

describe("what a break needs from each bucket", () => {
  it("is what the program locks when it creates one (the Rust unit tests' own examples)", () => {
    // programs/breaks/src/math.rs `creation_locks_cover_the_worst_case`.
    expect(worstCase(shape(10, 2, S, P))).toEqual({ subsidy: 50_000_000n, holder: 50_000_000n });
    expect(worstCase(shape(10, 2, P, P))).toEqual({ subsidy: 0n, holder: 50_000_000n });
    expect(worstCase(shape(10, 0, S, P))).toEqual({ subsidy: 50_000_000n, holder: 0n });
  });

  it("refuses a spot price above the pack price, and amounts that do not fit in 64 bits, as the program does", () => {
    expect(() => worstCase(shape(1, 1, P + 1n, P))).toThrow(RangeError);
    expect(() => worstCase(shape(65_535, 16, 1n, (1n << 64n) - 1n))).toThrow(RangeError);
    expect(() => worstCase(shape(1, 16, 1n, (1n << 64n) - 1n))).toThrow(RangeError);
    // Right at the edge it still fits.
    expect(worstCase(shape(1, 1, (1n << 64n) - 1n, (1n << 64n) - 1n))).toEqual({ subsidy: 0n, holder: (1n << 64n) - 1n });
    expect(worstCase(shape(1, 0, 0n, (1n << 64n) - 1n))).toEqual({ subsidy: (1n << 64n) - 1n, holder: 0n });
  });
});

describe("how far the reserve is from paying for the next break", () => {
  it("is the keeper's answer for every case in a table made with the keeper's own reserveProgress", () => {
    // Made by running keeper/src/scheduler/policy.ts `reserveProgress` over these shapes and balances.
    const shapes = [shape(10, 2, S, P), shape(10, 2, P, P), shape(10, 0, S, P), shape(3, 1, 7_000_000n, 10_000_000n), shape(1, 0, 10_000_000n, 10_000_000n)];
    const worst: [bigint, bigint][] = [[50000000n, 50000000n], [0n, 50000000n], [50000000n, 0n], [9000000n, 10000000n], [0n, 0n]];
    shapes.forEach((s, i) => expect([worstCase(s).subsidy, worstCase(s).holder], `shape ${i}`).toEqual(worst[i]));
    const rows: [number, bigint, bigint, number, boolean][] = [
  [0, 0n, 0n, 0, false],
  [0, 50000000n, 50000000n, 100, true],
  [0, 49999999n, 50000000n, 99, false],
  [0, 50000000n, 49999999n, 99, false],
  [0, 25000000n, 40000000n, 50, false],
  [0, 1n, 3n, 0, false],
  [0, 1000000n, 1000000n, 2, false],
  [0, 999999999n, 0n, 0, false],
  [0, 0n, 999999999n, 0, false],
  [0, 8999999n, 10000000n, 17, false],
  [1, 0n, 0n, 0, false],
  [1, 50000000n, 50000000n, 100, true],
  [1, 49999999n, 50000000n, 100, true],
  [1, 50000000n, 49999999n, 99, false],
  [1, 25000000n, 40000000n, 80, false],
  [1, 1n, 3n, 0, false],
  [1, 1000000n, 1000000n, 2, false],
  [1, 999999999n, 0n, 0, false],
  [1, 0n, 999999999n, 100, true],
  [1, 8999999n, 10000000n, 20, false],
  [2, 0n, 0n, 0, false],
  [2, 50000000n, 50000000n, 100, true],
  [2, 49999999n, 50000000n, 99, false],
  [2, 50000000n, 49999999n, 100, true],
  [2, 25000000n, 40000000n, 50, false],
  [2, 1n, 3n, 0, false],
  [2, 1000000n, 1000000n, 2, false],
  [2, 999999999n, 0n, 100, true],
  [2, 0n, 999999999n, 0, false],
  [2, 8999999n, 10000000n, 17, false],
  [3, 0n, 0n, 0, false],
  [3, 50000000n, 50000000n, 100, true],
  [3, 49999999n, 50000000n, 100, true],
  [3, 50000000n, 49999999n, 100, true],
  [3, 25000000n, 40000000n, 100, true],
  [3, 1n, 3n, 0, false],
  [3, 1000000n, 1000000n, 10, false],
  [3, 999999999n, 0n, 0, false],
  [3, 0n, 999999999n, 0, false],
  [3, 8999999n, 10000000n, 99, false],
  [4, 0n, 0n, 100, true],
  [4, 50000000n, 50000000n, 100, true],
  [4, 49999999n, 50000000n, 100, true],
  [4, 50000000n, 49999999n, 100, true],
  [4, 25000000n, 40000000n, 100, true],
  [4, 1n, 3n, 100, true],
  [4, 1000000n, 1000000n, 100, true],
  [4, 999999999n, 0n, 100, true],
  [4, 0n, 999999999n, 100, true],
  [4, 8999999n, 10000000n, 100, true],
    ];
    expect(rows).toHaveLength(50);
    for (const [i, subsidy, holder, percent, enough] of rows) {
      const r = reserveProgress(shapes[i] as BreakShape, { subsidy, holder });
      expect({ percent: r.percent, enough }, `shape ${i}, ${subsidy} and ${holder}`).toEqual({ percent, enough: r.enough });
      expect(r.enough, `shape ${i}, ${subsidy} and ${holder}`).toBe(enough);
    }
  });

  it("is decided by the bucket furthest from its target, rounded down, and is 100 only when both have enough", () => {
    const s = shape(10, 2, S, P);
    expect(reserveProgress(s, { subsidy: 0n, holder: 0n }).percent).toBe(0);
    expect(reserveProgress(s, { subsidy: 25_000_000n, holder: 40_000_000n }).percent).toBe(50);
    expect(reserveProgress(s, { subsidy: 49_999_999n, holder: 50_000_000n })).toMatchObject({ percent: 99, enough: false });
    expect(reserveProgress(s, { subsidy: 50_000_000n, holder: 50_000_000n })).toMatchObject({ percent: 100, enough: true });
    expect(reserveProgress(s, { subsidy: 900_000_000n, holder: 50_000_000n })).toMatchObject({ percent: 100, enough: true });
    // One bucket full does not make up for the other.
    expect(reserveProgress(s, { subsidy: 900_000_000n, holder: 0n })).toMatchObject({ percent: 0, enough: false });
  });

  it("ignores a bucket the break does not need anything from", () => {
    expect(reserveProgress(shape(10, 2, P, P), { subsidy: 0n, holder: 25_000_000n })).toMatchObject({ percent: 50, enough: false });
    expect(reserveProgress(shape(10, 0, S, P), { subsidy: 25_000_000n, holder: 0n })).toMatchObject({ percent: 50, enough: false });
    expect(reserveProgress(shape(1, 0, P, P), { subsidy: 0n, holder: 0n })).toMatchObject({ percent: 100, enough: true });
  });

  it("says what each bucket still lacks, and nothing for one that has enough", () => {
    const s = shape(10, 2, S, P);
    expect(reserveProgress(s, { subsidy: 20_000_000n, holder: 50_000_000n }).missing).toEqual({ subsidy: 30_000_000n, holder: 0n });
    expect(reserveProgress(s, { subsidy: 60_000_000n, holder: 1n }).missing).toEqual({ subsidy: 0n, holder: 49_999_999n });
    expect(reserveProgress(s, { subsidy: 50_000_000n, holder: 50_000_000n }).missing).toEqual({ subsidy: 0n, holder: 0n });
  });

  it("carries what it was given: the requirement and the available amounts", () => {
    const r = reserveProgress(shape(10, 2, S, P), { subsidy: 7n, holder: 9n });
    expect(r.required).toEqual({ subsidy: 50_000_000n, holder: 50_000_000n });
    expect(r.available).toEqual({ subsidy: 7n, holder: 9n });
  });

  it("does not lose a micro-dollar to rounding on large amounts", () => {
    const big = shape(65_535, 16, 1n, 10_000_000_000n);
    const need = worstCase(big);
    expect(reserveProgress(big, { subsidy: need.subsidy - 1n, holder: need.holder })).toMatchObject({ percent: 99, enough: false });
    expect(reserveProgress(big, need)).toMatchObject({ percent: 100, enough: true });
  });
});
