import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { ed25519 } from "@noble/curves/ed25519.js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { type AppConfig, RANDOMNESS_REQUEST_RENT, type WatchConfig, buildJobs, buildWatchdog, watchdogDeps, checkSchema, sqlFromPool, verifyKeeperIdentity, verifyMint } from "../src/app.js";
import { buildEligibility, serializeInputs } from "../src/eligibility/eligibility.js";
import { listDocument } from "../src/eligibility/planner.js";
import { exclusionsDocument } from "../src/eligibility/exclusions.js";
import { hashv, toHex, utf8 } from "../src/draw/bytes.js";
import { assignCards } from "../src/draw/pool.js";
import { Tree } from "../src/draw/tree.js";
import { createRunner, type Job } from "../src/job.js";
import type { AlertMessage } from "../src/watch/alerter.js";
import { JobHealth } from "../src/watch/health.js";
import { ORAO_PROGRAM, breakAddress, oraoNetworkState, requestAddress } from "../src/solana/breaks.js";
import { addressFromBytes, addressToBytes, associatedTokenAddress } from "../src/solana/pubkey.js";
import { encodeBreak } from "./support/accounts.js";
import { ScriptedPoster, brk } from "./support/bot.js";
import { addr } from "./support/chain.js";
import { insertBreak, migratedDb } from "./support/db.js";
import { oneMachine } from "./support/packs.js";
import { packMachineBytes } from "../src/scheduler/machine.js";
import { MINT, TokenLedger } from "./support/token-ledger.js";
import { ANSWER, KEEPER, ORAO_TREASURY, PROGRAMS, logger, world } from "./support/world.js";

const config: AppConfig = {
  programs: PROGRAMS,
  vrf: { program: ORAO_PROGRAM },
  packProvider: "mock",
  cardTransfer: "mock",
  mockPackPrice: 25_000_000n,
  jobIntervalMs: 1000,
  eligibility: { minTwab: 1n, settleSecs: 120 },
  indexer: { mint: MINT, intervalSecs: 900, lagSecs: 120, callsPerRun: 1000, pageSize: 100, concurrency: 4 },
  sweep: { enabled: false, swapProvider: "none", policy: { keepLamports: 1_000_000_000n, minLamports: 100_000_000n, maxLamports: 10_000_000_000n, slippageBps: 50, minDeposit: 1_000_000n } },
  publish: { intervalSecs: 60 },
  bot: {
    enabled: false,
    poster: "log",
    intervalSecs: 60,
    settings: { milestones: [25, 50, 75], reminderHours: [3, 1], finalityMarginSecs: 120 },
    limits: { minGapSecs: 60, maxPerDay: 20, maxAttempts: 5, retryStepSecs: 120 },
    lookback: 5,
  },
  scheduler: {
    enabled: true,
    template: { paidSpots: 3, freeSpots: 2, spotPrice: 20_000_000n, packs: oneMachine("pokemon-25", 25_000_000n, 5), windowSecs: 21_600n },
  },
};

/** A node that has seen no transactions of the token. */
const quietNode = () => new TokenLedger(1_800_000_000);

describe("sqlFromPool", () => {
  it("passes the query and its parameters through and returns the rows", async () => {
    const calls: [string, unknown[] | undefined][] = [];
    const sql = sqlFromPool({
      query: async (text, params) => {
        calls.push([text, params]);
        return { rows: [{ n: "1" }] };
      },
    });
    expect(await sql.query("select $1", [5])).toEqual({ rows: [{ n: "1" }] });
    expect(calls).toEqual([["select $1", [5]]]);
  });
});

// One migrated database for every test that only reads from it.
let shared: PGlite;
beforeAll(async () => {
  shared = await migratedDb();
});

describe("checkSchema", () => {
  it("accepts a database with every migration", async () => {
    expect(await checkSchema(shared)).toEqual([]);
  });

  it("names what an empty database lacks", async () => {
    const problems = await checkSchema(new PGlite());
    expect(problems).toContain("table breaks is missing (migration 0001)");
    expect(problems).toContain("table packs is missing (migration 0001)");
    expect(problems).toContain("deliveries.adopted is missing (migration 0003)");
  });

  it("names the migrations an older database still needs", async () => {
    const dir = join(import.meta.dirname, "..", "..", "db", "migrations");
    const old = new PGlite();
    await old.exec(readFileSync(join(dir, readdirSync(dir).sort()[0] as string), "utf8")); // only 0001
    const problems = await checkSchema(old);
    expect(problems).toEqual([
      "packs.expiry is missing (migration 0002)",
      "pack_attempts.signature is missing (migration 0002)",
      "deliveries.adopted is missing (migration 0003)",
      "delivery_attempts.signature is missing (migration 0003)",
      "indexer_state.indexed_until is missing (migration 0005)",
      "published_documents.sha256 is missing (migration 0005)",
      "indexed_accounts.until_sig is missing (migration 0006)",
      "fee_swaps.signature is missing (migration 0007)",
      "bot_posts.valid_until is missing (migration 0008)",
      "eligibility_lists.exclusions_uri is missing (migration 0010)",
      "breaks.status does not accept 'drawn' (migration 0004)",
      "breaks.status does not accept 'refunded' (migration 0009)",
      "balance_events is not unique per owner (migration 0006)",
    ]);
  });
});

describe("checkSchema, the refunded status", () => {
  it("names a database that has every migration but 0009, since the refund job could not finish a break there", async () => {
    const dir = join(import.meta.dirname, "..", "..", "db", "migrations");
    const files = readdirSync(dir).sort();
    const db = new PGlite();
    for (const f of files.filter((f) => !f.startsWith("0009_"))) await db.exec(readFileSync(join(dir, f), "utf8"));
    expect(await checkSchema(db)).toEqual(["breaks.status does not accept 'refunded' (migration 0009)"]);
  });
});

describe("checkSchema, the exclusion snapshots", () => {
  it("names a database that has every migration but 0010, since the planner could not store the exclusion list it used", async () => {
    const dir = join(import.meta.dirname, "..", "..", "db", "migrations");
    const files = readdirSync(dir).sort();
    expect(files.at(-1)).toMatch(/^0010_/);
    const db = new PGlite();
    for (const f of files.slice(0, -1)) await db.exec(readFileSync(join(dir, f), "utf8"));
    expect(await checkSchema(db)).toEqual(["eligibility_lists.exclusions_uri is missing (migration 0010)"]);
  });
});

describe("verifyKeeperIdentity", () => {
  it("is true when the key is the program's keeper", async () => {
    const w = world();
    expect(await verifyKeeperIdentity(w.chain, { programs: PROGRAMS }, KEEPER)).toBe(true);
  });

  it("refuses a key the program does not expect", async () => {
    const w = world();
    await expect(verifyKeeperIdentity(w.chain, { programs: PROGRAMS }, addr(99))).rejects.toThrow(/expects .* as its keeper/);
  });

  it("is false, not an error, when the program is not initialized yet", async () => {
    const w = world();
    const other = { programs: { breaks: addr(1), treasury: addr(2) } };
    expect(await verifyKeeperIdentity(w.chain, other, KEEPER)).toBe(false);
  });
});

