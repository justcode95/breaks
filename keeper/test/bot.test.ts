import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type BotLimits, XBot, botJob } from "../src/bot/bot.js";
import type { BotSettings } from "../src/bot/policy.js";
import { SqlBotStore } from "../src/bot/store.js";
import { ChainWorld } from "../src/bot/world.js";
import type { JobContext } from "../src/job.js";
import type { AccountReader } from "../src/pipeline/chain.js";
import { packMachineBytes } from "../src/scheduler/machine.js";
import type { BreakTemplate } from "../src/scheduler/policy.js";
import { ORAO_PROGRAM, type BreakAccount } from "../src/solana/breaks.js";
import { treasuryAddresses } from "../src/solana/treasury.js";
import { HOUR, ScriptedPoster, T0, brk, drawn } from "./support/bot.js";
import { addr, BUYER } from "./support/chain.js";
import { migratedDb } from "./support/db.js";
import { MockChain } from "./support/mock-chain.js";
import { KEEPER, PROGRAMS, logger } from "./support/world.js";

const TEMPLATE: BreakTemplate = {
  paidSpots: 10,
  freeSpots: 2,
  spotPrice: 20_000_000n,
  maxPackPrice: 25_000_000n,
  packMachine: packMachineBytes("pokemon-25"),
  windowSecs: 43_200n,
};
// What TEMPLATE needs unlocked: $50 of subsidy and $50 for the holders.
const NEED = 50_000_000n;
const SETTINGS: BotSettings = { milestones: [25, 50, 75], reminderHours: [3, 1], finalityMarginSecs: 120 };
const LIMITS: BotLimits = { minGapSecs: 60, maxPerDay: 20, maxAttempts: 3, retryStepSecs: 120 };

let db: PGlite;
const sql = { query: (text: string, params?: unknown[]) => db.query(text, params) as never };

beforeAll(async () => {
  db = await migratedDb();
});
beforeEach(async () => {
  await db.exec("truncate bot_posts, x_links, breaks cascade");
});

interface Rows {
  dedupe_key: string;
  status: string;
  attempts: number;
  x_post_id: string | null;
  last_error: string | null;
  body: string;
}
// The keys in the table start with the scope of the bot that made them; the tests read them without it.
const SCOPE = "scope1";
const rows = async (scope = SCOPE) =>
  (await db.query<Rows>("select dedupe_key, status, attempts, x_post_id, last_error, body from bot_posts where starts_with(dedupe_key, $1) order by id", [`${scope}:`])).rows.map((r) => ({
    ...r,
    dedupe_key: r.dedupe_key.slice(scope.length + 1),
  }));
const statuses = async () => Object.fromEntries((await rows()).map((r) => [r.dedupe_key, r.status]));

function setup(over: { limits?: Partial<BotLimits>; settings?: Partial<BotSettings>; funds?: [bigint, bigint]; breaks?: BreakAccount[]; nextBreakId?: bigint; paused?: boolean; template?: Partial<BreakTemplate> } = {}) {
  const chain = new MockChain(PROGRAMS, {
    admin: addr(2),
    keeper: KEEPER,
    buyer: BUYER,
    usdcMint: addr(5),
    randomnessProgram: ORAO_PROGRAM,
    randomnessTimeoutSecs: 3_600n,
    nextBreakId: over.nextBreakId ?? 5n,
    minWindowSecs: 21_600n,
    maxWindowSecs: 86_400n,
    maxPaidSpots: 20,
    maxFreeSpots: 6,
    paused: over.paused ?? false,
    bump: 255,
  });
  const funds = over.funds ?? [0n, 0n];
  chain.treasury.subsidyVault = funds[0];
  chain.treasury.holderVault = funds[1];
  for (const b of over.breaks ?? []) chain.breaks.set(b.id, b);

  const clock = { t: Number(T0) };
  const store = new SqlBotStore(sql);
  const poster = new ScriptedPoster();
  const { log, errors, infos } = logger();
  const make = (reader: AccountReader = chain, scope = SCOPE) =>
    new XBot({
      scope,
      world: new ChainWorld({ chain: reader, programs: PROGRAMS, template: { ...TEMPLATE, ...over.template }, store, lookback: 5 }),
      store,
      poster,
      settings: { ...SETTINGS, ...over.settings },
      limits: { ...LIMITS, ...over.limits },
      log,
      now: () => new Date(clock.t * 1000),
    });
  return {
    chain,
    store,
    poster,
    bot: make(),
    make,
    errors,
    infos,
    /** Moves the clock to `secs` after T0. */
    at: (secs: number | bigint) => {
      clock.t = Number(T0) + Number(secs);
    },
    /** Moves the clock `secs` further. */
    later: (secs: number) => {
      clock.t += secs;
    },
  };
}

