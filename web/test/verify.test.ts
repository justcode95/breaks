import { readFileSync } from "node:fs";
import { join } from "node:path";
import { base58 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { fromHex, hashv, toHex, utf8 } from "../lib/draw/bytes";
import { emptyInput, exampleInput } from "../lib/example";
import { MAX_FREE_SPOTS, type VerifyInput, type VerifyResult, type Verified, verifyDraw } from "../lib/verify";

interface Case {
  name: string;
  leaves: { wallet: string; weight: string }[];
  root: { hash: string; sum: string };
  seed: string;
  free_winners: { leaf: number; start: string; weight: string; position: string }[];
  assignment_n: number;
  assignment: number[];
}
const root = join(import.meta.dirname, "..", "..");
const vectors: { cases: Case[] } = JSON.parse(readFileSync(join(root, "draw-core", "vectors.json"), "utf8"));

const b58 = (hex: string) => base58.encode(fromHex(hex));
const ok = (r: VerifyResult): Verified => {
  if (!r.ok) throw new Error(`expected a result, got: ${r.errors.join(" | ")}`);
  return r;
};
const errorsOf = (r: VerifyResult): string[] => (r.ok ? [] : r.errors);

/** The inputs of a Rust vector case, as a person would paste them. */
function inputOf(c: Case): VerifyInput {
  const winners = c.free_winners.length;
  const paid = c.assignment_n - winners;
  // Mint i is 32 bytes of i+1, so the sorted pool is in index order and `assignment[s]` names the card index directly.
  const mints = Array.from({ length: c.assignment_n }, (_, i) => base58.encode(new Uint8Array(32).fill(i + 1)));
  return {
    seed: c.seed,
    holders: c.leaves.map((l) => `${b58(l.wallet)} ${l.weight}`).join("\n"),
    record: "",
    inputs: "",
    freeSpots: String(winners),
    paidOwners: Array.from({ length: paid }, (_, i) => base58.encode(new Uint8Array(32).fill(200 + i))).join("\n"),
    cards: [...mints].reverse().join("\n"), // any order
    expected: { root: c.root.hash, totalWeight: c.root.sum, entryCount: String(c.leaves.length), inputsHash: "", poolHash: "" },
  };
}

describe("the Rust vectors, through the text a person pastes", () => {
  for (const c of vectors.cases) {
    it(c.name, () => {
      const r = ok(verifyDraw(inputOf(c)));
      expect(r.eligibility).toEqual({ root: c.root.hash, totalWeight: BigInt(c.root.sum), entries: c.leaves.length });
      expect(r.checks.map((x) => x.matches)).toEqual([true, true, true]);
      expect(r.winners.map((w) => ({ leaf: c.leaves.findIndex((l) => b58(l.wallet) === w.wallet), start: w.start.toString(), weight: w.weight.toString(), position: w.position.toString() }))).toEqual(c.free_winners);
      // Spot s gets the card at index perm[s] of the pool sorted by mint.
      const cardIndex = (card: string) => (base58.decode(card)[0] as number) - 1;
      expect(r.assignment?.map((s) => cardIndex(s.card))).toEqual(c.assignment);
      expect(r.assignment?.map((s) => s.kind)).toEqual([...Array(c.assignment_n - c.free_winners.length).fill("paid"), ...Array(c.free_winners.length).fill("free")]);
    });
  }
});

describe("the seed", () => {
  const base = exampleInput();

  it("takes the draw seed, or ORAO's 64 bytes and derives the seed from them", () => {
    const direct = ok(verifyDraw({ ...base, seed: "ab".repeat(32) }));
    expect(direct.seed).toEqual({ hex: "ab".repeat(32), derived: false });
    const answer = Array.from({ length: 64 }, (_, i) => i.toString(16).padStart(2, "0")).join("");
    const derived = ok(verifyDraw({ ...base, seed: answer }));
    // The Rust program's vector for this exact answer (programs/breaks/instruction-vectors.json, breaks.draw_seed).
    expect(derived.seed).toEqual({ hex: "894185abe9144339ba6dd9a8a963f0dec5e720cf547cd38c233fa7afc1d46630", derived: true });
  });

  it("ignores spaces, line breaks and a 0x prefix", () => {
    const s = "0x" + "ab".repeat(16) + "\n " + "ab".repeat(16);
    expect(ok(verifyDraw({ ...base, seed: s })).seed.hex).toBe("ab".repeat(32));
  });

  it("refuses anything else", () => {
    for (const bad of ["", "abc", "zz".repeat(32), "ab".repeat(33), "ab".repeat(31)]) {
      expect(errorsOf(verifyDraw({ ...base, seed: bad })).join(" "), JSON.stringify(bad)).toMatch(/^Seed/);
    }
  });

  it("changes the winners and the cards when the seed changes", () => {
    const a = ok(verifyDraw({ ...base, seed: "01".repeat(32) }));
    const b = ok(verifyDraw({ ...base, seed: "02".repeat(32) }));
    expect(a.assignment?.map((s) => s.card)).not.toEqual(b.assignment?.map((s) => s.card));
  });
});

describe("the eligible holders", () => {
  const base = exampleInput();
  const w = (n: number) => base58.encode(new Uint8Array(32).fill(n));

  it("may be listed in any order, with commas, tabs or comments, and give the same root", () => {
    const a = ok(verifyDraw({ ...base, holders: `${w(1)} 10\n${w(2)} 20\n${w(3)} 30` }));
    const b = ok(verifyDraw({ ...base, holders: `# a comment\n${w(3)},30\n\n${w(1)}\t10\r\n${w(2)};20` }));
    expect(b.eligibility).toEqual(a.eligibility);
    expect(b.winners).toEqual(a.winners);
  });

  it("reports each bad line by number and does not compute", () => {
    const r = verifyDraw({
      ...base,
      holders: [w(1) + " 10", "nonsense", w(2) + " 0", w(3) + " -5", "11111 7", w(1) + " 4", w(4) + " 18446744073709551616", w(5) + " 1 2"].join("\n"),
    });
    const e = errorsOf(r);
    expect(r.ok).toBe(false);
    expect(e.some((m) => /line 2.*got 1 fields/.test(m))).toBe(true);
    expect(e.some((m) => /line 3.*weight/.test(m))).toBe(true);
    expect(e.some((m) => /line 4.*weight/.test(m))).toBe(true);
    expect(e.some((m) => /line 5.*not a Solana address/.test(m))).toBe(true);
    expect(e.some((m) => /line 6.*already on line 1/.test(m))).toBe(true);
    expect(e.some((m) => /line 7.*weight/.test(m))).toBe(true);
    expect(e.some((m) => /line 8.*got 3 fields/.test(m))).toBe(true);
  });

  it("says when the weights add up to more than a u64", () => {
    const max = "18446744073709551615";
    expect(errorsOf(verifyDraw({ ...base, holders: `${w(1)} ${max}\n${w(2)} 1` }))).toEqual(["Holders: the weights add up to more than 18446744073709551615."]);
  });

  it("treats an empty list as a zero root and no winners, as the keeper commits it", () => {
    const r = ok(verifyDraw({ ...base, holders: "", paidOwners: w(9), cards: w(50), freeSpots: "2" }));
    expect(r.eligibility).toEqual({ root: "0".repeat(64), totalWeight: 0n, entries: 0 });
    expect(r.winners).toEqual([]);
    expect(r.assignment).toHaveLength(1);
  });

  it("draws only as many winners as there are wallets, and never one wallet twice", () => {
    const r = ok(verifyDraw({ ...base, holders: `${w(1)} 1000000\n${w(2)} 1`, freeSpots: "5", paidOwners: "", cards: "" }));
    expect(r.winners.map((x) => x.wallet).sort()).toEqual([w(1), w(2)].sort());
    expect(new Set(r.winners.map((x) => x.wallet)).size).toBe(2);
  });
});

describe("free spots", () => {
  it("is a whole number from 0 to 16", () => {
    for (const bad of ["", "-1", "1.5", "x", String(MAX_FREE_SPOTS + 1)]) {
      expect(errorsOf(verifyDraw({ ...exampleInput(), freeSpots: bad })).join(" "), bad).toMatch(/Free spots/);
    }
    expect(ok(verifyDraw({ ...exampleInput(), freeSpots: "0", cards: "", paidOwners: "" })).winners).toEqual([]);
    expect(ok(verifyDraw({ ...exampleInput(), freeSpots: "16", cards: "", paidOwners: "", holders: Array.from({ length: 20 }, (_, i) => `${base58.encode(new Uint8Array(32).fill(i + 1))} ${i + 1}`).join("\n") })).winners).toHaveLength(16);
  });
});

describe("the pool and the assignment", () => {
  const base = exampleInput();

  it("needs one card per spot", () => {
    // 3 paid + 2 free = 5 spots.
    const four = base.cards.split("\n").slice(0, 4).join("\n");
    expect(errorsOf(verifyDraw({ ...base, cards: four }))).toEqual(["Pool: 3 paid spots + 2 free winners make 5 spots, but 4 cards were given. There is one card per spot."]);
  });

  it("gives every card to exactly one spot, whatever order the cards are listed in", () => {
    const a = ok(verifyDraw(base));
    const reversed = ok(verifyDraw({ ...base, cards: base.cards.split("\n").reverse().join("\n") }));
    expect(reversed.assignment).toEqual(a.assignment);
    expect(reversed.poolHash).toBe(a.poolHash);
    expect(new Set(a.assignment?.map((s) => s.card)).size).toBe(5);
    expect(a.assignment?.map((s) => s.spot)).toEqual([1, 2, 3, 4, 5]);
    // The free spots go to the drawn winners, after the paid ones.
    expect(a.assignment?.slice(3).map((s) => s.wallet)).toEqual(a.winners.map((x) => x.wallet));
  });

  it("refuses a card listed twice and an address that is not one", () => {
    const first = base.cards.split("\n")[0] as string;
    expect(errorsOf(verifyDraw({ ...base, cards: `${base.cards}\n${first}` })).join(" ")).toMatch(/more than once/);
    expect(errorsOf(verifyDraw({ ...base, cards: "not-a-mint" })).join(" ")).toMatch(/Cards, line 1/);
    expect(errorsOf(verifyDraw({ ...base, paidOwners: "nope" })).join(" ")).toMatch(/Paid spots, line 1/);
  });

  it("shows the winners alone when no cards are given", () => {
    const r = ok(verifyDraw({ ...base, cards: "", paidOwners: "" }));
    expect(r.winners).toHaveLength(2);
    expect(r.assignment).toBeUndefined();
    expect(r.poolHash).toBeUndefined();
  });
});

describe("comparing with the break's account", () => {
  const base = exampleInput();
  const r = ok(verifyDraw(base));

  it("passes when every value matches (upper or lower case)", () => {
    const e = { root: r.eligibility.root.toUpperCase(), totalWeight: String(r.eligibility.totalWeight), entryCount: String(r.eligibility.entries), inputsHash: "", poolHash: r.poolHash as string };
    const checked = ok(verifyDraw({ ...base, expected: e }));
    expect(checked.checks.map((c) => [c.label, c.matches])).toEqual([
      ["Eligibility root", true],
      ["Total weight", true],
      ["Eligible wallets", true],
      ["Pool hash", true],
    ]);
  });

  it("flags each value that differs, and one that cannot be checked", () => {
    const good = { root: r.eligibility.root, totalWeight: String(r.eligibility.totalWeight), entryCount: String(r.eligibility.entries), inputsHash: "", poolHash: r.poolHash as string };
    const flip = (hex: string) => (hex[0] === "a" ? "b" : "a") + hex.slice(1);
    const bad = ok(verifyDraw({ ...base, expected: { root: flip(good.root), totalWeight: "1", entryCount: "99", inputsHash: "", poolHash: flip(good.poolHash) } }));
    expect(bad.checks.map((c) => c.matches)).toEqual([false, false, false, false]);
    const noCards = ok(verifyDraw({ ...base, cards: "", paidOwners: "", expected: { ...good, root: "", totalWeight: "", entryCount: "" } }));
    expect(noCards.checks).toEqual([{ label: "Pool hash", expected: good.poolHash, actual: "no cards given", matches: false }]);
  });

  it("checks nothing that is left empty, and refuses values that are not numbers or hashes", () => {
    expect(ok(verifyDraw(base)).checks).toEqual([]);
    const bad = errorsOf(verifyDraw({ ...base, expected: { root: "12", totalWeight: "abc", entryCount: "-1", inputsHash: "", poolHash: "zz" } }));
    expect(bad).toEqual(["Expected pool hash: 64 hex digits.", "Expected root: 64 hex digits.", "Expected total weight: a whole number.", "Expected entry count: a whole number."].sort((a, b) => bad.indexOf(a) - bad.indexOf(b)));
    expect(bad).toHaveLength(4);
  });
});

describe("asking before the list is pasted", () => {
  it("says why the root differs instead of only saying that it does", () => {
    const base = exampleInput();
    const r = ok(verifyDraw({ ...base, holders: "", freeSpots: "0", paidOwners: "", cards: "", expected: { root: "ab".repeat(32), totalWeight: "130", entryCount: "6", inputsHash: "", poolHash: "" } }));
    expect(r.checks.map((c) => c.matches)).toEqual([false, false, false]);
    expect(r.notes).toEqual(["The eligibility list is empty, so these inputs commit to the zero root: paste the published list to compare it."]);
  });

  it("stays quiet when an empty list is what was committed", () => {
    const r = ok(verifyDraw({ ...exampleInput(), holders: "", freeSpots: "0", paidOwners: "", cards: "", expected: { root: "0".repeat(64), totalWeight: "0", entryCount: "0", inputsHash: "", poolHash: "" } }));
    expect(r.checks.every((c) => c.matches)).toBe(true);
    expect(r.notes).toEqual([]);
  });
});

describe("a long list of mistakes", () => {
  it("shows the first dozen and counts the rest", () => {
    const holders = Array.from({ length: 30 }, () => "bad line").join("\n");
    const e = errorsOf(verifyDraw({ ...exampleInput(), holders }));
    expect(e).toHaveLength(13);
    expect(e[12]).toBe("... and 18 more.");
  });
});

describe("the example", () => {
  it("is a break that verifies, and the empty form is not", () => {
    const r = ok(verifyDraw(exampleInput()));
    expect(r.eligibility.entries).toBe(6);
    expect(r.eligibility.totalWeight).toBe(130n);
    expect(r.winners).toHaveLength(2);
    expect(r.assignment).toHaveLength(5);
    expect(verifyDraw(emptyInput()).ok).toBe(false);
    // Deterministic: the same words give the same break.
    expect(toHex(hashv(utf8("example seed")))).toBe(exampleInput().seed);
  });
});
