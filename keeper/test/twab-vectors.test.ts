// The TWAB vectors the website's own implementation is checked against (web/test/twab.test.ts reads them).
//
// Each case is the text the keeper publishes (`serializeInputs`) and what the keeper's `twabByOwner` makes of it: the TWAB of
// every owner, or the kind of refusal. Producer and consumer of the format are tied to the same bytes this way: change the
// keeper's TWAB and this test fails until the file is regenerated, and then the website's test shows what to change.
// `UPDATE_TWAB_VECTORS=1 pnpm --filter keeper test` rewrites the file.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { serializeInputs } from "../src/eligibility/eligibility.js";
import { type BalanceEvent, type Window, twabByOwner } from "../src/eligibility/twab.js";

const FILE = join(import.meta.dirname, "..", "..", "docs", "twab-vectors.json");
const W: Window = { start: 1_000, end: 2_000 }; // 1000 seconds

interface Case {
  name: string;
  window: Window;
  events: BalanceEvent[];
}

/** One event. The signature is given, since the order of signatures is what decides the published order inside a slot. */
const ev = (signature: string, owner: string, tokenAccount: string, time: number, delta: bigint, balanceAfter: bigint, slot = BigInt(time)): BalanceEvent => ({
  signature,
  slot,
  time,
  owner,
  tokenAccount,
  delta,
  balanceAfter,
});

const handwritten = (): Case[] => [
  { name: "a balance held for the whole window", window: W, events: [ev("s1", "alice", "a1", 500, 100n, 100n)] },
  { name: "a balance bought halfway", window: W, events: [ev("s1", "alice", "a1", 1500, 100n, 100n)] },
  { name: "a balance sold halfway", window: W, events: [ev("s1", "alice", "a1", 500, 100n, 100n), ev("s2", "alice", "a1", 1500, -100n, 0n)] },
  { name: "the history starts mid-way, so the first event shows the opening balance", window: W, events: [ev("s1", "alice", "a1", 1200, 10n, 110n)] },
  {
    name: "events at the edges: one at the start counts as before it, one at the exclusive end changes nothing",
    window: W,
    events: [ev("s1", "alice", "a1", 1000, 50n, 150n), ev("s2", "alice", "a1", 2000, -150n, 0n), ev("s3", "bob", "b1", 1000, 7n, 7n)],
  },
  {
    name: "events before the window only set the opening balance, events after it change nothing",
    window: W,
    events: [ev("s1", "alice", "a1", 100, 50n, 50n), ev("s2", "alice", "a1", 900, 50n, 100n), ev("s3", "alice", "a1", 2500, -100n, 0n)],
  },
  {
    name: "all the token accounts of one owner add up, other owners stay apart",
    window: W,
    events: [ev("s1", "alice", "a1", 100, 60n, 60n), ev("s2", "alice", "a2", 1500, 40n, 40n), ev("s3", "bob", "b1", 1500, 90n, 90n)],
  },
  {
    name: "a change of owner is two rows, one for each wallet",
    window: W,
    events: [ev("s1", "alice", "x1", 100, 100n, 100n), ev("s2", "alice", "x1", 1500, -100n, 0n), ev("s3", "bob", "x1", 1500, 100n, 100n)],
  },
  {
    name: "the area is rounded down to a whole base unit",
    window: { start: 1_000, end: 1_007 },
    events: [ev("s1", "alice", "a1", 1_003, 10n, 10n), ev("s2", "bob", "b1", 1_001, 1n, 1n)],
  },
  { name: "an owner who sold everything before the window has a TWAB of zero", window: W, events: [ev("s1", "alice", "a1", 100, 100n, 100n), ev("s2", "alice", "a1", 900, -100n, 0n)] },
  {
    name: "buying and selling in the same second counts for nothing",
    window: W,
    events: [ev("s1", "alice", "a1", 1500, 1_000_000n, 1_000_000n, 10n), ev("s2", "alice", "a1", 1500, -1_000_000n, 0n, 11n)],
  },
  {
    name: "amounts above 2^53 stay exact",
    window: W,
    events: [ev("s1", "alice", "a1", 1500, 18_000_000_000_000_000_000n, 18_000_000_000_000_000_000n)],
  },
  {
    // The account stood at 100. In one slot it had three transactions, 100 -> 150 -> 120 -> 130, which the published order
    // (by signature: a, b, c) puts as 120 -> 130, 100 -> 150, 150 -> 120.
    name: "three transactions in one slot whose signatures do not follow the order they ran in",
    window: W,
    events: [
      ev("s0", "pool", "v1", 100, 100n, 100n),
      ev("sc", "pool", "v1", 1500, -30n, 120n, 500n),
      ev("sa", "pool", "v1", 1500, 10n, 130n, 500n),
      ev("sb", "pool", "v1", 1500, 50n, 150n, 500n),
    ],
  },
  {
    name: "an account whose first events are in one slot: the history starts where no event of the slot ends",
    window: W,
    events: [ev("sb", "alice", "a1", 1500, -30n, 20n, 7n), ev("sa", "alice", "a1", 1500, 50n, 50n, 7n)],
  },
  {
    name: "a slot whose events return to where they began, with no earlier history: the first in the published order starts it",
    window: W,
    events: [ev("sa", "alice", "a1", 1500, -5n, 0n, 7n), ev("sb", "alice", "a1", 1500, 5n, 5n, 7n), ev("sc", "alice", "a1", 1500, -5n, 0n, 7n), ev("sd", "alice", "a1", 1500, 5n, 5n, 7n)],
  },
  {
    name: "events of one account in different slots of the same second keep the slot order",
    window: W,
    events: [ev("sz", "alice", "a1", 1500, 10n, 10n, 5n), ev("sa", "alice", "a1", 1500, 20n, 30n, 6n), ev("sm", "alice", "a1", 1500, -5n, 25n, 7n)],
  },
  {
    name: "24 transactions in one slot are put in the order they ran in",
    window: W,
    events: chainOfSwaps(24),
  },
  {
    // Past 24 the keeper leaves the published order alone, and that order does not chain, so it refuses.
    name: "25 transactions in one slot are not reordered, and the published order does not chain",
    window: W,
    events: chainOfSwaps(25),
  },
  {
    // 0 -> 100 once, then 100 -> 200 and 200 -> 100 eleven times each. The signatures put a step of the loop first, so an order
    // found by trying one order after another would take for ever.
    name: "23 transactions in one slot: a path and a long loop of alike steps",
    window: W,
    events: pathAndLoop(),
  },
  {
    // The account stood at 10 (carol). In one slot alice goes 10 -> 20 and 20 -> 30 and bob 20 -> 7: no order uses all three, so the
    // slot is read in the published order. In that order alice's second event does not follow her first, and the history is refused.
    name: "a slot of several owners with no order that adds up is read in the published order, and then refused",
    window: W,
    events: [ev("s0", "carol", "x1", 100, 10n, 10n), ev("sa", "alice", "x1", 1500, 10n, 30n, 500n), ev("sb", "bob", "x1", 1500, -13n, 7n, 500n), ev("sc", "alice", "x1", 1500, 10n, 20n, 500n)],
  },
  {
    name: "a delta that does not lead to the balance is refused",
    window: W,
    events: [ev("s1", "alice", "a1", 500, 100n, 100n), ev("s2", "alice", "a1", 1500, -30n, 80n)],
  },
  { name: "a negative opening balance is refused", window: W, events: [ev("s1", "alice", "a1", 500, 100n, 50n)] },
  {
    name: "a transaction missing between two events is refused",
    window: W,
    events: [ev("s1", "alice", "a1", 500, 100n, 100n), ev("s2", "alice", "a1", 1500, 10n, 150n)],
  },
  {
    name: "a slot with a transaction missing is refused",
    window: W,
    events: [ev("s0", "pool", "v1", 100, 100n, 100n), ev("sa", "pool", "v1", 1500, 50n, 150n, 9n), ev("sb", "pool", "v1", 1500, -10n, 90n, 9n)],
  },
];

