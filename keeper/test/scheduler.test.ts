import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Job, JobContext } from "../src/job.js";
import { packMachineBytes } from "../src/scheduler/machine.js";
import type { BreakTemplate } from "../src/scheduler/policy.js";
import { BreakScheduler, type SchedulerReport, schedulerJob } from "../src/scheduler/scheduler.js";
import { SqlSchedulerStore } from "../src/scheduler/store.js";
import { ORAO_PROGRAM, createBreak } from "../src/solana/breaks.js";
import { addr, BUYER } from "./support/chain.js";
import { migratedDb } from "./support/db.js";
import { MockChain } from "./support/mock-chain.js";
import { oneMachine } from "./support/packs.js";
import { KEEPER, PROGRAMS, logger } from "./support/world.js";

const T0 = 1_800_000_000;
const USDC = addr(5);
const TEMPLATE: BreakTemplate = {
  paidSpots: 10,
  freeSpots: 2,
  spotPrice: 20_000_000n,
  packs: oneMachine("pokemon-25", 25_000_000n, 12),
  windowSecs: 43_200n,
};
const TIERS = [{ machine: packMachineBytes("pokemon-25"), maxPrice: 25_000_000n }];
// What TEMPLATE needs unlocked: 10 * (25 - 20) = $50 of subsidy and 2 * 25 = $50 for the holders.
const NEED = 50_000_000n;

let db: PGlite;
beforeAll(async () => {
  db = await migratedDb();
});
beforeEach(async () => {
  await db.exec("truncate breaks cascade");
});

function setup(over: { template?: Partial<BreakTemplate>; enabled?: boolean; retryAfterMs?: number; config?: Partial<MockChain["config"]>; funds?: [bigint, bigint]; sol?: bigint; checkSol?: boolean } = {}) {
  const chain = new MockChain(PROGRAMS, {
    admin: addr(2),
    keeper: KEEPER,
    buyer: BUYER,
    usdcMint: USDC,
    randomnessProgram: ORAO_PROGRAM,
    randomnessTimeoutSecs: 3_600n,
    nextBreakId: 0n,
    minWindowSecs: 21_600n,
    maxWindowSecs: 86_400n,
    maxPaidSpots: 20,
    maxFreeSpots: 6,
    paused: false,
    bump: 255,
    ...over.config,
  });
  const clock = { t: T0 };
  chain.unixTime = BigInt(T0);
  // The keeper pays the rent of the break and its escrow: 5 SOL is plenty unless a test says otherwise.
  chain.solBalances.set(KEEPER, over.sol ?? 5_000_000_000n);
  const funds = over.funds ?? [NEED, NEED];
  chain.treasury.subsidyVault = funds[0];
  chain.treasury.holderVault = funds[1];
  const store = new SqlSchedulerStore({ query: (text, params) => db.query(text, params) as never });
  const scheduler = new BreakScheduler({
    chain,
    programs: PROGRAMS,
    keeper: KEEPER,
    store,
    template: { ...TEMPLATE, ...over.template },
    enabled: over.enabled ?? true,
    ...(over.checkSol === false ? {} : { wallet: chain }),
    now: () => new Date(clock.t * 1000),
    ...(over.retryAfterMs !== undefined ? { retryAfterMs: over.retryAfterMs } : {}),
  });
  /** Moves both the keeper's clock and the chain's. */
  const at = (t: number) => {
    clock.t = t;
    chain.unixTime = BigInt(t);
  };
  /** A break created outside the scheduler, with the keeper key (a script, or a send whose bookkeeping was lost). */
  const createByHand = async (breakId: bigint, over: Partial<Parameters<typeof createBreak>[1]> = {}) =>
    chain.sendAndConfirm([
      createBreak(PROGRAMS, {
        keeper: KEEPER,
        usdcMint: USDC,
        breakId,
        paidSpots: 10,
        freeSpots: 2,
        spotPrice: 20_000_000n,
        tiers: [{ machine: packMachineBytes("by-hand"), maxPrice: 25_000_000n }],
        packs: Array<number>(12).fill(0),
        opensAt: BigInt(clock.t),
        closesAt: BigInt(clock.t) + 43_200n,
        ...over,
      }),
    ]);
  return { chain, clock, store, scheduler, at, createByHand };
}

