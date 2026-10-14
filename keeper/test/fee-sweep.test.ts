import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Job, JobContext } from "../src/job.js";
import { associatedTokenAddress } from "../src/solana/pubkey.js";
import type { SweepPolicy } from "../src/sweep/policy.js";
import { SqlSweepStore } from "../src/sweep/store.js";
import { FeeSweeper, type SweepReport, feeSweepJob } from "../src/sweep/sweeper.js";
import { ORAO_PROGRAM } from "../src/solana/breaks.js";
import { addr, BUYER } from "./support/chain.js";
import { migratedDb } from "./support/db.js";
import { MockChain } from "./support/mock-chain.js";
import { MockSwapper } from "./support/mock-swapper.js";
import { KEEPER, PROGRAMS, logger } from "./support/world.js";

const SOL = 1_000_000_000n;
const USDC = addr(5);
const T0 = 1_800_000_000;
const POLICY: SweepPolicy = { keepLamports: SOL, minLamports: SOL / 10n, maxLamports: 10n * SOL, slippageBps: 50, minDeposit: 1_000_000n };

let db: PGlite;
beforeAll(async () => {
  db = await migratedDb();
});
beforeEach(async () => {
  await db.exec("truncate fee_swaps, treasury_events");
});

function setup(over: { swapper?: boolean; policy?: Partial<SweepPolicy>; usdc?: bigint; sol?: bigint; noAta?: boolean; retryAfterMs?: number } = {}) {
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
  });
  const clock = { t: T0 };
  if (!over.noAta) chain.giveUsdc(KEEPER, over.usdc ?? 0n);
  chain.solBalances.set(KEEPER, over.sol ?? 0n);
  const swapper = over.swapper === false ? undefined : new MockSwapper(chain, KEEPER);
  const store = new SqlSweepStore({ query: (text, params) => db.query(text, params) as never });
  const make = () =>
    new FeeSweeper({
      chain,
      treasuryProgram: PROGRAMS.treasury,
      wallet: KEEPER,
      wallets: chain,
      store,
      policy: { ...POLICY, ...over.policy },
      ...(swapper ? { swapper } : {}),
      now: () => new Date(clock.t * 1000),
      ...(over.retryAfterMs !== undefined ? { retryAfterMs: over.retryAfterMs } : {}),
    });
  const sweeper = make();
  const ata = associatedTokenAddress(KEEPER, USDC);
  return { chain, clock, swapper, store, sweeper, make, ata, usdcOf: () => chain.usdc.get(ata)?.amount ?? 0n };
}

const events = async () =>
  (await db.query<{ kind: string; asset: string; amount: string; tx_sig: string; note: string | null }>("select kind, asset, amount::text, tx_sig, note from treasury_events order by id")).rows;
const swaps = async () =>
  (await db.query<{ status: string; lamports_in: string; min_usdc_out: string; signature: string }>("select status, lamports_in::text, min_usdc_out::text, signature from fee_swaps order by id")).rows;

