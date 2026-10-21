// Wires the jobs together: which stores, which providers, which chain. `index.ts` only starts it.
//
// Up to nine jobs, each idempotent and each starting from what it reads, never from a shared in-memory state:
//   pipeline   - the on-chain steps (commit_pool, randomness, free-spot claims) and the status mirror
//   pack-buyer - buys the packs of funded breaks
//   delivery   - sends the cards of drawn breaks
//   indexer    - reads every transfer of the token into `balance_events` and says how far it got (`indexer_state`)
//   scheduler  - creates the next break when the treasury can pay for its worst case, and copies breaks from the chain
//   fee-sweep  - (only when SWEEP_ENABLED) deposits the USDC in the keeper's wallet into the treasury, and swaps fee SOL to USDC when a swapper exists
//   publish    - (only when PUBLISH_DIR is set) writes each break's eligible wallets and cards as files named by the hashes the chain committed
//   x-bot      - (only when BOT_ENABLED) announces the reserve, the sale, the free-spot winners and the results on X, from finalized chain data
//   refunds    - sends `refund_spot` for every spot of a cancelled break, so buyers get their USDC back without coming to the website
// and, built apart by `buildWatchdog` and run on a loop of its own (`startKeeper` in run.ts) because it watches the runner:
//   watchdog   - reports, once, a job that keeps failing or never finishes, a break stuck in a stage, too little SOL or a
//                pause, to the log and (with ALERTS=telegram) a Telegram chat, and again when it clears

import { XBot, botJob } from "./bot/bot.js";
import { LogPoster, type Poster } from "./bot/poster.js";
import { SqlBotStore } from "./bot/store.js";
import { ChainWorld } from "./bot/world.js";
import { XPoster } from "./bot/x-poster.js";
import type { Config } from "./config.js";
import { Deliverer, deliveryJob } from "./delivery/deliverer.js";
import { DbPublisher, SqlEligibilityPlanner } from "./eligibility/planner.js";
import { MockCardTransfer } from "./delivery/mock-transfer.js";
import { indexerJob, TokenIndexer } from "./indexer/indexer.js";
import type { TokenReader } from "./indexer/reader.js";
import { SqlIndexStore } from "./indexer/store.js";
import { BreakScheduler, schedulerJob } from "./scheduler/scheduler.js";
import { SqlSchedulerStore } from "./scheduler/store.js";
import { FeeSweeper, feeSweepJob } from "./sweep/sweeper.js";
import { SqlSweepStore } from "./sweep/store.js";
import { RANDOMNESS_REQUEST_ACCOUNT_BYTES, rentExempt } from "./solana/rent.js";
import type { WalletReader } from "./sweep/wallet.js";
import { SqlDeliveryStore } from "./delivery/sql-store.js";
import type { Job, Logger } from "./job.js";
import { PackBuyer, packBuyerJob } from "./packs/buyer.js";
import { BreakRefunder, refundJob } from "./refund/refunder.js";
import { PublishExporter, publishJob } from "./publish/exporter.js";
import { DirSink } from "./publish/sink.js";
import { SqlPublishStore } from "./publish/store.js";
import { MockPackProvider } from "./packs/mock-provider.js";
import { SqlPackStore, type Sql } from "./packs/sql-store.js";
import type { AccountReader, ChainClient } from "./pipeline/chain.js";
import { SqlEligibilityStore } from "./pipeline/eligibility-store.js";
import { pipelineJob } from "./pipeline/job.js";
import { OraoVrf } from "./pipeline/vrf.js";
import { BreakPipeline } from "./pipeline/pipeline.js";
import { SqlBreakRepo } from "./pipeline/repo.js";
import { DrawnBreaks, FundedBreaks } from "./pipeline/sources.js";
import { configAddress, decodeBreaksConfig } from "./solana/breaks.js";
import type { Address } from "./solana/pubkey.js";
import { scrubber } from "./doctor/report.js";
import { type Alerter, LogAlerter, TelegramAlerter } from "./watch/alerter.js";
import type { JobHealth } from "./watch/health.js";
import { SqlWatchStore, Watchdog, type WatchdogDeps, watchdogJob } from "./watch/watchdog.js";

