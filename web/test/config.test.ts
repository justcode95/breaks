import { describe, expect, it } from "vitest";
import { DEFAULT_RPC_URL, breakShapeSetup, chainSetup, treasurySetup } from "../lib/config";

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

describe("the shape of the next break, for the reserve bar", () => {
  const ALL = { paidSpots: "10", freeSpots: "2", spotPrice: "20000000", maxPackPrice: "25000000" };

  it("is off until a setting is given, and then needs all four", () => {
    expect(breakShapeSetup({})).toEqual({ kind: "off" });
    expect(breakShapeSetup({ paidSpots: " ", freeSpots: "", spotPrice: undefined, maxPackPrice: "  " })).toEqual({ kind: "off" });
    expect(breakShapeSetup({ paidSpots: "10" })).toEqual({
      kind: "problem",
      problem: "The next break's shape needs all four settings; missing NEXT_PUBLIC_BREAK_FREE_SPOTS, NEXT_PUBLIC_BREAK_SPOT_PRICE, NEXT_PUBLIC_BREAK_MAX_PACK_PRICE.",
    });
    expect(breakShapeSetup({ ...ALL, maxPackPrice: "" })).toMatchObject({ kind: "problem", problem: expect.stringContaining("missing NEXT_PUBLIC_BREAK_MAX_PACK_PRICE") });
  });

  it("reads the four numbers as the keeper's BREAK_* settings are written", () => {
    expect(breakShapeSetup(ALL)).toEqual({ kind: "on", config: { paidSpots: 10, freeSpots: 2, spotPrice: 20_000_000n, maxPackPrice: 25_000_000n } });
    expect(breakShapeSetup({ paidSpots: " 10 ", freeSpots: " 0 ", spotPrice: " 25000000 ", maxPackPrice: " 25000000 " })).toEqual({
      kind: "on",
      config: { paidSpots: 10, freeSpots: 0, spotPrice: 25_000_000n, maxPackPrice: 25_000_000n },
    });
  });

  it("accepts the limits the program has and refuses beyond them, naming the setting", () => {
    const problem = (over: Partial<typeof ALL>) => {
      const r = breakShapeSetup({ ...ALL, ...over });
      return r.kind === "problem" ? r.problem : r.kind;
    };
    expect(breakShapeSetup({ ...ALL, paidSpots: "1" }).kind).toBe("on");
    expect(breakShapeSetup({ ...ALL, paidSpots: "65535" }).kind).toBe("on");
    expect(problem({ paidSpots: "0" })).toBe("NEXT_PUBLIC_BREAK_PAID_SPOTS must be from 1 to 65535.");
    expect(problem({ paidSpots: "65536" })).toBe("NEXT_PUBLIC_BREAK_PAID_SPOTS must be from 1 to 65535.");
    expect(breakShapeSetup({ ...ALL, freeSpots: "0" }).kind).toBe("on");
    expect(breakShapeSetup({ ...ALL, freeSpots: "16" }).kind).toBe("on");
    expect(problem({ freeSpots: "17" })).toBe("NEXT_PUBLIC_BREAK_FREE_SPOTS must be from 0 to 16.");
    expect(problem({ spotPrice: "0" })).toBe("NEXT_PUBLIC_BREAK_SPOT_PRICE must be above zero and fit in 64 bits.");
    expect(problem({ maxPackPrice: "0" })).toBe("NEXT_PUBLIC_BREAK_MAX_PACK_PRICE must be above zero and fit in 64 bits.");
    expect(problem({ spotPrice: "18446744073709551616", maxPackPrice: "18446744073709551616" })).toBe("NEXT_PUBLIC_BREAK_SPOT_PRICE must be above zero and fit in 64 bits.");
  });

  it("refuses what is not a whole number, and says prices are micro-USDC", () => {
    for (const bad of ["20.5", "-1", "1e3", "ten", "0x10", "1 0"]) {
      expect(breakShapeSetup({ ...ALL, paidSpots: bad }), bad).toEqual({ kind: "problem", problem: "NEXT_PUBLIC_BREAK_PAID_SPOTS is not a whole number." });
      expect(breakShapeSetup({ ...ALL, freeSpots: bad }), bad).toEqual({ kind: "problem", problem: "NEXT_PUBLIC_BREAK_FREE_SPOTS is not a whole number." });
      expect(breakShapeSetup({ ...ALL, spotPrice: bad }), bad).toEqual({ kind: "problem", problem: "NEXT_PUBLIC_BREAK_SPOT_PRICE is not a whole number of micro-USDC (so $20 is 20000000)." });
      expect(breakShapeSetup({ ...ALL, maxPackPrice: bad }), bad).toEqual({ kind: "problem", problem: "NEXT_PUBLIC_BREAK_MAX_PACK_PRICE is not a whole number of micro-USDC (so $20 is 20000000)." });
    }
  });

  it("refuses a spot price above the pack price (a markup is not supported), and a worst case that does not fit in 64 bits", () => {
    expect(breakShapeSetup({ ...ALL, spotPrice: "25000001" })).toEqual({ kind: "problem", problem: "NEXT_PUBLIC_BREAK_SPOT_PRICE must not be above NEXT_PUBLIC_BREAK_MAX_PACK_PRICE." });
    expect(breakShapeSetup({ ...ALL, spotPrice: "25000000" }).kind).toBe("on");
    const huge = "18446744073709551615";
    expect(breakShapeSetup({ paidSpots: "2", freeSpots: "0", spotPrice: "1", maxPackPrice: huge })).toEqual({ kind: "problem", problem: "The next break's worst case does not fit in 64 bits." });
    expect(breakShapeSetup({ paidSpots: "1", freeSpots: "2", spotPrice: huge, maxPackPrice: huge })).toEqual({ kind: "problem", problem: "The next break's worst case does not fit in 64 bits." });
    expect(breakShapeSetup({ paidSpots: "1", freeSpots: "1", spotPrice: huge, maxPackPrice: huge }).kind).toBe("on");
  });
});