describe("FeeSweeper: depositing USDC", () => {
  it("deposits everything in the wallet's USDC account, split by the treasury's rule, and records it", async () => {
    const s = setup({ swapper: false, usdc: 1_000_001n });
    const r = await s.sweeper.run();
    expect(r.deposit).toMatchObject({ kind: "deposited", amount: 1_000_001n, signature: "mock-tx-1" });
    expect(s.chain.applied).toEqual(["deposit_fees"]);
    expect(s.usdcOf()).toBe(0n);
    // 70%: floor(1_000_001 * 7000 / 10000) = 700_000 to subsidy; the remainder, 300_001, to the holders. Nothing is lost.
    expect(s.chain.treasury.subsidyVault).toBe(700_000n);
    expect(s.chain.treasury.holderVault).toBe(300_001n);
    expect(await events()).toEqual([{ kind: "deposit", asset: "USDC", amount: "1000001", tx_sig: "mock-tx-1", note: null }]);
  });

  it("does nothing with no USDC, with less than the minimum, or when the swap is off", async () => {
    for (const usdc of [0n, 999_999n]) {
      const s = setup({ swapper: false, usdc });
      const r = await s.sweeper.run();
      expect(r.deposit.kind).toBe("none");
      expect(r.swap.kind).toBe("off");
      expect(s.chain.sendCalls).toBe(0);
    }
    const exact = setup({ swapper: false, usdc: 1_000_000n });
    expect((await exact.sweeper.run()).deposit.kind).toBe("deposited");
  });

  it("says what is missing instead of guessing: no treasury, no USDC account", async () => {
    const noAta = setup({ swapper: false, noAta: true });
    const r = await noAta.sweeper.run();
    expect(r.deposit).toMatchObject({ kind: "problem", problem: expect.stringContaining("has no USDC account") });
    expect(noAta.chain.sendCalls).toBe(0);

    const s = setup({ swapper: false, usdc: 5_000_000n });
    const lost = new FeeSweeper({ chain: s.chain, treasuryProgram: addr(1), wallet: KEEPER, wallets: s.chain, store: s.store, policy: POLICY });
    expect((await lost.run()).deposit).toMatchObject({ kind: "problem", problem: "the treasury is not initialized" });
  });

  it("adds up USDC that arrives in between into the next deposit", async () => {
    const s = setup({ swapper: false, usdc: 2_000_000n });
    await s.sweeper.run();
    s.chain.giveUsdc(KEEPER, 3_000_000n);
    s.chain.giveUsdc(KEEPER, 4_000_000n);
    const r = await s.sweeper.run();
    expect(r.deposit).toMatchObject({ kind: "deposited", amount: 7_000_000n });
    expect(s.chain.treasury.subsidyVault + s.chain.treasury.holderVault).toBe(9_000_000n);
  });

  it("waits after a refusal and then tries again", async () => {
    const s = setup({ swapper: false, usdc: 5_000_000n, retryAfterMs: 60_000 });
    s.chain.queueSend("fail");
    expect((await s.sweeper.run()).deposit).toMatchObject({ kind: "failed", amount: 5_000_000n });
    s.clock.t += 30;
    expect((await s.sweeper.run()).deposit.kind).toBe("backoff");
    expect(s.chain.sendCalls).toBe(1);
    s.clock.t += 31;
    expect((await s.sweeper.run()).deposit.kind).toBe("deposited");
    expect(s.chain.sendCalls).toBe(2);
  });

  it("deposits once when the deposit landed but its confirmation was lost", async () => {
    const s = setup({ swapper: false, usdc: 5_000_000n });
    s.chain.queueSend("applied-unknown");
    expect((await s.sweeper.run()).deposit.kind).toBe("pending");
    expect((await s.sweeper.run()).deposit.kind).toBe("none"); // the balance is gone: it landed
    expect(s.chain.sendCalls).toBe(1);
    expect(s.chain.treasury.subsidyVault + s.chain.treasury.holderVault).toBe(5_000_000n);
  });

  it("sends the deposit again when it never arrived, and it lands once", async () => {
    const s = setup({ swapper: false, usdc: 5_000_000n });
    s.chain.queueSend("drop");
    expect((await s.sweeper.run()).deposit.kind).toBe("pending");
    expect((await s.sweeper.run()).deposit).toMatchObject({ kind: "deposited", amount: 5_000_000n });
    expect(s.chain.treasury.subsidyVault + s.chain.treasury.holderVault).toBe(5_000_000n);
  });

  it("the program never lets two deposits spend the same USDC", async () => {
    // A late resend of an earlier deposit, with the balance already gone, is refused by the token program.
    const s = setup({ swapper: false, usdc: 5_000_000n });
    await s.sweeper.run();
    const late = await s.chain.sendAndConfirm([
      (await import("../src/solana/treasury.js")).depositFees(PROGRAMS.treasury, { depositor: KEEPER, depositorUsdc: s.ata, amount: 5_000_000n }),
    ]);
    expect(late).toMatchObject({ outcome: "failed", reason: "InsufficientFunds" });
    expect(s.chain.treasury.subsidyVault + s.chain.treasury.holderVault).toBe(5_000_000n);
  });
});

