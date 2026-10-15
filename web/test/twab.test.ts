import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type InputEvent, type InputWindow, parseInputs } from "../lib/twab/inputs";
import { MAX_SAME_SLOT, TwabError, twabByOwner } from "../lib/twab/twab";

// The vectors are made by the keeper's own code (keeper/test/twab-vectors.test.ts): the text the keeper publishes and what the
// keeper's TWAB makes of it. This implementation was written on its own and has to give the same numbers, and refuse the same
// histories, from the text alone.
interface Vector {
  name: string;
  inputs: string;
  twab?: Record<string, string>;
  error?: "opening" | "chain";
}
const VECTORS = (JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "docs", "twab-vectors.json"), "utf8")) as { version: number; cases: Vector[] }).cases;

const W: InputWindow = { start: 1_000, end: 2_000 };
const ev = (signature: string, owner: string, tokenAccount: string, time: number, delta: bigint, balanceAfter: bigint, slot = BigInt(time)): InputEvent => ({ signature, slot, time, owner, tokenAccount, delta, balanceAfter });
const twab = (events: InputEvent[], window = W) => Object.fromEntries([...twabByOwner(events, window)].map(([k, v]) => [k, v.toString()]));

describe("the keeper's vectors", () => {
  it("are all there, so an emptied file cannot pass", () => {
    expect(VECTORS.length).toBeGreaterThan(60);
    expect(VECTORS.filter((v) => v.twab).length).toBeGreaterThan(50);
    expect(VECTORS.filter((v) => v.error === "chain").length).toBeGreaterThan(3);
    expect(VECTORS.filter((v) => v.error === "opening").length).toBeGreaterThan(0);
  });

  it.each(VECTORS.map((v) => [v.name, v] as const))("%s", (_name, v) => {
    const parsed = parseInputs(v.inputs);
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    if (v.error) {
      let thrown: unknown;
      try {
        twabByOwner(parsed.events, parsed.window);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(TwabError);
      expect((thrown as TwabError).kind).toBe(v.error);
      return;
    }
    const got = Object.fromEntries([...twabByOwner(parsed.events, parsed.window)].map(([k, n]) => [k, n.toString()]));
    expect(got).toEqual(v.twab);
  });
});

describe("the definition", () => {
  it("a balance held for the whole window is its own TWAB, and one bought halfway counts half", () => {
    expect(twab([ev("s1", "alice", "a1", 500, 100n, 100n)])).toEqual({ alice: "100" });
    expect(twab([ev("s1", "alice", "a1", 1500, 100n, 100n)])).toEqual({ alice: "50" });
  });

  it("the history may start mid-way: the first event shows what the account held before it", () => {
    // 100 before 1200 (200 s), 110 after (800 s): (100 * 200 + 110 * 800) / 1000 = 108
    expect(twab([ev("s1", "alice", "a1", 1200, 10n, 110n)])).toEqual({ alice: "108" });
  });

  it("an event before the window only sets the balance the window opens with, one at its end changes nothing", () => {
    const events = [ev("s1", "alice", "a1", 100, 50n, 50n), ev("s2", "alice", "a1", 900, 50n, 100n), ev("s3", "alice", "a1", 2000, -100n, 0n)];
    expect(twab(events)).toEqual({ alice: "100" });
  });

  it("rounds down, never up", () => {
    // 10 held for 4 of 7 seconds: 40 / 7 = 5.71...
    expect(twab([ev("s1", "alice", "a1", 1_003, 10n, 10n)], { start: 1_000, end: 1_007 })).toEqual({ alice: "5" });
  });

  it("keeps an exact answer for amounts above 2^53", () => {
    const big = 18_000_000_000_000_000_000n;
    expect(twab([ev("s1", "alice", "a1", 1500, big, big)])).toEqual({ alice: (big / 2n).toString() });
  });

  it("adds an owner's token accounts and keeps owners apart, including an owner with nothing in the window", () => {
    const events = [ev("s1", "alice", "a1", 100, 60n, 60n), ev("s2", "alice", "a2", 1500, 40n, 40n), ev("s3", "bob", "b1", 100, 5n, 5n), ev("s4", "bob", "b1", 900, -5n, 0n)];
    expect(twab(events)).toEqual({ alice: "80", bob: "0" });
  });

  it("takes the events in any order: the published order is put in place first", () => {
    const events = [ev("s1", "alice", "a1", 100, 60n, 60n), ev("s2", "alice", "a1", 1500, -60n, 0n), ev("s3", "alice", "a1", 1800, 10n, 10n)];
    const reversed = [...events].reverse();
    expect(twab(reversed)).toEqual(twab(events));
    // 60 for 500 s, nothing for 300 s, 10 for 200 s: 32000 / 1000
    expect(twab(events)).toEqual({ alice: "32" });
  });

  it("refuses a window that does not end after it starts", () => {
    expect(() => twabByOwner([], { start: 5, end: 5 })).toThrow(RangeError);
    expect(() => twabByOwner([], { start: 6, end: 5 })).toThrow(RangeError);
    expect(twabByOwner([], { start: 5, end: 6 }).size).toBe(0);
  });
});

describe("transactions in one slot", () => {
  const swaps = (n: number) => Array.from({ length: n }, (_, i) => ev(`s${String(n - i).padStart(3, "0")}`, "pool", "v1", 1500, 1n, BigInt(i + 1), 500n));

  it("are put in the order they ran in, whatever their signatures say", () => {
    // The account stood at 100; the slot had 100 -> 150 -> 120 -> 130 and the signatures sort them 120 -> 130, 100 -> 150, 150 -> 120.
    const events = [ev("s0", "pool", "v1", 100, 100n, 100n), ev("sc", "pool", "v1", 1500, -30n, 120n, 500n), ev("sa", "pool", "v1", 1500, 10n, 130n, 500n), ev("sb", "pool", "v1", 1500, 50n, 150n, 500n)];
    expect(twab(events)).toEqual({ pool: "115" });
  });

  it("are not put in order past the limit, and then the published order must already chain", () => {
    expect(MAX_SAME_SLOT).toBe(24);
    expect(twab(swaps(24))).toEqual({ pool: "12" });
    expect(() => twabByOwner(swaps(25), W)).toThrow(TwabError);
    // In the published order a slot of any size is fine.
    const inOrder = Array.from({ length: 30 }, (_, i) => ev(`s${String(i).padStart(3, "0")}`, "pool", "v1", 1500, 1n, BigInt(i + 1), 500n));
    expect(twab(inOrder)).toEqual({ pool: "15" });
  });

  it("start, when nothing is known of the account, where no other event of the slot ends", () => {
    // 0 -> 50 and then 50 -> 20 in one slot; the signatures put the second ("sa") first, so the published order does not chain.
    // The account held 0 before the slot, not 50.
    expect(twab([ev("sa", "alice", "a1", 1500, -30n, 20n, 7n), ev("sb", "alice", "a1", 1500, 50n, 50n, 7n)])).toEqual({ alice: "10" });
  });

  it("start with the first in the published order when they all return to where they began", () => {
    // 5 -> 0 -> 5 -> 0 -> 5: the first event by signature starts it, so the account held 5 before the slot.
    const events = [ev("sa", "alice", "a1", 1500, -5n, 0n, 7n), ev("sb", "alice", "a1", 1500, 5n, 5n, 7n), ev("sc", "alice", "a1", 1500, -5n, 0n, 7n), ev("sd", "alice", "a1", 1500, 5n, 5n, 7n)];
    expect(twab(events)).toEqual({ alice: "5" });
  });

  it("with no order that adds up are read in the published order, which can then refuse one owner's events", () => {
    // The account stood at 10 (carol). Alice goes 10 -> 20 and 20 -> 30 in the slot and bob 20 -> 7. No order uses all three; a
    // walk that reaches them all (10 -> 20, 20 -> 7, then alice's 20 -> 30) is not a chain, and if it were taken alice's own events
    // would look fine. In the published order alice's second event does not follow her first.
    const events = [ev("s0", "carol", "x1", 100, 10n, 10n), ev("sa", "alice", "x1", 1500, 10n, 30n, 500n), ev("sb", "bob", "x1", 1500, -13n, 7n, 500n), ev("sc", "alice", "x1", 1500, 10n, 20n, 500n)];
    expect(() => twabByOwner(events, W)).toThrow(TwabError);
  });

  it("are found quickly however many alike steps there are: a path and a long loop in one slot", () => {
    // 0 -> 100 once, then 100 -> 200 and 200 -> 100 eleven times each, with the signatures putting a step of the loop first.
    const up = Array.from({ length: 11 }, (_, k) => ev(`a${String(k).padStart(2, "0")}`, "pool", "v1", 1500, 100n, 200n, 500n));
    const down = Array.from({ length: 11 }, (_, k) => ev(`b${String(k).padStart(2, "0")}`, "pool", "v1", 1500, -100n, 100n, 500n));
    const started = Date.now();
    expect(twab([...up, ...down, ev("z", "pool", "v1", 1500, 100n, 100n, 500n)])).toEqual({ pool: "50" });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("start where the account stood when that is known: the published order alone would begin at the wrong event", () => {
    // The account stood at 5. The slot's events go 5 -> 10 -> 5 and the signatures put the one that starts at 10 first. Begun
    // there (as it would be if the standing balance were ignored) the history would not add up and would be refused.
    const events = [ev("s0", "alice", "a1", 100, 5n, 5n), ev("sa", "alice", "a1", 1500, -5n, 5n, 7n), ev("sb", "alice", "a1", 1500, 5n, 10n, 7n)];
    expect(twab(events)).toEqual({ alice: "5" });
  });

  it("must share one block time: a record that says otherwise was not made from one chain", () => {
    const events = [ev("sa", "alice", "a1", 1500, 5n, 5n, 7n), ev("sb", "alice", "a1", 1501, 5n, 10n, 7n)];
    expect(() => twabByOwner(events, W)).toThrow(TwabError);
  });

  it("of different token accounts are never mixed up", () => {
    const events = [ev("sa", "alice", "a1", 1500, 10n, 10n, 7n), ev("sb", "alice", "a2", 1500, 20n, 20n, 7n)];
    expect(twab(events)).toEqual({ alice: "15" });
  });
});

describe("a history that does not add up is refused, and the refusal says why", () => {
  it("an account that would have held less than nothing", () => {
    try {
      twabByOwner([ev("s1", "alice", "a1", 500, 100n, 50n)], W);
      throw new Error("not refused");
    } catch (err) {
      expect(err).toBeInstanceOf(TwabError);
      expect((err as TwabError).kind).toBe("opening");
      expect((err as TwabError).message).toContain("a1");
      expect((err as TwabError).message).toContain("s1");
    }
  });

  it("a change that does not lead to the balance, naming the account and the transaction", () => {
    try {
      twabByOwner([ev("s1", "alice", "a1", 500, 100n, 100n), ev("s2", "alice", "a1", 1500, -30n, 80n)], W);
      throw new Error("not refused");
    } catch (err) {
      expect(err).toBeInstanceOf(TwabError);
      expect((err as TwabError).kind).toBe("chain");
      expect((err as TwabError).message).toContain("a1");
      expect((err as TwabError).message).toContain("s2");
    }
  });

  it("a transaction missing between two events, even when they are in different slots", () => {
    expect(() => twabByOwner([ev("s1", "alice", "a1", 500, 100n, 100n), ev("s2", "alice", "a1", 1500, 10n, 150n)], W)).toThrow(TwabError);
  });
});
