import { describe, expect, it } from "vitest";
import { packMachineLabel } from "../src/scheduler/machine.js";
import { parsePackGroups } from "../src/scheduler/packs-config.js";

const ok = (text: string) => {
  const r = parsePackGroups(text);
  if (!r.ok) throw new Error(`expected a pack list, got: ${r.error}`);
  return r.groups.map((g) => [packMachineLabel(g.machine), g.maxPrice, g.count] as const);
};
const error = (text: string) => {
  const r = parsePackGroups(text);
  if (r.ok) throw new Error("expected a problem");
  return r.error;
};

describe("parsePackGroups", () => {
  it("reads a list of groups: machine, the most one pack may cost, and how many packs", () => {
    expect(ok('[{"machine":"pokemon-25","maxPrice":"25000000","count":12}]')).toEqual([["pokemon-25", 25_000_000n, 12]]);
  });

  it("puts the groups cheapest first, and keeps the written order of groups with the same price", () => {
    const text = JSON.stringify([
      { machine: "top", maxPrice: "50000000", count: 2 },
      { machine: "b", maxPrice: "10000000", count: 1 },
      { machine: "a", maxPrice: "10000000", count: 1 },
      { machine: "mid", maxPrice: "25000000", count: 2 },
    ]);
    expect(ok(text)).toEqual([["b", 10_000_000n, 1], ["a", 10_000_000n, 1], ["mid", 25_000_000n, 2], ["top", 50_000_000n, 2]]);
  });

  it("takes a price as a string of digits, or as a whole number that is exact", () => {
    expect(ok('[{"machine":"m","maxPrice":25000000,"count":1}]')).toEqual([["m", 25_000_000n, 1]]);
    // A string holds what a number cannot: the largest price a u64 holds.
    expect(ok('[{"machine":"m","maxPrice":"18446744073709551615","count":1}]')).toEqual([["m", 18_446_744_073_709_551_615n, 1]]);
    expect(error('[{"machine":"m","maxPrice":"18446744073709551616","count":1}]')).toMatch(/fit in 64 bits/);
    expect(error('[{"machine":"m","maxPrice":9007199254740993,"count":1}]')).toMatch(/whole number of micro-USDC/);
  });

  it("takes a raw 32-byte machine id and any text a label may hold, commas and dollar signs included", () => {
    expect(ok(`[{"machine":"0x${"ab".repeat(32)}","maxPrice":"1","count":1}]`)[0]?.[0]).toBe(`0x${"ab".repeat(32)}`);
    expect(ok('[{"machine":"Pokemon $25, big","maxPrice":"1","count":1}]')[0]?.[0]).toBe("Pokemon $25, big");
  });

  it("says what is wrong, and which group", () => {
    expect(error("nope")).toMatch(/not valid JSON/);
    expect(error("null")).toMatch(/at least one group/);
    expect(error("{}")).toMatch(/at least one group/);
    expect(error("[]")).toMatch(/at least one group/);
    expect(error("[1]")).toMatch(/^group 1 must be an object/);
    expect(error("[[]]")).toMatch(/^group 1 must be an object/);
    expect(error("[null]")).toMatch(/^group 1 must be an object/);
    expect(error('[{"machine":"a","maxPrice":"1","count":1},{"machine":"b","maxPrice":"1","count":1,"note":"x"}]')).toMatch(/^group 2 has "note"/);
    expect(error('[{"machine":5,"maxPrice":"1","count":1}]')).toMatch(/^group 1: machine must be text/);
    expect(error('[{"maxPrice":"1","count":1}]')).toMatch(/^group 1: machine must be text/);
    expect(error('[{"machine":"","maxPrice":"1","count":1}]')).toMatch(/^group 1: .*empty/);
    expect(error('[{"machine":"m","maxPrice":"1.5","count":1}]')).toMatch(/maxPrice must be a whole number/);
    expect(error('[{"machine":"m","maxPrice":-1,"count":1}]')).toMatch(/maxPrice must be a whole number/);
    expect(error('[{"machine":"m","maxPrice":"0","count":1}]')).toMatch(/maxPrice must be above zero/);
    expect(error('[{"machine":"m","count":1}]')).toMatch(/maxPrice must be a whole number/);
    expect(error('[{"machine":"m","maxPrice":"1","count":"2"}]')).toMatch(/count must be a whole number, at least 1/);
    expect(error('[{"machine":"m","maxPrice":"1","count":0}]')).toMatch(/count must be a whole number, at least 1/);
    expect(error('[{"machine":"m","maxPrice":"1"}]')).toMatch(/count must be a whole number, at least 1/);
  });
});
