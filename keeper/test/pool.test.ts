import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fromHex, toHex } from "../src/draw/bytes.js";
import { assignCards, poolHash, sortedPool } from "../src/draw/pool.js";

const mint = (i: number): Uint8Array => new Uint8Array(32).fill(i);

describe("the pool", () => {
  it("is sorted by mint and refuses duplicates and wrong sizes", () => {
    expect(sortedPool([mint(3), mint(1), mint(2)]).map((m) => m[0])).toEqual([1, 2, 3]);
    expect(() => sortedPool([mint(1), mint(1)])).toThrow(/twice/);
    expect(() => sortedPool([new Uint8Array(31)])).toThrow(/32 bytes/);
  });

  it("has a hash that ignores the order cards were pulled in and changes with any card", () => {
    const h = toHex(poolHash([mint(3), mint(1), mint(2)]));
    expect(toHex(poolHash([mint(1), mint(2), mint(3)]))).toBe(h);
    expect(toHex(poolHash([mint(1), mint(2), mint(4)]))).not.toBe(h);
    expect(toHex(poolHash([mint(1), mint(2)]))).not.toBe(h);
  });
});

describe("assignCards", () => {
  // The Rust crate's example for 10 cards: the permutation for this seed.
  const vectors: { cases: { name: string; seed: string; assignment_n: number; assignment: number[] }[] } = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "..", "draw-core", "vectors.json"), "utf8"),
  );
  const c = vectors.cases.find((x) => x.assignment_n === 10) as (typeof vectors.cases)[number];
  const seed = fromHex(c.seed);
  const cards = Array.from({ length: 10 }, (_, i) => mint(i + 1));
  const paid = ["p0", "p1", "p2", "p3", "p4", "p5", "p6"];
  const free = ["f0", "f1", "f2"];

  it("gives spot s the card at index perm[s] of the sorted pool, paid spots first", () => {
    const result = assignCards(seed, cards, paid, free);
    expect(result).toHaveLength(10);
    result.forEach((r, s) => {
      expect(r.spot).toBe(s);
      expect(r.owner).toBe(s < 7 ? paid[s] : free[s - 7]);
      expect(r.kind).toBe(s < 7 ? "paid" : "free");
      expect(r.card[0]).toBe((c.assignment[s] as number) + 1);
    });
  });

  it("does not depend on the order the cards were pulled in", () => {
    const shuffled = [cards[4], cards[9], cards[0], cards[2], cards[7], cards[1], cards[8], cards[3], cards[6], cards[5]] as Uint8Array[];
    expect(assignCards(seed, shuffled, paid, free)).toEqual(assignCards(seed, cards, paid, free));
  });

  it("hands every card out exactly once", () => {
    const used = assignCards(seed, cards, paid, free).map((r) => r.card[0]);
    expect([...used].sort((a, b) => (a as number) - (b as number))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("needs exactly one card per spot", () => {
    expect(() => assignCards(seed, cards.slice(1), paid, free)).toThrow(/10 spots but 9 cards/);
    expect(() => assignCards(seed, cards, paid, free.slice(1))).toThrow();
  });
});