/** The one thing the keeper needs from a `pg` pool; kept narrow so tests can use another Postgres. */
export function sqlFromPool(pool: { query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }> }): Sql {
  return {
    async query<T>(text: string, params?: unknown[]) {
      const result = await pool.query(text, params);
      return { rows: result.rows as T[] };
    },
  };
}

/** Tables, columns and values the jobs rely on, one per migration; a database that lacks one is not ready. */
export async function checkSchema(sql: Sql): Promise<string[]> {
  const problems: string[] = [];
  const have = async (q: string, params: unknown[] = []) => ((await sql.query<{ n: string }>(q, params)).rows[0]?.n ?? "0") !== "0";

  for (const table of ["breaks", "spots", "packs", "deliveries", "twab_snapshots", "eligibility_lists", "balance_events", "exclusions"]) {
    if (!(await have("select count(*)::text as n from information_schema.tables where table_schema = 'public' and table_name = $1", [table]))) {
      problems.push(`table ${table} is missing (migration 0001)`);
    }
  }
  const columns: [string, string, string][] = [
    ["packs", "expiry", "0002"],
    ["pack_attempts", "signature", "0002"],
    ["deliveries", "adopted", "0003"],
    ["delivery_attempts", "signature", "0003"],
    ["indexer_state", "indexed_until", "0005"],
    ["published_documents", "sha256", "0005"],
    ["indexed_accounts", "until_sig", "0006"],
    ["fee_swaps", "signature", "0007"],
    ["bot_posts", "valid_until", "0008"],
    ["eligibility_lists", "exclusions_uri", "0010"],
  ];
  for (const [table, column, migration] of columns) {
    const ok = await have(
      "select count(*)::text as n from information_schema.columns where table_schema = 'public' and table_name = $1 and column_name = $2",
      [table, column],
    );
    if (!ok) problems.push(`${table}.${column} is missing (migration ${migration})`);
  }
  // 0004: the status check must know `drawn`. Only look if the table is there at all.
  if (await have("select count(*)::text as n from information_schema.tables where table_schema = 'public' and table_name = 'breaks'")) {
    const ok = await have(
      `select count(*)::text as n from pg_constraint
        where conrelid = 'breaks'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%drawn%'`,
    );
    if (!ok) problems.push("breaks.status does not accept 'drawn' (migration 0004)");
    // 0009: a cancelled break whose spots are all refunded ends as `refunded`.
    const refunded = await have(
      `select count(*)::text as n from pg_constraint
        where conrelid = 'breaks'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%refunded%'`,
    );
    if (!refunded) problems.push("breaks.status does not accept 'refunded' (migration 0009)");
  }
  // 0006: a token account that changes owner has two rows for one transaction, so the owner is part of the key.
  if (await have("select count(*)::text as n from information_schema.tables where table_schema = 'public' and table_name = 'balance_events'")) {
    const ok = await have(
      `select count(*)::text as n from pg_constraint
        where conrelid = 'balance_events'::regclass and contype = 'u' and pg_get_constraintdef(oid) like '%owner%'`,
    );
    if (!ok) problems.push("balance_events is not unique per owner (migration 0006)");
  }
  return problems;
}

/**
 * Refuses a TOKEN_MINT that is not an initialized token mint on this cluster. With a wrong address the indexer would
 * find nothing, claim to have read everything, and every break would get an empty eligibility list.
 */
export async function verifyMint(chain: AccountReader, mint: Address): Promise<void> {
  const data = await chain.getAccountData(mint);
  if (!data) throw new Error(`TOKEN_MINT ${mint} does not exist on this cluster`);
  // A mint is 82 bytes (is_initialized at 45). Token-2022 mints are longer (padded to 165, then the account type 1 = mint).
  const classic = data.length === 82 && data[45] === 1;
  const extended = data.length >= 166 && data[45] === 1 && data[165] === 1;
  if (!classic && !extended) throw new Error(`TOKEN_MINT ${mint} is not an initialized token mint`);
}