describe("verifyMint", () => {
  it("accepts a classic mint and a Token-2022 mint", async () => {
    const w = world();
    await verifyMint(w.chain, MINT);
    const extended = new Uint8Array(200);
    extended[45] = 1;
    extended[165] = 1;
    w.chain.accounts.set(addr(0xc1), extended);
    await verifyMint(w.chain, addr(0xc1));
  });

  it("refuses an address that does not exist, so a typo cannot make every list empty", async () => {
    const w = world();
    await expect(verifyMint(w.chain, addr(0xc2))).rejects.toThrow(/does not exist on this cluster/);
  });

  it("refuses an account that is not a mint", async () => {
    const w = world();
    w.chain.accounts.set(addr(0xc3), new Uint8Array(165).fill(1)); // a token account is 165 bytes
    w.chain.accounts.set(addr(0xc4), new Uint8Array(82)); // not initialized
    const extendedAccount = new Uint8Array(200);
    extendedAccount[45] = 1;
    extendedAccount[165] = 2; // account type 2 = token account
    w.chain.accounts.set(addr(0xc5), extendedAccount);
    for (const a of [addr(0xc3), addr(0xc4), addr(0xc5)]) await expect(verifyMint(w.chain, a)).rejects.toThrow(/not an initialized token mint/);
  });

  it("is checked before any job is built", async () => {
    const w = world();
    await expect(buildJobs({ ...config, indexer: { ...config.indexer, mint: addr(0xc2) } }, { sql: shared, chain: w.chain, reader: quietNode(), wallets: w.chain, keeper: KEEPER, log: logger().log })).rejects.toThrow(/TOKEN_MINT/);
  });
});

describe("the report on ORAO at startup", () => {
  it("says what ORAO charges and where it goes", async () => {
    const w = world();
    const { log, infos, errors } = logger();
    const seen: unknown[] = [];
    await buildJobs(config, { sql: shared, chain: w.chain, reader: quietNode(), wallets: w.chain, keeper: KEEPER, log: { info: (m, e) => (infos.push(m), m === "ORAO VRF" && seen.push(e)), error: log.error } });
    expect(seen).toEqual([{ program: ORAO_PROGRAM, requestFee: "1500000", treasury: ORAO_TREASURY, oracles: 2, tokenFeeConfigured: false }]);
    expect(errors).toEqual([]);
  });

  it("warns when the keeper cannot pay for a request: ORAO's fee plus the rent of the request account", async () => {
    for (const [lamports, warned] of [[RANDOMNESS_REQUEST_RENT + 1_500_000n - 1n, true], [RANDOMNESS_REQUEST_RENT + 1_500_000n, false]] as const) {
      const w = world();
      w.chain.solBalances.set(KEEPER, lamports);
      const logs: [string, Record<string, unknown> | undefined][] = [];
      await buildJobs(config, { sql: shared, chain: w.chain, reader: quietNode(), wallets: w.chain, keeper: KEEPER, log: { info() {}, error: (m, e) => logs.push([m, e]) } });
      expect(logs.length === 1, String(lamports)).toBe(warned);
      if (warned) expect(logs[0]).toEqual(["the keeper wallet cannot pay for a randomness request: top it up with SOL", { keeper: KEEPER, lamports: String(lamports), needed: String(RANDOMNESS_REQUEST_RENT + 1_500_000n) }]);
    }
  });

  it("reports a network state it cannot read without refusing to start", async () => {
    const w = world();
    w.chain.accounts.delete(oraoNetworkState(ORAO_PROGRAM));
    const { log, errors } = logger();
    const jobs = await buildJobs(config, { sql: shared, chain: w.chain, reader: quietNode(), wallets: w.chain, keeper: KEEPER, log });
    expect(jobs.length).toBeGreaterThan(0);
    expect(errors).toEqual(["cannot read ORAO's network state; randomness requests will wait until it can be read"]);
  });
});

describe("buildJobs", () => {
  it("refuses a database that is not ready, before any job exists", async () => {
    const w = world();
    await expect(buildJobs(config, { sql: new PGlite(), chain: w.chain, reader: quietNode(), wallets: w.chain, keeper: KEEPER, log: logger().log })).rejects.toThrow(/the database is not ready: table breaks is missing/);
  });

  it("refuses the wrong key", async () => {
    const w = world();
    await expect(buildJobs(config, { sql: shared, chain: w.chain, reader: quietNode(), wallets: w.chain, keeper: addr(99), log: logger().log })).rejects.toThrow(/expects/);
  });

  it("still builds the jobs when the program is not initialized yet, and says so", async () => {
    const w = world();
    const { log, errors } = logger();
    const jobs = await buildJobs({ ...config, programs: { breaks: addr(1), treasury: addr(2) } }, { sql: shared, chain: w.chain, reader: quietNode(), wallets: w.chain, keeper: KEEPER, log });
    expect(jobs.map((j) => j.name)).toEqual(["indexer", "scheduler", "pipeline", "pack-buyer", "delivery", "refunds"]);
    expect(errors).toEqual(["the breaks program is not initialized on this cluster; breaks will be reported as problems until it is"]);
  });

  it("says that the providers are mocks", async () => {
    const w = world();
    const { log, infos } = logger();
    await buildJobs(config, { sql: shared, chain: w.chain, reader: quietNode(), wallets: w.chain, keeper: KEEPER, log });
    expect(infos).toContain("MOCK pack provider and MOCK card transfer: no real packs are bought and no real cards move");
  });
});

describe("the jobs, run by the real runner", () => {
  
  it("take a funded break to delivered, with every table filled in", async () => {
    const db = shared;
    const w = world();
    const { log, errors } = logger();

    // The database knows the break (created by the scheduler, later) and the eligibility list the pipeline will use.
    const id = await insertBreak(db);
    await db.query("update breaks set onchain_id = 7, status = 'funded' where id = $1::bigint", [id]);
    for (const leaf of w.leaves) {
      await db.query("insert into twab_snapshots (break_id, wallet, twab, weight, eligible) values ($1, $2, $3, $3, true)", [id, addressOf(leaf.wallet), leaf.weight]);
    }

    const jobs = await buildJobs(config, { sql: db, chain: w.chain, reader: quietNode(), wallets: w.chain, keeper: KEEPER, log, now: w.clock.now });
    let clock = 1_800_040_000_000;
    const runner = createRunner(jobs, { now: () => new Date(clock), log });
    const tick = async () => {
      await runner.tick();
      clock += 1000;
    };
    const status = async () => (await db.query<{ status: string }>("select status from breaks where id = $1::bigint", [id])).rows[0]?.status;

    // 1. The pack buyer buys the packs; the pipeline waits for them.
    await tick();
    const packs = await db.query<{ status: string }>("select status from packs where break_id = $1::bigint", [id]);
    expect(packs.rows).toHaveLength(5);
    expect(packs.rows.every((r) => r.status === "pulled")).toBe(true);

    // 2. Next tick: the pool is committed and randomness asked for.
    await tick();
    expect(w.chain.applied).toEqual(["commit_pool", "request_randomness"]);
    expect(await status()).toBe("randomness_requested");

    // 3. ORAO answers; the pipeline settles and records the free winners.
    w.chain.fulfill(requestAddress(ORAO_PROGRAM, w.chain.breaks.get(7n)!.randomnessRequestId), ANSWER);
    await tick();
    expect(await status()).toBe("drawn");

    // 4. The deliverer sends every card; the break is marked delivered.
    await tick();
    await tick();
    expect(await status()).toBe("delivered");
    expect(errors).toEqual([]);

    // Every card went to the wallet the draw assigned it.
    const b = w.chain.breaks.get(7n)!;
    const owners = [10, 11, 12].map((n) => addr(n));
    const winners = b.freeWinners.slice(0, 2).map((x) => x.wallet);
    const cards = (await db.query<{ card_mint: string }>("select card_mint from packs where break_id = $1::bigint", [id])).rows.map((r) => r.card_mint);
    const expected = assignCards(b.seed, cards.map(addressToBytes), owners, winners);
    const delivered = await db.query<{ kind: string; idx: number; recipient: string; card_mint: string; status: string; tx_sig: string | null }>(
      `select s.kind, s.idx, d.recipient, d.card_mint, d.status, d.tx_sig from deliveries d join spots s on s.id = d.spot_id
        where d.break_id = $1::bigint order by case s.kind when 'paid' then 0 else 1 end, s.idx`,
      [id],
    );
    expect(delivered.rows.map((r) => r.recipient)).toEqual([...owners, ...winners]);
    expect(delivered.rows.map((r) => addressToBytes(r.card_mint))).toEqual(expected.map((e) => e.card));
    expect(delivered.rows.every((r) => r.status === "confirmed" && r.tx_sig)).toBe(true);

    // The spots copied from the chain are there for the website to read.
    const spots = await db.query<{ kind: string; idx: number; wallet: string; paid: string | null }>(
      "select kind, idx, wallet, paid::text as paid from spots where break_id = $1::bigint order by case kind when 'paid' then 0 else 1 end, idx",
      [id],
    );
    expect(spots.rows.map((s) => [s.kind, s.idx, s.wallet, s.paid])).toEqual([
      ["paid", 0, addr(10), "20000000"],
      ["paid", 1, addr(11), "20000000"],
      ["paid", 2, addr(12), "20000000"],
      ["free", 0, winners[0], null],
      ["free", 1, winners[1], null],
    ]);

    // And a finished break is left alone.
    const sends = w.chain.sendCalls;
    await tick();
    await tick();
    expect(w.chain.sendCalls).toBe(sends);
  });
});