describe("FeeSweeper: swapping SOL", () => {
  it("does nothing without a swap provider and leaves the SOL alone", async () => {
    const s = setup({ swapper: false, sol: 50n * SOL });
    expect((await s.sweeper.run()).swap).toEqual({ kind: "off" });
    expect(s.chain.solBalances.get(KEEPER)).toBe(50n * SOL);
  });

  it("swaps nothing when there is not enough SOL above what the wallet keeps", async () => {
    for (const sol of [0n, SOL, SOL + SOL / 10n - 1n]) {
      const s = setup({ sol });
      const r = await s.sweeper.run();
      expect(r.swap.kind, String(sol)).toBe("none");
      expect(s.swapper!.prepared).toEqual([]);
    }
  });

  it("swaps what is above what it keeps, with the floor from the quote less the slippage", async () => {
    const s = setup({ sol: 3n * SOL + SOL / 2n });
    // 2.5 SOL at $150 = $375; less 0.5% = $373.125
    expect((await s.sweeper.run()).swap).toMatchObject({ kind: "started", lamports: 5n * SOL / 2n, minUsdcOut: 373_125_000n });
  });

  it("swaps at most the cap in one go", async () => {
    const s = setup({ sol: 50n * SOL });
    expect((await s.sweeper.run()).swap).toMatchObject({ kind: "started", lamports: 10n * SOL, minUsdcOut: 1_492_500_000n });
  });

  it("saves the swap before it is sent", async () => {
    const s = setup({ sol: 5n * SOL });
    let seenInStore: string | undefined;
    s.swapper!.onSubmit = async () => {
      seenInStore = (await s.store.inFlight())?.signature;
    };
    const r = await s.sweeper.run();
    expect(r.swap.kind).toBe("started");
    expect(seenInStore).toBe("swap-1");
    expect(await swaps()).toEqual([{ status: "submitted", lamports_in: String(4n * SOL), min_usdc_out: "597000000", signature: "swap-1" }]);
  });

  it("takes the swap through to the treasury: swap, land, deposit, and the ledger says so", async () => {
    const s = setup({ sol: 5n * SOL });
    s.swapper!.behaviors.push("hold");
    const first = await s.sweeper.run();
    expect(first.swap.kind).toBe("started");
    expect(first.deposit.kind).toBe("none"); // nothing has landed yet
    s.swapper!.release("swap-1");
    const second = await s.sweeper.run();
    expect(second.swap).toMatchObject({ kind: "landed", signature: "swap-1", lamports: 4n * SOL });
    // 4 SOL at $150 = $600, deposited in the same run that saw the swap land
    expect(second.deposit).toMatchObject({ kind: "deposited", amount: 600_000_000n });
    expect(s.chain.solBalances.get(KEEPER)).toBe(SOL);
    expect(s.chain.treasury.subsidyVault).toBe(420_000_000n);
    expect(s.chain.treasury.holderVault).toBe(180_000_000n);
    expect(await swaps()).toEqual([expect.objectContaining({ status: "landed" })]);
    expect((await events()).map((e) => [e.kind, e.asset, e.amount])).toEqual([
      ["swap", "SOL", String(4n * SOL)],
      ["deposit", "USDC", "600000000"],
    ]);
    // Nothing more to do: the SOL left is what the wallet keeps.
    expect((await s.sweeper.run()).swap.kind).toBe("none");
  });

  it("never has two swaps in flight: a swap that has not landed blocks a new one, and is sent again", async () => {
    const s = setup({ sol: 50n * SOL });
    s.swapper!.behaviors.push("drop", "drop", "drop", "drop");
    expect((await s.sweeper.run()).swap.kind).toBe("started");
    for (let i = 0; i < 3; i++) expect((await s.sweeper.run()).swap).toEqual({ kind: "waiting", signature: "swap-1" });
    expect(s.swapper!.prepared).toEqual(["swap-1"]);
    // The same signed transaction was sent again each time, and no other one was made.
    expect(s.swapper!.submitted).toEqual(["swap-1", "swap-1", "swap-1", "swap-1"]);
    expect(await swaps()).toHaveLength(1);
    // The fifth try arrives.
    expect((await s.sweeper.run()).swap).toEqual({ kind: "waiting", signature: "swap-1" });
    expect((await s.sweeper.run()).swap).toMatchObject({ kind: "landed", signature: "swap-1" });
  });

  it("lets a held swap land later, and swaps only once", async () => {
    const s = setup({ sol: 50n * SOL });
    s.swapper!.behaviors.push("hold");
    await s.sweeper.run();
    expect((await s.sweeper.run()).swap.kind).toBe("waiting");
    s.swapper!.release("swap-1");
    expect((await s.sweeper.run()).swap).toMatchObject({ kind: "landed", signature: "swap-1" });
    expect(s.swapper!.prepared).toEqual(["swap-1"]);
    expect(s.chain.solBalances.get(KEEPER)).toBe(40n * SOL);
  });

  it("starts a new swap only after the old one can never land, and waits a while after a failure", async () => {
    const s = setup({ sol: 50n * SOL, retryAfterMs: 60_000 });
    s.swapper!.behaviors.push("drop");
    await s.sweeper.run();
    s.swapper!.height += 151; // past the last block height
    expect((await s.sweeper.run()).swap).toEqual({ kind: "expired", signature: "swap-1" });
    expect((await swaps())[0]!.status).toBe("expired");

    expect((await s.sweeper.run()).swap.kind).toBe("backoff");
    s.clock.t += 61;
    const again = await s.sweeper.run();
    expect(again.swap).toMatchObject({ kind: "started", signature: "swap-2" });
    expect((await swaps()).map((x) => x.status)).toEqual(["expired", "submitted"]);
  });

  it("treats a reverted swap as a failure and waits before trying again", async () => {
    const s = setup({ sol: 50n * SOL, retryAfterMs: 60_000 });
    s.swapper!.behaviors.push("revert");
    await s.sweeper.run();
    expect((await s.sweeper.run()).swap).toEqual({ kind: "failed", signature: "swap-1" });
    expect((await s.sweeper.run()).swap.kind).toBe("backoff");
    expect(s.chain.solBalances.get(KEEPER)).toBe(50n * SOL);
    expect(await events()).toEqual([]);
  });

  it("finds a swap that was saved but not sent after a restart, and sends that same one", async () => {
    const s = setup({ sol: 50n * SOL });
    s.swapper!.onSubmit = async () => {
      throw new Error("crash");
    };
    await expect(s.sweeper.run()).rejects.toThrow("crash");
    expect((await swaps())[0]!.status).toBe("prepared");

    // A new process: nothing in memory.
    s.swapper!.onSubmit = undefined;
    const restarted = s.make();
    const r = await restarted.run();
    expect(r.swap).toEqual({ kind: "waiting", signature: "swap-1" });
    expect(s.swapper!.prepared).toEqual(["swap-1"]);
    expect((await swaps())[0]!.status).toBe("submitted");
    expect((await restarted.run()).swap.kind).toBe("landed");
  });

  it("does not send a swap when another process has one in flight", async () => {
    const s = setup({ sol: 50n * SOL });
    // The other process gets in between this one's check and its save.
    const real = s.swapper!.prepare.bind(s.swapper!);
    s.swapper!.prepare = async (req) => {
      const p = await real(req);
      await s.store.insertPrepared({ ...p, signature: "other-process", payload: "x" });
      return p;
    };
    const r = await s.sweeper.run();
    expect(r.swap).toEqual({ kind: "none", reason: "another swap is in flight" });
    expect(s.swapper!.submitted).toEqual([]);
    expect(await swaps()).toEqual([expect.objectContaining({ signature: "other-process" })]);
  });

  it("refuses a swap that is not the one asked for", async () => {
    const wrongAmount = setup({ sol: 5n * SOL });
    wrongAmount.swapper!.overrideLamports = 5n * SOL;
    expect((await wrongAmount.sweeper.run()).swap).toMatchObject({ kind: "problem", problem: expect.stringContaining("not 4000000000") });
    expect(wrongAmount.swapper!.submitted).toEqual([]);
    expect(await swaps()).toEqual([]);

    const looseFloor = setup({ sol: 5n * SOL });
    looseFloor.swapper!.overrideMin = 1n;
    expect((await looseFloor.sweeper.run()).swap).toMatchObject({ kind: "problem", problem: expect.stringContaining("below the floor") });
    expect(looseFloor.swapper!.submitted).toEqual([]);
  });

  it("does not swap when the market is under the floor price", async () => {
    const s = setup({ sol: 5n * SOL, policy: { minUsdcPerSol: 160_000_000n } }); // the pretend market pays $150
    const r = await s.sweeper.run();
    expect(r.swap).toMatchObject({ kind: "skipped", reason: expect.stringContaining("below the floor price") });
    expect(s.swapper!.prepared).toEqual([]);

    s.swapper!.price = 170_000_000n;
    expect((await s.sweeper.run()).swap.kind).toBe("started");
  });

  it("a swap that would give back less than its floor fails on-chain and nothing is swapped", async () => {
    const s = setup({ sol: 5n * SOL });
    s.swapper!.behaviors.push("hold");
    await s.sweeper.run();
    s.swapper!.price = 100_000_000n; // the market moved by a third before it landed
    s.swapper!.release("swap-1");
    expect((await s.sweeper.run()).swap).toEqual({ kind: "failed", signature: "swap-1" });
    expect(s.chain.solBalances.get(KEEPER)).toBe(5n * SOL);
  });
});