/** `n` transactions on one account in one slot, 0 -> 1 -> 2 ..., with signatures in the opposite order to how they ran. */
function chainOfSwaps(n: number): BalanceEvent[] {
  return Array.from({ length: n }, (_, i) => ev(`s${String(n - i).padStart(3, "0")}`, "pool", "v1", 1500, 1n, BigInt(i + 1), 500n));
}

function pathAndLoop(): BalanceEvent[] {
  const up = Array.from({ length: 11 }, (_, k) => ev(`a${String(k).padStart(2, "0")}`, "pool", "v1", 1500, 100n, 200n, 500n));
  const down = Array.from({ length: 11 }, (_, k) => ev(`b${String(k).padStart(2, "0")}`, "pool", "v1", 1500, -100n, 100n, 500n));
  return [...up, ...down, ev("z", "pool", "v1", 1500, 100n, 100n, 500n)];
}

/** A small deterministic generator, so the random cases are the same every time. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SIGNATURE_CHARS = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * A made-up history that is consistent by construction: a few token accounts with opening balances, a few owners (one owner may
 * have several accounts), transactions slot by slot (several on one account in one slot are common) with random signatures, so
 * the published order is not the order they ran in, and a window that has events before it, inside it and after it.
 */
function randomCase(index: number, rnd: () => number): Case {
  const pick = (n: number) => Math.floor(rnd() * n);
  const owners = ["ownerA", "ownerB", "ownerC"].slice(0, 1 + pick(3));
  const accounts = Array.from({ length: 1 + pick(4) }, (_, i) => ({ id: `acct${i}`, owner: owners[pick(owners.length)] as string, balance: BigInt(pick(3) === 0 ? 0 : pick(500)) }));
  const events: BalanceEvent[] = [];
  const start = 10_000 + pick(1_000);
  const end = start + 100 + pick(900);
  let slot = 100n + BigInt(pick(50));
  const slots = 4 + pick(7);
  for (let s = 0; s < slots; s++) {
    slot += 1n + BigInt(pick(3));
    // Block times are whole seconds, so several slots share one.
    const time = start - 200 + Math.floor(Number(slot - 100n) * ((end - start + 400) / (slots * 2)));
    for (let k = 0, count = 1 + pick(3); k < count; k++) {
      const account = accounts[pick(accounts.length)] as (typeof accounts)[number];
      const delta = BigInt(pick(2) === 0 ? 1 + pick(200) : -pick(Number(account.balance) + 1));
      if (delta === 0n) continue;
      account.balance += delta;
      const signature = Array.from({ length: 12 }, () => SIGNATURE_CHARS[pick(SIGNATURE_CHARS.length)]).join("");
      events.push({ signature, slot, time, owner: account.owner, tokenAccount: account.id, delta, balanceAfter: account.balance });
    }
  }
  return { name: `random history ${index}`, window: { start, end }, events };
}