describe("the jobs, from an open break", () => {
  it("index the holders from the node, close the break, work out the eligibility list, commit it, fund, buy, draw and deliver", async () => {
    const db = shared;
    const w = world({ status: "Open", id: 8n });
    const { log, errors } = logger();
    const b0 = w.chain.breaks.get(8n)!;
    const opensAt = Number(b0.opensAt);
    const closesAt = Number(b0.closesAt);

    // Six real holders, each with a different balance held through the whole window. The indexer reads them from a node.
    await db.exec("truncate indexed_accounts, balance_events, indexer_state");
    await db.query("delete from exclusions");
    const ledger = new TokenLedger(opensAt - 1000);
    const holders = [1, 2, 3, 4, 5, 6].map((n) => ledger.holder(`holder${n}`));
    ledger.at(opensAt - 100);
    for (const [i, h] of holders.entries()) ledger.mintTo(h, BigInt((i + 1) * 1000));
    const wallets = holders.map((h) => h.wallet);

    const id = await insertBreak(db);
    await db.query("update breaks set onchain_id = 8, status = 'open' where id = $1::bigint", [id]);

    const jobs = await buildJobs({ ...config, eligibility: { minTwab: 1n, settleSecs: 120 } }, { sql: db, chain: w.chain, reader: ledger, wallets: w.chain, keeper: KEEPER, log, now: w.clock.now });
    let clock = 1_800_040_000_000;
    const runner = createRunner(jobs, { now: () => new Date(clock), log });
    const status = async () => (await db.query<{ status: string }>("select status from breaks where id = $1::bigint", [id])).rows[0]?.status;

    for (let i = 0; i < 30 && (await status()) !== "delivered"; i++) {
      await runner.tick();
      clock += 1000;
      // ORAO answers as soon as the request exists.
      const requestId = w.chain.breaks.get(8n)!.randomnessRequestId;
      if (w.chain.breaks.get(8n)!.status === "RandomnessRequested") {
        w.chain.fulfill(requestAddress(ORAO_PROGRAM, requestId), ANSWER);
      }
    }
    expect(await status()).toBe("delivered");
    expect(errors).toEqual([]);
    expect(w.chain.applied.slice(0, 3)).toEqual(["close_break", "commit_eligibility", "fund_purchases"]);

    // The list that went on-chain is the stored one, and its record is public.
    const b = w.chain.breaks.get(8n)!;
    const list = (await db.query<{ root: string; total_weight: string; entry_count: number; list_uri: string; inputs_uri: string }>(
      "select encode(root, 'hex') as root, total_weight::text as total_weight, entry_count, list_uri, inputs_uri from eligibility_lists where break_id = $1::bigint",
      [id],
    )).rows[0]!;
    expect(list.root).toBe(Buffer.from(b.eligibilityRoot).toString("hex"));
    expect(list.total_weight).toBe("21000"); // 1000 + 2000 + ... + 6000
    expect(list.entry_count).toBe(6);
    expect(b.eligibilityTotalWeight).toBe(21_000n);
    for (const uri of [list.list_uri, list.inputs_uri]) {
      const doc = await db.query("select 1 from published_documents where sha256 = $1", [uri.replace("db:sha256:", "")]);
      expect(doc.rows).toHaveLength(1);
    }

    // The two free winners are two of the six holders, and every card went out.
    const winners = b.freeWinners.slice(0, 2).map((x) => x.wallet);
    expect(winners.every((x) => wallets.includes(x))).toBe(true);
    expect(new Set(winners).size).toBe(2);
    const delivered = await db.query<{ status: string }>("select status from deliveries where break_id = $1::bigint", [id]);
    expect(delivered.rows).toHaveLength(5);
    expect(delivered.rows.every((r) => r.status === "confirmed")).toBe(true);
  });
});

describe("the jobs, from an empty chain", () => {
  it("create the break from the treasury, index the holders, close it, fund it, buy, draw and deliver", async () => {
    const db = shared;
    const w = world({ status: "Open", id: 8n });
    const { log, errors } = logger();

    // A chain with no break yet and a treasury that can pay for the worst case of one: 3 paid spots topped up by $5
    // each, 2 free spots at $25 each.
    w.chain.breaks.clear();
    w.chain.spots.clear();
    w.chain.config.nextBreakId = 0n;
    w.chain.treasury.subsidyVault = 15_000_000n;
    w.chain.treasury.holderVault = 50_000_000n;

    let clock = Number(w.chain.unixTime) * 1000;
    const startSecs = clock / 1000;
    await db.exec("truncate breaks, indexed_accounts, balance_events, indexer_state cascade");
    await db.query("delete from exclusions");
    // Six real holders, each with a different balance that they held long before the break.
    const ledger = new TokenLedger(startSecs - 5000);
    const holders = [1, 2, 3, 4, 5, 6].map((n) => ledger.holder(`holder${n}`));
    ledger.at(startSecs - 4000);
    for (const [i, h] of holders.entries()) ledger.mintTo(h, BigInt((i + 1) * 1000));
    const wallets = holders.map((h) => h.wallet);

    const jobs = await buildJobs(config, { sql: db, chain: w.chain, reader: ledger, wallets: w.chain, keeper: KEEPER, log, now: () => new Date(clock) });
    const runner = createRunner(jobs, { now: () => new Date(clock), log });
    const status = async () => (await db.query<{ status: string }>("select status from breaks where onchain_id = 0")).rows[0]?.status;
    const tick = async () => {
      w.chain.unixTime = BigInt(Math.floor(clock / 1000));
      await runner.tick();
      clock += 1000;
    };

    // 1. The scheduler creates the break, and the next run copies it into the database.
    await tick();
    expect(w.chain.applied).toEqual(["create_break"]);
    await tick();
    expect(await status()).toBe("open");
    const created = w.chain.breaks.get(0n)!;
    expect(created).toMatchObject({ paidSpots: 3, freeSpots: 2, lockedSubsidy: 15_000_000n, lockedHolder: 50_000_000n, closesAt: created.opensAt + 21_600n });
    expect(w.chain.treasury.config).toMatchObject({ lockedSubsidy: 15_000_000n, lockedHolder: 50_000_000n });

    // 2. People buy the three paid spots (the web app does this on-chain; the model has no buy_spot).
    for (let i = 0; i < 3; i++) w.chain.addSpot({ breakId: 0n, index: i, owner: addr(10 + i), paid: 20_000_000n, refunded: false, bump: 255 });
    created.spotsSold = 3;

    // 3. The sale ends and time passes until the indexer has read past the window; everything else follows.
    clock = (Number(created.closesAt) + 120 + 120 + 10) * 1000;
    for (let i = 0; i < 40 && (await status()) !== "delivered"; i++) {
      await tick();
      const b = w.chain.breaks.get(0n)!;
      if (b.status === "RandomnessRequested") w.chain.fulfill(requestAddress(ORAO_PROGRAM, b.randomnessRequestId), ANSWER);
    }
    expect(await status()).toBe("delivered");
    expect(errors).toEqual([]);

    // One break only: the funds are used up (the pack budget was paid out) and nothing else was created.
    expect(w.chain.applied.filter((x) => x === "create_break")).toHaveLength(1);
    expect(w.chain.breaks.size).toBe(1);
    expect(w.chain.treasury.config).toMatchObject({ lockedSubsidy: 0n, lockedHolder: 0n });
    expect(w.chain.treasury).toMatchObject({ subsidyVault: 0n, holderVault: 0n });

    // The database row is the chain's, with the creation transaction.
    const row = (await db.query<{ create_tx: string | null; pack_machine: string; paid_spots: number }>("select create_tx, pack_machine, paid_spots from breaks where onchain_id = 0")).rows[0]!;
    expect(row).toEqual({ create_tx: "mock-tx-1", pack_machine: "pokemon-25", paid_spots: 3 });

    // The free winners are two of the holders the indexer read, and every card went out.
    const b = w.chain.breaks.get(0n)!;
    const winners = b.freeWinners.slice(0, 2).map((x) => x.wallet);
    expect(winners.every((x) => wallets.includes(x))).toBe(true);
    expect(new Set(winners).size).toBe(2);
    const delivered = await db.query<{ status: string }>("select d.status from deliveries d join breaks b on b.id = d.break_id where b.onchain_id = 0");
    expect(delivered.rows).toHaveLength(5);
  });
});

