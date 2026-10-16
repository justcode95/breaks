import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { Deliverer, deliveryJob } from "../src/delivery/deliverer.js";
import { MockCardTransfer } from "../src/delivery/mock-transfer.js";
import { MemoryDeliveryStore } from "../src/delivery/store.js";
import { assignCards } from "../src/draw/pool.js";
import { PackBuyer, packBuyerJob } from "../src/packs/buyer.js";
import { packMachineBytes } from "../src/scheduler/machine.js";
import { MockPackProvider } from "../src/packs/mock-provider.js";
import { pipelineJob } from "../src/pipeline/job.js";
import { SqlEligibilityStore } from "../src/pipeline/eligibility-store.js";
import { type DbBreakStatus, SqlBreakRepo, dbStatusOf } from "../src/pipeline/repo.js";
import { DrawnBreaks, FundedBreaks } from "../src/pipeline/sources.js";
import { ORAO_PROGRAM, breakAddress, decodeSpot, requestAddress, spotAddress } from "../src/solana/breaks.js";
import { addressFromBytes, addressToBytes } from "../src/solana/pubkey.js";
import { addr } from "./support/chain.js";
import { insertBreak, migratedDb } from "./support/db.js";
import { ANSWER, MemoryRepo, PROGRAMS, logger, world } from "./support/world.js";

const requestOf = (w: ReturnType<typeof world>) => requestAddress(ORAO_PROGRAM, w.chain.breaks.get(7n)!.randomnessRequestId);

function sourcesOf(w: ReturnType<typeof world>, repo = new MemoryRepo([w.active]), packs = w.packs) {
  const { log, errors } = logger();
  const deps = { chain: w.chain, programs: PROGRAMS, repo, packs, log };
  return { repo, errors, funded: new FundedBreaks(deps), drawn: new DrawnBreaks(deps) };
}

async function drawn() {
  const w = world();
  await w.pullPacks();
  const pipe = w.pipeline();
  await pipe.advance(w.active);
  w.chain.fulfill(requestOf(w), ANSWER);
  await pipe.advance(w.active);
  expect(w.chain.breaks.get(7n)!.status).toBe("Drawn");
  return w;
}

describe("FundedBreaks", () => {
  it("plans the packs of a funded break from the chain", async () => {
    const w = world();
    const { funded } = sourcesOf(w);
    expect(await funded.breaksToBuy()).toEqual([
      { breakId: "7", poolSize: 5, packs: Array.from({ length: 5 }, () => ({ machine: "w".repeat(32), maxPrice: 25_000_000n })), packBudget: 125_000_000n },
    ]);
  });

  it("plans a mixed break from its list: the first pool_size packs, each from its own machine and with its own cap", async () => {
    const w = world();
    const b = w.chain.breaks.get(7n)!;
    b.tiers = [
      { machine: packMachineBytes("cheap"), maxPrice: 10_000_000n },
      { machine: packMachineBytes("top"), maxPrice: 50_000_000n },
    ];
    b.packs = [0, 0, 1, 1, 1];
    b.packBudget = 170_000_000n;
    const cheap = { machine: "cheap", maxPrice: 10_000_000n };
    const top = { machine: "top", maxPrice: 50_000_000n };
    const { funded } = sourcesOf(w);
    expect(await funded.breaksToBuy()).toEqual([{ breakId: "7", poolSize: 5, packs: [cheap, cheap, top, top, top], packBudget: 170_000_000n }]);

    // A break that did not fill buys only the first packs of the list: the cheapest, never a later one.
    b.poolSize = 3;
    b.packBudget = 70_000_000n;
    expect(await funded.breaksToBuy()).toEqual([{ breakId: "7", poolSize: 3, packs: [cheap, cheap, top], packBudget: 70_000_000n }]);
  });

  it("does not plan a pool that is bigger than the pack list, and says so", async () => {
    const w = world();
    w.chain.breaks.get(7n)!.poolSize = 6;
    const { funded, errors } = sourcesOf(w);
    expect(await funded.breaksToBuy()).toEqual([]);
    expect(errors).toEqual(["pack plan refused: the pool is bigger than the pack list"]);
  });

  it("skips breaks that are not funded, and breaks missing on-chain", async () => {
    const w = world();
    const { funded } = sourcesOf(w, new MemoryRepo([w.active, { ...w.active, id: "8", onchainId: 99n }]));
    w.chain.breaks.get(7n)!.status = "PoolCommitted";
    expect(await funded.breaksToBuy()).toEqual([]);
    w.chain.breaks.get(7n)!.status = "Closed";
    expect(await funded.breaksToBuy()).toEqual([]);
  });

  it("logs a pack that needs attention", async () => {
    const w = world();
    const { funded, errors } = sourcesOf(w);
    const plan = (await funded.breaksToBuy())[0]!;
    await funded.report(plan, { total: 5, pulled: 4, inFlight: 0, waiting: 0, failed: 1, complete: false, cards: [], anomalies: [], packs: [] });
    expect(errors).toEqual(["pack buyer needs attention"]);
  });
});

