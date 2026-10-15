import { describe, expect, it } from "vitest";
import { checkWeights } from "../lib/twab/weights";

const twabs = (o: Record<string, bigint>) => new Map(Object.entries(o));

describe("checking the weights on the list against the TWABs", () => {
  it("says every weight is its TWAB when they all are", () => {
    const r = checkWeights(
      [{ wallet: "a", weight: 100n }, { wallet: "b", weight: 50n }],
      twabs({ a: 100n, b: 50n }),
    );
    expect(r.verdict).toBe("equal");
    expect(r.counts).toEqual({ equal: 2, below: 0, above: 0, "no-history": 0 });
    expect(r.rows).toEqual([
      { wallet: "a", weight: 100n, twab: 100n, status: "equal" },
      { wallet: "b", weight: 50n, twab: 50n, status: "equal" },
    ]);
    expect(r.offList).toEqual([]);
  });

  it("calls a weight below its TWAB capped: only a cap explains it, and nothing is wrong with it", () => {
    const r = checkWeights([{ wallet: "a", weight: 100n }, { wallet: "b", weight: 40n }], twabs({ a: 100n, b: 900n }));
    expect(r.verdict).toBe("capped");
    expect(r.rows.map((x) => x.status)).toEqual(["equal", "below"]);
  });

  it("calls a weight above its TWAB wrong, even by one base unit", () => {
    const r = checkWeights([{ wallet: "a", weight: 101n }, { wallet: "b", weight: 50n }], twabs({ a: 100n, b: 50n }));
    expect(r.verdict).toBe("wrong");
    expect(r.rows[0]).toEqual({ wallet: "a", weight: 101n, twab: 100n, status: "above" });
    expect(r.counts.above).toBe(1);
  });

  it("calls a wallet with no event in the record wrong: it cannot have a weight", () => {
    const r = checkWeights([{ wallet: "ghost", weight: 5n }, { wallet: "a", weight: 10n }], twabs({ a: 10n }));
    expect(r.verdict).toBe("wrong");
    expect(r.rows[0]).toEqual({ wallet: "ghost", weight: 5n, twab: undefined, status: "no-history" });
  });

  it("is wrong when one row is wrong, however many are fine or capped", () => {
    const r = checkWeights([{ wallet: "a", weight: 1n }, { wallet: "b", weight: 200n }, { wallet: "c", weight: 3n }], twabs({ a: 10n, b: 100n, c: 3n }));
    expect(r.verdict).toBe("wrong");
    expect(r.counts).toEqual({ equal: 1, below: 1, above: 1, "no-history": 0 });
  });

  it("lists, biggest first, the wallets with a TWAB that are not on the list, and leaves out the ones with nothing", () => {
    const r = checkWeights([{ wallet: "a", weight: 100n }], twabs({ a: 100n, z: 30n, y: 30n, big: 5000n, none: 0n }));
    expect(r.offList).toEqual([
      { wallet: "big", twab: 5000n },
      { wallet: "y", twab: 30n },
      { wallet: "z", twab: 30n },
    ]);
    expect(r.verdict).toBe("equal");
  });

  it("keeps the order of the list in its rows, and compares exact numbers above 2^53", () => {
    const big = 18_000_000_000_000_000_001n;
    const r = checkWeights([{ wallet: "z", weight: big }, { wallet: "a", weight: big }], twabs({ a: big - 1n, z: big }));
    expect(r.rows.map((x) => x.wallet)).toEqual(["z", "a"]);
    expect(r.rows.map((x) => x.status)).toEqual(["equal", "above"]);
  });

  it("is fine with an empty list, and with an empty record", () => {
    expect(checkWeights([], twabs({ a: 10n })).verdict).toBe("equal");
    expect(checkWeights([], twabs({ a: 10n })).offList).toEqual([{ wallet: "a", twab: 10n }]);
    expect(checkWeights([], new Map())).toEqual({ rows: [], counts: { equal: 0, below: 0, above: 0, "no-history": 0 }, offList: [], verdict: "equal" });
  });
});
