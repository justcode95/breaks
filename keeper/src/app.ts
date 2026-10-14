// Wires the jobs together: which stores, which providers, which chain. `index.ts` only starts it.
//
// Up to six jobs, each idempotent and each starting from what it reads, never from a shared in-memory state:
//   pipeline   - the on-chain steps (commit_pool, randomness, free-spot claims) and the status mirror
//   pack-buyer - buys the packs of funded breaks
//   delivery   - sends the cards of drawn breaks
//   indexer    - reads every transfer of the token into `balance_events` and says how far it got (`indexer_state`)
//   scheduler  - creates the next break when the treasury can pay for its worst case, and copies breaks from the chain
//   fee-sweep  - (only when SWEEP_ENABLED) deposits the USDC in the keeper's wallet into the treasury, and swaps fee SOL to USDC when a swapper exists

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
import type { WalletReader } from "./sweep/wallet.js";
import { SqlDeliveryStore } from "./delivery/sql-store.js";
import type { Job, Logger } from "./job.js";
import { PackBuyer, packBuyerJob } from "./packs/buyer.js";
import { MockPackProvider } from "./packs/mock-provider.js";
import { SqlPackStore, type Sql } from "./packs/sql-store.js";
import type { ChainClient } from "./pipeline/chain.js";
import { SqlEligibilityStore } from "./pipeline/eligibility-store.js";
import { pipelineJob } from "./pipeline/job.js";
import { OraoVrf } from "./pipeline/vrf.js";
import { BreakPipeline } from "./pipeline/pipeline.js";
import { SqlBreakRepo } from "./pipeline/repo.js";
import { DrawnBreaks, FundedBreaks } from "./pipeline/sources.js";
import { configAddress, decodeBreaksConfig } from "./solana/breaks.js";
import type { Address } from "./solana/pubkey.js";

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
export async function verifyMint(chain: ChainClient, mint: Address): Promise<void> {
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
export async function verifyKeeperIdentity(chain: ChainClient, config: Pick<Config, "programs">, keeper: Address): Promise<boolean> {
  const data = await chain.getAccountData(configAddress(config.programs));
  if (!data) return false;
  const onChain = decodeBreaksConfig(data).keeper;
  if (onChain !== keeper) {
    throw new Error(`this keeper key is ${keeper} but the breaks program expects ${onChain} as its keeper`);
  }
  return true;
}

/** About what the rent of ORAO's request account costs (748 bytes), paid by the keeper on top of ORAO's fee. */
export const RANDOMNESS_REQUEST_RENT = 6_100_000n;

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
}

export type AppConfig = Pick<Config, "programs" | "vrf" | "packProvider" | "cardTransfer" | "mockPackPrice" | "jobIntervalMs" | "eligibility" | "indexer" | "scheduler" | "sweep">;

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
  return [
    ...jobs,
    pipelineJob({ pipeline, repo, intervalMs }),
    packBuyerJob({ buyer: new PackBuyer({ provider, store: packs, log }), source: new FundedBreaks(sourceDeps), intervalMs }),
    deliveryJob({
      deliverer: new Deliverer({ transfer: cards, store: new SqlDeliveryStore(sql), log }),
      source: new DrawnBreaks(sourceDeps),
      intervalMs,
    }),
  ];
}
