import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SqlPackStore } from "../src/packs/sql-store.js";
import { MemoryPackStore, type PackStore } from "../src/packs/store.js";
import { insertBreak, migratedDb } from "./support/db.js";

// The same rules must hold for the in-memory store (tests, devnet) and the SQL one (production), so every
// test below runs against both.
let db: PGlite;
let breakId: string;
let otherBreakId: string;

beforeAll(async () => {
  db = await migratedDb();
});

// Every test gets fresh breaks, so the tests share one database without seeing each other's packs.
beforeEach(async () => {
  breakId = await insertBreak(db);
  otherBreakId = await insertBreak(db);
});

const stores: [string, () => PackStore][] = [
  ["MemoryPackStore", () => new MemoryPackStore()],
  ["SqlPackStore", () => new SqlPackStore(db)],
];

describe.each(stores)("%s", (_name, make) => {
  const k = (index = 0, id = breakId) => ({ breakId: id, index });
  // Signatures and cards are unique across the whole table, and the tests share one database.
  const sig = (n: number) => `${breakId}-sig-${n}`;
  const card = (name: string) => `${breakId}-card-${name}`;
  const attempt = (n: number) => ({ signature: sig(n), expiry: String(1000 + n), price: 25_000_000n });

  it("ensure creates a planned pack once", async () => {
    const store = make();
    const a = await store.ensure(k());
    expect(a).toMatchObject({ key: k(), status: "planned", attempt: 0 });
    expect(await store.ensure(k())).toEqual(a);
    expect(await store.get(k(5))).toBeUndefined();
  });

  it("startAttempt moves planned to submitted exactly once", async () => {
    const store = make();
    await store.ensure(k());
    expect(await store.startAttempt(k(), attempt(1))).toBe(true);
    expect(await store.startAttempt(k(), attempt(2))).toBe(false);
    expect(await store.get(k())).toMatchObject({
      status: "submitted",
      attempt: 1,
      signature: sig(1),
      expiry: "1001",
      price: 25_000_000n,
    });
    expect(await store.attempts(k())).toEqual([{ attempt: 1, signature: sig(1), expiry: "1001", price: 25_000_000n, outcome: "submitted" }]);
  });

  it("startAttempt on a pack that was never ensured does nothing", async () => {
    expect(await make().startAttempt(k(9), attempt(1))).toBe(false);
  });

  it("two attempts started at the same time: one wins", async () => {
    const store = make();
    await store.ensure(k());
    const results = await Promise.all([store.startAttempt(k(), attempt(1)), store.startAttempt(k(), attempt(2))]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await store.attempts(k())).toHaveLength(1);
  });

  it("confirms only the signature the pack is waiting on", async () => {
    const store = make();
    await store.ensure(k());
    await store.startAttempt(k(), attempt(1));
    await store.setError(k(), "submit failed: timeout");
    expect(await store.resolveAttempt(k(), "someone-elses-sig", { to: "confirmed" })).toBe(false);
    expect(await store.get(k())).toMatchObject({ status: "submitted" });
    expect(await store.resolveAttempt(k(), sig(1), { to: "confirmed" })).toBe(true);
    const row = await store.get(k());
    expect(row).toMatchObject({ status: "confirmed", signature: sig(1) });
    expect(row?.lastError).toBeUndefined();
    expect((await store.attempts(k()))[0]?.outcome).toBe("confirmed");
    expect(await store.resolveAttempt(k(), sig(1), { to: "confirmed" })).toBe(false);
  });

  it("an expired attempt sends the pack back to planned and keeps the old signature on record", async () => {
    const store = make();
    await store.ensure(k());
    await store.startAttempt(k(), attempt(1));
    expect(await store.resolveAttempt(k(), sig(1), { to: "planned", why: "expired", reason: "expired" })).toBe(true);
    const row = await store.get(k());
    expect(row).toMatchObject({ status: "planned", attempt: 1, lastError: "expired" });
    expect(row?.signature).toBeUndefined();
    expect(row?.price).toBeUndefined();

    expect(await store.startAttempt(k(), attempt(2))).toBe(true);
    expect(await store.get(k())).toMatchObject({ status: "submitted", attempt: 2, signature: sig(2) });
    expect((await store.attempts(k())).map((a) => [a.attempt, a.signature, a.outcome])).toEqual([
      [1, sig(1), "expired"],
      [2, sig(2), "submitted"],
    ]);
  });

  it("giving up marks the pack failed and keeps its last signature", async () => {
    const store = make();
    await store.ensure(k());
    await store.startAttempt(k(), attempt(1));
    expect(await store.resolveAttempt(k(), sig(1), { to: "failed", why: "failed", reason: "reverted; gave up" })).toBe(true);
    expect(await store.get(k())).toMatchObject({ status: "failed", signature: sig(1), lastError: "reverted; gave up" });
    expect(await store.startAttempt(k(), attempt(2))).toBe(false);
    expect((await store.attempts(k()))[0]?.outcome).toBe("failed");
  });

  it("a purchase adopted again after a wrong 'expired' verdict is not logged twice", async () => {
    const store = make();
    await store.ensure(k());
    await store.startAttempt(k(), attempt(1));
    await store.resolveAttempt(k(), sig(1), { to: "planned", why: "expired", reason: "expired" });
    expect(await store.startAttempt(k(), { signature: sig(1), expiry: "1001" })).toBe(true);
    expect(await store.resolveAttempt(k(), sig(1), { to: "confirmed" })).toBe(true);
    const log = await store.attempts(k());
    expect(log).toHaveLength(1);
    expect(log[0]?.outcome).toBe("confirmed");
    expect(await store.get(k())).toMatchObject({ status: "confirmed", attempt: 2, signature: sig(1) });
  });

  it("complete pulls a confirmed pack and nothing else", async () => {
    const store = make();
    await store.ensure(k());
    expect(await store.complete(k(), { cardMint: card("a") })).toBe(false);
    await store.startAttempt(k(), attempt(1));
    expect(await store.complete(k(), { cardMint: card("a") })).toBe(false);
    await store.resolveAttempt(k(), sig(1), { to: "confirmed" });
    expect(await store.complete(k(), { cardMint: card("a"), proofRef: "proof-a", price: 24_000_000n })).toBe(true);
    expect(await store.get(k())).toMatchObject({ status: "pulled", cardMint: card("a"), proofRef: "proof-a", price: 24_000_000n });
    expect(await store.complete(k(), { cardMint: card("b") })).toBe(false);
  });

  it("one card can only belong to one pack", async () => {
    const store = make();
    for (const i of [0, 1]) {
      await store.ensure(k(i));
      await store.startAttempt(k(i), attempt(i));
      await store.resolveAttempt(k(i), sig(i), { to: "confirmed" });
    }
    await store.complete(k(0), { cardMint: card("same") });
    await expect(store.complete(k(1), { cardMint: card("same") })).rejects.toThrow();
    expect((await store.get(k(1)))?.status).toBe("confirmed");
  });

  it("lists the packs of one break in order", async () => {
    const store = make();
    for (const i of [2, 0, 1]) await store.ensure(k(i));
    await store.ensure(k(0, otherBreakId));
    expect((await store.listForBreak(breakId)).map((r) => r.key.index)).toEqual([0, 1, 2]);
    expect(await store.listForBreak(otherBreakId)).toHaveLength(1);
  });

  it("sets and clears the note on a pack", async () => {
    const store = make();
    await store.ensure(k());
    await store.setError(k(), "price above the cap");
    expect((await store.get(k()))?.lastError).toBe("price above the cap");
    await store.setError(k(), null);
    expect((await store.get(k()))?.lastError).toBeUndefined();
  });
});

describe("SqlPackStore against the schema", () => {
  it("the table refuses a submitted pack without an expiry", async () => {
    await expect(
      db.query("insert into packs (break_id, pack_index, status, purchase_sig) values ($1, 0, 'submitted', 's')", [breakId]),
    ).rejects.toThrow();
  });

  it("pack_attempts only exist for a real pack and a signature is never recorded twice", async () => {
    await expect(
      db.query("insert into pack_attempts (break_id, pack_index, attempt, signature, expiry) values ($1, 0, 1, 's', '1')", [breakId]),
    ).rejects.toThrow();
    await db.query("insert into packs (break_id, pack_index) values ($1, 0)", [breakId]);
    await db.query("insert into pack_attempts (break_id, pack_index, attempt, signature, expiry) values ($1, 0, 1, 's', '1')", [breakId]);
    await expect(
      db.query("insert into pack_attempts (break_id, pack_index, attempt, signature, expiry) values ($1, 0, 2, 's', '1')", [breakId]),
    ).rejects.toThrow();
  });
});
