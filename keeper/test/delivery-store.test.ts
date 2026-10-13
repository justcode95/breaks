import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SqlDeliveryStore } from "../src/delivery/sql-store.js";
import { type DeliveryKey, type DeliveryStore, MemoryDeliveryStore, PlanChangedError } from "../src/delivery/store.js";
import { insertBreak, migratedDb } from "./support/db.js";

// The same rules must hold for the in-memory store (tests, devnet) and the SQL one (production), so every
// test below runs against both. Signatures and cards are unique across the whole table and the tests share
// one database, so their names carry the break id.
let db: PGlite;
let breakId: string;
let otherBreakId: string;

beforeAll(async () => {
  db = await migratedDb();
});

async function insertSpots(id: string) {
  for (const idx of [0, 1, 2]) {
    await db.query("insert into spots (break_id, kind, idx, wallet, paid) values ($1, 'paid', $2, $3, 20000000)", [id, idx, `buyer-${idx}`]);
  }
  for (const idx of [0, 1]) {
    await db.query("insert into spots (break_id, kind, idx, wallet) values ($1, 'free', $2, $3)", [id, idx, `holder-${idx}`]);
  }
}

beforeEach(async () => {
  breakId = await insertBreak(db);
  otherBreakId = await insertBreak(db);
  await insertSpots(breakId);
  await insertSpots(otherBreakId);
});

const stores: [string, () => DeliveryStore][] = [
  ["MemoryDeliveryStore", () => new MemoryDeliveryStore()],
  ["SqlDeliveryStore", () => new SqlDeliveryStore(db)],
];