/**
 * Refuses to run with the wrong key: if the breaks program is initialized, its keeper must be the key we sign
 * with, or every step would be refused. Returns false if the program is not initialized yet.
 */
export async function verifyKeeperIdentity(chain: AccountReader, config: Pick<Config, "programs">, keeper: Address): Promise<boolean> {
  const data = await chain.getAccountData(configAddress(config.programs));
  if (!data) return false;
  const onChain = decodeBreaksConfig(data).keeper;
  if (onChain !== keeper) {
    throw new Error(`this keeper key is ${keeper} but the breaks program expects ${onChain} as its keeper`);
  }
  return true;
}

/** The rent of ORAO's request account (749 bytes on devnet), paid by the keeper on top of ORAO's fee: about 0.0061 SOL. */
export const RANDOMNESS_REQUEST_RENT = rentExempt(RANDOMNESS_REQUEST_ACCOUNT_BYTES);

/**
 * Says what ORAO charges and where it goes, from ORAO's network state, and warns if the keeper cannot pay for a request.
 * A network state that cannot be read is reported, not fatal: the other jobs do not need it, and a request waits until it can.
 */
export async function reportVrf(deps: Pick<AppDeps, "chain" | "wallets" | "keeper" | "log">, program: Address): Promise<void> {
  const { chain, wallets, keeper, log } = deps;
  try {
    const state = await new OraoVrf(chain, program).state();
    log.info("ORAO VRF", {
      program,
      requestFee: String(state.requestFee),
      treasury: state.treasury,
      oracles: state.fulfillmentAuthorities.length,
      tokenFeeConfigured: state.tokenFee !== undefined,
    });
    const have = await wallets.lamports(keeper);
    const needed = state.requestFee + RANDOMNESS_REQUEST_RENT;
    if (have < needed) {
      log.error("the keeper wallet cannot pay for a randomness request: top it up with SOL", { keeper, lamports: String(have), needed: String(needed) });
    }
  } catch (err) {
    log.error("cannot read ORAO's network state; randomness requests will wait until it can be read", { error: err instanceof Error ? err.message : String(err) });
  }
}

export interface AppDeps {
  sql: Sql;
  chain: ChainClient;
  /** Reads token history from a node (finalized data only). */
  reader: TokenReader;
  /** Reads a wallet's SOL balance (for the fee sweep). */
  wallets: WalletReader;
  /** The keeper's address (the key `chain` signs with). */
  keeper: Address;
  log: Logger;
  now?: () => Date;
  /** Reads accounts at `finalized`, for the X bot (required when it is on): it announces nothing that could roll back. */
  finalized?: AccountReader;
  /** Where the X bot's posts go. Default: built from the config (a dry run, or X). */
  poster?: Poster;
}

export type AppConfig = Pick<Config, "programs" | "vrf" | "packProvider" | "cardTransfer" | "mockPackPrice" | "jobIntervalMs" | "eligibility" | "indexer" | "scheduler" | "sweep" | "publish" | "bot">;

/** The X bot over finalized chain data and the keeper's own tables, posting to X or (the default) only to the log. */
function buildBot(config: AppConfig, deps: AppDeps, now: () => Date): XBot {
  const { sql, finalized, log } = deps;
  if (!finalized) throw new Error("the X bot needs a chain reader at the finalized commitment");
  let poster = deps.poster;
  if (!poster) {
    if (config.bot.poster === "x") {
      if (!config.bot.x) throw new Error("BOT_POSTER=x needs the X_* credentials");
      poster = new XPoster({ credentials: config.bot.x.credentials, ...(config.bot.x.baseUrl !== undefined ? { baseUrl: config.bot.x.baseUrl } : {}) });
      log.info("X bot on: posts are sent to X", { dailyLimit: config.bot.limits.maxPerDay, minGapSecs: config.bot.limits.minGapSecs });
    } else {
      poster = new LogPoster(log);
      log.info("X bot on as a DRY RUN: posts are only written to the log (BOT_POSTER=log)");
    }
  }
  const store = new SqlBotStore(sql);
  return new XBot({
    scope: config.programs.breaks,
    world: new ChainWorld({ chain: finalized, programs: config.programs, template: config.scheduler.template, store, lookback: config.bot.lookback }),
    store,
    poster,
    settings: config.bot.settings,
    limits: config.bot.limits,
    log,
    now,
  });
}

