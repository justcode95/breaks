import { describe, expect, it } from "vitest";
import { DEFAULT_RPC_URL, breakShapeSetup, chainSetup, publishedSetup, treasurySetup } from "../lib/config";

const PROGRAM = "8tmJjCG3D4TF7oPiPWNoaCjZ4pN2U4H237BSGVw2B8KU";

describe("where the site reads the chain from", () => {
  it("is off until the program is named", () => {
    expect(chainSetup({})).toEqual({ kind: "off" });
    expect(chainSetup({ program: "  ", rpcUrl: "https://x.example" })).toEqual({ kind: "off" });
  });

  it("uses the public devnet node unless told otherwise", () => {
    expect(chainSetup({ program: PROGRAM })).toEqual({ kind: "on", config: { rpcUrl: DEFAULT_RPC_URL, breaksProgram: PROGRAM } });
    expect(chainSetup({ program: PROGRAM, rpcUrl: "" })).toMatchObject({ kind: "on", config: { rpcUrl: DEFAULT_RPC_URL } });
    expect(chainSetup({ program: ` ${PROGRAM} `, rpcUrl: "https://rpc.example/key" })).toEqual({ kind: "on", config: { rpcUrl: "https://rpc.example/key", breaksProgram: PROGRAM } });
  });

  it("accepts a plain http node only on this machine", () => {
    expect(chainSetup({ program: PROGRAM, rpcUrl: "http://localhost:8899" }).kind).toBe("on");
    expect(chainSetup({ program: PROGRAM, rpcUrl: "http://127.0.0.1:8899" }).kind).toBe("on");
    expect(chainSetup({ program: PROGRAM, rpcUrl: "http://rpc.example" })).toEqual({ kind: "problem", problem: "NEXT_PUBLIC_SOLANA_RPC_URL must be an https:// address." });
    expect(chainSetup({ program: PROGRAM, rpcUrl: "ftp://rpc.example" }).kind).toBe("problem");
  });

  it("names what is wrong", () => {
    expect(chainSetup({ program: "nope" })).toEqual({ kind: "problem", problem: "NEXT_PUBLIC_BREAKS_PROGRAM_ID is not a Solana address." });
    expect(chainSetup({ program: PROGRAM, rpcUrl: "not a url" })).toEqual({ kind: "problem", problem: "NEXT_PUBLIC_SOLANA_RPC_URL is not a web address." });
  });
});

describe("where the treasury page reads from", () => {
  it("is off until the treasury program is named, and takes the same node as the rest of the site", () => {
    expect(treasurySetup({})).toEqual({ kind: "off" });
    expect(treasurySetup({ program: "", rpcUrl: "https://x.example" })).toEqual({ kind: "off" });
    expect(treasurySetup({ program: PROGRAM })).toEqual({ kind: "on", config: { rpcUrl: DEFAULT_RPC_URL, treasuryProgram: PROGRAM } });
    expect(treasurySetup({ program: PROGRAM, rpcUrl: "https://rpc.example/key" })).toEqual({ kind: "on", config: { rpcUrl: "https://rpc.example/key", treasuryProgram: PROGRAM } });
  });

  it("names the setting that is wrong", () => {
    expect(treasurySetup({ program: "nope" })).toEqual({ kind: "problem", problem: "NEXT_PUBLIC_TREASURY_PROGRAM_ID is not a Solana address." });
    expect(treasurySetup({ program: PROGRAM, rpcUrl: "http://rpc.example" })).toEqual({ kind: "problem", problem: "NEXT_PUBLIC_SOLANA_RPC_URL must be an https:// address." });
    expect(treasurySetup({ program: PROGRAM, rpcUrl: "nope" })).toEqual({ kind: "problem", problem: "NEXT_PUBLIC_SOLANA_RPC_URL is not a web address." });
    expect(treasurySetup({ program: PROGRAM, rpcUrl: "http://localhost:8899" }).kind).toBe("on");
  });
});