describe.each(stores)("%s", (_name, make) => {
  const k = (idx = 0, kind: "paid" | "free" = "paid", id = breakId): DeliveryKey => ({ breakId: id, spot: { kind, idx } });
  const sig = (n: number) => `${breakId}-sig-${n}`;
  const card = (n: number, id = breakId) => `${id}-card-${n}`;
  const delivery = (idx = 0, kind: "paid" | "free" = "paid", id = breakId) => ({
    spot: { kind, idx },
    recipient: `${kind === "paid" ? "buyer" : "holder"}-${idx}`,
    cardMint: card(idx + (kind === "free" ? 10 : 0), id),
  });
  const attempt = (n: number) => ({ signature: sig(n), expiry: String(1000 + n) });

  it("ensure creates a pending delivery once", async () => {
    const store = make();
    const a = await store.ensure(breakId, delivery());
    expect(a).toMatchObject({ key: k(), status: "pending", attempt: 0, adopted: false, recipient: "buyer-0", cardMint: card(0) });
    expect(await store.ensure(breakId, delivery())).toEqual(a);
    expect(await store.get(k(1))).toBeUndefined();
  });

  it("stops when the plan for a spot changes", async () => {
    const store = make();
    await store.ensure(breakId, delivery());
    await expect(store.ensure(breakId, { ...delivery(), cardMint: card(99) })).rejects.toBeInstanceOf(PlanChangedError);
    await expect(store.ensure(breakId, { ...delivery(), recipient: "someone-else" })).rejects.toBeInstanceOf(PlanChangedError);
  });

  it("one card cannot be planned for two spots", async () => {
    const store = make();
    await store.ensure(breakId, delivery(0));
    await expect(store.ensure(breakId, { ...delivery(1), cardMint: card(0) })).rejects.toThrow();
  });

  it("startAttempt moves pending to submitted exactly once", async () => {
    const store = make();
    await store.ensure(breakId, delivery());
    expect(await store.startAttempt(k(), attempt(1))).toBe(true);
    expect(await store.startAttempt(k(), attempt(2))).toBe(false);
    expect(await store.get(k())).toMatchObject({ status: "submitted", attempt: 1, signature: sig(1), expiry: "1001" });
    expect(await store.attempts(k())).toEqual([{ attempt: 1, signature: sig(1), expiry: "1001", outcome: "submitted" }]);
  });

  it("startAttempt on a delivery that was never ensured does nothing", async () => {
    expect(await make().startAttempt(k(2), attempt(1))).toBe(false);
  });

  it("two attempts started at the same time: one wins", async () => {
    const store = make();
    await store.ensure(breakId, delivery());
    const results = await Promise.all([store.startAttempt(k(), attempt(1)), store.startAttempt(k(), attempt(2))]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await store.attempts(k())).toHaveLength(1);
  });

  it("confirms only the signature the delivery is waiting on", async () => {
    const store = make();
    await store.ensure(breakId, delivery());
    await store.startAttempt(k(), attempt(1));
    await store.setError(k(), "submit failed: timeout");
    expect(await store.resolveAttempt(k(), "someone-elses-sig", { to: "confirmed" })).toBe(false);
    expect(await store.resolveAttempt(k(), sig(1), { to: "confirmed" })).toBe(true);
    const row = await store.get(k());
    expect(row).toMatchObject({ status: "confirmed", signature: sig(1), adopted: false });
    expect(row?.lastError).toBeUndefined();
    expect((await store.attempts(k()))[0]?.outcome).toBe("confirmed");
    expect(await store.resolveAttempt(k(), sig(1), { to: "confirmed" })).toBe(false);
  });

  it("an expired attempt sends the delivery back to pending and keeps the old signature on record", async () => {
    const store = make();
    await store.ensure(breakId, delivery());
    await store.startAttempt(k(), attempt(1));
    expect(await store.resolveAttempt(k(), sig(1), { to: "pending", why: "expired", reason: "expired" })).toBe(true);
    const row = await store.get(k());
    expect(row).toMatchObject({ status: "pending", attempt: 1, lastError: "expired" });
    expect(row?.signature).toBeUndefined();

    expect(await store.startAttempt(k(), attempt(2))).toBe(true);
    expect(await store.get(k())).toMatchObject({ status: "submitted", attempt: 2, signature: sig(2) });
    expect((await store.attempts(k())).map((a) => [a.attempt, a.signature, a.outcome])).toEqual([
      [1, sig(1), "expired"],
      [2, sig(2), "submitted"],
    ]);
  });

  it("giving up marks the delivery failed and keeps its last signature", async () => {
    const store = make();
    await store.ensure(breakId, delivery());
    await store.startAttempt(k(), attempt(1));
    expect(await store.resolveAttempt(k(), sig(1), { to: "failed", why: "failed", reason: "reverted; gave up" })).toBe(true);
    expect(await store.get(k())).toMatchObject({ status: "failed", signature: sig(1), lastError: "reverted; gave up" });
    expect(await store.startAttempt(k(), attempt(2))).toBe(false);
  });

  it("a transfer adopted again after a wrong 'expired' verdict is not logged twice", async () => {
    const store = make();
    await store.ensure(breakId, delivery());
    await store.startAttempt(k(), attempt(1));
    await store.resolveAttempt(k(), sig(1), { to: "pending", why: "expired", reason: "expired" });
    expect(await store.startAttempt(k(), attempt(1))).toBe(true);
    expect(await store.resolveAttempt(k(), sig(1), { to: "confirmed" })).toBe(true);
    const log = await store.attempts(k());
    expect(log).toHaveLength(1);
    expect(log[0]?.outcome).toBe("confirmed");
  });

  it("adopt confirms a pending delivery without a transaction of ours", async () => {
    const store = make();
    await store.ensure(breakId, delivery());
    expect(await store.adopt(k())).toBe(true);
    expect(await store.get(k())).toMatchObject({ status: "confirmed", adopted: true });
    expect((await store.get(k()))?.signature).toBeUndefined();
    expect(await store.adopt(k())).toBe(false);
    expect(await store.startAttempt(k(), attempt(1))).toBe(false);
  });

  it("fail stops a pending delivery for good", async () => {
    const store = make();
    await store.ensure(breakId, delivery());
    expect(await store.fail(k(), "card is in the wrong wallet")).toBe(true);
    expect(await store.get(k())).toMatchObject({ status: "failed", lastError: "card is in the wrong wallet" });
    expect(await store.startAttempt(k(), attempt(1))).toBe(false);
    expect(await store.fail(k(), "again")).toBe(false);
  });

  it("lists the deliveries of one break, paid spots first", async () => {
    const store = make();
    await store.ensure(breakId, delivery(1, "free"));
    await store.ensure(breakId, delivery(2));
    await store.ensure(breakId, delivery(0));
    await store.ensure(otherBreakId, delivery(0, "paid", otherBreakId));
    expect((await store.listForBreak(breakId)).map((r) => `${r.key.spot.kind}${r.key.spot.idx}`)).toEqual(["paid0", "paid2", "free1"]);
    expect(await store.listForBreak(otherBreakId)).toHaveLength(1);
  });

  it("sets and clears the note on a delivery", async () => {
    const store = make();
    await store.ensure(breakId, delivery());
    await store.setError(k(), "card not found");
    expect((await store.get(k()))?.lastError).toBe("card not found");
    await store.setError(k(), null);
    expect((await store.get(k()))?.lastError).toBeUndefined();
  });
});

describe("SqlDeliveryStore against the schema", () => {
  it("refuses a delivery for a spot that is not recorded", async () => {
    await expect(
      new SqlDeliveryStore(db).ensure(breakId, { spot: { kind: "paid", idx: 9 }, recipient: "w", cardMint: `${breakId}-card-x` }),
    ).rejects.toThrow(/not recorded/);
  });

  it("the table refuses a submitted delivery without a signature or expiry, and a confirmed one without proof", async () => {
    const { rows } = await db.query<{ id: string }>("select id::text as id from spots where break_id = $1 and kind = 'paid' and idx = 0", [breakId]);
    const spotId = rows[0]!.id;
    await expect(db.query("insert into deliveries (break_id, spot_id, card_mint, status, tx_sig) values ($1, $2, 'c1', 'submitted', 's')", [breakId, spotId])).rejects.toThrow();
    await expect(db.query("insert into deliveries (break_id, spot_id, card_mint, status) values ($1, $2, 'c2', 'confirmed')", [breakId, spotId])).rejects.toThrow();
    await db.query("insert into deliveries (break_id, spot_id, card_mint, status, adopted) values ($1, $2, $3, 'confirmed', true)", [breakId, spotId, `${breakId}-c3`]);
  });
});
