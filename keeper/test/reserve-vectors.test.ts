// The reserve vectors the website's own implementation is checked against (web/test/reserve.test.ts reads them).
//
// Each case is a break (spots, spot price, pack list) and, for a few balances of the two buckets, what the keeper's `worstCase`
// and `reserveProgress` make of it: what each bucket needs, the percent the X bot announces, and whether the program would accept
// the break; or the reason the keeper refuses the break. Producer and consumer are tied to the same numbers this way: change the
// keeper's rule and this test fails until the file is regenerated, and then the website's test shows what to change.
// `UPDATE_RESERVE_VECTORS=1 pnpm --filter keeper test` rewrites the file.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { packMachineBytes } from "../src/scheduler/machine.js";
import { reserveProgress, worstCase } from "../src/scheduler/policy.js";

const FILE = join(import.meta.dirname, "..", "..", "docs", "reserve-vectors.json");
const D = 1_000_000n;
const U64_MAX = (1n << 64n) - 1n;

interface Shape {
  name: string;
  paidSpots: number;
  freeSpots: number;
  spotPrice: bigint;
  /** machine, the most a pack may cost, how many packs. */
  packs: [string, bigint, number][];
}

const SHAPES: Shape[] = [
  { name: "one price: 10 paid and 2 free spots, $20 spots, $25 packs", paidSpots: 10, freeSpots: 2, spotPrice: 20n * D, packs: [["pokemon-25", 25n * D, 12]] },
  { name: "one price: a spot at the pack price", paidSpots: 10, freeSpots: 2, spotPrice: 25n * D, packs: [["pokemon-25", 25n * D, 12]] },
  { name: "one price: no free spots", paidSpots: 10, freeSpots: 0, spotPrice: 20n * D, packs: [["pokemon-25", 25n * D, 10]] },
  { name: "one price: a small break", paidSpots: 3, freeSpots: 1, spotPrice: 7n * D, packs: [["small", 10n * D, 4]] },
  { name: "one price: one paid spot at the pack price, nothing to pay", paidSpots: 1, freeSpots: 0, spotPrice: 10n * D, packs: [["small", 10n * D, 1]] },
  { name: "the mixed break of the Rust tests: 6 paid and 2 free spots, $10, $25 and $50 packs", paidSpots: 6, freeSpots: 2, spotPrice: 20n * D, packs: [["cheap", 10n * D, 4], ["mid", 25n * D, 2], ["top", 50n * D, 2]] },
  { name: "two grails and thirteen $250 packs, a $300 spot", paidSpots: 13, freeSpots: 2, spotPrice: 300n * D, packs: [["filler", 250n * D, 13], ["grail", 1000n * D, 2]] },
  { name: "two grails and thirteen $250 packs, a $250 spot", paidSpots: 13, freeSpots: 2, spotPrice: 250n * D, packs: [["filler", 250n * D, 13], ["grail", 1000n * D, 2]] },
  { name: "two grails and thirteen $250 packs, a spot at the average of $350", paidSpots: 13, freeSpots: 2, spotPrice: 350n * D, packs: [["filler", 250n * D, 13], ["grail", 1000n * D, 2]] },
  { name: "the groups written most expensive first give the same numbers", paidSpots: 6, freeSpots: 2, spotPrice: 20n * D, packs: [["top", 50n * D, 2], ["mid", 25n * D, 2], ["cheap", 10n * D, 4]] },
  { name: "rounding: prices of 10, 10, 10 and 11 micro-dollars average 10", paidSpots: 3, freeSpots: 1, spotPrice: 10n, packs: [["a", 10n, 3], ["b", 11n, 1]] },
  { name: "rounding: the 11 packs of the Rust dust test", paidSpots: 5, freeSpots: 6, spotPrice: 10n, packs: [["a", 10n, 1], ["b", 11n, 9], ["c", 12n, 1]] },
  { name: "mostly free spots", paidSpots: 1, freeSpots: 3, spotPrice: 5n * D, packs: [["x", 5n * D, 2], ["y", 9n * D, 2]] },
  { name: "the largest amounts that fit in 64 bits", paidSpots: 1, freeSpots: 1, spotPrice: 1n, packs: [["huge", (1n << 63n) - 1n, 2]] },
  { name: "refused: a spot above the average pack price", paidSpots: 6, freeSpots: 2, spotPrice: 23_750_001n, packs: [["cheap", 10n * D, 4], ["mid", 25n * D, 2], ["top", 50n * D, 2]] },
  { name: "refused: one pack too few", paidSpots: 6, freeSpots: 2, spotPrice: 20n * D, packs: [["cheap", 10n * D, 4], ["mid", 25n * D, 2], ["top", 50n * D, 1]] },
  { name: "refused: one pack too many", paidSpots: 6, freeSpots: 2, spotPrice: 20n * D, packs: [["cheap", 10n * D, 4], ["mid", 25n * D, 2], ["top", 50n * D, 3]] },
  { name: "refused: no packs", paidSpots: 6, freeSpots: 2, spotPrice: 20n * D, packs: [] },
  { name: "refused: amounts that do not fit in 64 bits", paidSpots: 1, freeSpots: 1, spotPrice: 1n, packs: [["huge", U64_MAX, 2]] },
];