describe("DrawnBreaks", () => {
  it("builds the delivery plan from the chain's spots and winners and the pulled cards", async () => {
    const w = await drawn();
    const { drawn: source } = sourcesOf(w);
    const plans = await source.plansToDeliver();
    expect(plans).toHaveLength(1);
    const plan = plans[0]!;

    const b = w.chain.breaks.get(7n)!;
    const owners = [10, 11, 12].map((n) => addr(n));
    const winners = b.freeWinners.slice(0, 2).map((x) => x.wallet);
    const expected = assignCards(b.seed, w.cards.map(addressToBytes), owners, winners);
    expect(plan.buyer).toBe(w.config.buyer);
    expect(plan.deliveries.map((d) => d.recipient)).toEqual([...owners, ...winners]);
    expect(plan.deliveries.map((d) => addressToBytes(d.cardMint))).toEqual(expected.map((e) => e.card));
  });

  it("builds nothing until the break is drawn", async () => {
    const w = world();
    await w.pullPacks();
    const { drawn: source } = sourcesOf(w);
    expect(await source.plansToDeliver()).toEqual([]);
    await w.pipeline().advance(w.active); // RandomnessRequested
    expect(await source.plansToDeliver()).toEqual([]);
  });

  it("skips and reports a break whose cards are not the committed pool, without holding up the others", async () => {
    const w = await drawn();
    const repo = new MemoryRepo([w.active, { ...w.active, id: "8", onchainId: 99n }]);
    const { drawn: source, errors } = sourcesOf(w, repo);
    // Break 7 is fine; break 8 does not exist on-chain, which is not "drawn", so it is simply not planned.
    expect((await source.plansToDeliver()).map((p) => p.breakId)).toEqual(["7"]);

    // The same chain, but a pack store holding other cards than the ones committed.
    const stranger = world({ cardBase: 150 });
    await stranger.pullPacks();
    const refused = sourcesOf(w, repo, stranger.packs);
    expect(await refused.drawn.plansToDeliver()).toEqual([]);
    expect(refused.errors).toEqual(["delivery plan refused"]);
    expect(errors).toEqual([]);
  });

  it("reports a spot account that is missing on-chain", async () => {
    const w = await drawn();
    const { drawn: source, errors } = sourcesOf(w);
    w.chain.spots.delete(spotAddress(PROGRAMS, breakAddress(PROGRAMS, 7n), 1));
    expect(await source.plansToDeliver()).toEqual([]);
    expect(errors).toEqual(["delivery plan refused"]);
  });

  it("records the spots it plans for, once the plan is verified", async () => {
    const w = await drawn();
    const { drawn: source, repo } = sourcesOf(w);
    await source.plansToDeliver();
    const b = w.chain.breaks.get(7n)!;
    expect([...repo.spots.values()].map((s) => [s.kind, s.idx, s.wallet, s.paid])).toEqual([
      ["paid", 0, addr(10), 20_000_000n],
      ["paid", 1, addr(11), 20_000_000n],
      ["paid", 2, addr(12), 20_000_000n],
      ["free", 0, b.freeWinners[0]!.wallet, undefined],
      ["free", 1, b.freeWinners[1]!.wallet, undefined],
    ]);
    // Asking again changes nothing.
    await source.plansToDeliver();
    expect(repo.spots.size).toBe(5);
  });

  it("does not record anything for a plan that is refused", async () => {
    const w = await drawn();
    const stranger = world({ cardBase: 150 });
    await stranger.pullPacks();
    const { drawn: source, repo, errors } = sourcesOf(w, undefined, stranger.packs);
    expect(await source.plansToDeliver()).toEqual([]);
    expect(repo.spots.size).toBe(0);
    expect(errors).toEqual(["delivery plan refused"]);
  });

  it("refuses a plan when a spot is already recorded for another wallet", async () => {
    const w = await drawn();
    const { drawn: source, repo, errors } = sourcesOf(w);
    await repo.recordSpots("7", [{ kind: "paid", idx: 1, wallet: addr(99), paid: 20_000_000n }]);
    expect(await source.plansToDeliver()).toEqual([]);
    expect(errors).toEqual(["delivery plan refused"]);
  });

  it("marks the break delivered once every card is out", async () => {
    const w = await drawn();
    const { drawn: source, repo } = sourcesOf(w);
    const plan = (await source.plansToDeliver())[0]!;
    await source.report(plan, { total: 5, delivered: 4, inFlight: 1, waiting: 0, failed: 0, complete: false, anomalies: [], deliveries: [] });
    expect(repo.statuses.get("7")).toBe("funded");
    await source.report(plan, { total: 5, delivered: 5, inFlight: 0, waiting: 0, failed: 0, complete: true, anomalies: [], deliveries: [] });
    expect(repo.statuses.get("7")).toBe("delivered");
    expect(await repo.activeBreaks()).toEqual([]);
  });

  it("decodes the spot accounts it reads", async () => {
    const w = await drawn();
    const data = await w.chain.getAccountData(spotAddress(PROGRAMS, breakAddress(PROGRAMS, 7n), 2));
    expect(decodeSpot(data as Uint8Array)).toMatchObject({ breakId: 7n, index: 2, owner: addr(12), refunded: false });
  });
});