describe("SqlSweepStore", () => {
  const prepared = (signature: string) => ({ signature, expiry: "1150", payload: "p", lamportsIn: SOL, minUsdcOut: 100n });

  it("allows one swap in flight and another once it has an outcome", async () => {
    const s = setup();
    const first = await s.store.insertPrepared(prepared("a"));
    expect(first).toMatchObject({ signature: "a", status: "prepared", lamportsIn: SOL, minUsdcOut: 100n });
    expect(await s.store.insertPrepared(prepared("b"))).toBeUndefined();
    await s.store.markSubmitted(first!.id);
    expect((await s.store.inFlight())?.status).toBe("submitted");
    await s.store.resolve(first!.id, "landed");
    expect(await s.store.inFlight()).toBeUndefined();
    expect(await s.store.insertPrepared(prepared("b"))).toMatchObject({ signature: "b" });
  });

  it("does not take the same signature twice", async () => {
    const s = setup();
    const first = await s.store.insertPrepared(prepared("a"));
    await s.store.resolve(first!.id, "failed");
    expect(await s.store.insertPrepared(prepared("a"))).toBeUndefined();
  });

  it("does not change an outcome that is already final", async () => {
    const s = setup();
    const first = await s.store.insertPrepared(prepared("a"));
    await s.store.resolve(first!.id, "landed");
    await s.store.resolve(first!.id, "failed");
    expect((await swaps())[0]!.status).toBe("landed");
  });

  it("writes the same treasury event once", async () => {
    const s = setup();
    const e = { kind: "deposit" as const, asset: "USDC" as const, amount: 5n, txSig: "t1" };
    await s.store.recordEvent(e);
    await s.store.recordEvent(e);
    await s.store.recordEvent({ ...e, kind: "swap", asset: "SOL" }); // another kind of event for the same transaction
    expect(await events()).toHaveLength(2);
  });
});

