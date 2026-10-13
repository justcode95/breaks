import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { Deliverer, type DeliverySource, deliveryJob } from "../src/delivery/deliverer.js";
import { MockCardTransfer } from "../src/delivery/mock-transfer.js";
import { type DeliveryPlan, buildDeliveryPlan } from "../src/delivery/plan.js";
import { SqlDeliveryStore } from "../src/delivery/sql-store.js";
import { type DeliveryStore, MemoryDeliveryStore } from "../src/delivery/store.js";
import type { CardTransfer, DeliveryRequest, PreparedTransfer } from "../src/delivery/transfer.js";
import type { Logger } from "../src/job.js";
import { addr, drawnBreak } from "./support/chain.js";
import { insertBreak, migratedDb } from "./support/db.js";

function planFor(breakId = "1", opts: Parameters<typeof drawnBreak>[0] = {}): DeliveryPlan {
  const d = drawnBreak(opts);
  return buildDeliveryPlan({ breakId, buyer: d.buyer, chain: d.chain, paidSpots: d.paidSpots, cards: d.cards });
}

function logger() {
  const errors: string[] = [];
  const log: Logger = { info() {}, error: (msg) => errors.push(msg) };
  return { log, errors };
}

/** A mock chain where the buyer wallet holds every card of the plan. */
function setup(opts: { plan?: DeliveryPlan; maxAttempts?: number; store?: DeliveryStore; transfer?: CardTransfer } = {}) {
  const plan = opts.plan ?? planFor();
  const mock = new MockCardTransfer();
  for (const d of plan.deliveries) mock.give(d.cardMint, plan.buyer);
  const store = opts.store ?? new MemoryDeliveryStore();
  const { log, errors } = logger();
  const deliverer = (transfer: CardTransfer = opts.transfer ?? mock) =>
    new Deliverer({ transfer, store, log, maxAttempts: opts.maxAttempts ?? 5 });
  return { plan, mock, store, errors, log, deliverer };
}

async function ownersOf(mock: MockCardTransfer, plan: DeliveryPlan) {
  return Promise.all(plan.deliveries.map((d) => mock.ownerOf(d.cardMint)));
}

describe("Deliverer: the normal path", () => {
  it("sends every card to the wallet the draw assigned it to, once", async () => {
    const { plan, mock, deliverer } = setup();
    const progress = await deliverer().deliverBreak(plan);
    expect(progress).toMatchObject({ total: 5, delivered: 5, inFlight: 0, waiting: 0, failed: 0, complete: true, anomalies: [] });
    expect(await ownersOf(mock, plan)).toEqual(plan.deliveries.map((d) => d.recipient));
    for (const d of plan.deliveries) expect(mock.transfersOf(d.cardMint)).toBe(1);
    expect(progress.deliveries.every((r) => r.status === "confirmed" && r.signature && !r.adopted)).toBe(true);
  });

  it("running it again sends nothing", async () => {
    const { plan, mock, deliverer } = setup();
    await deliverer().deliverBreak(plan);
    const prepared = mock.prepareCalls;
    const again = await deliverer().deliverBreak(plan);
    expect(again.complete).toBe(true);
    expect(mock.prepareCalls).toBe(prepared);
  });

  it("an empty plan is not complete and does nothing", async () => {
    const { mock, deliverer } = setup({ plan: { breakId: "1", buyer: addr(250), deliveries: [] } });
    const progress = await deliverer().deliverBreak({ breakId: "1", buyer: addr(250), deliveries: [] });
    expect(progress).toMatchObject({ total: 0, complete: false });
    expect(mock.prepareCalls).toBe(0);
  });
});