describe("pipelineJob", () => {
  it("advances every break and mirrors the chain status into the database", async () => {
    const w = world();
    await w.pullPacks();
    const repo = new MemoryRepo([w.active]);
    const { log, errors, infos } = logger();
    const job = pipelineJob({ pipeline: w.pipeline(), repo, intervalMs: 1000 });
    expect(job.name).toBe("pipeline");
    await job.run({ now: () => new Date(), log });
    expect(repo.statuses.get("7")).toBe(dbStatusOf("RandomnessRequested"));
    expect(infos).toContain("pipeline");
    expect(errors).toEqual([]);
  });

  it("reports a problem and carries on with the next break", async () => {
    const w = world();
    await w.pullPacks();
    const repo = new MemoryRepo([{ ...w.active, id: "8", onchainId: 99n }, w.active]);
    const { log, errors } = logger();
    await pipelineJob({ pipeline: w.pipeline(), repo, intervalMs: 1000 }).run({ now: () => new Date(), log });
    expect(errors).toEqual(["pipeline needs attention"]);
    expect(repo.statuses.get("7")).toBe("randomness_requested");
  });

  it("survives a repo that fails for one break", async () => {
    const w = world();
    await w.pullPacks();
    const repo = new MemoryRepo([w.active]);
    repo.setStatus = async () => {
      throw new Error("database is down");
    };
    const { log, errors } = logger();
    await pipelineJob({ pipeline: w.pipeline(), repo, intervalMs: 1000 }).run({ now: () => new Date(), log });
    expect(errors).toEqual(["pipeline: break failed"]);
  });
});

