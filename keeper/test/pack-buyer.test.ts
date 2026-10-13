import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import type { Logger } from "../src/job.js";
import { type BreakPlan, type BreakSource, PackBuyer, packBuyerJob } from "../src/packs/buyer.js";
import { MockPackProvider } from "../src/packs/mock-provider.js";
import {
  type BuyOptions,
  type ExistingPurchase,
  type PackKey,
  type PackProvider,
  type PackReveal,
  type PreparedPurchase,
  type PurchaseStatus,
} from "../src/packs/provider.js";
import { SqlPackStore } from "../src/packs/sql-store.js";
import { MemoryPackStore, type PackStore } from "../src/packs/store.js";
import { insertBreak, migratedDb } from "./support/db.js";

const PRICE = 25_000_000n;

function plan(breakId: string, poolSize = 4, maxPackPrice = PRICE): BreakPlan {
  return { breakId, poolSize, machine: "pokemon-25", maxPackPrice, packBudget: maxPackPrice * BigInt(poolSize) };
}

function logger() {
  const errors: string[] = [];
  const log: Logger = { info() {}, error: (msg) => errors.push(msg) };
  return { log, errors };
}

function setup(opts: { price?: bigint; maxAttempts?: number; store?: PackStore; provider?: PackProvider } = {}) {
  const mock = new MockPackProvider(opts.price ?? PRICE);
  const store = opts.store ?? new MemoryPackStore();
  const { log, errors } = logger();
  const buyer = (provider: PackProvider = opts.provider ?? mock) =>
    new PackBuyer({ provider, store, log, maxAttempts: opts.maxAttempts ?? 5 });
  return { mock, store, errors, log, buyer };
}

const key = (breakId: string, index: number): PackKey => ({ breakId, index });

describe("PackBuyer: the normal path", () => {
  it("buys one pack per index and pulls every card", async () => {
    const { mock, buyer } = setup();
    const progress = await buyer().buyBreak(plan("1"));
    expect(progress).toMatchObject({ total: 4, pulled: 4, inFlight: 0, waiting: 0, failed: 0, complete: true, anomalies: [] });
    expect(new Set(progress.cards).size).toBe(4);
    for (let i = 0; i < 4; i++) expect(mock.confirmedFor(key("1", i))).toHaveLength(1);
    expect(mock.moneySpent()).toBe(4n * PRICE);
    expect(progress.packs.every((p) => p.status === "pulled" && p.proofRef)).toBe(true);
  });

  it("running it again buys nothing", async () => {
    const { mock, buyer } = setup();
    await buyer().buyBreak(plan("1"));
    const prepared = mock.prepareCalls;
    const again = await buyer().buyBreak(plan("1"));
    expect(again.complete).toBe(true);
    expect(mock.prepareCalls).toBe(prepared);
    expect(mock.moneySpent()).toBe(4n * PRICE);
  });

  it("holds a card back until it can be read, without buying again", async () => {
    const { mock, buyer } = setup();
    mock.revealDelay = 2;
    const b = buyer();
    const first = await b.buyBreak(plan("1", 2));
    expect(first).toMatchObject({ pulled: 0, inFlight: 2, complete: false, cards: [] });
    await b.buyBreak(plan("1", 2));
    const third = await b.buyBreak(plan("1", 2));
    expect(third).toMatchObject({ pulled: 2, complete: true });
    expect(mock.moneySpent()).toBe(2n * PRICE);
  });

  it("an empty pool is not complete and buys nothing", async () => {
    const { mock, buyer } = setup();
    const progress = await buyer().buyBreak(plan("1", 0));
    expect(progress).toMatchObject({ total: 0, complete: false });
    expect(mock.prepareCalls).toBe(0);
  });

  it("refuses a plan whose budget is not pool size × max price", async () => {
    const { mock, buyer } = setup();
    await expect(buyer().buyBreak({ ...plan("1"), packBudget: 1n })).rejects.toThrow(RangeError);
    await expect(buyer().buyBreak(plan("1", -1))).rejects.toThrow(RangeError);
    await expect(buyer().buyBreak(plan("1", 70_000))).rejects.toThrow(RangeError);
    expect(mock.prepareCalls).toBe(0);
  });
});