describe("Deliverer: transfers that go wrong", () => {
  it("a transfer that never landed is waited on, then redone exactly once", async () => {
    const { plan, mock, store, deliverer } = setup();
    mock.queueSubmit("drop");
    const first = await deliverer().deliverBreak(plan);
    expect(first).toMatchObject({ delivered: 4, inFlight: 1 });
    const stuck = first.deliveries[0]!;
    expect(stuck).toMatchObject({ status: "submitted", attempt: 1 });
    const prepared = mock.prepareCalls;

    // A fresh process (new deliverer, same notes) must not resend while the first could still land.
    expect((await deliverer().deliverBreak(plan)).inFlight).toBe(1);
    expect(mock.prepareCalls).toBe(prepared);

    mock.advanceBlocks(151);
    const done = await deliverer().deliverBreak(plan);
    expect(done.complete).toBe(true);
    for (const d of plan.deliveries) expect(mock.transfersOf(d.cardMint)).toBe(1);
    expect((await store.attempts(stuck.key)).map((a) => a.outcome)).toEqual(["expired", "confirmed"]);
  });

  it("a send that threw before landing is waited on and the error shown", async () => {
    const { plan, mock, deliverer } = setup();
    mock.queueSubmit("throw");
    const first = await deliverer().deliverBreak(plan);
    expect(first.deliveries[0]).toMatchObject({ status: "submitted", lastError: "submit failed: mock: network error" });
    mock.advanceBlocks(151);
    expect((await deliverer().deliverBreak(plan)).complete).toBe(true);
  });

  it("a send that threw AFTER landing is not sent again", async () => {
    const { plan, mock, deliverer } = setup();
    mock.queueSubmit("land-then-throw");
    const progress = await deliverer().deliverBreak(plan);
    expect(progress.complete).toBe(true);
    expect(mock.prepareCalls).toBe(5);
    expect(progress.deliveries[0]?.lastError).toBeUndefined();
  });

  it("a reverted transfer is retried, and the attempt log shows both", async () => {
    const { plan, mock, store, deliverer } = setup();
    mock.queueSubmit("revert");
    const progress = await deliverer().deliverBreak(plan);
    expect(progress.complete).toBe(true);
    const first = progress.deliveries[0]!;
    expect(first.attempt).toBe(2);
    expect((await store.attempts(first.key)).map((a) => a.outcome)).toEqual(["failed", "confirmed"]);
  });

  it("gives a delivery up after too many attempts and does not try again", async () => {
    const { plan, mock, deliverer } = setup({ maxAttempts: 3 });
    mock.queueSubmit("revert", "revert", "revert");
    const b = deliverer();
    const progress = await b.deliverBreak(plan);
    expect(progress).toMatchObject({ delivered: 4, failed: 1, complete: false });
    expect(progress.deliveries[0]).toMatchObject({ status: "failed", attempt: 3 });
    expect(progress.deliveries[0]?.lastError).toMatch(/gave up after 3 attempts/);
    const prepared = mock.prepareCalls;
    await b.deliverBreak(plan);
    expect(mock.prepareCalls).toBe(prepared);
  });

  it("two deliverers working on the same break at once send each card once", async () => {
    const { plan, mock, deliverer } = setup();
    await Promise.all([deliverer().deliverBreak(plan), deliverer().deliverBreak(plan)]);
    for (const d of plan.deliveries) expect(mock.transfersOf(d.cardMint)).toBe(1);
    expect(await ownersOf(mock, plan)).toEqual(plan.deliveries.map((d) => d.recipient));
    expect((await deliverer().deliverBreak(plan)).complete).toBe(true);
  });
});