const rows = async () =>
  (await db.query<{ onchain_id: string; status: string; paid_spots: number; free_spots: number; spot_price: string; max_pack_price: string; pack_machine: string; opens: string; closes: string; create_tx: string | null }>(
    `select onchain_id::text, status, paid_spots, free_spots, spot_price::text, max_pack_price::text, pack_machine,
            extract(epoch from opens_at)::bigint::text as opens, extract(epoch from closes_at)::bigint::text as closes, create_tx
       from breaks order by onchain_id`,
  )).rows;

describe("BreakScheduler", () => {
  it("does nothing while the breaks program is not initialized", async () => {
    const s = setup();
    const scheduler = new BreakScheduler({ chain: s.chain, programs: { breaks: addr(1), treasury: addr(2) }, keeper: KEEPER, store: s.store, template: TEMPLATE, enabled: true });
    expect(await scheduler.run()).toEqual({ kind: "idle", reason: "the breaks program is not initialized", recorded: [] });
    expect(s.chain.sendCalls).toBe(0);
  });

  describe("waiting for the reserve", () => {
    it("sends nothing until both buckets cover the worst case, and says how far it is", async () => {
      const s = setup({ funds: [25_000_000n, 40_000_000n] });
      const r = await s.scheduler.run();
      expect(r).toMatchObject({ kind: "reserve", recorded: [], progress: { percent: 50, enough: false, availableSubsidy: 25_000_000n, availableHolder: 40_000_000n } });
      expect(s.chain.sendCalls).toBe(0);
      expect(await rows()).toEqual([]);
    });

    it("counts only unlocked funds: what another break has locked does not pay for this one", async () => {
      const s = setup({ funds: [NEED + 10_000_000n, NEED + 10_000_000n] });
      s.chain.treasury.config.lockedSubsidy = 20_000_000n;
      const r = await s.scheduler.run();
      expect(r.kind).toBe("reserve");
      expect(s.chain.sendCalls).toBe(0);
    });

    it("agrees with the program at the boundary: exactly enough creates, one micro-dollar short waits and would be refused", async () => {
      const exact = setup({ funds: [NEED, NEED] });
      expect((await exact.scheduler.run()).kind).toBe("created");

      const short = setup({ funds: [NEED, NEED - 1n] });
      expect((await short.scheduler.run()).kind).toBe("reserve");
      expect(short.chain.sendCalls).toBe(0);
      // The program model, asked directly, refuses the same break: the check is not more generous than the chain.
      const refused = await short.createByHand(0n, { tiers: TIERS });
      expect(refused).toMatchObject({ outcome: "failed", reason: "InsufficientAvailable" });
    });
  });

  describe("a break of several machines", () => {
    const D = 1_000_000n;
    const group = (machine: string, dollars: bigint, count: number) => ({ machine: packMachineBytes(machine), maxPrice: dollars * D, count });
    // 6 paid spots at $20 and 2 free: four $10 packs, two $25 and two $50. $190 over 8 spots is $23.75 on average, so the
    // free spots are $47.50 from the holder bucket and the subsidy bucket reserves $190 − 6 × $20 − $47.50 = $22.50.
    const MIXED = { paidSpots: 6, freeSpots: 2, packs: [group("cheap", 10n, 4), group("mid", 25n, 2), group("top", 50n, 2)] };
    const SUBSIDY = 22_500_000n;
    const HOLDER = 47_500_000n;

    it("sends the list in order and reserves what the whole list needs", async () => {
      const s = setup({ template: MIXED, funds: [SUBSIDY, HOLDER] });
      expect(await s.scheduler.run()).toMatchObject({ kind: "created", breakId: 0n });
      const b = s.chain.breaks.get(0n)!;
      expect(b.tiers.map((t) => [Buffer.from(t.machine).toString().replace(/\0+$/, ""), t.maxPrice])).toEqual([["cheap", 10n * D], ["mid", 25n * D], ["top", 50n * D]]);
      expect(b.packs).toEqual([0, 0, 0, 0, 1, 1, 2, 2]);
      expect(b).toMatchObject({ paidSpots: 6, freeSpots: 2, lockedSubsidy: SUBSIDY, lockedHolder: HOLDER });
      expect(s.chain.treasury.config).toMatchObject({ lockedSubsidy: SUBSIDY, lockedHolder: HOLDER });
    });

    it("agrees with the program model at the boundary: one micro-dollar short waits, and the model refuses the same break", async () => {
      const short = setup({ template: MIXED, funds: [SUBSIDY - 1n, HOLDER] });
      expect(await short.scheduler.run()).toMatchObject({ kind: "reserve", progress: { percent: 99, enough: false, requiredSubsidy: SUBSIDY, requiredHolder: HOLDER } });
      expect(short.chain.sendCalls).toBe(0);
      const refused = await short.createByHand(0n, { paidSpots: 6, freeSpots: 2, tiers: MIXED.packs.map((g) => ({ machine: g.machine, maxPrice: g.maxPrice })), packs: [0, 0, 0, 0, 1, 1, 2, 2] });
      expect(refused).toMatchObject({ outcome: "failed", reason: "InsufficientAvailable" });
      const holder = setup({ template: MIXED, funds: [SUBSIDY, HOLDER - 1n] });
      expect(await holder.scheduler.run()).toMatchObject({ kind: "reserve", progress: { percent: 99 } });
    });

    it("does not send a break the program would refuse: a spot price above the average pack price", async () => {
      const s = setup({ template: { ...MIXED, spotPrice: 23_750_001n }, funds: [10n * SUBSIDY, 10n * HOLDER] });
      const r = await s.scheduler.run();
      expect(r).toMatchObject({ kind: "problem" });
      expect(JSON.stringify(r)).toContain("above the average pack price");
      expect(s.chain.sendCalls).toBe(0);
    });

    it("copies a break of several machines into the database as a summary: the machines joined and the highest price", async () => {
      const s = setup({ template: MIXED, funds: [SUBSIDY, HOLDER] });
      await s.scheduler.run();
      await s.scheduler.run();
      expect(await rows()).toMatchObject([{ onchain_id: "0", pack_machine: "cheap, mid, top", max_pack_price: "50000000", paid_spots: 6, free_spots: 2 }]);
    });
  });

  describe("creating a break", () => {
    it("sends create_break with the configured break and locks its worst case in the treasury", async () => {
      const s = setup();
      const r = await s.scheduler.run();
      expect(r).toMatchObject({ kind: "created", breakId: 0n, signature: "mock-tx-1", recorded: [] });
      expect(s.chain.applied).toEqual(["create_break"]);

      const b = s.chain.breaks.get(0n)!;
      expect(b).toMatchObject({ status: "Open", paidSpots: 10, freeSpots: 2, spotPrice: 20_000_000n, tiers: TIERS, packs: Array<number>(12).fill(0), opensAt: BigInt(T0), closesAt: BigInt(T0) + 43_200n, lockedSubsidy: NEED, lockedHolder: NEED });
      expect(s.chain.treasury.config).toMatchObject({ lockedSubsidy: NEED, lockedHolder: NEED });
      expect(s.chain.config.nextBreakId).toBe(1n);
    });

    it("copies the break from the chain into the database on the next run, with its transaction", async () => {
      const s = setup();
      await s.scheduler.run();
      expect(await rows()).toEqual([]); // not yet: the database only learns from the chain

      const next = await s.scheduler.run();
      expect(next).toMatchObject({ kind: "selling", breakId: 0n, recorded: [0n] });
      expect(await rows()).toEqual([
        {
          onchain_id: "0",
          status: "open",
          paid_spots: 10,
          free_spots: 2,
          spot_price: "20000000",
          max_pack_price: "25000000",
          pack_machine: "pokemon-25",
          opens: String(T0),
          closes: String(T0 + 43_200),
          create_tx: "mock-tx-1",
        },
      ]);
    });

    it("creates only one break while it is selling, however often it runs", async () => {
      const s = setup({ funds: [10n * NEED, 10n * NEED] });
      await s.scheduler.run();
      for (let i = 0; i < 5; i++) {
        s.at(T0 + 60 * (i + 1));
        expect((await s.scheduler.run()).kind).toBe("selling");
      }
      expect(s.chain.breaks.size).toBe(1);
      expect(s.chain.sendCalls).toBe(1);
    });

    it("starts the next break when the sale has ended and the reserve allows it", async () => {
      const s = setup({ funds: [NEED, NEED] });
      await s.scheduler.run();
      s.at(T0 + 43_200 + 1); // the first sale is over, but it has used the reserve (locked)
      expect((await s.scheduler.run()).kind).toBe("reserve");

      s.chain.treasury.subsidyVault += NEED; // fees came in
      s.chain.treasury.holderVault += NEED;
      const r = await s.scheduler.run();
      expect(r).toMatchObject({ kind: "created", breakId: 1n });
      expect(s.chain.treasury.config).toMatchObject({ lockedSubsidy: 2n * NEED, lockedHolder: 2n * NEED });
      expect(s.chain.breaks.get(1n)!.opensAt).toBe(BigInt(T0 + 43_201));
    });

    it("does not wait for a sale that has ended but whose break the pipeline has not closed yet", async () => {
      const s = setup({ funds: [2n * NEED, 2n * NEED] });
      await s.scheduler.run();
      s.at(T0 + 43_200); // closes_at reached; on-chain the break is still `Open` until someone calls close_break
      expect(s.chain.breaks.get(0n)!.status).toBe("Open");
      expect((await s.scheduler.run()).kind).toBe("created");
    });
  });

  describe("when it must not create", () => {
    it("is idle while the program is paused (it still copies breaks from the chain)", async () => {
      const s = setup({ config: { paused: true } });
      s.chain.breaks.clear();
      const r = await s.scheduler.run();
      expect(r).toEqual({ kind: "idle", reason: "the breaks program is paused", recorded: [] });
      expect(s.chain.sendCalls).toBe(0);
    });

    it("is idle when automatic creation is off, but still picks up a break made by hand", async () => {
      const s = setup({ enabled: false });
      await s.createByHand(0n);
      const r = await s.scheduler.run();
      expect(r).toEqual({ kind: "idle", reason: "automatic break creation is off", recorded: [0n] });
      expect((await rows()).map((x) => [x.onchain_id, x.pack_machine])).toEqual([["0", "by-hand"]]);
      expect(s.chain.sendCalls).toBe(1); // only the by-hand one
    });

    it("reports a break the program would refuse instead of sending it", async () => {
      for (const template of [{ paidSpots: 21 }, { freeSpots: 7 }, { windowSecs: 3_600n }, { spotPrice: 30_000_000n }]) {
        const s = setup({ template });
        const r = await s.scheduler.run();
        expect(r.kind, JSON.stringify(template, (_, v) => (typeof v === "bigint" ? String(v) : v))).toBe("problem");
        expect(s.chain.sendCalls).toBe(0);
      }
    });
  });

  describe("copying breaks from the chain", () => {
    it("picks up a break whose creation landed but whose bookkeeping was lost, and does not create another", async () => {
      const s = setup({ funds: [10n * NEED, 10n * NEED] });
      await s.createByHand(0n, { tiers: TIERS });
      // A new process: nothing in memory, nothing in the database.
      const fresh = new BreakScheduler({ chain: s.chain, programs: PROGRAMS, keeper: KEEPER, store: s.store, template: TEMPLATE, enabled: true, now: () => new Date(T0 * 1000) });
      const r = await fresh.run();
      expect(r).toMatchObject({ kind: "selling", breakId: 0n, recorded: [0n] });
      expect(s.chain.breaks.size).toBe(1);
      expect((await rows())[0]).toMatchObject({ onchain_id: "0", create_tx: null, pack_machine: "pokemon-25" });
    });

    it("takes every break of the chain into a new database, and only the newer ones into an old one", async () => {
      const s = setup({ enabled: false, funds: [10n * NEED, 10n * NEED] });
      for (let i = 0n; i < 3n; i++) await s.createByHand(i);
      expect((await s.scheduler.run()).recorded).toEqual([0n, 1n, 2n]);

      await s.createByHand(3n);
      expect((await s.scheduler.run()).recorded).toEqual([3n]);
      expect((await s.scheduler.run()).recorded).toEqual([]);
    });

    it("takes at most 25 breaks in one run and the rest in the next", async () => {
      const s = setup({ enabled: false, config: { maxPaidSpots: 20 } });
      // 30 breaks exist on-chain (set up directly in the model).
      await s.createByHand(0n);
      const template = s.chain.breaks.get(0n)!;
      for (let i = 1n; i < 30n; i++) s.chain.breaks.set(i, { ...template, id: i });
      s.chain.config.nextBreakId = 30n;
      expect((await s.scheduler.run()).recorded).toHaveLength(25);
      expect((await s.scheduler.run()).recorded).toHaveLength(5);
    });

    it("keeps the chain's status for a break that is already past its sale", async () => {
      const s = setup({ enabled: false });
      await s.createByHand(0n);
      s.chain.breaks.get(0n)!.status = "Funded";
      await s.scheduler.run();
      expect((await rows())[0]!.status).toBe("funded");
    });

    it("refuses to go on when a break below the next id is missing on the chain", async () => {
      const s = setup({ enabled: false });
      s.chain.config.nextBreakId = 2n; // ids 0 and 1 should exist
      await expect(s.scheduler.run()).rejects.toThrow(/break 0 should exist/);
    });
  });

  describe("results that are not known or not good", () => {
    it("tries the same id again when the transaction never arrived, and ends up with one break", async () => {
      const s = setup();
      s.chain.queueSend("drop");
      const first = await s.scheduler.run();
      expect(first).toMatchObject({ kind: "pending", breakId: 0n, signature: "mock-tx-1" });
      expect(s.chain.breaks.size).toBe(0);

      const second = await s.scheduler.run();
      expect(second).toMatchObject({ kind: "created", breakId: 0n });
      expect(s.chain.breaks.size).toBe(1);
    });

    it("does not create a second break when the first landed but its confirmation was lost", async () => {
      const s = setup({ funds: [10n * NEED, 10n * NEED] });
      s.chain.queueSend("applied-unknown");
      expect((await s.scheduler.run()).kind).toBe("pending");
      expect(s.chain.breaks.size).toBe(1);

      const next = await s.scheduler.run();
      expect(next).toMatchObject({ kind: "selling", breakId: 0n, recorded: [0n] });
      expect(s.chain.sendCalls).toBe(1);
      // The signature of the lost confirmation is still noted with the break.
      expect((await rows())[0]!.create_tx).toBe("mock-tx-1");
    });

    it("resending an old attempt at an id that has since been created is refused by the program", async () => {
      const s = setup();
      await s.createByHand(0n);
      const late = await s.createByHand(0n); // the same id again, as a delayed resend would be
      expect(late).toMatchObject({ outcome: "failed", reason: "ConstraintSeeds" });
      expect(s.chain.breaks.size).toBe(1);
    });

    it("waits before trying again after a refusal, then tries the same id again", async () => {
      const s = setup({ retryAfterMs: 60_000 });
      s.chain.queueSend("fail");
      expect(await s.scheduler.run()).toMatchObject({ kind: "failed", breakId: 0n });

      s.at(T0 + 30);
      expect(await s.scheduler.run()).toMatchObject({ kind: "backoff", breakId: 0n });
      expect(s.chain.sendCalls).toBe(1);

      s.at(T0 + 61);
      expect(await s.scheduler.run()).toMatchObject({ kind: "created", breakId: 0n });
      expect(s.chain.sendCalls).toBe(2);
    });
  });
});