describe("the jobs, with a pack list of several machines", () => {
  const D = 1_000_000n;
  const group = (machine: string, dollars: bigint, count: number) => ({ machine: packMachineBytes(machine), maxPrice: dollars * D, count });
  // 3 paid spots at $20 and 2 free: two $10 packs, two $25 and one $50: $120, or $24 on average. The free spots are $48 from
  // the holder bucket, the buyers pay $60 and the subsidy bucket the other $12.
  const template = { paidSpots: 3, freeSpots: 2, spotPrice: 20_000_000n, packs: [group("cheap", 10n, 2), group("mid", 25n, 2), group("top", 50n, 1)], windowSecs: 21_600n };

  /** Runs the keeper from an empty chain, with the mock pack provider's live price set to `price`, until `done` or 40 ticks. */
  async function run(price: bigint, done: (status: string | undefined) => boolean) {
    const db = shared;
    const w = world({ status: "Open", id: 8n });
    const { log, errors } = logger();
    w.chain.breaks.clear();
    w.chain.spots.clear();
    w.chain.config.nextBreakId = 0n;
    w.chain.treasury.subsidyVault = 12_000_000n;
    w.chain.treasury.holderVault = 48_000_000n;

    let clock = Number(w.chain.unixTime) * 1000;
    const startSecs = clock / 1000;
    await db.exec("truncate breaks, indexed_accounts, balance_events, indexer_state cascade");
    await db.query("delete from exclusions");
    const ledger = new TokenLedger(startSecs - 5000);
    const holders = [1, 2, 3, 4, 5, 6].map((n) => ledger.holder(`holder${n}`));
    ledger.at(startSecs - 4000);
    for (const [i, h] of holders.entries()) ledger.mintTo(h, BigInt((i + 1) * 1000));

    const cfg = { ...config, mockPackPrice: price, scheduler: { enabled: true, template } };
    const jobs = await buildJobs(cfg, { sql: db, chain: w.chain, reader: ledger, wallets: w.chain, keeper: KEEPER, log, now: () => new Date(clock) });
    const runner = createRunner(jobs, { now: () => new Date(clock), log });
    const status = async () => (await db.query<{ status: string }>("select status from breaks where onchain_id = 0")).rows[0]?.status;
    const tick = async () => {
      w.chain.unixTime = BigInt(Math.floor(clock / 1000));
      await runner.tick();
      clock += 1000;
    };

    await tick();
    await tick();
    const created = w.chain.breaks.get(0n)!;
    for (let i = 0; i < 3; i++) w.chain.addSpot({ breakId: 0n, index: i, owner: addr(10 + i), paid: 20_000_000n, refunded: false, bump: 255 });
    created.spotsSold = 3;
    clock = (Number(created.closesAt) + 120 + 120 + 10) * 1000;
    for (let i = 0; i < 40 && !done(await status()); i++) {
      await tick();
      const b = w.chain.breaks.get(0n)!;
      if (b.status === "RandomnessRequested") w.chain.fulfill(requestAddress(ORAO_PROGRAM, b.randomnessRequestId), ANSWER);
    }
    return { db, w, errors, status };
  }

  it("creates the break with the list, funds exactly its packs, buys each one and delivers every card", async () => {
    const { db, w, errors, status } = await run(10n * D, (st) => st === "delivered");
    expect(await status()).toBe("delivered");
    expect(errors).toEqual([]);
    const b = w.chain.breaks.get(0n)!;
    expect(b.packs).toEqual([0, 0, 1, 1, 2]);
    expect(b.tiers.map((t) => t.maxPrice)).toEqual([10n * D, 25n * D, 50n * D]);
    // $120 of packs: $60 from the buyers, $12 from the subsidy bucket and $48 from the holder bucket. Nothing is left.
    expect(b.packBudget).toBe(120n * D);
    expect(w.chain.treasury).toMatchObject({ subsidyVault: 0n, holderVault: 0n });
    expect(w.chain.treasury.config).toMatchObject({ lockedSubsidy: 0n, lockedHolder: 0n });
    const row = (await db.query<{ pack_machine: string; max_pack_price: string }>("select pack_machine, max_pack_price::text from breaks where onchain_id = 0")).rows[0]!;
    expect(row).toEqual({ pack_machine: "cheap, mid, top", max_pack_price: "50000000" });
    expect((await db.query("select d.status from deliveries d join breaks b on b.id = d.break_id where b.onchain_id = 0")).rows).toHaveLength(5);
  });

  it("buys a pack only while the live price is within that pack's own cap: at $25 the two $10 packs wait", async () => {
    const { db, w, errors, status } = await run(25n * D, () => false);
    // The break is paid for, but only the three packs that allow $25 are bought; the pipeline waits for the other two.
    expect(["funded", "eligibility_committed"]).toContain(await status());
    expect(w.chain.breaks.get(0n)!.status).toBe("Funded");
    const packs = (await db.query<{ pack_index: number; status: string }>("select p.pack_index, p.status from packs p join breaks b on b.id = p.break_id where b.onchain_id = 0 order by p.pack_index")).rows;
    expect(packs.map((p) => [p.pack_index, p.status])).toEqual([[0, "planned"], [1, "planned"], [2, "pulled"], [3, "pulled"], [4, "pulled"]]);
    expect(errors).toEqual([]);
  });
});

