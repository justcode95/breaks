import { describe, expect, it } from "vitest";
import { TOLERANCE, freeSpotChance, gaussKronrod, integrate } from "../lib/chance";
import { hashv, u16le, utf8 } from "../lib/draw/bytes";
import { drawFreeWinners } from "../lib/draw/draw";

/** The chance by going through every order in which the first `k` winners can be drawn: the definition, with nothing clever. */
function exact(weights: readonly number[], i: number, k: number): number {
  const walk = (left: readonly number[], drawn: number): number => {
    if (drawn === k) return 0;
    const total = left.reduce((a, j) => a + (weights[j] as number), 0);
    let p = 0;
    for (const j of left) {
      const pj = (weights[j] as number) / total;
      p += j === i ? pj : pj * walk(left.filter((x) => x !== j), drawn + 1);
    }
    return p;
  };
  return walk(
    weights.map((_, j) => j),
    0,
  );
}

/** Small numbers that are the same on every run. */
function numbers(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

describe("the Gauss–Kronrod rule", () => {
  it("is exact for polynomials up to degree 22, and its Gauss part up to degree 13", () => {
    for (let d = 0; d <= 22; d++) {
      const { kronrod, gauss } = gaussKronrod((x) => x ** d, 0, 1);
      expect(kronrod, `degree ${d}`).toBeCloseTo(1 / (d + 1), 14);
      if (d <= 13) expect(gauss, `degree ${d}`).toBeCloseTo(1 / (d + 1), 14);
    }
    // Degree 14 is the first the Gauss part gets wrong, which is what makes the difference an error estimate.
    const { kronrod, gauss } = gaussKronrod((x) => x ** 14, 0, 1);
    expect(Math.abs(kronrod - gauss)).toBeGreaterThan(1e-9);
    // Any interval, not only [0, 1].
    expect(gaussKronrod((x) => 3 * x * x, -2, 5).kronrod).toBeCloseTo(133, 10);
  });

  it("integrates over several pieces, halving where it is not sure yet, to the tolerance", () => {
    expect(TOLERANCE).toBe(1e-7);
    expect(integrate((x) => Math.exp(-x), [[0, 30]])).toBeCloseTo(1, 7);
    // A bump narrower than the gaps between a rule's points is not seen at all, and the error estimate says all is well: why the
    // chance below first cuts its window where the features are. With a cut at the bump, the halving finds it.
    const bump = (x: number) => Math.exp(-(((x - 3.3) / 0.01) ** 2));
    expect(integrate(bump, [[0, 10]])).toBe(0);
    expect(integrate(bump, [[0, 3.3], [3.3, 10]])).toBeCloseTo(0.01 * Math.sqrt(Math.PI), 7);
    expect(integrate((x) => x, [[0, 1], [1, 3]])).toBeCloseTo(4.5, 12);
  });

  it("stops after a bounded amount of work, even for something it can never get right", () => {
    let calls = 0;
    const wild = (x: number) => {
      calls++;
      return Math.sin(1 / x);
    };
    expect(Number.isFinite(integrate(wild, [[0, 1]]))).toBe(true);
    // One piece to start with, then two for each of at most 200 halvings, 15 points each.
    expect(calls).toBeLessThanOrEqual((1 + 2 * 200) * 15);
    expect(calls).toBeGreaterThan(200 * 15);
  });
});

describe("the chance of a free spot", () => {
  it("is the definition's, for every wallet and every number of free spots of small lists, however lopsided", () => {
    const next = numbers(7);
    let checked = 0;
    for (let trial = 0; trial < 160; trial++) {
      const n = 2 + Math.floor(next() * 6);
      const skew = [1, 1e3, 1e6, 1e12][trial % 4] as number;
      const weights = Array.from({ length: n }, () => 1 + Math.floor(next() ** 3 * skew));
      for (let k = 1; k <= n; k++) {
        for (let i = 0; i < n; i++) {
          expect(Math.abs(freeSpotChance(weights.map(BigInt), i, k) - exact(weights, i, k)), `${weights} wallet ${i}, ${k} drawn`).toBeLessThan(TOLERANCE);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(1500);
  });

  it("is the definition's for a tiny wallet among big ones, whose chance a coarse look misses", () => {
    // Found while writing this: integrating over another variable, every point of the first rule fell past where this wallet's
    // chance lives, and the answer was 0 with an error estimate of 0.
    const weights = [476, 177895, 720177, 767942, 23764, 753068, 532864];
    expect(freeSpotChance(weights.map(BigInt), 0, 3)).toBeCloseTo(exact(weights, 0, 3), 9);
    expect(exact(weights, 0, 3)).toBeGreaterThan(6e-4);
  });

  it("is the definition's for one wallet among many alike, whose chance has a formula, from far lighter to far heavier", () => {
    // One wallet of weight v among m of weight w: while it is not drawn and r others are, it is drawn next with chance
    // v / (v + (m − r) w). Many alike wallets make the others' step as narrow as it gets for k free spots, and sweeping v moves it
    // across this wallet's bump, which is where a coarse look goes wrong (pieces 16 units wide miss it by 10^−6).
    const formula = (v: number, w: number, m: number, k: number) => {
      let stay = 1;
      for (let r = 0; r < k; r++) stay *= 1 - v / (v + (m - r) * w);
      return 1 - stay;
    };
    for (const m of [50, 500]) {
      for (const k of [2, 16]) {
        for (let p = -70; p <= 30; p += 2) {
          const w = 1_000_000_000;
          const v = Math.max(1, Math.round(10 ** (p / 10) * w));
          const weights = [BigInt(v), ...Array<bigint>(m).fill(BigInt(w))];
          expect(Math.abs(freeSpotChance(weights, 0, k) - formula(v, w, m, k)), `${m} alike, ${k} drawn, v/w = 1e${p / 10}`).toBeLessThan(TOLERANCE);
        }
      }
    }
  });

  it("is exactly the share of the weight for one free spot, all or nothing at the edges, and k in n for equal weights", () => {
    expect(freeSpotChance([3n, 1n, 4n], 2, 1)).toBe(0.5);
    expect(freeSpotChance([1n, 2n], 0, 1)).toBe(1 / 3);
    expect(freeSpotChance([7n, 3n, 11n, 1n], 2, 1)).toBe(11 / 22);
    expect(freeSpotChance([7n, 3n, 11n, 1n], 3, 1)).toBe(1 / 22);
    expect(freeSpotChance([3n, 1n, 4n], 1, 0)).toBe(0);
    expect(freeSpotChance([3n, 1n, 4n], 1, 3)).toBe(1);
    expect(freeSpotChance([1n, 10n ** 12n, 1n], 0, 3)).toBe(1);
    expect(freeSpotChance([5n, 10n ** 9n, 2n, 10n ** 6n], 2, 4)).toBe(1);
    expect(freeSpotChance([3n, 1n, 4n], 1, 5)).toBe(1);
    expect(freeSpotChance(Array<bigint>(10).fill(7n), 3, 4)).toBeCloseTo(0.4, 9);
    // Weights near the 64-bit limit work the same as small ones.
    const big = 2n ** 64n - 1n;
    expect(freeSpotChance([big, big, big / 2n, 1n], 3, 2)).toBeCloseTo(exact([2 ** 64, 2 ** 64, 2 ** 63, 1], 3, 2), 9);
    expect(freeSpotChance([big, big, big / 2n, 1n], 2, 2)).toBeCloseTo(exact([2 ** 64, 2 ** 64, 2 ** 63, 1], 2, 2), 9);
  });

  it("adds up to the number of free spots over the whole list", () => {
    const next = numbers(11);
    for (const [n, k, skew] of [
      [40, 5, 1e3],
      [60, 16, 1e6],
      [25, 2, 1],
    ] as const) {
      const weights = Array.from({ length: n }, () => BigInt(1 + Math.floor(next() ** 2 * skew)));
      const sum = weights.reduce((acc, _, i) => acc + freeSpotChance(weights, i, k), 0);
      expect(sum, `${n} wallets, ${k} drawn`).toBeCloseTo(k, 5);
    }
  });

  it("is what the real draw does: how often each wallet wins over many seeds", () => {
    const weights = [50n, 20n, 15n, 10n, 3n, 2n];
    const leaves = weights.map((weight, i) => ({ wallet: new Uint8Array(32).fill(i + 1), weight }));
    const runs = 4000;
    const wins = weights.map(() => 0);
    for (let s = 0; s < runs; s++) {
      for (const w of drawFreeWinners(hashv(utf8("chance test"), u16le(s)), leaves, 2)) wins[w.leafIndex] = (wins[w.leafIndex] as number) + 1;
    }
    for (const [i, count] of wins.entries()) {
      const p = freeSpotChance(weights, i, 2);
      const spread = Math.sqrt((p * (1 - p)) / runs);
      expect(Math.abs(count / runs - p), `wallet ${i}: ${count} wins, chance ${p}`).toBeLessThan(5 * spread + 1e-9);
    }
  });

  it("works out a big list quickly enough for a page", () => {
    const equal = Array<bigint>(5000).fill(123n);
    const started = performance.now();
    expect(freeSpotChance(equal, 17, 16)).toBeCloseTo(16 / 5000, 7);
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it("refuses what is not a list, a wallet or a number of free spots", () => {
    expect(() => freeSpotChance([1n, 2n], 2, 1)).toThrow("no wallet at index 2 of 2");
    expect(() => freeSpotChance([1n, 2n], -1, 1)).toThrow("no wallet at index -1 of 2");
    expect(() => freeSpotChance([1n, 2n], 0.5, 1)).toThrow("no wallet at index 0.5 of 2");
    expect(() => freeSpotChance([1n, 2n], 0, -1)).toThrow("cannot draw -1 free spots");
    expect(() => freeSpotChance([1n, 2n], 0, 1.5)).toThrow("cannot draw 1.5 free spots");
    expect(() => freeSpotChance([1n, 0n], 0, 1)).toThrow("every weight on a list is above zero");
    expect(() => freeSpotChance([], 0, 1)).toThrow("no wallet at index 0 of 0");
  });
});