describe("SqlSchedulerStore", () => {
  const breakAccount = async (id: bigint, over: Record<string, unknown> = {}) => {
    const s = setup({ funds: [10n * NEED, 10n * NEED] });
    await s.createByHand(0n);
    return { s, b: { ...s.chain.breaks.get(0n)!, id, ...over } };
  };

  it("records a break once: a second record of the same on-chain id changes nothing", async () => {
    const { s, b } = await breakAccount(4n);
    await s.store.recordBreak(b, "first");
    await s.store.recordBreak({ ...b, paidSpots: 1 }, "second");
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ onchain_id: "4", paid_spots: 10, create_tx: "first" });
  });

  it("knows the highest id, and none for an empty database", async () => {
    const { s, b } = await breakAccount(0n);
    expect(await s.store.highestOnchainId()).toBeUndefined();
    await s.store.recordBreak({ ...b, id: 2n });
    await s.store.recordBreak({ ...b, id: 9n });
    await s.store.recordBreak({ ...b, id: 5n });
    expect(await s.store.highestOnchainId()).toBe(9n);
  });

  it("lists only the breaks the database still has as not closed", async () => {
    const { s, b } = await breakAccount(0n);
    for (const [id, status] of [[1n, "Open"], [2n, "Closed"], [3n, "Funded"], [4n, "Cancelled"], [5n, "Open"]] as const) {
      await s.store.recordBreak({ ...b, id, status });
    }
    expect(await s.store.openOnchainIds()).toEqual([1n, 5n]);
  });

  it("summarises a break with several machines: the machines joined, and the highest pack price", async () => {
    const { s, b } = await breakAccount(3n, {
      tiers: [
        { machine: packMachineBytes("cheap"), maxPrice: 10_000_000n },
        { machine: packMachineBytes("mid"), maxPrice: 25_000_000n },
        { machine: packMachineBytes("cheap"), maxPrice: 40_000_000n },
        { machine: packMachineBytes("top"), maxPrice: 50_000_000n },
      ],
    });
    await s.store.recordBreak(b);
    expect(await rows()).toMatchObject([{ onchain_id: "3", pack_machine: "cheap, mid, top", max_pack_price: "50000000" }]);
  });

  it("keeps a machine id that is not text as hex", async () => {
    const { s, b } = await breakAccount(7n, { tiers: [{ machine: new Uint8Array(32).fill(0xff), maxPrice: 25_000_000n }] });
    await s.store.recordBreak(b);
    expect((await rows())[0]!.pack_machine).toBe(`0x${"ff".repeat(32)}`);
  });
});