describe("the jobs, with a break nobody joins", () => {
  const D = 1_000_000n;

  it("cancel it once its list is committed, since anyone may and nothing else can be done with it, and the reserve it held lets the scheduler make the next break", async () => {
    const db = shared;
    const w = world({ status: "Open", id: 8n });
    const { log, errors } = logger();
    w.chain.breaks.clear();
    w.chain.spots.clear();
    w.chain.config.nextBreakId = 0n;
    // Exactly enough for one break of the default template (3 paid at $20 and 2 free, $25 packs): $15 and $50.
    w.chain.treasury.subsidyVault = 15n * D;
    w.chain.treasury.holderVault = 50n * D;

    let clock = Number(w.chain.unixTime) * 1000;
    const startSecs = clock / 1000;
    await db.exec("truncate breaks, indexed_accounts, balance_events, indexer_state cascade");
    await db.query("delete from exclusions");
    // A holder exists, but holds far less than the minimum, so the list that is committed is empty.
    const ledger = new TokenLedger(startSecs - 5000);
    ledger.at(startSecs - 4000);
    ledger.mintTo(ledger.holder("small"), 5n);

    const cfg = { ...config, eligibility: { minTwab: 1_000_000n, settleSecs: 120 } };
    const jobs = await buildJobs(cfg, { sql: db, chain: w.chain, reader: ledger, wallets: w.chain, keeper: KEEPER, log, now: () => new Date(clock) });
    const runner = createRunner(jobs, { now: () => new Date(clock), log });
    const tick = async () => {
      w.chain.unixTime = BigInt(Math.floor(clock / 1000));
      await runner.tick();
      clock += 1000;
    };

    await tick();
    await tick();
    const first = w.chain.breaks.get(0n)!;
    expect(first.status).toBe("Open");
    expect(w.chain.treasury.config).toMatchObject({ lockedSubsidy: 15n * D, lockedHolder: 50n * D });

    // Nobody buys. The sale ends, the keeper closes the break and commits the empty list, and then cancels it.
    clock = (Number(first.closesAt) + 120 + 120 + 10) * 1000;
    for (let i = 0; i < 40 && w.chain.breaks.get(0n)!.status !== "Cancelled"; i++) await tick();
    expect(w.chain.breaks.get(0n)).toMatchObject({ status: "Cancelled", spotsSold: 0, lockedSubsidy: 0n, lockedHolder: 0n });
    expect(w.chain.applied.filter((n) => n !== "create_break")).toEqual(expect.arrayContaining(["close_break", "commit_eligibility", "cancel_unfundable"]));
    expect(w.chain.applied).not.toContain("fund_purchases");
    expect((await db.query<{ status: string }>("select status from breaks where onchain_id = 0")).rows[0]?.status).toBe("cancelled");

    // The money it reserved is free again, so the scheduler creates the next break.
    for (let i = 0; i < 10 && !w.chain.breaks.get(1n); i++) await tick();
    expect(w.chain.breaks.get(1n)).toMatchObject({ status: "Open" });
    expect(w.chain.treasury.config).toMatchObject({ lockedSubsidy: 15n * D, lockedHolder: 50n * D });
    expect(w.chain.treasury).toMatchObject({ subsidyVault: 15n * D, holderVault: 50n * D });
    expect(errors).toEqual([]);
  });
});

describe("the jobs, with a break that is cancelled after someone bought a spot", () => {
  const D = 1_000_000n;
  const group = (machine: string, dollars: bigint, count: number) => ({ machine: packMachineBytes(machine), maxPrice: dollars * D, count });
  // 3 paid spots at $20 and 2 free, with two $10 packs first: one early buyer and nobody eligible leaves a pool of one $10 pack,
  // worth less than the $20 the buyer paid, so the break can never be funded.
  const template = { paidSpots: 3, freeSpots: 2, spotPrice: 20_000_000n, packs: [group("cheap", 10n, 2), group("mid", 25n, 2), group("top", 50n, 1)], windowSecs: 21_600n };

  it("cancels it, gives the buyer the USDC back from the escrow, and then stops looking at the break", async () => {
    const db = shared;
    const w = world({ status: "Open", id: 8n });
    const { log, errors } = logger();
    w.chain.breaks.clear();
    w.chain.spots.clear();
    w.chain.config.nextBreakId = 0n;
    w.chain.treasury.subsidyVault = 12_000_000n;
    w.chain.treasury.holderVault = 48_000_000n;

    let clock = Number(w.chain.unixTime) * 1000;
    const startSecs = clock / 1000;
    await db.exec("truncate breaks, indexed_accounts, balance_events, indexer_state cascade");
    await db.query("delete from exclusions");
    const ledger = new TokenLedger(startSecs - 5000);
    ledger.at(startSecs - 4000);
    ledger.mintTo(ledger.holder("small"), 5n);

    const cfg = { ...config, eligibility: { minTwab: 1_000_000n, settleSecs: 120 }, scheduler: { enabled: true, template } };
    const jobs = await buildJobs(cfg, { sql: db, chain: w.chain, reader: ledger, wallets: w.chain, keeper: KEEPER, log, now: () => new Date(clock) });
    expect(jobs.map((j) => j.name).at(-1)).toBe("refunds");
    const runner = createRunner(jobs, { now: () => new Date(clock), log });
    const status = async () => (await db.query<{ status: string }>("select status from breaks where onchain_id = 0")).rows[0]?.status;
    const tick = async () => {
      w.chain.unixTime = BigInt(Math.floor(clock / 1000));
      await runner.tick();
      clock += 1000;
    };

    await tick();
    await tick();
    const created = w.chain.breaks.get(0n)!;
    expect(created.status).toBe("Open");

    // One person buys a spot (the model has no buy_spot) and has a USDC account, as every buyer does.
    const buyer = addr(10);
    const buyerUsdc = w.chain.giveUsdc(buyer, 0n);
    w.chain.addSpot({ breakId: 0n, index: 0, owner: buyer, paid: 20_000_000n, refunded: false, bump: 255 });
    created.spotsSold = 1;

    clock = (Number(created.closesAt) + 120 + 120 + 10) * 1000;
    for (let i = 0; i < 40 && (await status()) !== "refunded"; i++) await tick();

    expect(await status()).toBe("refunded");
    expect(w.chain.breaks.get(0n)).toMatchObject({ status: "Cancelled", spotsSold: 1, lockedSubsidy: 0n, lockedHolder: 0n });
    expect(w.chain.applied).toContain("cancel_unfundable");
    expect(w.chain.applied).not.toContain("fund_purchases");
    // The buyer has the $20 back, the escrow is empty, and the keeper refunded exactly once.
    expect(w.chain.usdc.get(buyerUsdc)?.amount).toBe(20n * D);
    expect(w.chain.escrow.get(0n)).toBe(0n);
    expect(w.chain.applied.filter((n) => n === "refund_spot")).toHaveLength(1);
    expect(errors).toEqual([]);

    // Finished: more ticks refund nothing again (the scheduler may start the next break from the reserve that was released).
    for (let i = 0; i < 5; i++) await tick();
    expect(w.chain.applied.filter((n) => n === "refund_spot")).toHaveLength(1);
    expect(await status()).toBe("refunded");
    expect(w.chain.usdc.get(buyerUsdc)?.amount).toBe(20n * D);
  });
});

