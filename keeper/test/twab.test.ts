import { describe, expect, it } from "vitest";
import { sortEvents, twabByOwner, type BalanceEvent } from "../src/eligibility/twab.js";

const W = { start: 1000, end: 2000 }; // 1000 seconds

let n = 0;
/** An event on `account` of `owner`: `delta` at `time`, leaving `after`. */
function ev(owner: string, account: string, time: number, delta: bigint, after: bigint, slot = BigInt(time)): BalanceEvent {
  return { signature: `sig${n++}`, slot, time, owner, tokenAccount: account, delta, balanceAfter: after };
}

describe("twabByOwner", () => {
  it("a balance held for the whole window is its own TWAB", () => {
    const events = [ev("alice", "a1", 500, 100n, 100n)];
    expect(twabByOwner(events, W).get("alice")).toBe(100n);
  });

  it("a balance bought halfway counts half", () => {
    expect(twabByOwner([ev("alice", "a1", 1500, 100n, 100n)], W).get("alice")).toBe(50n);
  });

  it("a balance sold halfway counts half", () => {
    const events = [ev("alice", "a1", 500, 100n, 100n), ev("alice", "a1", 1500, -100n, 0n)];
    expect(twabByOwner(events, W).get("alice")).toBe(50n);
  });

  it("a huge balance held for one second is worth almost nothing", () => {
    const events = [ev("alice", "a1", 1500, 1_000_000n, 1_000_000n), ev("alice", "a1", 1501, -1_000_000n, 0n)];
    expect(twabByOwner(events, W).get("alice")).toBe(1_000n);
  });

  it("buying and selling in the same second counts for nothing", () => {
    const events = [ev("alice", "a1", 1500, 1_000_000n, 1_000_000n, 10n), ev("alice", "a1", 1500, -1_000_000n, 0n, 11n)];
    expect(twabByOwner(events, W).get("alice")).toBe(0n);
  });

  it("adds up all the token accounts of one owner", () => {
    const events = [
      ev("alice", "a1", 100, 60n, 60n), // held all window
      ev("alice", "a2", 1500, 40n, 40n), // half the window
    ];
    expect(twabByOwner(events, W).get("alice")).toBe(80n);
  });

  it("keeps owners apart", () => {
    const events = [ev("alice", "a1", 100, 10n, 10n), ev("bob", "b1", 1500, 90n, 90n)];
    const r = twabByOwner(events, W);
    expect([r.get("alice"), r.get("bob")]).toEqual([10n, 45n]);
  });

  it("infers the opening balance from the first event when the history starts mid-way", () => {
    // 100 before the first event at 1200, 110 after: (100 * 200 + 110 * 800) / 1000 = 108
    expect(twabByOwner([ev("alice", "a1", 1200, 10n, 110n)], W).get("alice")).toBe(108n);
  });

  it("events before the window only set the opening balance, events after it change nothing", () => {
    const events = [
      ev("alice", "a1", 100, 50n, 50n),
      ev("alice", "a1", 900, 50n, 100n),
      ev("alice", "a1", 2000, -100n, 0n), // at the (exclusive) end
      ev("alice", "a1", 5000, 7n, 7n),
    ];
    expect(twabByOwner(events, W).get("alice")).toBe(100n);
  });

  it("rounds down", () => {
    // 1 token for 999 of 1000 seconds
    expect(twabByOwner([ev("alice", "a1", 1001, 1n, 1n)], W).get("alice")).toBe(0n);
    expect(twabByOwner([ev("alice", "a1", 1001, 1000n, 1000n)], W).get("alice")).toBe(999n);
  });

  it("does not depend on the order the events are given in", () => {
    const events = [
      ev("alice", "a1", 100, 100n, 100n),
      ev("alice", "a1", 1300, -40n, 60n),
      ev("alice", "a1", 1700, 30n, 90n),
      ev("alice", "a2", 1400, 5n, 5n),
    ];
    const expected = twabByOwner(events, W).get("alice");
    expect(twabByOwner([...events].reverse(), W).get("alice")).toBe(expected);
    expect(twabByOwner([events[2], events[0], events[3], events[1]] as BalanceEvent[], W).get("alice")).toBe(expected);
  });

  it("orders events of the same second by slot", () => {
    const first = ev("alice", "a1", 1500, 100n, 100n, 1n);
    const second = ev("alice", "a1", 1500, -100n, 0n, 2n);
    expect(twabByOwner([second, first], W).get("alice")).toBe(0n);
  });

  it("handles amounts with many digits exactly", () => {
    const big = 10n ** 15n;
    expect(twabByOwner([ev("alice", "a1", 0, big, big)], { start: 0, end: 86_400 }).get("alice")).toBe(big);
  });

  it("includes an owner whose balance was always zero", () => {
    const events = [ev("alice", "a1", 100, 5n, 5n), ev("alice", "a1", 200, -5n, 0n)];
    expect(twabByOwner(events, W).get("alice")).toBe(0n);
  });

  it("refuses a broken history and an empty window", () => {
    expect(() => twabByOwner([ev("alice", "a1", 1500, 10n, 5n)], W)).toThrow(/negative opening balance/);
    const broken = [ev("alice", "a1", 1000, 10n, 10n), ev("alice", "a1", 1100, 5n, 99n)];
    expect(() => twabByOwner(broken, W)).toThrow(/delta does not lead/);
    expect(() => twabByOwner([], { start: 5, end: 5 })).toThrow();
  });
});