describe("PackBuyer: the price cap", () => {
  it("buys nothing while the live price is above the cap, and carries on when it drops", async () => {
    const { mock, buyer } = setup({ price: PRICE + 1n });
    const b = buyer();
    const blocked = await b.buyBreak(plan("1"));
    expect(blocked).toMatchObject({ pulled: 0, waiting: 4, complete: false });
    expect(blocked.packs[0]?.lastError).toMatch(/above the cap/);
    expect(mock.moneySpent()).toBe(0n);

    mock.setLivePrice(PRICE);
    const done = await b.buyBreak(plan("1"));
    expect(done.complete).toBe(true);
    expect(mock.moneySpent()).toBe(4n * PRICE);
  });

  it("does not trust a provider that builds a purchase above the cap", async () => {
    const mock = new MockPackProvider(PRICE);
    const greedy: PackProvider = {
      findExisting: (k) => mock.findExisting(k),
      prepare: async (k, o) => ({ ...(await mock.prepare(k, o)), price: PRICE + 1n }),
      submit: (p) => mock.submit(p),
      status: (s, e) => mock.status(s, e),
      reveal: (s) => mock.reveal(s),
    };
    const { buyer, store, errors } = setup({ provider: greedy });
    const progress = await buyer().buyBreak(plan("1", 2));
    expect(progress).toMatchObject({ pulled: 0, waiting: 2 });
    expect(mock.moneySpent()).toBe(0n);
    expect(await store.attempts(key("1", 0))).toEqual([]);
    expect(errors).toHaveLength(2);
  });
});