describe("the jobs, with the fee sweep", () => {
  it("deposit the USDC in the keeper's wallet into the treasury, and then the scheduler can create the break", async () => {
    const db = shared;
    const w = world({ status: "Open", id: 8n });
    const { log, errors, infos } = logger();
    w.chain.breaks.clear();
    w.chain.spots.clear();
    w.chain.config.nextBreakId = 0n;
    // An empty treasury and $200 of fees that were paid to the keeper's wallet.
    w.chain.treasury.subsidyVault = 0n;
    w.chain.treasury.holderVault = 0n;
    w.chain.giveUsdc(KEEPER, 200_000_000n);
    await db.exec("truncate breaks, indexed_accounts, balance_events, indexer_state, fee_swaps, treasury_events cascade");

    const on = { ...config, sweep: { ...config.sweep, enabled: true } };
    const jobs = await buildJobs(on, { sql: db, chain: w.chain, reader: quietNode(), wallets: w.chain, keeper: KEEPER, log, now: w.clock.now });
    expect(jobs.map((j) => j.name)).toEqual(["indexer", "scheduler", "fee-sweep", "pipeline", "pack-buyer", "delivery", "refunds"]);
    expect(infos).toContain("fee sweep on, without a swap provider: USDC in the keeper's wallet is deposited into the treasury");

    let clock = Number(w.chain.unixTime) * 1000;
    const runner = createRunner(jobs, { now: () => new Date(clock), log });
    for (let i = 0; i < 4; i++) {
      w.chain.unixTime = BigInt(Math.floor(clock / 1000));
      await runner.tick();
      clock += 1000;
    }

    // The deposit came first (the scheduler had nothing to work with), then the break.
    expect(w.chain.applied).toEqual(["deposit_fees", "create_break"]);
    expect(errors).toEqual([]);
    // $200 split 70/30, then the break's worst case ($15 subsidy, $50 holders) is locked.
    expect(w.chain.treasury).toMatchObject({ subsidyVault: 140_000_000n, holderVault: 60_000_000n });
    expect(w.chain.treasury.config).toMatchObject({ lockedSubsidy: 15_000_000n, lockedHolder: 50_000_000n });
    expect(w.chain.usdc.get(associatedTokenAddress(KEEPER, w.chain.config.usdcMint))?.amount).toBe(0n);
    const ledger = await db.query<{ kind: string; asset: string; amount: string }>("select kind, asset, amount::text from treasury_events");
    expect(ledger.rows).toEqual([{ kind: "deposit", asset: "USDC", amount: "200000000" }]);
  });

  it("the scheduler waits, and says so, while the keeper's wallet cannot pay for a break, then creates it once topped up", async () => {
    const w = world({ status: "Open", id: 8n });
    const { log, errors } = logger();
    w.chain.breaks.clear();
    w.chain.spots.clear();
    w.chain.config.nextBreakId = 0n;
    // The treasury can pay for the break (its worst case is $15 of subsidy and $50 for the holders); the keeper has too little SOL.
    w.chain.treasury.subsidyVault = 140_000_000n;
    w.chain.treasury.holderVault = 60_000_000n;
    w.chain.solBalances.set(KEEPER, 1_000_000n);
    await shared.exec("truncate breaks, indexed_accounts, balance_events, indexer_state cascade");

    const jobs = await buildJobs(config, { sql: shared, chain: w.chain, reader: quietNode(), wallets: w.chain, keeper: KEEPER, log, now: w.clock.now });
    let clock = Number(w.chain.unixTime) * 1000;
    const runner = createRunner(jobs, { now: () => new Date(clock), log });
    const tick = async () => {
      w.chain.unixTime = BigInt(Math.floor(clock / 1000));
      await runner.tick();
      clock += 1000;
    };
    for (let i = 0; i < 3; i++) await tick();
    expect(w.chain.applied).toEqual([]);
    // (At startup the keeper also warns that it could not pay for a randomness request: a separate message, about a later step.)
    const aboutBreak = () => errors.filter((e) => e.includes("a new break"));
    expect(aboutBreak()).toEqual(["the keeper wallet cannot pay for a new break: top it up with SOL"]);

    w.chain.solBalances.set(KEEPER, 50_000_000n);
    for (let i = 0; i < 2; i++) await tick();
    expect(w.chain.applied).toEqual(["create_break"]);
    expect(aboutBreak()).toHaveLength(1);
  });

  it("builds no sweep job while the sweep is off", async () => {
    const w = world();
    const jobs = await buildJobs(config, { sql: shared, chain: w.chain, reader: quietNode(), wallets: w.chain, keeper: KEEPER, log: logger().log });
    expect(jobs.map((j) => j.name)).not.toContain("fee-sweep");
  });
});

