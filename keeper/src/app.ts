// Wires the jobs together: which stores, which providers, which chain. `index.ts` only starts it.
//
// Three jobs, each idempotent and each starting from what it reads, never from a shared in-memory state:
//   pipeline   - the on-chain steps (commit_pool, randomness, free-spot claims) and the status mirror
//   pack-buyer - buys the packs of funded breaks
//   delivery   - sends the cards of drawn breaks
// Creating a break (the scheduler) and filling `balance_events` / `indexer_state` (the balance indexer) are not built
// yet. Until they are, a break has to be created by hand, and nothing is eligible until the indexer has run.

import type { Config } from "./config.js";
import { Deliverer, deliveryJob } from "./delivery/deliverer.js";
import { DbPublisher, SqlEligibilityPlanner } from "./eligibility/planner.js";
import { MockCardTransfer } from "./delivery/mock-transfer.js";
import { SqlDeliveryStore } from "./delivery/sql-store.js";
import type { Job, Logger } from "./job.js";
import { PackBuyer, packBuyerJob } from "./packs/buyer.js";
import { MockPackProvider } from "./packs/mock-provider.js";
import { SqlPackStore, type Sql } from "./packs/sql-store.js";
import type { ChainClient } from "./pipeline/chain.js";
import { SqlEligibilityStore } from "./pipeline/eligibility-store.js";
import { pipelineJob } from "./pipeline/job.js";
import { BreakPipeline } from "./pipeline/pipeline.js";
import { SqlBreakRepo } from "./pipeline/repo.js";
import { DrawnBreaks, FundedBreaks } from "./pipeline/sources.js";
import { configAddress, decodeBreaksConfig, oraoNetworkState } from "./solana/breaks.js";
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
  return problems;
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

export interface AppDeps {
  sql: Sql;
  chain: ChainClient;
  /** The keeper's address (the key `chain` signs with). */
  keeper: Address;
  log: Logger;
  now?: () => Date;
}

export type AppConfig = Pick<Config, "programs" | "vrf" | "packProvider" | "cardTransfer" | "mockPackPrice" | "jobIntervalMs" | "eligibility">;

/** Checks the database and the key, then builds the jobs. Throws, before any job runs, if something is not ready. */
export async function buildJobs(config: AppConfig, deps: AppDeps): Promise<Job[]> {
  const { sql, chain, keeper, log } = deps;
  const now = deps.now ?? (() => new Date());

  const problems = await checkSchema(sql);
  if (problems.length > 0) throw new Error(`the database is not ready: ${problems.join("; ")}`);

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
    vrf: { program: config.vrf.program, networkState: oraoNetworkState(config.vrf.program), treasury: config.vrf.treasury },
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
  return [
    pipelineJob({ pipeline, repo, intervalMs }),
    packBuyerJob({ buyer: new PackBuyer({ provider, store: packs, log }), source: new FundedBreaks(sourceDeps), intervalMs }),
    deliveryJob({
      deliverer: new Deliverer({ transfer: cards, store: new SqlDeliveryStore(sql), log }),
      source: new DrawnBreaks(sourceDeps),
      intervalMs,
    }),
  ];
}