describe("the keeper's SOL", () => {
  const COST = 13_695_320n; // rent of the break and its escrow, the fee, and what the wallet keeps: src/solana/rent.ts

  it("holds back a break the keeper cannot pay for and says how much it has and needs, without sending anything", async () => {
    const s = setup({ sol: 1_000_000n });
    const r = await s.scheduler.run();
    expect(r).toEqual({ kind: "funds", have: 1_000_000n, needed: COST, recorded: [] });
    expect(s.chain.sendCalls).toBe(0);
    expect(s.chain.breaks.size).toBe(0);
    expect(await rows()).toEqual([]);
  });

  it("creates the break once the wallet is topped up, and the rent comes out of it", async () => {
    const s = setup({ sol: 1_000_000n });
    expect((await s.scheduler.run()).kind).toBe("funds");
    s.chain.solBalances.set(KEEPER, COST + 7n);
    expect((await s.scheduler.run()).kind).toBe("created");
    // 10,760,160 + 2,039,280 of rent and the 5,000 fee are paid; what is left is what must stay.
    expect(s.chain.solBalances.get(KEEPER)).toBe(890_887n);
  });

  it("agrees with the program at the boundary: exactly enough creates, one lamport short waits and would be refused", async () => {
    const exact = setup({ sol: COST });
    expect((await exact.scheduler.run()).kind).toBe("created");
    expect(exact.chain.solBalances.get(KEEPER)).toBe(890_880n);

    const short = setup({ sol: COST - 1n });
    expect(await short.scheduler.run()).toMatchObject({ kind: "funds", have: COST - 1n, needed: COST });
    expect(short.chain.sendCalls).toBe(0);
    // The program model, asked directly, refuses the same break: the check is not more generous than the chain.
    const refused = await short.createByHand(0n, { tiers: TIERS });
    expect(refused).toMatchObject({ outcome: "failed", reason: "InsufficientFundsForRent" });
    expect(short.chain.solBalances.get(KEEPER)).toBe(COST - 1n);
  });

  it("does not nag while the reserve is short: the reserve is what is waited for first", async () => {
    const s = setup({ sol: 0n, funds: [NEED, NEED - 1n] });
    expect((await s.scheduler.run()).kind).toBe("reserve");
  });

  it("does not matter while a break is selling, when the program is paused or when creation is off", async () => {
    const selling = setup();
    expect((await selling.scheduler.run()).kind).toBe("created");
    selling.chain.solBalances.set(KEEPER, 0n);
    expect(await selling.scheduler.run()).toMatchObject({ kind: "selling", breakId: 0n });

    expect((await setup({ sol: 0n, config: { paused: true } }).scheduler.run()).kind).toBe("idle");
    expect((await setup({ sol: 0n, enabled: false }).scheduler.run()).kind).toBe("idle");
  });

  it("is not checked when the scheduler is not given a way to read the wallet: the program refuses instead", async () => {
    const s = setup({ sol: 1_000_000n, checkSol: false });
    expect(await s.scheduler.run()).toMatchObject({ kind: "failed", breakId: 0n, reason: "InsufficientFundsForRent" });
    expect(s.chain.sendCalls).toBe(1);
  });

  it("reads the keeper's own wallet", async () => {
    const s = setup({ sol: COST });
    s.chain.solBalances.set(addr(77), 0n); // someone else's wallet is no use
    expect((await s.scheduler.run()).kind).toBe("created");
  });
});