/** Checks the database and the key, then builds the jobs. Throws, before any job runs, if something is not ready. */
export async function buildJobs(config: AppConfig, deps: AppDeps): Promise<Job[]> {
  const { sql, chain, reader, wallets, keeper, log } = deps;
  const now = deps.now ?? (() => new Date());

  const problems = await checkSchema(sql);
  if (problems.length > 0) throw new Error(`the database is not ready: ${problems.join("; ")}`);

  await verifyMint(chain, config.indexer.mint);
  await reportVrf(deps, config.vrf.program);

  if (await verifyKeeperIdentity(chain, config, keeper)) {
    log.info("keeper key matches the breaks program", { keeper });
  } else {
    log.error("the breaks program is not initialized on this cluster; breaks will be reported as problems until it is", { keeper });
  }

  // Only mocks exist (config.packProvider and config.cardTransfer are "mock"). Say so loudly.
  log.info("MOCK pack provider and MOCK card transfer: no real packs are bought and no real cards move", {
    packProvider: config.packProvider,
    cardTransfer: config.cardTransfer,
  });

  const packs = new SqlPackStore(sql);
  const repo = new SqlBreakRepo(sql);
  const provider = new MockPackProvider(config.mockPackPrice);
  // The mock treats every card as held by the buyer wallet until it is sent, so it needs no memory shared with the
  // pack provider and a restart does not lose a card (delivered cards are remembered by the database).
  const cards = new MockCardTransfer(async () => {
    const data = await chain.getAccountData(configAddress(config.programs));
    if (!data) throw new Error("the breaks program is not initialized");
    return decodeBreaksConfig(data).buyer;
  });

  const sourceDeps = { chain, programs: config.programs, repo, packs, log };
  const pipeline = new BreakPipeline({
    chain,
    programs: config.programs,
    keeper,
    vrf: new OraoVrf(chain, config.vrf.program),
    eligibility: new SqlEligibilityStore(sql),
    planner: new SqlEligibilityPlanner(sql, new DbPublisher(sql), {
      policy: { minTwab: config.eligibility.minTwab, ...(config.eligibility.capPerWallet !== undefined ? { capPerWallet: config.eligibility.capPerWallet } : {}) },
      settleSecs: config.eligibility.settleSecs,
    }),
    packs,
    cards,
    log,
    now,
  });

  const intervalMs = config.jobIntervalMs;
  const indexer = new TokenIndexer({
    reader,
    store: new SqlIndexStore(sql),
    log,
    options: {
      mint: config.indexer.mint,
      intervalSecs: config.indexer.intervalSecs,
      lagSecs: config.indexer.lagSecs,
      settleSecs: config.eligibility.settleSecs,
      callsPerRun: config.indexer.callsPerRun,
      pageSize: config.indexer.pageSize,
    },
  });
  const scheduler = new BreakScheduler({
    chain,
    programs: config.programs,
    keeper,
    store: new SqlSchedulerStore(sql),
    template: config.scheduler.template,
    enabled: config.scheduler.enabled,
    wallet: wallets,
    now,
  });
  const jobs: Job[] = [indexerJob({ indexer, intervalMs, log }), schedulerJob({ scheduler, intervalMs })];
  if (config.sweep.enabled) {
    // No swapper exists yet (Jupiter is a mainnet service): the sweep deposits USDC that is already in the keeper's wallet.
    log.info("fee sweep on, without a swap provider: USDC in the keeper's wallet is deposited into the treasury", { wallet: keeper });
    const sweeper = new FeeSweeper({
      chain,
      treasuryProgram: config.programs.treasury,
      wallet: keeper,
      wallets,
      store: new SqlSweepStore(sql),
      policy: config.sweep.policy,
      now,
    });
    jobs.push(feeSweepJob({ sweeper, intervalMs }));
  }
  if (config.publish.dir) {
    if (!deps.finalized) throw new Error("publishing the lists needs a chain reader at the finalized commitment");
    log.info("publishing eligibility lists, the balance events, records and exclusion lists behind them, card pools and the ledgers of delivered breaks as files", { dir: config.publish.dir });
    const exporter = new PublishExporter({ store: new SqlPublishStore(sql), sink: new DirSink(config.publish.dir), chain: deps.finalized, programs: config.programs });
    jobs.push(publishJob({ exporter, intervalMs: config.publish.intervalSecs * 1000 }));
  }
  if (config.bot.enabled) jobs.push(botJob({ bot: buildBot(config, deps, now), intervalMs: config.bot.intervalSecs * 1000 }));
  return [
    ...jobs,
    pipelineJob({ pipeline, repo, intervalMs }),
    packBuyerJob({ buyer: new PackBuyer({ provider, store: packs, log }), source: new FundedBreaks(sourceDeps), intervalMs }),
    deliveryJob({
      deliverer: new Deliverer({ transfer: cards, store: new SqlDeliveryStore(sql), log }),
      source: new DrawnBreaks(sourceDeps),
      intervalMs,
    }),
    refundJob({ refunder: new BreakRefunder({ chain, programs: config.programs, repo, log }), intervalMs }),
  ];
}