describe("PackBuyer: never buying twice", () => {
  it("a purchase that was never sent is waited on, then rebought exactly once", async () => {
    // 'drop' stands for a crash between saving the attempt and sending it.
    const { mock, buyer, store } = setup();
    mock.queueSubmit("drop");
    const p = plan("1", 3);

    const first = await buyer().buyBreak(p);
    expect(first).toMatchObject({ pulled: 2, inFlight: 1 });
    const stuck = first.packs[0]!;
    expect(stuck).toMatchObject({ status: "submitted", attempt: 1 });
    const prepared = mock.prepareCalls;

    // A fresh process (new buyer, same notes) must not buy while the first purchase could still land.
    expect((await buyer().buyBreak(p)).inFlight).toBe(1);
    expect(mock.prepareCalls).toBe(prepared);

    mock.advanceBlocks(151);
    const done = await buyer().buyBreak(p);
    expect(done).toMatchObject({ pulled: 3, complete: true });
    expect(mock.confirmedFor(key("1", 0))).toHaveLength(1);
    expect(mock.moneySpent()).toBe(3n * PRICE);
    expect((await store.attempts(key("1", 0))).map((a) => a.outcome)).toEqual(["expired", "confirmed"]);
  });

  it("a send that threw but never landed is also waited on, and the error is shown", async () => {
    const { mock, buyer } = setup();
    mock.queueSubmit("throw");
    const b = buyer();
    const first = await b.buyBreak(plan("1", 1));
    expect(first.packs[0]).toMatchObject({ status: "submitted", lastError: "submit failed: mock: network error" });
    expect(first.pulled).toBe(0);
    mock.advanceBlocks(151);
    expect((await b.buyBreak(plan("1", 1))).complete).toBe(true);
    expect(mock.confirmedFor(key("1", 0))).toHaveLength(1);
  });

  it("a send that threw AFTER landing is not bought again", async () => {
    const { mock, buyer } = setup();
    mock.queueSubmit("land-then-throw");
    const progress = await buyer().buyBreak(plan("1", 2));
    expect(progress.complete).toBe(true);
    expect(mock.confirmedFor(key("1", 0))).toHaveLength(1);
    expect(mock.prepareCalls).toBe(2);
    expect(mock.moneySpent()).toBe(2n * PRICE);
    expect(progress.packs[0]?.lastError).toBeUndefined();
  });

  it("a reverted purchase is retried, and the attempt log shows both", async () => {
    const { mock, buyer, store } = setup();
    mock.queueSubmit("revert");
    const progress = await buyer().buyBreak(plan("1", 1));
    expect(progress.complete).toBe(true);
    expect(mock.moneySpent()).toBe(PRICE);
    const log = await store.attempts(key("1", 0));
    expect(log.map((a) => a.outcome)).toEqual(["failed", "confirmed"]);
    expect(progress.packs[0]).toMatchObject({ attempt: 2 });
  });

  it("gives a pack up after too many attempts and does not try again", async () => {
    const { mock, buyer } = setup({ maxAttempts: 3 });
    mock.queueSubmit("revert", "revert", "revert");
    const b = buyer();
    const progress = await b.buyBreak(plan("1", 2));
    expect(progress).toMatchObject({ pulled: 1, failed: 1, complete: false });
    expect(progress.packs[0]).toMatchObject({ status: "failed", attempt: 3 });
    expect(progress.packs[0]?.lastError).toMatch(/gave up after 3 attempts/);
    const prepared = mock.prepareCalls;
    await b.buyBreak(plan("1", 2));
    expect(mock.prepareCalls).toBe(prepared);
  });

  it("finds a purchase the notes lost and adopts it instead of buying again", async () => {
    const { mock, buyer } = setup();
    const signature = mock.landUnrecorded(key("1", 0));
    const progress = await buyer().buyBreak(plan("1", 2));
    expect(progress.complete).toBe(true);
    expect(mock.confirmedFor(key("1", 0))).toEqual([signature]);
    expect(mock.moneySpent()).toBe(2n * PRICE);
    expect(progress.packs[0]?.signature).toBe(signature);
  });

  it("reports a pack that was bought twice instead of hiding it", async () => {
    const { mock, buyer } = setup();
    const first = mock.landUnrecorded(key("1", 0));
    mock.landUnrecorded(key("1", 0));
    const progress = await buyer().buyBreak(plan("1", 1));
    expect(progress.anomalies).toHaveLength(1);
    expect(progress.anomalies[0]).toMatch(/DOUBLE PURCHASE for 1:0/);
    expect(progress.packs[0]?.signature).toBe(first);
    expect(progress.packs[0]?.lastError).toMatch(/DOUBLE PURCHASE/);
  });

  it("notices a double purchase that shows up in the history after the pack was bought", async () => {
    // The notes say purchase A is the one in flight; the wallet history also holds an older purchase B.
    const mock = new MockPackProvider(PRICE);
    mock.landUnrecorded(key("1", 0));
    const store = new MemoryPackStore();
    await store.ensure(key("1", 0));
    const prepared = await mock.prepare(key("1", 0), { machine: "pokemon-25", maxPrice: PRICE });
    await store.startAttempt(key("1", 0), { signature: prepared.signature, expiry: prepared.expiry, price: PRICE });
    await mock.submit(prepared);

    const progress = await new PackBuyer({ provider: mock, store, log: logger().log }).buyBreak(plan("1", 1));
    expect(progress.anomalies).toHaveLength(1);
    expect(progress.anomalies[0]).toMatch(/DOUBLE PURCHASE/);
  });

  it("two buyers working on the same break at once buy each pack once", async () => {
    const { mock, buyer } = setup();
    const p = plan("1", 6);
    const [a, b] = await Promise.all([buyer().buyBreak(p), buyer().buyBreak(p)]);
    for (let i = 0; i < 6; i++) expect(mock.confirmedFor(key("1", i))).toHaveLength(1);
    expect(mock.moneySpent()).toBe(6n * PRICE);
    // Whoever lost a race leaves the pack to the winner; a further run brings everything home.
    const done = await buyer().buyBreak(p);
    expect(done.complete).toBe(true);
    expect(a.anomalies).toEqual([]);
    expect(b.anomalies).toEqual([]);
  });
});