/** Breaks a consistent random history by changing one event's balance, so the history no longer adds up. */
function broken(base: Case, index: number): Case {
  const events = base.events.map((e) => ({ ...e }));
  const victim = events[index % events.length] as BalanceEvent;
  victim.balanceAfter += 1n;
  return { name: `${base.name}, with one balance changed`, window: base.window, events };
}

function build(): Case[] {
  const rnd = mulberry32(20_261_015);
  const random = Array.from({ length: 40 }, (_, i) => randomCase(i, rnd)).filter((c) => c.events.length > 0);
  return [...handwritten(), ...random, ...random.slice(0, 6).map((c, i) => broken(c, i * 3 + 1))];
}

interface Vector {
  name: string;
  inputs: string;
  twab?: Record<string, string>;
  error?: "opening" | "chain";
}

function vectorOf(c: Case): Vector {
  const inputs = serializeInputs(c.events, c.window);
  try {
    const twab = twabByOwner(c.events, c.window);
    return { name: c.name, inputs, twab: Object.fromEntries([...twab.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([owner, value]) => [owner, value.toString()])) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("negative opening balance")) return { name: c.name, inputs, error: "opening" };
    if (message.includes("does not lead to the balance")) return { name: c.name, inputs, error: "chain" };
    throw err;
  }
}

const render = (vectors: Vector[]): string => `{"version":1,"cases":[\n${vectors.map((v) => `  ${JSON.stringify(v)}`).join(",\n")}\n]}\n`;

describe("the TWAB vectors the website is checked against", () => {
  const vectors = build().map(vectorOf);

  it("are exactly what the keeper makes of these histories", async () => {
    if (process.env.UPDATE_TWAB_VECTORS) await writeFile(FILE, render(vectors), "utf8");
    expect(await readFile(FILE, "utf8")).toBe(render(vectors));
  });

  it("cover the cases that matter: every kind of refusal, the same-slot ordering and plenty of ordinary histories", () => {
    const names = vectors.map((v) => v.name);
    expect(names.length).toBeGreaterThan(60);
    expect(new Set(names).size).toBe(names.length);
    expect(vectors.filter((v) => v.error === "opening").length).toBeGreaterThan(0);
    expect(vectors.filter((v) => v.error === "chain").length).toBeGreaterThan(3);
    expect(vectors.filter((v) => v.twab !== undefined).length).toBeGreaterThan(50);
    // The same-slot cases the ordering exists for: all of them give a number except the ones that cannot be chained.
    const byName = (n: string) => vectors.find((v) => v.name.startsWith(n)) as Vector;
    expect(byName("three transactions in one slot").twab).toEqual({ pool: "115" }); // 100 for half the window, then 130
    expect(byName("24 transactions in one slot").twab).toBeDefined();
    expect(byName("25 transactions in one slot").error).toBe("chain");
    expect(byName("23 transactions in one slot").twab).toEqual({ pool: "50" }); // 0 for half the window, then 100
    // The random histories are consistent, so the keeper accepts them; the six broken copies are refused.
    expect(vectors.filter((v) => v.name.endsWith("with one balance changed")).every((v) => v.error !== undefined)).toBe(true);
    expect(vectors.filter((v) => v.name.startsWith("random history") && !v.name.endsWith("changed")).every((v) => v.twab !== undefined)).toBe(true);
  });
});