export type WatchConfig = Pick<Config, "cluster" | "programs" | "vrf" | "eligibility" | "scheduler" | "watch">;

/**
 * What the watchdog is built with: every setting it takes from the configuration, the channels (the log, and Telegram with
 * ALERTS=telegram) and the secrets it hides (`secrets`, such as the node's url and the database's password, and the bot token).
 */
export function watchdogDeps(
  config: WatchConfig,
  deps: Pick<AppDeps, "sql" | "chain" | "wallets" | "keeper" | "log" | "now"> & { health?: JobHealth; secrets?: readonly string[]; telegram?: Alerter },
): WatchdogDeps {
  const { watch } = config;
  const channels: Alerter[] = [new LogAlerter(deps.log)];
  if (watch.alerts === "telegram") {
    if (!watch.telegram) throw new Error("ALERTS=telegram needs ALERT_TELEGRAM_BOT_TOKEN and ALERT_TELEGRAM_CHAT_ID");
    channels.push(deps.telegram ?? new TelegramAlerter(watch.telegram));
  }
  return {
    chain: deps.chain,
    wallets: deps.wallets,
    keeper: deps.keeper,
    programs: config.programs,
    vrfProgram: config.vrf.program,
    freeSpots: config.scheduler.template.freeSpots,
    store: new SqlWatchStore(deps.sql),
    ...(deps.health ? { jobs: deps.health } : {}),
    limits: { afterMs: watch.afterMins * 60_000, settleSecs: config.eligibility.settleSecs },
    channels,
    title: `BREAKS keeper on ${config.cluster}`,
    repeatMs: watch.repeatHours * 3_600_000,
    scrub: scrubber([...(deps.secrets ?? []), ...(watch.telegram ? [watch.telegram.token] : [])]),
    log: deps.log,
    now: deps.now ?? (() => new Date()),
  };
}

/** The watchdog job, which watches the runner: pass the same `JobHealth` to the runner (`startKeeper` does). It only reads. */
export function buildWatchdog(config: WatchConfig, deps: Parameters<typeof watchdogDeps>[1]): Job {
  const built = watchdogDeps(config, deps);
  if (built.channels.length > 1) {
    deps.log.info("watchdog on: alerts go to the log and to a Telegram chat", { chat: config.watch.telegram?.chatId, afterMins: config.watch.afterMins });
  } else {
    deps.log.info("watchdog on: alerts only go to the log (ALERTS=log)", { afterMins: config.watch.afterMins });
  }
  return watchdogJob({ watchdog: new Watchdog(built), intervalMs: config.watch.intervalSecs * 1000 });
}