describe("schedulerJob", () => {
  function run(reports: (SchedulerReport | Error)[]) {
    const { log, errors, infos } = logger();
    const lines: string[] = [];
    const fake = { run: async () => { const r = reports.shift()!; if (r instanceof Error) throw r; return r; } } as unknown as BreakScheduler;
    const job: Job = schedulerJob({ scheduler: fake, intervalMs: 1000 });
    const clock = { t: T0 };
    const ctx: JobContext = { now: () => new Date(clock.t * 1000), log: { info: (m, e) => { infos.push(m); lines.push(`${m} ${JSON.stringify(e ?? {}, (_, v) => (typeof v === "bigint" ? String(v) : v))}`); }, error: (m, e) => { errors.push(m); lines.push(`${m} ${JSON.stringify(e ?? {})}`); } } };
    void log;
    return { job, ctx, errors, infos, lines, clock };
  }
  const reserve = (percent: number): SchedulerReport => ({
    kind: "reserve",
    recorded: [],
    progress: { percent, enough: false, requiredSubsidy: 50n, requiredHolder: 50n, availableSubsidy: BigInt(percent) / 2n, availableHolder: BigInt(percent) / 2n },
  });

  it("says the reserve progress only when it moves", async () => {
    const t = run([reserve(10), reserve(10), reserve(10), reserve(11)]);
    for (let i = 0; i < 4; i++) await t.job.run(t.ctx);
    expect(t.infos).toEqual(["waiting for the reserve", "waiting for the reserve"]);
  });

  it("says a problem once until it changes", async () => {
    const t = run([
      { kind: "problem", problem: "a", recorded: [] },
      { kind: "problem", problem: "a", recorded: [] },
      { kind: "problem", problem: "b", recorded: [] },
    ]);
    for (let i = 0; i < 3; i++) await t.job.run(t.ctx);
    expect(t.errors).toHaveLength(2);
  });

  const funds = (have: bigint): SchedulerReport => ({ kind: "funds", have, needed: 13_695_320n, recorded: [] });

  it("says the keeper is short of SOL, with what it has and needs, then stays quiet while nothing changes", async () => {
    const t = run([funds(1_000n), funds(1_000n), funds(1_000n)]);
    for (let i = 0; i < 3; i++) await t.job.run(t.ctx);
    expect(t.errors).toEqual(["the keeper wallet cannot pay for a new break: top it up with SOL"]);
    expect(t.lines[0]).toBe('the keeper wallet cannot pay for a new break: top it up with SOL {"lamports":"1000","needed":"13695320"}');
  });

  it("says it again when the balance moves, and once an hour while it stays short", async () => {
    const t = run([funds(1_000n), funds(2_000n), funds(2_000n), funds(2_000n), funds(2_000n)]);
    await t.job.run(t.ctx); // first time
    await t.job.run(t.ctx); // the balance moved
    expect(t.errors).toHaveLength(2);
    t.clock.t += 3_599;
    await t.job.run(t.ctx); // not yet an hour
    expect(t.errors).toHaveLength(2);
    t.clock.t += 1;
    await t.job.run(t.ctx); // an hour since the last time
    expect(t.errors).toHaveLength(3);
    await t.job.run(t.ctx); // and the hour starts again
    expect(t.errors).toHaveLength(3);
  });

  it("says it afresh when it is short again after having been fine in between", async () => {
    const t = run([funds(1_000n), { kind: "selling", breakId: 1n, recorded: [] }, funds(1_000n)]);
    for (let i = 0; i < 3; i++) await t.job.run(t.ctx);
    expect(t.errors).toHaveLength(2);
  });

  it("reports creations, unknown results, refusals and recorded breaks, and stays quiet otherwise", async () => {
    const t = run([
      { kind: "created", breakId: 3n, signature: "sig", recorded: [] },
      { kind: "pending", breakId: 4n, recorded: [] },
      { kind: "failed", breakId: 4n, reason: "nope", recorded: [] },
      { kind: "selling", breakId: 4n, recorded: [4n] },
      { kind: "idle", reason: "paused", recorded: [] },
      { kind: "backoff", breakId: 5n, recorded: [] },
    ]);
    for (let i = 0; i < 6; i++) await t.job.run(t.ctx);
    expect(t.infos).toEqual(["break created", "break creation sent, result not known yet", "break recorded from the chain"]);
    expect(t.errors).toEqual(["break creation failed"]);
  });
});