describe("what the bot posts, and when", () => {
  it("saves what is worth saying and sends one post per run, oldest first, with a gap between", async () => {
    const t = setup({ funds: [15_000_000n, 15_000_000n], breaks: [brk()] }); // 30% funded, a sale is live

    const first = await t.bot.run();
    expect(first.queued).toEqual(["reserve:5:25", "open:4"]);
    expect(first.sent).toMatchObject({ dedupeKey: "reserve:5:25", outcome: "posted", detail: "x-1" });
    expect(t.poster.sent).toEqual(["Break #6 is 25% funded 🔥 Unlocks at $100."]);

    // The minimum gap since the last post has not passed: nothing goes out.
    t.later(30);
    const waiting = await t.bot.run();
    expect(waiting.queued).toEqual([]);
    expect(waiting).toMatchObject({ waiting: "the minimum gap since the last post" });
    expect(t.poster.sent).toHaveLength(1);

    t.later(31);
    expect((await t.bot.run()).sent).toMatchObject({ dedupeKey: "open:4", outcome: "posted", detail: "x-2" });
    expect(t.poster.sent[1]).toBe("Break #5 is LIVE — 10 paid spots @ $20 + 2 FREE holder spots. Packs: pokemon-25. Closes Jan 15, 20:00 UTC.");

    // Nothing more to say, and nothing is said twice.
    t.later(61);
    const idle = await t.bot.run();
    expect(idle).toEqual({ queued: [], expired: 0 });
    expect(await rows()).toEqual([
      expect.objectContaining({ dedupe_key: "reserve:5:25", status: "posted", x_post_id: "x-1", attempts: 0 }),
      expect.objectContaining({ dedupe_key: "open:4", status: "posted", x_post_id: "x-2", attempts: 0 }),
    ]);
  });

  it("does not say anything twice, not even after a restart", async () => {
    const t = setup({ breaks: [brk()] });
    await t.bot.run();
    expect(t.poster.sent).toHaveLength(1);

    t.later(3_600);
    const restarted = t.make();
    const r = await restarted.run();
    expect(r).toEqual({ queued: [], expired: 0 });
    expect(t.poster.sent).toHaveLength(1);
    expect(await db.query("select count(*)::int as n from bot_posts")).toMatchObject({ rows: [{ n: 1 }] });
  });

  it("keeps each deployment apart: a fresh program announces its own breaks, and another deployment's saved posts are never sent", async () => {
    const t = setup({ breaks: [brk()] });
    t.poster.answer({ outcome: "retry", reason: "503" });
    await t.bot.run(); // saved for the first deployment, not sent
    expect(await rows()).toEqual([expect.objectContaining({ dedupe_key: "open:4", status: "queued", attempts: 1 })]);

    // Devnet was reset: the same break ids on a new program. Its bot has its own `open:4`.
    t.later(61);
    const fresh = await t.make(t.chain, "scope2").run();
    expect(fresh.queued).toEqual(["open:4"]);
    expect(fresh.sent).toMatchObject({ dedupeKey: "open:4", outcome: "posted" });
    expect(await rows("scope2")).toEqual([expect.objectContaining({ dedupe_key: "open:4", status: "posted" })]);
    // The first one's saved post is left alone, not sent by the other bot.
    expect(await rows()).toEqual([expect.objectContaining({ status: "queued", attempts: 1 })]);
    expect(t.poster.sent).toHaveLength(2);
  });

  it("does not let a milestone announced by another deployment silence this one's", async () => {
    const t = setup({ funds: [(NEED * 80n) / 100n, (NEED * 80n) / 100n] });
    expect((await t.bot.run()).queued).toEqual(["reserve:5:75"]);
    t.chain.treasury.subsidyVault = (NEED * 60n) / 100n;
    t.chain.treasury.holderVault = (NEED * 60n) / 100n;
    t.later(61);
    // Same break id, but a fresh program: its reserve is at 60%, and 50 is news there.
    expect((await t.make(t.chain, "scope2").run()).queued).toEqual(["reserve:5:50"]);
  });

  it("announces the milestones as the reserve fills, the highest reached, and nothing once the break can be created", async () => {
    const t = setup({ limits: { minGapSecs: 0 } });
    const fund = (pct: bigint) => {
      t.chain.treasury.subsidyVault = (NEED * pct) / 100n;
      t.chain.treasury.holderVault = (NEED * pct) / 100n;
    };
    fund(10n);
    expect((await t.bot.run()).queued).toEqual([]);
    fund(60n); // jumped over 25: only the 50 is news
    await t.bot.run();
    fund(80n);
    await t.bot.run();
    fund(100n); // enough: the break itself will be announced once it exists
    expect((await t.bot.run()).queued).toEqual([]);
    expect(t.poster.sent).toEqual(["Break #6 is 50% funded 🔥 Unlocks at $100.", "Break #6 is 75% funded 🔥 Unlocks at $100."]);
  });

  it("names the winners with the handles of those who agreed to be tagged, and nobody else", async () => {
    // Both winners have a handle on file; only alice agreed to be tagged.
    await db.query("insert into x_links (wallet, x_handle, signature, may_tag) values ($1, 'alice', 's', true), ($2, 'bob', 's', false)", [addr(21), addr(22)]);
    const t = setup({ breaks: [drawn()], nextBreakId: 5n });
    t.at(14n * HOUR);
    await t.bot.run();
    expect(t.poster.sent).toEqual([`Free holder spots in Break #5 go to @alice, ${addr(22).slice(0, 4)}…${addr(22).slice(-4)} 🎉`]);
  });

  it("never puts a handle that is not a plain X handle into a post, even one the site stored", async () => {
    await db.query("insert into x_links (wallet, x_handle, signature, may_tag) values ($1, 'evil http://x.co', 's', true), ($2, 'ok_name', 's', true)", [addr(21), addr(22)]);
    const t = setup({ breaks: [drawn()], nextBreakId: 5n });
    t.at(14n * HOUR);
    await t.bot.run();
    expect(t.poster.sent).toEqual([`Free holder spots in Break #5 go to ${addr(21).slice(0, 4)}…${addr(21).slice(-4)}, @ok_name 🎉`]);
  });

  it("posts the results of a delivered break once its last delivery has had time to settle", async () => {
    const b = (await db.query<{ id: string }>(
      `insert into breaks (onchain_id, status, paid_spots, free_spots, spot_price, pack_machine, max_pack_price, opens_at, closes_at)
       values (4, 'delivered', 3, 2, 20000000, 'pokemon-25', 25000000, now(), now() + interval '6 hours') returning id::text as id`,
    )).rows[0]!.id;
    const walletOf = [addr(31), addr(32), addr(31)];
    for (const [i, wallet] of walletOf.entries()) {
      const spot = (await db.query<{ id: string }>("insert into spots (break_id, kind, idx, wallet, paid) values ($1, 'paid', $2, $3, 20000000) returning id::text as id", [b, i, wallet])).rows[0]!.id;
      await db.query(
        "insert into deliveries (break_id, spot_id, card_mint, status, tx_sig, updated_at) values ($1, $2, $3, 'confirmed', $4, $5)",
        [b, spot, addr(40 + i), `sig${i}`, new Date((Number(T0) + 20 * 3600 + i * 60) * 1000).toISOString()],
      );
    }
    // A delivery that is not confirmed does not count.
    const pending = (await db.query<{ id: string }>("insert into spots (break_id, kind, idx, wallet, paid) values ($1, 'paid', 9, $2, 20000000) returning id::text as id", [b, addr(33)])).rows[0]!.id;
    await db.query("insert into deliveries (break_id, spot_id, card_mint, status, tx_sig, expiry) values ($1, $2, $3, 'submitted', 'sigp', '99')", [b, pending, addr(49)]);

    const t = setup({ breaks: [drawn()], settings: { siteUrl: "https://example.org" } });
    // The last confirmed delivery was at 20h02m and the margin is 2 minutes. The winners post is due earlier; it goes first.
    t.at(20n * HOUR + 239n);
    expect((await t.bot.run()).queued).toEqual(["winners:4"]);
    t.later(61);
    expect(await t.bot.run()).toMatchObject({ queued: ["results:4"], sent: { dedupeKey: "results:4", outcome: "posted" } });
    expect(t.poster.sent.at(-1)).toBe("Break #5 results are in: 3 cards sent to 2 wallets. Full results + proof: https://example.org/breaks/5");
  });

  it("drops a post that went stale while it waited, and never sends it", async () => {
    const t = setup({ breaks: [brk()], limits: { minGapSecs: 0 } });
    t.poster.answer({ outcome: "retry", reason: "rate limited by X (429)" });
    t.at(10n * HOUR);
    const r = await t.bot.run(); // the open post cannot be sent
    expect(r.sent).toMatchObject({ outcome: "retry" });

    t.at(12n * HOUR + 5n); // the sale is over
    const later = await t.bot.run();
    expect(later.expired).toBe(2); // the open post and the reminder saved with it
    expect(later.sent).toBeUndefined();
    expect(await statuses()).toEqual({ "open:4": "expired", "reminder:4:3": "expired" });
    expect(t.poster.sent).toHaveLength(1);
  });

  it("does not post more than the daily limit, and goes on the next day", async () => {
    const t = setup({ breaks: [drawn()], limits: { maxPerDay: 1, minGapSecs: 0 } });
    // Winners and the results of one break are both ready; only one fits in a day.
    const b = (await db.query<{ id: string }>(
      `insert into breaks (onchain_id, status, paid_spots, free_spots, spot_price, pack_machine, max_pack_price, opens_at, closes_at)
       values (4, 'delivered', 1, 0, 20000000, 'pokemon-25', 25000000, now(), now() + interval '6 hours') returning id::text as id`,
    )).rows[0]!.id;
    const spot = (await db.query<{ id: string }>("insert into spots (break_id, kind, idx, wallet, paid) values ($1, 'paid', 0, $2, 20000000) returning id::text as id", [b, addr(31)])).rows[0]!.id;
    await db.query("insert into deliveries (break_id, spot_id, card_mint, status, tx_sig, updated_at) values ($1, $2, $3, 'confirmed', 'sig', $4)", [
      b,
      spot,
      addr(40),
      new Date((Number(T0) + 14 * 3600) * 1000).toISOString(),
    ]);

    t.at(15n * HOUR);
    expect((await t.bot.run()).sent).toMatchObject({ dedupeKey: "winners:4", outcome: "posted" });
    t.later(3_600);
    expect(await t.bot.run()).toMatchObject({ waiting: "the daily limit of posts" });
    t.later(23 * 3600 - 60); // 24 hours after the first post, to the second
    expect(await t.bot.run()).toMatchObject({ waiting: "the daily limit of posts" });
    t.later(61);
    expect((await t.bot.run()).sent).toMatchObject({ dedupeKey: "results:4", outcome: "posted" });
    expect(t.poster.sent).toHaveLength(2);
  });
});