describe("several transactions on one token account in the same slot", () => {
  // Inside a slot the order of the transactions is not in the data (no signature order follows it), but the balances
  // chain: each event starts where the one before it ended. The order is recovered from that chain.
  const at = (sig: string, account: string, time: number, slot: bigint, delta: bigint, after: bigint): BalanceEvent => ({
    signature: sig, slot, time, owner: "pool", tokenAccount: account, delta, balanceAfter: after,
  });

  it("does not depend on the signature order", () => {
    // Real order: 100 -> 150 (sig "z") -> 120 (sig "a"). Sorted by signature they would read 120 <- 100 first.
    const first = at("z", "v1", 1500, 7n, 50n, 150n);
    const second = at("a", "v1", 1500, 7n, -30n, 120n);
    const opening = at("m", "v1", 500, 1n, 100n, 100n);
    const expected = twabByOwner([opening, first, second], W).get("pool");
    expect(expected).toBe((100n * 500n + 120n * 500n) / 1000n);
    expect(twabByOwner([second, opening, first], W).get("pool")).toBe(expected);
  });

  it("works when a balance comes back to where it was (a cycle)", () => {
    // 100 -> 80 -> 100 -> 80 -> 100 inside one slot; any order that chains gives the same result.
    const events = [
      at("e", "v1", 1200, 9n, -20n, 80n),
      at("d", "v1", 1200, 9n, 20n, 100n),
      at("c", "v1", 1200, 9n, -20n, 80n),
      at("b", "v1", 1200, 9n, 20n, 100n),
      at("o", "v1", 900, 1n, 100n, 100n),
    ];
    expect(twabByOwner(events, W).get("pool")).toBe(100n);
  });

  it("keeps the accounts of one slot apart", () => {
    const events = [
      at("a", "v1", 1200, 9n, 10n, 10n),
      at("b", "v2", 1200, 9n, 20n, 20n),
      at("c", "v1", 1200, 9n, 5n, 15n),
    ];
    expect(twabByOwner(events, W).get("pool")).toBe((15n * 800n + 20n * 800n) / 1000n);
  });

  it("still refuses a history with a transaction missing", () => {
    // 100 -> (missing: +40) -> 140 -> 150: the second event does not start where the first ended.
    const events = [at("a", "v1", 500, 1n, 100n, 100n), at("b", "v1", 1200, 9n, 10n, 150n), at("c", "v1", 1200, 9n, 5n, 165n)];
    expect(() => twabByOwner(events, W)).toThrow(/delta does not lead to the balance/);
  });

  it("sorts events that differ only in their owner in a fixed order", () => {
    const a: BalanceEvent = { signature: "s", slot: 5n, time: 100, owner: "alice", tokenAccount: "t", delta: -5n, balanceAfter: 0n };
    const b: BalanceEvent = { ...a, owner: "bob", delta: 5n, balanceAfter: 5n };
    expect(sortEvents([b, a]).map((e) => e.owner)).toEqual(["alice", "bob"]);
    expect(sortEvents([a, b]).map((e) => e.owner)).toEqual(["alice", "bob"]);
  });
});