describe("the whole path after funding", () => {
  it("packs are bought, the pool committed, the draw recorded and every card delivered to the assigned wallet", async () => {
    const w = world();
    const repo = new MemoryRepo([w.active]);
    const { log, errors } = logger();
    const ctx = { now: () => new Date(), log };
    const deps = { chain: w.chain, programs: PROGRAMS, repo, packs: w.packs, log };

    // The three jobs, each with its own source, all reading the same chain and the same notes.
    const provider = new MockPackProvider(25_000_000n);
    const buyerJob = packBuyerJob({ buyer: new PackBuyer({ provider, store: w.packs, log }), source: new FundedBreaks(deps), intervalMs: 1 });
    const pipeJob = pipelineJob({ pipeline: w.pipeline(), repo, intervalMs: 1 });
    const deliverer = new Deliverer({ transfer: w.transfer, store: new MemoryDeliveryStore(), log });
    const sendJob = deliveryJob({ deliverer, source: new DrawnBreaks(deps), intervalMs: 1 });

    // Nothing to commit before the packs exist.
    await pipeJob.run(ctx);
    expect(w.chain.applied).toEqual([]);

    await buyerJob.run(ctx);
    const rows = await w.packs.listForBreak("7");
    expect(rows.every((r) => r.status === "pulled")).toBe(true);
    // The pulled cards sit in the buyer wallet (one chain in real life; two mocks here).
    for (const r of rows) w.transfer.give(r.cardMint as string, w.config.buyer);

    await pipeJob.run(ctx);
    expect(w.chain.applied).toEqual(["commit_pool", "request_randomness"]);
    expect(repo.statuses.get("7")).toBe("randomness_requested");

    await sendJob.run(ctx); // nothing is drawn yet: nothing is sent
    expect(w.transfer.prepareCalls).toBe(0);

    w.chain.fulfill(requestOf(w), ANSWER);
    await pipeJob.run(ctx);
    expect(repo.statuses.get("7")).toBe("drawn");

    await sendJob.run(ctx);
    expect(repo.statuses.get("7")).toBe("delivered");
    expect(errors).toEqual([]);

    // Every card went where the draw says.
    const b = w.chain.breaks.get(7n)!;
    const owners = [10, 11, 12].map((n) => addr(n));
    const winners = b.freeWinners.slice(0, 2).map((x) => x.wallet);
    const expected = assignCards(b.seed, rows.map((r) => addressToBytes(r.cardMint as string)), owners, winners);
    const recipients = [...owners, ...winners];
    for (const [i, a] of expected.entries()) {
      expect(await w.transfer.ownerOf(addressFromBytes(a.card))).toBe(recipients[i]);
      expect(w.transfer.transfersOf(addressFromBytes(a.card))).toBe(1);
    }

    // And nothing more happens afterwards.
    const sends = w.chain.sendCalls;
    await pipeJob.run(ctx);
    await sendJob.run(ctx);
    expect(w.chain.sendCalls).toBe(sends);
    expect(w.transfer.prepareCalls).toBe(5);
  });
});