describe("feeSweepJob", () => {
  function run(reports: (SweepReport | Error)[]) {
    const { errors, infos } = logger();
    const fake = { run: async () => { const r = reports.shift()!; if (r instanceof Error) throw r; return r; } } as unknown as FeeSweeper;
    const job: Job = feeSweepJob({ sweeper: fake, intervalMs: 1000 });
    const ctx: JobContext = { now: () => new Date(T0 * 1000), log: { info: (m) => infos.push(m), error: (m) => errors.push(m) } };
    return { job, ctx, errors, infos };
  }
  const quiet: SweepReport = { swap: { kind: "off" }, deposit: { kind: "none", reason: "x" } };

  it("stays quiet when nothing happens and speaks about deposits and swaps", async () => {
    const t = run([
      quiet,
      { swap: { kind: "started", lamports: 1n, minUsdcOut: 1n, signature: "s" }, deposit: { kind: "none", reason: "x" } },
      { swap: { kind: "landed", lamports: 1n, signature: "s" }, deposit: { kind: "deposited", amount: 5n, signature: "d" } },
      { swap: { kind: "waiting", signature: "s" }, deposit: { kind: "pending", amount: 5n } },
      { swap: { kind: "expired", signature: "s" }, deposit: { kind: "failed", amount: 5n, reason: "no" } },
      { swap: { kind: "skipped", reason: "low" }, deposit: { kind: "backoff" } },
    ]);
    for (let i = 0; i < 6; i++) await t.job.run(t.ctx);
    expect(t.infos).toEqual([
      "fee swap sent",
      "fee swap landed",
      "fees deposited into the treasury",
      "fee deposit sent, result not known yet",
      "fee swap skipped",
    ]);
    expect(t.errors).toEqual(["fee swap expired", "fee deposit failed"]);
  });

  it("reports a problem once until it changes or clears", async () => {
    const p = (problem: string): SweepReport => ({ swap: { kind: "problem", problem }, deposit: { kind: "problem", problem } });
    const t = run([p("a"), p("a"), quiet, p("a"), p("b")]);
    for (let i = 0; i < 5; i++) await t.job.run(t.ctx);
    expect(t.errors).toEqual(["the fee sweep cannot run", "the fee sweep cannot run", "the fee sweep cannot run"]);
  });
});