describe("a send that does not end well", () => {
  const draftsOf = async (t: ReturnType<typeof setup>) => {
    t.at(0);
    const r = await t.bot.run();
    return r;
  };

  it("takes 'duplicate' to mean an earlier send did land, and does not send it again", async () => {
    const t = setup({ breaks: [brk()] });
    t.poster.answer({ outcome: "duplicate" });
    expect((await draftsOf(t)).sent).toMatchObject({ outcome: "duplicate" });
    expect(await rows()).toEqual([expect.objectContaining({ status: "posted", x_post_id: null, last_error: expect.stringMatching(/duplicate/) })]);
    t.later(600);
    expect((await t.bot.run()).sent).toBeUndefined();
    expect(t.poster.sent).toHaveLength(1);
  });

  it("gives up on text X refuses for good, and goes on to the next post", async () => {
    const t = setup({ breaks: [brk()], settings: { milestones: [] }, limits: { minGapSecs: 0 }, funds: [0n, 0n] });
    t.at(9n * HOUR + 1800n); // the sale is live and a reminder is due too
    t.poster.answer({ outcome: "rejected", reason: "X refused the post (400): too long" });
    expect((await t.bot.run()).sent).toMatchObject({ dedupeKey: "open:4", outcome: "rejected" });
    expect((await t.bot.run()).sent).toMatchObject({ dedupeKey: "reminder:4:3", outcome: "posted" });
    expect(await statuses()).toEqual({ "open:4": "failed", "reminder:4:3": "posted" });
    expect((await rows())[0]).toMatchObject({ last_error: "X refused the post (400): too long" });
  });

  it("repeats a send without a verdict after a wait that grows, with exactly the same words, and gives up after the limit", async () => {
    const t = setup({ breaks: [brk()], limits: { minGapSecs: 0, maxAttempts: 3, retryStepSecs: 120 } });
    t.at(9n * HOUR + 1800n);
    // The open post (saved first) gets no verdict three times; the reminder is sent in between, while it waits.
    t.poster.answer(
      { outcome: "retry", reason: "no answer from X: timeout" },
      { outcome: "posted", id: "r" },
      { outcome: "retry", reason: "X answered 503" },
      { outcome: "retry", reason: "X answered 503" },
    );
    const a = await t.bot.run();
    expect(a.sent).toMatchObject({ dedupeKey: "open:4", outcome: "retry" });
    // Not before 1 x 120 s.
    t.later(119);
    expect((await t.bot.run()).sent).toMatchObject({ dedupeKey: "reminder:4:3" }); // the next one is not held up
    t.later(2);
    expect((await t.bot.run()).sent).toMatchObject({ dedupeKey: "open:4", outcome: "retry" }); // second send, same text
    // Second wait is 2 x 120 s.
    t.later(239);
    expect((await t.bot.run()).sent).toBeUndefined();
    t.later(2);
    expect((await t.bot.run()).sent).toMatchObject({ dedupeKey: "open:4", outcome: "gave-up" });

    const open = (await rows()).find((r) => r.dedupe_key === "open:4")!;
    expect(open).toMatchObject({ status: "failed", attempts: 3 });
    expect(open.last_error).toMatch(/given up after 3 sends/);
    // Every send of that post had the very same text.
    const sends = t.poster.sent.filter((s) => s.includes("is LIVE"));
    expect(sends).toHaveLength(3);
    expect(new Set(sends).size).toBe(1);
  });

  it("keeps the saved words even when the world has moved on by the time a send is repeated", async () => {
    const t = setup({ breaks: [brk()], limits: { minGapSecs: 0, retryStepSecs: 60 } });
    t.at(9n * HOUR + 1800n);
    t.poster.answer({ outcome: "posted", id: "1" }, { outcome: "retry", reason: "503" }); // the open post, then the reminder fails
    await t.bot.run();
    await t.bot.run();
    const original = t.poster.sent[1]!;
    expect(original).toBe("7 spots left in Break #5. Closes in 3h.");

    // Spots sell out and the clock moves: a fresh reminder would read differently.
    t.chain.breaks.set(4n, brk({ spotsSold: 8 }));
    t.later(3_000);
    await t.bot.run();
    expect(t.poster.sent[2]).toBe(original);
  });

  it("treats a poster that throws like a send without a verdict", async () => {
    const t = setup({ breaks: [brk()] });
    t.poster.throws = new Error("socket closed");
    const r = await draftsOf(t);
    expect(r.sent).toMatchObject({ outcome: "retry", detail: "the poster failed: socket closed" });
    expect(await rows()).toEqual([expect.objectContaining({ status: "queued", attempts: 1 })]);
    // It is still there to be sent when the poster works again.
    t.poster.throws = undefined;
    t.later(121);
    expect((await t.bot.run()).sent).toMatchObject({ outcome: "posted" });
  });

  it("sends the saved post after a crash between the send and the note that it was sent: the same words again", async () => {
    const t = setup({ breaks: [brk()] });
    // The poster got the text out and then the process died before `markPosted`: simulate by a store that fails once.
    const original = t.store.markPosted.bind(t.store);
    let failed = false;
    t.store.markPosted = async (...args) => {
      if (!failed) {
        failed = true;
        throw new Error("the keeper died here");
      }
      return original(...args);
    };
    t.at(0);
    await expect(t.bot.run()).rejects.toThrow(/died/);
    expect(t.poster.sent).toHaveLength(1);
    expect(await statuses()).toEqual({ "open:4": "queued" });

    // After the restart the very same text goes out again; X refuses a duplicate, which marks it posted.
    t.poster.answer({ outcome: "duplicate" });
    t.later(61);
    await t.make().run();
    expect(t.poster.sent).toHaveLength(2);
    expect(t.poster.sent[1]).toBe(t.poster.sent[0]);
    expect(await statuses()).toEqual({ "open:4": "posted" });
  });
});