describe("PackBuyer: trouble with one pack does not stop the others", () => {
  it("an RPC error on one pack is noted and retried on the next run", async () => {
    const mock = new MockPackProvider(PRICE);
    let broken = true;
    const flaky: PackProvider = {
      findExisting: (k) => mock.findExisting(k),
      prepare: async (k, o: BuyOptions) => {
        if (broken && k.index === 1) throw new Error("rpc: 503");
        return mock.prepare(k, o);
      },
      submit: (p: PreparedPurchase) => mock.submit(p),
      status: (s: string, e: string): Promise<PurchaseStatus> => mock.status(s, e),
      reveal: (s: string): Promise<PackReveal | undefined> => mock.reveal(s),
    };
    const { buyer, errors } = setup({ provider: flaky });
    const b = buyer();
    const first = await b.buyBreak(plan("1", 3));
    expect(first).toMatchObject({ pulled: 2, waiting: 1 });
    expect(first.packs[1]?.lastError).toBe("rpc: 503");
    expect(errors).toEqual(["pack step failed"]);

    broken = false;
    expect((await b.buyBreak(plan("1", 3))).complete).toBe(true);
    expect(mock.moneySpent()).toBe(3n * PRICE);
  });

  it("a card that is already taken by another pack is flagged and the pack stays confirmed", async () => {
    const mock = new MockPackProvider(PRICE);
    const sameCard: PackProvider = {
      findExisting: (k: PackKey): Promise<ExistingPurchase[]> => mock.findExisting(k),
      prepare: (k, o) => mock.prepare(k, o),
      submit: (p) => mock.submit(p),
      status: (s, e) => mock.status(s, e),
      reveal: async () => ({ cardMint: "one-card", price: PRICE }),
    };
    const { buyer } = setup({ provider: sameCard });
    const progress = await buyer().buyBreak(plan("1", 2));
    expect(progress).toMatchObject({ pulled: 1, inFlight: 1 });
    expect(progress.packs[1]?.lastError).toMatch(/already assigned|unique|duplicate/i);
  });
});

describe("PackBuyer against the real schema", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await migratedDb();
  });

  it("buys a whole break and records the cards", async () => {
    const breakId = await insertBreak(db);
    const { mock, buyer } = setup({ store: new SqlPackStore(db) });
    const progress = await buyer().buyBreak(plan(breakId, 3));
    expect(progress.complete).toBe(true);
    const { rows } = await db.query<{ status: string; card_mint: string; purchase_sig: string }>(
      "select status, card_mint, purchase_sig from packs where break_id = $1 order by pack_index",
      [breakId],
    );
    expect(rows.map((r) => r.status)).toEqual(["pulled", "pulled", "pulled"]);
    expect(rows.every((r) => r.card_mint && r.purchase_sig)).toBe(true);
    expect(mock.moneySpent()).toBe(3n * PRICE);
  });

  it("survives a lost send and a restart without buying twice", async () => {
    const breakId = await insertBreak(db);
    const { mock, buyer } = setup({ store: new SqlPackStore(db) });
    mock.queueSubmit("drop");
    const p = plan(breakId, 2);
    expect((await buyer().buyBreak(p)).inFlight).toBe(1);
    // "Restart": a new buyer and a new store object over the same database.
    mock.advanceBlocks(151);
    const restarted = new PackBuyer({ provider: mock, store: new SqlPackStore(db), log: logger().log });
    const done = await restarted.buyBreak(p);
    expect(done.complete).toBe(true);
    expect(mock.confirmedFor(key(breakId, 0))).toHaveLength(1);
    expect(mock.moneySpent()).toBe(2n * PRICE);
    const { rows } = await db.query<{ outcome: string }>(
      "select outcome from pack_attempts where break_id = $1 and pack_index = 0 order by attempt",
      [breakId],
    );
    expect(rows.map((r) => r.outcome)).toEqual(["expired", "confirmed"]);
  });
});

describe("packBuyerJob", () => {
  it("runs every break, reports progress, and one bad plan does not hold up the others", async () => {
    const { mock, buyer } = setup();
    const { log, errors } = logger();
    const reported: [string, boolean][] = [];
    const source: BreakSource = {
      breaksToBuy: async () => [{ ...plan("1", 2), packBudget: 1n }, plan("2", 2)],
      report: async (p, progress) => {
        reported.push([p.breakId, progress.complete]);
      },
    };
    const job = packBuyerJob({ buyer: buyer(), source, intervalMs: 1000 });
    expect(job.name).toBe("pack-buyer");
    await job.run({ now: () => new Date(), log });
    expect(reported).toEqual([["2", true]]);
    expect(errors).toEqual(["pack buyer: break failed"]);
    expect(mock.moneySpent()).toBe(2n * PRICE);
  });
});