describe("the jobs, with the lists published as files", () => {
  const on = (over: Partial<AppConfig["publish"]> = {}): AppConfig => ({ ...config, publish: { ...config.publish, dir: "/nonexistent/published", ...over } });

  it("builds the publish job only when a directory is named", async () => {
    const w = world({ status: "Open", id: 8n });
    const without = await buildJobs(config, { sql: shared, chain: w.chain, finalized: w.chain, reader: quietNode(), wallets: w.chain, keeper: KEEPER, log: logger().log });
    expect(without.map((j) => j.name)).not.toContain("publish");
    const { log, infos } = logger();
    const jobs = await buildJobs(on({ intervalSecs: 45 }), { sql: shared, chain: w.chain, finalized: w.chain, reader: quietNode(), wallets: w.chain, keeper: KEEPER, log });
    expect(jobs.map((j) => j.name)).toEqual(["indexer", "scheduler", "publish", "pipeline", "pack-buyer", "delivery", "refunds"]);
    expect(jobs.find((j) => j.name === "publish")?.intervalMs).toBe(45_000);
    expect(infos).toContain("publishing eligibility lists, the balance events, records and exclusion lists behind them, card pools and the ledgers of delivered breaks as files");
  });

  it("needs a chain reader at the finalized commitment: nothing is published against a commitment that could roll back", async () => {
    const w = world({ status: "Open", id: 8n });
    await expect(buildJobs(on(), { sql: shared, chain: w.chain, reader: quietNode(), wallets: w.chain, keeper: KEEPER, log: logger().log })).rejects.toThrow(/needs a chain reader at the finalized commitment/);
  });

  it("publishes from the finalized view only: a break the confirmed view shows but the finalized one does not is not published", async () => {
    await shared.exec("truncate packs, twab_snapshots, eligibility_lists, breaks cascade");
    // A holder (a real public key: the rules leave out addresses off the curve) who held 7 all through the window.
    const holder = addressFromBytes(ed25519.getPublicKey(new Uint8Array(32).fill(31)));
    const leaf = { wallet: addressToBytes(holder), weight: 7n };
    const tree = Tree.build([leaf]);
    const breakId = await insertBreak(shared);
    await shared.query("update breaks set onchain_id = 31, status = 'eligibility_committed' where id = $1::bigint", [breakId]);
    await shared.query("insert into twab_snapshots (break_id, wallet, twab, weight, eligible) values ($1::bigint, $2, 7, 7, true)", [breakId, holder]);
    // The record of the inputs the planner would have published: its SHA-256 is what the chain committed.
    const window = { start: 1_800_000_000, end: 1_800_043_200 };
    const events = [{ signature: "sig-31", slot: 5n, time: 1_799_999_990, owner: holder, tokenAccount: addr(32), delta: 7n, balanceAfter: 7n }];
    const inputs = serializeInputs(events, window);
    const inputsHash = toHex(hashv(utf8(inputs)));
    await shared.query("insert into published_documents (sha256, content_type, body) values ($1, 'text/plain; charset=utf-8', $2) on conflict do nothing", [inputsHash, inputs]);
    // And the record of why each wallet is in or out, as the planner stores it.
    const policy = { minTwab: 1n };
    const record = listDocument(breakId, window, policy, { root: tree.root.hash, totalWeight: 7n, entryCount: 1, inputsHash: hashv(utf8(inputs)) }, buildEligibility({ events, window, policy, exclusions: new Map() }));
    const recordHash = toHex(hashv(utf8(record)));
    await shared.query("insert into published_documents (sha256, content_type, body) values ($1, 'application/json', $2) on conflict do nothing", [recordHash, record]);
    // And the exclusion list it was made with: an exchange's wallet that held none of the token.
    const exclusions = exclusionsDocument(inputsHash, new Map([[addr(33), "exchange"]]));
    const exclusionsHash = toHex(hashv(utf8(exclusions)));
    await shared.query("insert into published_documents (sha256, content_type, body) values ($1, 'application/json', $2) on conflict do nothing", [exclusionsHash, exclusions]);
    await shared.query(
      "insert into eligibility_lists (break_id, root, total_weight, entry_count, inputs_hash, list_uri, inputs_uri, exclusions_uri) values ($1::bigint, decode($2, 'hex'), 7, 1, decode($3, 'hex'), $4, $5, $6)",
      [breakId, toHex(tree.root.hash), inputsHash, `db:sha256:${recordHash}`, `db:sha256:${inputsHash}`, `db:sha256:${exclusionsHash}`],
    );
    const account = encodeBreak(
      brk({ id: 31n, status: "EligibilityCommitted", opensAt: BigInt(window.start), closesAt: BigInt(window.end), eligibilityRoot: tree.root.hash, eligibilityTotalWeight: 7n, eligibilityCount: 1, eligibilityInputsHash: hashv(utf8(inputs)) }),
    );
    const finalized = { getAccountData: async (a: string) => (a === breakAddress(PROGRAMS, 31n) ? account : undefined) };
    const w = world({ status: "Open", id: 8n }); // its chain knows nothing of break 31
    const dir = await mkdtemp(join(tmpdir(), "app-publish-"));
    try {
      const { log, errors } = logger();
      const jobs = await buildJobs(on({ dir }), { sql: shared, chain: w.chain, finalized, reader: quietNode(), wallets: w.chain, keeper: KEEPER, log });
      await jobs.find((j) => j.name === "publish")!.run({ now: w.clock.now, log });
      expect(errors).toEqual([]);
      expect(await readdir(join(dir, "eligibility"))).toEqual([`${toHex(tree.root.hash)}.json`]);
      // The balance events behind the weights go out too, under the hash the chain holds, byte for byte.
      expect(await readdir(join(dir, "inputs"))).toEqual([`${inputsHash}.txt`]);
      expect(await readFile(join(dir, "inputs", `${inputsHash}.txt`), "utf8")).toBe(inputs);
      // And the record of why the holder is on the list, under the same inputs hash.
      expect(await readdir(join(dir, "records"))).toEqual([`${inputsHash}.json`]);
      expect(JSON.parse(await readFile(join(dir, "records", `${inputsHash}.json`), "utf8")).wallets).toEqual([{ wallet: holder, twab: "7", weight: "7", reason: null }]);
      // And the whole exclusion list, as it was stored.
      expect(await readdir(join(dir, "exclusions"))).toEqual([`${inputsHash}.json`]);
      expect(await readFile(join(dir, "exclusions", `${inputsHash}.json`), "utf8")).toBe(exclusions);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("publishes a delivered break's ledger, from the finalized view, and it is what the tables and the draw say", async () => {
    await shared.exec("truncate packs, twab_snapshots, eligibility_lists, breaks cascade");
    const w = world();
    const id = await insertBreak(shared);
    await shared.query("update breaks set onchain_id = 7, status = 'funded' where id = $1::bigint", [id]);
    for (const leaf of w.leaves) {
      await shared.query("insert into twab_snapshots (break_id, wallet, twab, weight, eligible) values ($1, $2, $3, $3, true)", [id, addressOf(leaf.wallet), leaf.weight]);
    }
    const dir = await mkdtemp(join(tmpdir(), "app-ledger-"));
    try {
      const { log, errors } = logger();
      const jobs = await buildJobs(on({ dir }), { sql: shared, chain: w.chain, finalized: w.chain, reader: quietNode(), wallets: w.chain, keeper: KEEPER, log, now: w.clock.now });
      const run = (name: string) => jobs.find((j) => j.name === name)!.run({ now: w.clock.now, log });
      const status = async () => (await shared.query<{ status: string }>("select status from breaks where id = $1::bigint", [id])).rows[0]?.status;

      // Buy and pull the packs, commit the pool, ask for randomness, settle and draw, then deliver every card.
      await run("pack-buyer");
      await run("pipeline");
      w.chain.fulfill(requestAddress(ORAO_PROGRAM, w.chain.breaks.get(7n)!.randomnessRequestId), ANSWER);
      await run("pipeline");
      await run("delivery");
      await run("delivery");
      expect(await status()).toBe("delivered");

      await run("publish");
      expect(errors).toEqual([]);
      const b = w.chain.breaks.get(7n)!;
      const name = `${toHex(b.poolHash)}.json`;
      expect(await readdir(join(dir, "ledger"))).toEqual([name]);
      const ledger = JSON.parse(await readFile(join(dir, "ledger", name), "utf8"));
      expect(ledger).toMatchObject({ version: 1, kind: "ledger", poolHash: toHex(b.poolHash) });

      // Every pack as the buyer stored it, in the order of the pack list.
      const packs = await shared.query<{ pack_index: number; price: string; purchase_sig: string; card_mint: string; proof_ref: string }>(
        "select pack_index, price::text as price, purchase_sig, card_mint, proof_ref from packs where break_id = $1::bigint order by pack_index",
        [id],
      );
      expect(ledger.packs).toEqual(packs.rows.map((r) => ({ index: r.pack_index, price: r.price, purchaseTx: r.purchase_sig, card: r.card_mint, proof: r.proof_ref })));
      // Every spot: the wallet and the card the draw gives it, and the transaction that sent the card.
      const owners = [10, 11, 12].map((n) => addr(n));
      const winners = b.freeWinners.slice(0, 2).map((x) => x.wallet);
      const assigned = assignCards(b.seed, packs.rows.map((r) => addressToBytes(r.card_mint)), owners, winners);
      const sent = await shared.query<{ card_mint: string; tx_sig: string }>("select card_mint, tx_sig from deliveries where break_id = $1::bigint", [id]);
      const txOf = new Map(sent.rows.map((r) => [r.card_mint, r.tx_sig]));
      expect(ledger.spots).toEqual(
        assigned.map((a, i) => {
          const card = addressFromBytes(a.card);
          return { kind: a.kind, index: a.kind === "paid" ? i : i - 3, wallet: a.owner, card, deliveryTx: txOf.get(card) };
        }),
      );
      expect(ledger.spots.map((x: { wallet: string }) => x.wallet)).toEqual([...owners, ...winners]);

      // Nothing more on the next run: the file is there.
      await run("publish");
      expect(await readdir(join(dir, "ledger"))).toEqual([name]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does nothing, and reports no problem, while no break has a committed list", async () => {
    await shared.exec("truncate breaks cascade");
    const w = world({ status: "Open", id: 8n });
    const { log, errors } = logger();
    const jobs = await buildJobs(on(), { sql: shared, chain: w.chain, finalized: w.chain, reader: quietNode(), wallets: w.chain, keeper: KEEPER, log });
    await jobs.find((j) => j.name === "publish")!.run({ now: w.clock.now, log });
    expect(errors).toEqual([]);
  });
});

describe("the jobs, with the X bot", () => {
  const on = (over: Partial<AppConfig["bot"]> = {}): AppConfig => ({ ...config, bot: { ...config.bot, enabled: true, ...over } });
  const openWorld = () => {
    const w = world({ status: "Open", id: 8n });
    w.chain.unixTime = 1_800_000_100n; // the sale has just opened
    return w;
  };

  it("builds the bot job only when it is on, and announces a live sale from the finalized view", async () => {
    await shared.exec("truncate bot_posts cascade");
    const w = openWorld();
    const poster = new ScriptedPoster();
    const { log, errors } = logger();
    const jobs = await buildJobs(on(), { sql: shared, chain: w.chain, finalized: w.chain, poster, reader: quietNode(), wallets: w.chain, keeper: KEEPER, log, now: w.clock.now });
    expect(jobs.map((j) => j.name)).toEqual(["indexer", "scheduler", "x-bot", "pipeline", "pack-buyer", "delivery", "refunds"]);

    // Only the bot is run here: the other jobs have their own tests and need a database that matches this chain.
    await jobs.find((j) => j.name === "x-bot")!.run({ now: w.clock.now, log });
    expect(errors).toEqual([]);
    // (The fixture's machine id is 32 bytes of 0x77, which reads as the text "wwww...".)
    expect(poster.sent).toEqual([`Break #9 is LIVE — 3 paid spots @ $20 + 2 FREE holder spots. Packs: ${"w".repeat(32)}. Closes Jan 15, 14:00 UTC.`]);
  });

  it("announces nothing that the finalized view does not show yet, even if the confirmed view does", async () => {
    await shared.exec("truncate bot_posts cascade");
    const confirmed = openWorld();
    const finalized = openWorld();
    finalized.chain.breaks.clear();
    const poster = new ScriptedPoster();
    const jobs = await buildJobs(on(), { sql: shared, chain: confirmed.chain, finalized: finalized.chain, poster, reader: quietNode(), wallets: confirmed.chain, keeper: KEEPER, log: logger().log, now: confirmed.clock.now });
    const bot = jobs.find((j) => j.name === "x-bot")!;
    await bot.run({ now: confirmed.clock.now, log: logger().log });
    expect(poster.sent).toEqual([]);
    finalized.chain.breaks.set(8n, confirmed.chain.breaks.get(8n)!);
    await bot.run({ now: confirmed.clock.now, log: logger().log });
    expect(poster.sent).toHaveLength(1);
  });

  it("is a dry run by default: it says so, and only writes the posts to the log", async () => {
    await shared.exec("truncate bot_posts cascade");
    const w = openWorld();
    const seen: [string, Record<string, unknown> | undefined][] = [];
    const log = { info: (m: string, e?: Record<string, unknown>) => seen.push([m, e]), error: (m: string, e?: Record<string, unknown>) => seen.push([`ERROR ${m}`, e]) };
    const jobs = await buildJobs(on(), { sql: shared, chain: w.chain, finalized: w.chain, reader: quietNode(), wallets: w.chain, keeper: KEEPER, log, now: w.clock.now });
    expect(seen.map(([m]) => m)).toContain("X bot on as a DRY RUN: posts are only written to the log (BOT_POSTER=log)");
    await jobs.find((j) => j.name === "x-bot")!.run({ now: w.clock.now, log });
    const dry = seen.find(([m]) => m.startsWith("X post (dry run"));
    expect(dry?.[1]).toMatchObject({ text: expect.stringContaining("is LIVE") });
  });

  it("refuses to start without a finalized reader, or to post to X without credentials", async () => {
    const w = openWorld();
    const base = { sql: shared, chain: w.chain, reader: quietNode(), wallets: w.chain, keeper: KEEPER, log: logger().log };
    await expect(buildJobs(on(), base)).rejects.toThrow(/finalized commitment/);
    await expect(buildJobs(on({ poster: "x" }), { ...base, finalized: w.chain })).rejects.toThrow(/X_\* credentials/);
  });

  it("says when it posts to X", async () => {
    const w = openWorld();
    const { log, infos } = logger();
    const x = { credentials: { consumerKey: "a", consumerSecret: "b", accessToken: "c", accessTokenSecret: "d" } };
    await buildJobs(on({ poster: "x", x }), { sql: shared, chain: w.chain, finalized: w.chain, reader: quietNode(), wallets: w.chain, keeper: KEEPER, log, now: w.clock.now });
    expect(infos).toContain("X bot on: posts are sent to X");
  });
});

function addressOf(bytes: Uint8Array): string {
  return addr(bytes[0] as number);
}

describe("buildWatchdog", () => {
  const watchConfig = (watch: Partial<WatchConfig["watch"]> = {}): WatchConfig => ({
    ...config,
    cluster: "devnet",
    watch: { alerts: "log", afterMins: 2, repeatHours: 12, intervalSecs: 60, ...watch },
  });
  const TOKEN = "123456789:AAH-secret_token_value_0123456789";

  /** A log that keeps every line with its fields. */
  const lines = () => {
    const out: [string, string, Record<string, unknown> | undefined][] = [];
    return { out, log: { info: (m: string, e?: Record<string, unknown>) => out.push(["info", m, e]), error: (m: string, e?: Record<string, unknown>) => out.push(["error", m, e]) } };
  };

  it("is the watchdog job, on its interval, and says where its alerts go", () => {
    const w = world();
    const l = lines();
    const job = buildWatchdog(watchConfig({ intervalSecs: 30 }), { sql: shared, chain: w.chain, wallets: w.chain, keeper: KEEPER, log: l.log });
    expect(job).toMatchObject({ name: "watchdog", intervalMs: 30_000 });
    expect(l.out).toEqual([["info", "watchdog on: alerts only go to the log (ALERTS=log)", { afterMins: 2 }]]);

    const t = lines();
    buildWatchdog(watchConfig({ alerts: "telegram", telegram: { token: TOKEN, chatId: "-100200" } }), { sql: shared, chain: w.chain, wallets: w.chain, keeper: KEEPER, log: t.log });
    expect(t.out).toEqual([["info", "watchdog on: alerts go to the log and to a Telegram chat", { chat: "-100200", afterMins: 2 }]]);
    expect(JSON.stringify(t.out)).not.toContain(TOKEN);
    expect(() => buildWatchdog(watchConfig({ alerts: "telegram" }), { sql: shared, chain: w.chain, wallets: w.chain, keeper: KEEPER, log: t.log })).toThrow(/ALERT_TELEGRAM_BOT_TOKEN/);
  });

  it("passes on every setting, in the units the watchdog counts in", () => {
    const w = world();
    const health = new JobHealth();
    const now = () => new Date(5);
    const d = watchdogDeps(
      { ...watchConfig({ afterMins: 7, repeatHours: 3, alerts: "telegram", telegram: { token: TOKEN, chatId: "42" } }), cluster: "localnet", eligibility: { minTwab: 1n, settleSecs: 300 } },
      { sql: shared, chain: w.chain, wallets: w.chain, keeper: KEEPER, log: logger().log, now, health, secrets: ["SECRETPATH0123456789"] },
    );
    expect(d).toMatchObject({
      chain: w.chain,
      wallets: w.chain,
      keeper: KEEPER,
      programs: PROGRAMS,
      vrfProgram: ORAO_PROGRAM,
      freeSpots: 2,
      jobs: health,
      limits: { afterMs: 7 * 60_000, settleSecs: 300 },
      title: "BREAKS keeper on localnet",
      repeatMs: 3 * 3_600_000,
      now,
    });
    expect(d.channels.map((c) => c.name)).toEqual(["log", "telegram"]);
    expect(d.scrub(`x SECRETPATH0123456789 ${TOKEN} y`)).toBe("x [hidden] [hidden] y");
    const plain = watchdogDeps(watchConfig(), { sql: shared, chain: w.chain, wallets: w.chain, keeper: KEEPER, log: logger().log });
    expect(plain.channels.map((c) => c.name)).toEqual(["log"]);
    expect(plain).not.toHaveProperty("jobs");
    expect(plain.now().getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("watches the real runner: a job that keeps failing is reported once in the log and on Telegram, without secrets, and nothing is sent to the chain", async () => {
    const w = world();
    const l = lines();
    const sent: AlertMessage[] = [];
    const send = vi.spyOn(w.chain, "sendAndConfirm");
    let clock = 1_800_040_000_000;
    const health = new JobHealth();
    const watchdog = buildWatchdog(watchConfig({ alerts: "telegram", telegram: { token: TOKEN, chatId: "-100200" } }), {
      sql: shared,
      chain: w.chain,
      wallets: w.chain,
      keeper: KEEPER,
      log: l.log,
      now: () => new Date(clock),
      health,
      secrets: ["SECRETPATH0123456789"],
      telegram: { name: "telegram", send: async (m) => void sent.push(m) },
    });
    const flaky: Job = {
      name: "indexer",
      intervalMs: 60_000,
      run: async () => {
        throw new Error(`request to https://rpc.example/SECRETPATH0123456789 failed; bot${TOKEN}`);
      },
    };
    const runner = createRunner([flaky, watchdog], { now: () => new Date(clock), log: l.log }, health);
    for (let i = 0; i < 4; i++) {
      await runner.tick();
      clock += 60_000;
    }
    const alert =
      "• The indexer job has failed every run for 2 min (3 runs in a row). Last error: request to https://rpc.example/[hidden] failed; bot[hidden]";
    expect(sent.map((m) => m.text)).toEqual([
      "BREAKS keeper on devnet started. A problem that lasts is reported here once, and again when it clears.",
      `BREAKS keeper on devnet: 1 new problem.\nNew:\n${alert}`,
    ]);
    expect(sent.map((m) => m.urgent)).toEqual([false, true]);
    expect(l.out.filter(([, m]) => m === "watchdog").map(([level, , e]) => [level, e?.message])).toEqual([
      ["info", "BREAKS keeper on devnet started. A problem that lasts is reported here once, and again when it clears."],
      ["error", `BREAKS keeper on devnet: 1 new problem.\nNew:\n${alert}`],
    ]);
    expect(send).not.toHaveBeenCalled();
  });
});