/** A few balances around what a break needs: exactly enough, one micro-dollar short in each bucket, half, a surplus, nothing. */
const balancesFor = (need: { subsidy: bigint; holder: bigint }): [bigint, bigint][] => {
  const { subsidy: s, holder: h } = need;
  const rows: [bigint, bigint][] = [[0n, 0n], [s, h], [s / 2n, h], [s, h / 3n], [10n * s + 1n, 0n], [0n, 10n * h + 1n], [1n, 1n]];
  if (s > 0n) rows.push([s - 1n, h]);
  if (h > 0n) rows.push([s, h - 1n]);
  return rows.filter(([a, b], i) => rows.findIndex(([c, d]) => c === a && d === b) === i);
};

interface Vector {
  name: string;
  paidSpots: number;
  freeSpots: number;
  spotPrice: string;
  packs: { machine: string; maxPrice: string; count: number }[];
  /** What the keeper refuses the break with, or what it makes of each balance. */
  error?: string;
  required?: { subsidy: string; holder: string };
  rows?: { subsidy: string; holder: string; percent: number; enough: boolean }[];
}

function vectorOf(s: Shape): Vector {
  const template = { paidSpots: s.paidSpots, freeSpots: s.freeSpots, spotPrice: s.spotPrice, packs: s.packs.map(([machine, maxPrice, count]) => ({ machine: packMachineBytes(machine), maxPrice, count })) };
  const base = {
    name: s.name,
    paidSpots: s.paidSpots,
    freeSpots: s.freeSpots,
    spotPrice: String(s.spotPrice),
    packs: s.packs.map(([machine, maxPrice, count]) => ({ machine, maxPrice: String(maxPrice), count })),
  };
  let need: { subsidy: bigint; holder: bigint };
  try {
    need = worstCase(template);
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
  return {
    ...base,
    required: { subsidy: String(need.subsidy), holder: String(need.holder) },
    rows: balancesFor(need).map(([subsidy, holder]) => {
      const p = reserveProgress(template, { subsidy, holder });
      return { subsidy: String(subsidy), holder: String(holder), percent: p.percent, enough: p.enough };
    }),
  };
}

const render = (vectors: Vector[]): string => `{"version":1,"cases":[\n${vectors.map((v) => `  ${JSON.stringify(v)}`).join(",\n")}\n]}\n`;

describe("the reserve vectors the website is checked against", () => {
  const vectors = SHAPES.map(vectorOf);

  it("are exactly what the keeper makes of these breaks", async () => {
    if (process.env.UPDATE_RESERVE_VECTORS) await writeFile(FILE, render(vectors), "utf8");
    expect(await readFile(FILE, "utf8")).toBe(render(vectors));
  });

  it("cover what matters: one price, a mix, the spot price at the average, rounding, the 64-bit edge and every refusal", () => {
    const byName = (n: string) => vectors.find((v) => v.name.startsWith(n)) as Vector;
    expect(new Set(vectors.map((v) => v.name)).size).toBe(vectors.length);
    // The numbers the Rust unit tests and the on-chain tests use.
    expect(byName("one price: 10 paid").required).toEqual({ subsidy: "50000000", holder: "50000000" });
    expect(byName("the mixed break").required).toEqual({ subsidy: "22500000", holder: "47500000" });
    expect(byName("two grails and thirteen $250 packs, a $300 spot").required).toEqual({ subsidy: "650000000", holder: "700000000" });
    expect(byName("two grails and thirteen $250 packs, a spot at the average").required).toEqual({ subsidy: "0", holder: "700000000" });
    expect(byName("rounding: the 11 packs").required).toEqual({ subsidy: "5", holder: "66" });
    expect(byName("the groups written most expensive first").required).toEqual(byName("the mixed break").required);
    // A micro-dollar short reads 99, never 100.
    expect(byName("the mixed break").rows?.find((r) => r.subsidy === "22499999")).toMatchObject({ percent: 99, enough: false });
    expect(vectors.filter((v) => v.error !== undefined).map((v) => v.error)).toEqual([
      "the spot price is above the average pack price",
      "the pack list has 7 packs for 8 spots",
      "the pack list has 9 packs for 8 spots",
      "the pack list has 0 packs for 8 spots",
      "the amounts do not fit in a u64",
    ]);
    expect(vectors.filter((v) => v.rows !== undefined).length).toBe(14);
  });
});