describe("what the bot looks at", () => {
  it("says nothing before the breaks program exists", async () => {
    const t = setup();
    expect(await t.make({ getAccountData: async () => undefined }).run()).toEqual({ queued: [], expired: 0 });
  });

  it("looks at the latest breaks only", async () => {
    const t = setup({ nextBreakId: 12n, breaks: [3, 4, 5, 6, 7, 8, 9, 10, 11].map((i) => brk({ id: BigInt(i) })) });
    const r = await t.bot.run();
    // Five breaks are looked at: 7 to 11. All are open sales.
    expect(r.queued).toEqual(["open:7", "open:8", "open:9", "open:10", "open:11"]);
  });

  it("says nothing about the reserve while the program is paused or would refuse the configured break", async () => {
    const funded: [bigint, bigint] = [NEED, NEED / 2n];
    expect((await setup({ funds: funded, paused: true }).bot.run()).queued).toEqual([]);
    expect((await setup({ funds: funded }).bot.run()).queued).toEqual(["reserve:5:50"]);
    // 19 paid spots is within what the program allows (20) and 21 is not: it would not create that break, so there is
    // no progress to report, though the same funds are 57% of its worst case.
    const part: [bigint, bigint] = [60_000_000n, 50_000_000n];
    await db.exec("truncate bot_posts cascade");
    expect((await setup({ funds: part, template: { paidSpots: 19 } }).bot.run()).queued).toEqual(["reserve:5:50"]);
    await db.exec("truncate bot_posts cascade");
    expect((await setup({ funds: part, template: { paidSpots: 21 } }).bot.run()).queued).toEqual([]);
  });

  it("decides from the view it is given: a break that is not final yet is not announced", async () => {
    const confirmed = setup({ breaks: [brk()] }); // the break exists as far as the confirmed view knows
    const finalized = setup({ breaks: [] }); // and not yet as far as the finalized view knows
    const bot = confirmed.make(finalized.chain);
    expect((await bot.run()).queued).toEqual([]);
    expect(confirmed.poster.sent).toEqual([]);

    finalized.chain.breaks.set(4n, brk());
    expect((await bot.run()).queued).toEqual(["open:4"]);
  });

  it("has no reserve to report while the treasury does not exist, but an unreachable node is an error", async () => {
    const t = setup({ funds: [NEED / 2n, NEED / 2n] });
    const vault = treasuryAddresses(PROGRAMS.treasury).subsidyVault;
    const readerWith = (onVault: () => undefined): AccountReader => ({
      async getAccountData(address) {
        if (address === vault) return onVault();
        return t.chain.getAccountData(address);
      },
    });
    // A vault that is not there (the treasury is not set up yet): nothing to say, and nothing wrong.
    expect(await t.make(readerWith(() => undefined)).run()).toEqual({ queued: [], expired: 0 });
    // A node that fails is not "no reserve": the run fails and is repeated.
    await expect(
      t.make(
        readerWith(() => {
          throw new Error("node unreachable");
        }),
      ).run(),
    ).rejects.toThrow(/node unreachable/);
    expect(await rows()).toEqual([]);
    // With the treasury readable, the same reserve is news.
    expect((await t.bot.run()).queued).toEqual(["reserve:5:50"]);
  });

  it("repeats the run when the node fails, rather than assuming there is nothing to say", async () => {
    const t = setup({ breaks: [brk()] });
    const bot = t.make({
      async getAccountData() {
        throw new Error("node unreachable");
      },
    });
    await expect(bot.run()).rejects.toThrow(/node unreachable/);
    expect(await rows()).toEqual([]);
  });
});