describe("Deliverer: the chain decides where a card is", () => {
  it("counts a card that is already at its recipient as delivered, without sending it", async () => {
    const { plan, mock, deliverer } = setup();
    const done = plan.deliveries[1]!;
    mock.give(done.cardMint, done.recipient);
    const progress = await deliverer().deliverBreak(plan);
    expect(progress.complete).toBe(true);
    expect(progress.deliveries[1]).toMatchObject({ status: "confirmed", adopted: true });
    expect(progress.deliveries[1]?.signature).toBeUndefined();
    expect(mock.transfersOf(done.cardMint)).toBe(0);
    expect(mock.prepareCalls).toBe(4);
  });

  it("sends nothing for a card held by a stranger, and says so", async () => {
    const { plan, mock, deliverer } = setup();
    const lost = plan.deliveries[2]!;
    mock.give(lost.cardMint, addr(222));
    const progress = await deliverer().deliverBreak(plan);
    expect(progress).toMatchObject({ delivered: 4, failed: 1, complete: false });
    expect(progress.anomalies).toHaveLength(1);
    expect(progress.anomalies[0]).toMatch(/held by .* not by the buyer wallet or the recipient/);
    expect(mock.transfersOf(lost.cardMint)).toBe(0);
    expect(await mock.ownerOf(lost.cardMint)).toBe(addr(222));
    // And it stays stopped: a human decides.
    const prepared = mock.prepareCalls;
    await deliverer().deliverBreak(plan);
    expect(mock.prepareCalls).toBe(prepared);
  });

  it("waits for a card that cannot be found yet", async () => {
    const plan = planFor();
    const mock = new MockCardTransfer();
    const { deliverer } = setup({ plan, transfer: mock });
    const first = await deliverer().deliverBreak(plan);
    expect(first).toMatchObject({ delivered: 0, waiting: 5 });
    expect(first.deliveries[0]?.lastError).toBe("card not found on-chain yet");
    for (const d of plan.deliveries) mock.give(d.cardMint, plan.buyer);
    expect((await deliverer().deliverBreak(plan)).complete).toBe(true);
  });

  it("refuses a provider that builds a transfer to another wallet", async () => {
    const mock = new MockCardTransfer();
    const wrong: CardTransfer = {
      ownerOf: (c) => mock.ownerOf(c),
      prepare: async (r: DeliveryRequest): Promise<PreparedTransfer> => mock.prepare({ ...r, recipient: addr(231) }),
      submit: (p) => mock.submit(p),
      status: (s, e) => mock.status(s, e),
    };
    const { plan, store, deliverer, errors } = setup({ transfer: wrong });
    for (const d of plan.deliveries) mock.give(d.cardMint, plan.buyer);
    const progress = await deliverer().deliverBreak(plan);
    expect(progress).toMatchObject({ delivered: 0, waiting: 5 });
    expect(await ownersOf(mock, plan)).toEqual(plan.deliveries.map(() => plan.buyer));
    expect(await store.attempts({ breakId: plan.breakId, spot: plan.deliveries[0]!.spot })).toEqual([]);
    expect(errors).toHaveLength(5);
  });

  it("does not take the chain's word for a transfer that left the card somewhere else", async () => {
    const mock = new MockCardTransfer();
    const lying: CardTransfer = {
      ownerOf: (c) => mock.ownerOf(c),
      prepare: (r) => mock.prepare(r),
      submit: async () => {}, // nothing is sent
      status: async () => ({ state: "confirmed" }),
    };
    const { plan, deliverer } = setup({ transfer: lying });
    for (const d of plan.deliveries) mock.give(d.cardMint, plan.buyer);
    const progress = await deliverer().deliverBreak(plan);
    expect(progress).toMatchObject({ delivered: 0, failed: 5, complete: false });
    expect(progress.anomalies).toHaveLength(5);
    expect(progress.anomalies[0]).toMatch(/is confirmed but card .* is held by/);
  });

  it("stops a delivery whose plan changed since it was recorded", async () => {
    const { plan, mock, deliverer } = setup();
    await deliverer().deliverBreak(plan);
    // Same cards, same break, a different seed: the cards would go to other spots.
    const other = planFor("1", { seed: 0x42 });
    const progress = await deliverer().deliverBreak(other);
    expect(progress.anomalies.length).toBeGreaterThan(0);
    expect(progress.anomalies[0]).toMatch(/was planned differently before/);
    for (const d of plan.deliveries) expect(mock.transfersOf(d.cardMint)).toBe(1);
  });
});