describe("where the published lists are read from", () => {
  it("is off until a folder is named", () => {
    expect(publishedSetup(undefined)).toEqual({ kind: "off" });
    expect(publishedSetup("")).toEqual({ kind: "off" });
    expect(publishedSetup("   ")).toEqual({ kind: "off" });
  });

  it("takes an https folder, with or without a trailing slash, and keeps its path", () => {
    expect(publishedSetup("https://files.example")).toEqual({ kind: "on", config: { baseUrl: "https://files.example" } });
    expect(publishedSetup("https://files.example/")).toEqual({ kind: "on", config: { baseUrl: "https://files.example" } });
    expect(publishedSetup(" https://files.example/breaks/published/// ")).toEqual({ kind: "on", config: { baseUrl: "https://files.example/breaks/published" } });
    expect(publishedSetup("https://files.example:8443/p")).toEqual({ kind: "on", config: { baseUrl: "https://files.example:8443/p" } });
  });

  it("accepts a plain http folder only on this machine", () => {
    expect(publishedSetup("http://localhost:8080/published")).toEqual({ kind: "on", config: { baseUrl: "http://localhost:8080/published" } });
    expect(publishedSetup("http://127.0.0.1:8080")).toEqual({ kind: "on", config: { baseUrl: "http://127.0.0.1:8080" } });
    expect(publishedSetup("http://files.example")).toEqual({ kind: "problem", problem: "NEXT_PUBLIC_PUBLISHED_URL must be an https:// address." });
    expect(publishedSetup("ftp://files.example").kind).toBe("problem");
  });

  it("names what is wrong, and refuses an address that carries a login, a query or a fragment", () => {
    expect(publishedSetup("not a url")).toEqual({ kind: "problem", problem: "NEXT_PUBLIC_PUBLISHED_URL is not a web address." });
    for (const bad of ["https://user:pass@files.example", "https://user@files.example", "https://files.example/p?key=1", "https://files.example/p#x"]) {
      expect(publishedSetup(bad), bad).toEqual({ kind: "problem", problem: "NEXT_PUBLIC_PUBLISHED_URL must be a plain folder address, without a login, a query or a fragment." });
    }
  });
});