describe("the job", () => {
  it("says what it saved and sent, a wait once, and a failure as an error", async () => {
    const t = setup({ breaks: [brk()], limits: { minGapSecs: 100 } });
    const job = botJob({ bot: t.bot, intervalMs: 60_000 });
    const seen: [string, string, Record<string, unknown> | undefined][] = [];
    const ctx: JobContext = {
      now: () => new Date(Number(T0) * 1000),
      log: { info: (m, e) => seen.push(["info", m, e]), error: (m, e) => seen.push(["error", m, e]) },
    };

    await job.run(ctx);
    expect(seen).toEqual([
      ["info", "X post saved", { key: "open:4" }],
      ["info", "X post posted", { key: "open:4", detail: "x-1" }],
    ]);

    seen.length = 0;
    t.chain.breaks.set(5n, brk({ id: 5n }));
    t.chain.config.nextBreakId = 6n;
    t.later(10);
    await job.run(ctx);
    await job.run(ctx); // the same wait is not said twice
    expect(seen).toEqual([
      ["info", "X post saved", { key: "open:5" }],
      ["info", "an X post is waiting for", { limit: "the minimum gap since the last post" }],
    ]);

    seen.length = 0;
    t.later(200);
    t.poster.answer({ outcome: "rejected", reason: "X refused the post (400): no" });
    await job.run(ctx);
    expect(seen).toEqual([["error", "X post rejected", { key: "open:5", detail: "X refused the post (400): no" }]]);
    expect(job.name).toBe("x-bot");
    expect(job.intervalMs).toBe(60_000);
  });
});