describe("Deliverer against the real schema", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await migratedDb();
  });

  async function breakWithSpots(plan: DeliveryPlan): Promise<string> {
    const id = await insertBreak(db);
    for (const d of plan.deliveries) {
      await db.query(
        d.spot.kind === "paid"
          ? "insert into spots (break_id, kind, idx, wallet, paid) values ($1, 'paid', $2, $3, 20000000)"
          : "insert into spots (break_id, kind, idx, wallet) values ($1, 'free', $2, $3)",
        [id, d.spot.idx, d.recipient],
      );
    }
    return id;
  }

  // Cards are unique across the whole table, so every break gets its own.
  async function newBreak(cardBase: number): Promise<DeliveryPlan> {
    const id = await breakWithSpots(planFor("0", { cardBase }));
    return planFor(id, { cardBase });
  }

  it("delivers a whole break and records it", async () => {
    const plan = await newBreak(100);
    const id = plan.breakId;
    const { mock, deliverer } = setup({ plan, store: new SqlDeliveryStore(db) });
    const progress = await deliverer().deliverBreak(plan);
    expect(progress.complete).toBe(true);
    const { rows } = await db.query<{ status: string; recipient: string; tx_sig: string }>(
      "select status, recipient, tx_sig from deliveries where break_id = $1 order by id",
      [id],
    );
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.status === "confirmed" && r.tx_sig)).toBe(true);
    expect(new Set(rows.map((r) => r.recipient))).toEqual(new Set(plan.deliveries.map((d) => d.recipient)));
    for (const d of plan.deliveries) expect(mock.transfersOf(d.cardMint)).toBe(1);
  });

  it("survives a lost send and a restart without sending twice", async () => {
    const plan = await newBreak(120);
    const id = plan.breakId;
    const { mock, deliverer } = setup({ plan, store: new SqlDeliveryStore(db) });
    mock.queueSubmit("drop");
    expect((await deliverer().deliverBreak(plan)).inFlight).toBe(1);
    mock.advanceBlocks(151);
    const restarted = new Deliverer({ transfer: mock, store: new SqlDeliveryStore(db), log: logger().log });
    expect((await restarted.deliverBreak(plan)).complete).toBe(true);
    for (const d of plan.deliveries) expect(mock.transfersOf(d.cardMint)).toBe(1);
    const { rows } = await db.query<{ outcome: string }>(
      `select a.outcome from delivery_attempts a join deliveries d on d.id = a.delivery_id
        where d.break_id = $1 order by a.attempt, a.id`,
      [id],
    );
    expect(rows.filter((r) => r.outcome === "expired")).toHaveLength(1);
  });

  it("records a card that was already at its recipient as adopted", async () => {
    const plan = await newBreak(140);
    const id = plan.breakId;
    const { mock, deliverer } = setup({ plan, store: new SqlDeliveryStore(db) });
    const done = plan.deliveries[0]!;
    mock.give(done.cardMint, done.recipient);
    expect((await deliverer().deliverBreak(plan)).complete).toBe(true);
    const { rows } = await db.query<{ adopted: boolean; tx_sig: string | null }>(
      "select adopted, tx_sig from deliveries where break_id = $1 and card_mint = $2",
      [id, done.cardMint],
    );
    expect(rows[0]).toEqual({ adopted: true, tx_sig: null });
  });
});

describe("deliveryJob", () => {
  it("runs every break, reports progress, and one break failing does not hold up the others", async () => {
    const first = planFor("1", { cardBase: 100 });
    const second = planFor("2", { cardBase: 120 });
    const mock = new MockCardTransfer();
    for (const p of [first, second]) for (const d of p.deliveries) mock.give(d.cardMint, p.buyer);
    const reported: [string, boolean][] = [];
    const source: DeliverySource = {
      plansToDeliver: async () => [first, second],
      report: async (p, progress) => {
        if (p.breakId === "1") throw new Error("database is down");
        reported.push([p.breakId, progress.complete]);
      },
    };
    const { log, errors } = logger();
    const job = deliveryJob({ deliverer: new Deliverer({ transfer: mock, store: new MemoryDeliveryStore(), log }), source, intervalMs: 1000 });
    expect(job.name).toBe("delivery");
    await job.run({ now: () => new Date(), log });
    expect(errors).toEqual(["delivery: break failed"]);
    expect(reported).toEqual([["2", true]]);
  });
});