describe("against the real schema", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await migratedDb();
  });

  it("the repo lists on-chain breaks that are not finished and updates their status", async () => {
    const repo = new SqlBreakRepo(db);
    const id = await insertBreak(db);
    const other = await insertBreak(db);
    await db.query("update breaks set onchain_id = $2 where id = $1::bigint", [id, 1001]);
    // `other` has no on-chain id yet, so it is not active.
    expect((await repo.activeBreaks()).find((b) => b.id === other)).toBeUndefined();
    const mine = (await repo.activeBreaks()).find((b) => b.id === id);
    expect(mine).toEqual({ id, onchainId: 1001n, status: "scheduled" });

    for (const status of ["funded", "pool_committed", "randomness_requested", "settled", "drawn"] as DbBreakStatus[]) {
      await repo.setStatus(id, status);
      expect((await repo.activeBreaks()).find((b) => b.id === id)?.status).toBe(status);
    }
    await repo.setStatus(id, "delivered");
    expect((await repo.activeBreaks()).find((b) => b.id === id)).toBeUndefined();
  });

  it("the repo lists cancelled breaks for the refund job until they are marked refunded, and a refunded break is no longer active", async () => {
    const repo = new SqlBreakRepo(db);
    const id = await insertBreak(db);
    const noChainId = await insertBreak(db);
    await db.query("update breaks set onchain_id = $2 where id = $1::bigint", [id, 2002]);
    await repo.setStatus(noChainId, "cancelled");
    // Not cancelled yet: not for the refund job.
    expect((await repo.cancelledBreaks()).find((b) => b.id === id)).toBeUndefined();

    await repo.setStatus(id, "cancelled");
    expect((await repo.cancelledBreaks()).find((b) => b.id === id)).toEqual({ id, onchainId: 2002n, status: "cancelled" });
    // A cancelled break is not one the pipeline advances, and one with no on-chain id is not one the refund job can read.
    expect((await repo.activeBreaks()).find((b) => b.id === id)).toBeUndefined();
    expect((await repo.cancelledBreaks()).find((b) => b.id === noChainId)).toBeUndefined();

    await repo.setStatus(id, "refunded");
    expect((await repo.cancelledBreaks()).find((b) => b.id === id)).toBeUndefined();
    expect((await repo.activeBreaks()).find((b) => b.id === id)).toBeUndefined();
    expect((await db.query<{ status: string }>("select status from breaks where id = $1::bigint", [id])).rows[0]?.status).toBe("refunded");
  });

  it("the repo copies spots from the chain, keeps what is there, and refuses a different wallet", async () => {
    const repo = new SqlBreakRepo(db);
    const id = await insertBreak(db);
    const spots = [
      { kind: "paid" as const, idx: 0, wallet: addr(10), paid: 20_000_000n },
      { kind: "paid" as const, idx: 1, wallet: addr(11), paid: 20_000_000n },
      { kind: "free" as const, idx: 0, wallet: addr(50) },
    ];
    await repo.recordSpots(id, spots);
    await repo.recordSpots(id, spots); // again: nothing changes
    const { rows } = await db.query<{ kind: string; idx: number; wallet: string; paid: string | null }>(
      "select kind, idx, wallet, paid::text as paid from spots where break_id = $1 order by kind, idx",
      [id],
    );
    expect(rows).toEqual([
      { kind: "free", idx: 0, wallet: addr(50), paid: null },
      { kind: "paid", idx: 0, wallet: addr(10), paid: "20000000" },
      { kind: "paid", idx: 1, wallet: addr(11), paid: "20000000" },
    ]);
    await expect(repo.recordSpots(id, [{ kind: "paid", idx: 0, wallet: addr(99), paid: 20_000_000n }])).rejects.toThrow(/is recorded for .* but the chain says/);
  });

  it("the schema accepts every status the chain can be in and nothing else", async () => {
    const id = await insertBreak(db);
    for (const status of ["Open", "Closed", "EligibilityCommitted", "Funded", "PoolCommitted", "RandomnessRequested", "Settled", "Drawn", "Cancelled"] as const) {
      await db.query("update breaks set status = $2 where id = $1::bigint", [id, dbStatusOf(status)]);
    }
    await expect(db.query("update breaks set status = 'nonsense' where id = $1::bigint", [id])).rejects.toThrow();
  });

  it("the eligibility store returns the eligible wallets sorted by bytes", async () => {
    const id = await insertBreak(db);
    const rows: [string, number, boolean][] = [
      [addr(80), 5, true],
      [addr(70), 9, true],
      [addr(75), 0, true], // weight zero: not a leaf
      [addr(60), 7, false], // not eligible
      [addr(65), 3, true],
    ];
    for (const [wallet, weight, eligible] of rows) {
      await db.query("insert into twab_snapshots (break_id, wallet, twab, weight, eligible) values ($1, $2, $3, $3, $4)", [id, wallet, weight, eligible]);
    }
    const leaves = await new SqlEligibilityStore(db).leaves(id);
    expect(leaves.map((l) => [addressFromBytes(l.wallet), l.weight])).toEqual([
      [addr(65), 3n],
      [addr(70), 9n],
      [addr(80), 5n],
    ]);
    expect(await new SqlEligibilityStore(db).leaves(await insertBreak(db))).toEqual([]);
  });
});