describe("the shape of the next break, for the reserve bar", () => {
  const packs = (...groups: Array<[string, number | string, number]>) => JSON.stringify(groups.map(([machine, maxPrice, count]) => ({ machine, maxPrice, count })));
  const ONE = packs(["classic", "25000000", 12]);
  const ALL = { paidSpots: "10", freeSpots: "2", spotPrice: "20000000", packs: ONE };
  const MIXED = packs(["pricey", "50000000", 2], ["cheap", "10000000", 4], ["mid", "25000000", 2]);

  const problem = (over: Partial<typeof ALL>) => {
    const r = breakShapeSetup({ ...ALL, ...over });
    return r.kind === "problem" ? r.problem : r.kind;
  };

  it("is off until a setting is given, and then needs all four", () => {
    expect(breakShapeSetup({})).toEqual({ kind: "off" });
    expect(breakShapeSetup({ paidSpots: " ", freeSpots: "", spotPrice: undefined, packs: "  " })).toEqual({ kind: "off" });
    expect(breakShapeSetup({ paidSpots: "10" })).toEqual({
      kind: "problem",
      problem: "The next break's shape needs all four settings; missing NEXT_PUBLIC_BREAK_FREE_SPOTS, NEXT_PUBLIC_BREAK_SPOT_PRICE, NEXT_PUBLIC_BREAK_PACKS.",
    });
    expect(breakShapeSetup({ ...ALL, packs: "" })).toMatchObject({ kind: "problem", problem: expect.stringContaining("missing NEXT_PUBLIC_BREAK_PACKS") });
    // The old single-price setting is gone: a build that still sets only it is told what is missing.
    expect(breakShapeSetup({ paidSpots: "10", freeSpots: "2", spotPrice: "20000000" })).toMatchObject({ kind: "problem", problem: expect.stringContaining("missing NEXT_PUBLIC_BREAK_PACKS") });
  });

  it("reads the settings as the keeper's BREAK_* settings are written", () => {
    expect(breakShapeSetup(ALL)).toEqual({
      kind: "on",
      config: { paidSpots: 10, freeSpots: 2, spotPrice: 20_000_000n, packs: [{ machine: "classic", maxPrice: 25_000_000n, count: 12 }] },
    });
    expect(breakShapeSetup({ paidSpots: " 10 ", freeSpots: " 0 ", spotPrice: " 25000000 ", packs: ` ${packs(["classic", "25000000", 10])} ` })).toEqual({
      kind: "on",
      config: { paidSpots: 10, freeSpots: 0, spotPrice: 25_000_000n, packs: [{ machine: "classic", maxPrice: 25_000_000n, count: 10 }] },
    });
  });

  it("puts the groups cheapest first whatever order they are written in, and keeps equal prices in the order written", () => {
    const r = breakShapeSetup({ paidSpots: "6", freeSpots: "2", spotPrice: "20000000", packs: MIXED });
    expect(r).toEqual({
      kind: "on",
      config: {
        paidSpots: 6,
        freeSpots: 2,
        spotPrice: 20_000_000n,
        packs: [
          { machine: "cheap", maxPrice: 10_000_000n, count: 4 },
          { machine: "mid", maxPrice: 25_000_000n, count: 2 },
          { machine: "pricey", maxPrice: 50_000_000n, count: 2 },
        ],
      },
    });
    const tie = breakShapeSetup({ paidSpots: "3", freeSpots: "1", spotPrice: "1", packs: packs(["b", "5", 2], ["a", "5", 2]) });
    expect(tie.kind === "on" && tie.config.packs.map((g) => g.machine)).toEqual(["b", "a"]);
  });

  it("accepts a price written as a number, and a machine given as 0x and 64 hex digits", () => {
    const hex = `0x${"ab".repeat(32)}`;
    const r = breakShapeSetup({ ...ALL, packs: JSON.stringify([{ machine: hex, maxPrice: 25000000, count: 12 }]) });
    expect(r).toEqual({ kind: "on", config: { paidSpots: 10, freeSpots: 2, spotPrice: 20_000_000n, packs: [{ machine: hex, maxPrice: 25_000_000n, count: 12 }] } });
  });

  it("accepts the limits the program has and refuses beyond them, naming the setting", () => {
    expect(breakShapeSetup({ ...ALL, paidSpots: "1", packs: packs(["m", "25000000", 3]) }).kind).toBe("on");
    expect(problem({ paidSpots: "0" })).toBe("NEXT_PUBLIC_BREAK_PAID_SPOTS must be from 1 to 65535.");
    expect(problem({ paidSpots: "65536" })).toBe("NEXT_PUBLIC_BREAK_PAID_SPOTS must be from 1 to 65535.");
    expect(breakShapeSetup({ ...ALL, freeSpots: "0", packs: packs(["m", "25000000", 10]) }).kind).toBe("on");
    expect(breakShapeSetup({ ...ALL, paidSpots: "10", freeSpots: "16", packs: packs(["m", "25000000", 26]) }).kind).toBe("on");
    expect(problem({ freeSpots: "17" })).toBe("NEXT_PUBLIC_BREAK_FREE_SPOTS must be from 0 to 16.");
    expect(problem({ spotPrice: "0" })).toBe("NEXT_PUBLIC_BREAK_SPOT_PRICE must be above zero and fit in 64 bits.");
    expect(problem({ spotPrice: "18446744073709551616" })).toBe("NEXT_PUBLIC_BREAK_SPOT_PRICE must be above zero and fit in 64 bits.");
  });

  it("allows up to 64 spots (one pack each) and 8 groups, and refuses more", () => {
    const sixtyFour = breakShapeSetup({ paidSpots: "60", freeSpots: "4", spotPrice: "1", packs: packs(["m", "5", 64]) });
    expect(sixtyFour.kind).toBe("on");
    expect(breakShapeSetup({ paidSpots: "61", freeSpots: "4", spotPrice: "1", packs: packs(["m", "5", 65]) })).toEqual({
      kind: "problem",
      problem: "NEXT_PUBLIC_BREAK_PAID_SPOTS + NEXT_PUBLIC_BREAK_FREE_SPOTS is 65; a break has at most 64 spots (one pack each).",
    });
    const groups = (n: number) => packs(...Array.from({ length: n }, (_, i): [string, number, number] => [`m${i}`, 10 + i, 1]));
    expect(breakShapeSetup({ paidSpots: "8", freeSpots: "0", spotPrice: "1", packs: groups(8) }).kind).toBe("on");
    expect(breakShapeSetup({ paidSpots: "9", freeSpots: "0", spotPrice: "1", packs: groups(9) })).toEqual({
      kind: "problem",
      problem: "NEXT_PUBLIC_BREAK_PACKS has 9 groups; a break lists at most 8 machines.",
    });
  });

  it("refuses what is not a whole number, and says prices are micro-USDC", () => {
    for (const bad of ["20.5", "-1", "1e3", "ten", "0x10", "1 0"]) {
      expect(problem({ paidSpots: bad }), bad).toBe("NEXT_PUBLIC_BREAK_PAID_SPOTS is not a whole number.");
      expect(problem({ freeSpots: bad }), bad).toBe("NEXT_PUBLIC_BREAK_FREE_SPOTS is not a whole number.");
      expect(problem({ spotPrice: bad }), bad).toBe("NEXT_PUBLIC_BREAK_SPOT_PRICE is not a whole number of micro-USDC (so $20 is 20000000).");
    }
  });

  it("refuses a pack list that is not usable, saying which group and why", () => {
    const one = (g: unknown) => problem({ packs: JSON.stringify([g]) });
    expect(problem({ packs: "not json" })).toBe("NEXT_PUBLIC_BREAK_PACKS is not valid JSON (copy the keeper's BREAK_PACKS as it is written there).");
    expect(problem({ packs: "{}" })).toBe("NEXT_PUBLIC_BREAK_PACKS must be a list with at least one group of packs.");
    expect(problem({ packs: "[]" })).toBe("NEXT_PUBLIC_BREAK_PACKS must be a list with at least one group of packs.");
    expect(problem({ packs: "[7]" })).toBe("NEXT_PUBLIC_BREAK_PACKS, group 1: must be an object with machine, maxPrice and count.");
    expect(problem({ packs: "[null]" })).toBe("NEXT_PUBLIC_BREAK_PACKS, group 1: must be an object with machine, maxPrice and count.");
    expect(problem({ packs: "[[]]" })).toBe("NEXT_PUBLIC_BREAK_PACKS, group 1: must be an object with machine, maxPrice and count.");
    expect(one({ machine: "m", maxPrice: "25000000", count: 12, extra: 1 })).toBe('NEXT_PUBLIC_BREAK_PACKS, group 1: "extra" is not one of machine, maxPrice, count.');
    expect(problem({ packs: JSON.stringify([{ machine: "m", maxPrice: "25000000", count: 6 }, { machine: 5, maxPrice: "25000000", count: 6 }]) })).toBe(
      "NEXT_PUBLIC_BREAK_PACKS, group 2: machine must be text.",
    );
    expect(one({ machine: "", maxPrice: "25000000", count: 12 })).toBe("NEXT_PUBLIC_BREAK_PACKS, group 1: machine is empty.");
    expect(one({ machine: "x".repeat(33), maxPrice: "25000000", count: 12 })).toBe("NEXT_PUBLIC_BREAK_PACKS, group 1: machine is 33 bytes; at most 32 (or 0x and 64 hex digits).");
    expect(one({ machine: "é".repeat(17), maxPrice: "25000000", count: 12 })).toContain("machine is 34 bytes");
    expect(one({ machine: "a\nb", maxPrice: "25000000", count: 12 })).toBe("NEXT_PUBLIC_BREAK_PACKS, group 1: machine has a control character.");
    expect(one({ machine: "0xabc", maxPrice: "25000000", count: 12 })).toBe("NEXT_PUBLIC_BREAK_PACKS, group 1: machine looks like a hex id but is not 0x followed by exactly 64 hex digits.");
    expect(one({ machine: `0x${"zz".repeat(32)}`, maxPrice: "25000000", count: 12 })).toContain("looks like a hex id");
    // One hex digit too few or too many is not an id either, and neither is a missing 0x.
    for (const machine of [`0x${"a".repeat(63)}`, `0x${"a".repeat(65)}`, `0x${"a".repeat(62)}`, `0x${"a".repeat(66)}`]) {
      expect(one({ machine, maxPrice: "25000000", count: 12 }), machine).toContain("looks like a hex id");
    }
    // As the keeper reads it, the prefix is a lower-case 0x; the digits may be either case.
    expect(one({ machine: `0X${"a".repeat(64)}`, maxPrice: "25000000", count: 12 })).toContain("looks like a hex id");
    expect(breakShapeSetup({ ...ALL, packs: JSON.stringify([{ machine: `0x${"aB".repeat(32)}`, maxPrice: "25000000", count: 12 }]) }).kind).toBe("on");
    for (const bad of ["20.5", "-1", "1e3", "ten", "", "1 0", 1.5, -3, true, null, 2 ** 60]) {
      expect(one({ machine: "m", maxPrice: bad, count: 12 }), String(bad)).toBe(
        "NEXT_PUBLIC_BREAK_PACKS, group 1: maxPrice must be a whole number of micro-USDC (so $20 is 20000000), as a string of digits.",
      );
    }
    expect(one({ machine: "m", maxPrice: "0", count: 12 })).toBe("NEXT_PUBLIC_BREAK_PACKS, group 1: maxPrice must be above zero and fit in 64 bits.");
    expect(one({ machine: "m", maxPrice: 0, count: 12 })).toBe("NEXT_PUBLIC_BREAK_PACKS, group 1: maxPrice must be above zero and fit in 64 bits.");
    expect(one({ machine: "m", maxPrice: "18446744073709551616", count: 12 })).toBe("NEXT_PUBLIC_BREAK_PACKS, group 1: maxPrice must be above zero and fit in 64 bits.");
    for (const bad of [0, -1, 1.5, "12", null]) {
      expect(one({ machine: "m", maxPrice: "25000000", count: bad }), String(bad)).toBe("NEXT_PUBLIC_BREAK_PACKS, group 1: count must be a whole number, at least 1.");
    }
  });

  it("refuses a list whose packs do not add up to the spots: one pack per spot", () => {
    expect(problem({ packs: packs(["m", "25000000", 11]) })).toBe(
      "NEXT_PUBLIC_BREAK_PACKS lists 11 packs but NEXT_PUBLIC_BREAK_PAID_SPOTS + NEXT_PUBLIC_BREAK_FREE_SPOTS is 12: one pack per spot.",
    );
    expect(problem({ packs: packs(["m", "25000000", 13]) })).toContain("lists 13 packs");
    // The groups add up across machines, not within one.
    expect(breakShapeSetup({ ...ALL, packs: packs(["a", "20000000", 6], ["b", "30000000", 6]) }).kind).toBe("on");
  });

  it("refuses a spot price above the average pack price (a markup is not supported), and a worst case that does not fit in 64 bits", () => {
    const wrong = "NEXT_PUBLIC_BREAK_SPOT_PRICE must not be above the average pack price in NEXT_PUBLIC_BREAK_PACKS.";
    expect(problem({ spotPrice: "25000001" })).toBe(wrong);
    expect(problem({ spotPrice: "25000000" })).toBe("on");
    // Mixed packs: 4 × $10 + 2 × $25 + 2 × $50 = $190 over 8 spots, an average of $23.75.
    const mixed = { paidSpots: "6", freeSpots: "2", packs: MIXED };
    expect(breakShapeSetup({ ...mixed, spotPrice: "23750000" }).kind).toBe("on");
    expect(breakShapeSetup({ ...mixed, spotPrice: "23750001" })).toEqual({ kind: "problem", problem: wrong });
    // The average is rounded down, as the program rounds it: $10.0000005 per pack is $10 for the price check.
    const odd = packs(["m", "10", 1], ["n", "11", 1]);
    expect(breakShapeSetup({ paidSpots: "1", freeSpots: "1", spotPrice: "10", packs: odd }).kind).toBe("on");
    expect(breakShapeSetup({ paidSpots: "1", freeSpots: "1", spotPrice: "11", packs: odd })).toEqual({ kind: "problem", problem: wrong });
    const huge = "18446744073709551615";
    const overflow = { kind: "problem", problem: "The next break's worst case does not fit in 64 bits." };
    expect(breakShapeSetup({ paidSpots: "2", freeSpots: "0", spotPrice: "1", packs: packs(["m", huge, 2]) })).toEqual(overflow);
    expect(breakShapeSetup({ paidSpots: "1", freeSpots: "1", spotPrice: "1", packs: packs(["a", huge, 1], ["b", huge, 1]) })).toEqual(overflow);
    expect(breakShapeSetup({ paidSpots: "1", freeSpots: "0", spotPrice: huge, packs: packs(["m", huge, 1]) }).kind).toBe("on");
  });
});
