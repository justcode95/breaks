// The watchdog job: once a minute it looks at how the other jobs' runs went, where every break the keeper is working on
// stands on chain, the keeper's SOL and the program's pause, and tells each channel (the log, and Telegram when set up) about
// a problem once when it has lasted long enough and once when it clears. It only reads: it sends no transaction and writes no
// row. What it remembers (which alerts each channel was told, when it first saw a break in a stage) is in memory: after a
// restart it says it started, and a problem that is still there is reported again.

import type { Job, JobContext, Logger } from "../job.js";
import type { Sql } from "../packs/sql-store.js";
import type { AccountReader } from "../pipeline/chain.js";
import type { ActiveBreak } from "../pipeline/pipeline.js";
import { SqlBreakRepo } from "../pipeline/repo.js";
import { OraoVrf } from "../pipeline/vrf.js";
import { type BreakStatus, type Programs, breakAddress, configAddress, decodeBreak, decodeBreaksConfig } from "../solana/breaks.js";
import type { Address } from "../solana/pubkey.js";
import { keeperSolNeed } from "../solana/rent.js";
import type { WalletReader } from "../sweep/wallet.js";
import type { Alerter } from "./alerter.js";
import { AlertBook } from "./book.js";
import type { JobStatus } from "./health.js";
import { type Alert, type BreakFacts, WATCHDOG_JOB, type WatchLimits, breakAlert, jobAlerts, keeperAlert, pausedAlert, unreadAlert } from "./rules.js";

/** What the watchdog reads from the keeper's database. */
export interface WatchStore {
  /** The breaks the keeper is still working on (on chain, not delivered, cancelled or refunded). */
  activeBreaks(): Promise<ActiveBreak[]>;
  /** How many of a break's cards are delivered (`breaks.id`). */
  deliveredCount(breakId: string): Promise<number>;
}

export class SqlWatchStore implements WatchStore {
  private readonly repo: SqlBreakRepo;
  constructor(private readonly sql: Sql) {
    this.repo = new SqlBreakRepo(sql);
  }

  activeBreaks(): Promise<ActiveBreak[]> {
    return this.repo.activeBreaks();
  }

  async deliveredCount(breakId: string): Promise<number> {
    const { rows } = await this.sql.query<{ n: number }>("select count(*)::int as n from deliveries where break_id = $1::bigint and status = 'confirmed'", [breakId]);
    return rows[0]?.n ?? 0;
  }
}

export interface WatchdogDeps {
  /** Reads the breaks program's accounts and ORAO's network state. */
  chain: AccountReader;
  wallets: WalletReader;
  keeper: Address;
  programs: Programs;
  vrfProgram: Address;
  /** BREAK_FREE_SPOTS: a free spot is one more claim the keeper pays for. */
  freeSpots: number;
  store: WatchStore;
  /** How the other jobs' runs went (the runner's view). Without it, jobs are not watched. */
  jobs?: { snapshot(): JobStatus[] };
  limits: WatchLimits;
  /** Where messages go. The first is the log and always works; the rest are tried and, if they fail, tried again next run. */
  channels: readonly Alerter[];
  /** BookOptions for every channel: the title and how often what stays open is listed again. */
  title: string;
  repeatMs: number;
  /** Hides secrets (the node's url, the database's password, the bot token) in anything that is sent. */
  scrub: (text: string) => string;
  log: Logger;
  now: () => Date;
}

type Source = "chain" | "database";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class Watchdog {
  private readonly books: { alerter: Alerter; book: AlertBook }[];
  /** When each break was first seen in its current status (by on-chain id). A break that leaves the list never comes back. */
  private readonly seen = new Map<bigint, { status: BreakFacts["status"]; since: Date }>();
  /** Since when a source could not be read, and why. */
  private readonly unread = new Map<Source, { since: Date; error: string }>();
  /** The last alerts each group gave, used again while what the group needs cannot be read (so nothing clears by accident). */
  private last = { chain: [] as Alert[], breaks: [] as Alert[] };

  constructor(private readonly deps: WatchdogDeps) {
    this.books = deps.channels.map((alerter) => ({ alerter, book: new AlertBook({ title: deps.title, repeatMs: deps.repeatMs }) }));
  }

  /** The alerts that are open now. Never throws: what cannot be read is itself a problem, reported once it lasts. */
  async alerts(): Promise<Alert[]> {
    const { limits, now } = this.deps;
    const at = now();
    const failed = new Map<Source, string>();
    const fail = (source: Source, err: unknown) => {
      if (!failed.has(source)) failed.set(source, message(err));
    };

    const chain = await this.chainAlerts().catch((err) => (fail("chain", err), undefined));
    if (chain) this.last.chain = chain;
    const breaks = await this.breakAlerts(at, fail);
    if (breaks) this.last.breaks = breaks;

    const unread: Alert[] = [];
    for (const source of ["chain", "database"] as const) {
      const error = failed.get(source);
      if (error === undefined) {
        this.unread.delete(source);
        continue;
      }
      const u = this.unread.get(source) ?? { since: at, error };
      u.error = error;
      this.unread.set(source, u);
      const a = unreadAlert(source, u.since, error, at, limits);
      if (a) unread.push(a);
    }

    const jobs = this.deps.jobs ? jobAlerts(this.deps.jobs.snapshot(), at, limits) : [];
    return [...jobs, ...this.last.chain, ...this.last.breaks, ...unread].map((a) => ({ key: a.key, text: this.deps.scrub(a.text) }));
  }

  /** The pause and the keeper's SOL. */
  private async chainAlerts(): Promise<Alert[]> {
    const { chain, wallets, keeper, programs, vrfProgram, freeSpots } = this.deps;
    const out: Alert[] = [];
    const config = await chain.getAccountData(configAddress(programs));
    // An uninitialized program is the pipeline's to report (every break is a problem until it is set up).
    if (config) {
      const paused = pausedAlert(decodeBreaksConfig(config).paused);
      if (paused) out.push(paused);
    }
    // ORAO's fee is part of what a break costs; a network state that cannot be read leaves it out (the pipeline reports that).
    const fee = await new OraoVrf(chain, vrfProgram)
      .state()
      .then((s) => s.requestFee)
      .catch(() => 0n);
    const sol = keeperAlert(keeper, await wallets.lamports(keeper), keeperSolNeed(freeSpots, fee));
    if (sol) out.push(sol);
    return out;
  }

  /** Every break that has stayed too long in its stage; undefined when the breaks could not be read. */
  private async breakAlerts(at: Date, fail: (source: Source, err: unknown) => void): Promise<Alert[] | undefined> {
    const { store, chain, programs, limits } = this.deps;
    let active: ActiveBreak[];
    try {
      active = await store.activeBreaks();
    } catch (err) {
      fail("database", err);
      return undefined;
    }
    const facts: BreakFacts[] = [];
    try {
      for (const a of active) {
        const data = await chain.getAccountData(breakAddress(programs, a.onchainId));
        const b = data ? decodeBreak(data) : undefined;
        const status: BreakFacts["status"] = b ? b.status : "missing";
        facts.push({
          id: a.onchainId,
          status,
          seenSince: this.sighting(a.onchainId, status, at),
          closesAt: b?.closesAt ?? 0n,
          randomnessAttempt: b?.randomnessAttempt ?? 0,
          randomnessRequestedAt: b?.randomnessRequestedAt ?? 0n,
          seededAt: b?.seededAt ?? 0n,
          poolSize: b?.poolSize ?? 0,
        });
      }
    } catch (err) {
      fail("chain", err);
      return undefined;
    }

    const out: Alert[] = [];
    for (const [i, f] of facts.entries()) {
      if (f.status === "Drawn") {
        try {
          f.delivered = await store.deliveredCount((active[i] as ActiveBreak).id);
        } catch (err) {
          // The alert still goes out, without the count.
          fail("database", err);
        }
      }
      const a = breakAlert(f, at, limits);
      if (a) out.push(a);
    }
    return out;
  }

  private sighting(id: bigint, status: BreakStatus | "missing", at: Date): Date {
    const s = this.seen.get(id);
    if (s && s.status === status) return s.since;
    this.seen.set(id, { status, since: at });
    return at;
  }

  /** One run: works out the alerts and tells each channel what it does not know yet. */
  async run(): Promise<void> {
    const alerts = await this.alerts();
    const at = this.deps.now();
    for (const { alerter, book } of this.books) {
      book.update(alerts);
      const out = book.message(at);
      if (!out) continue;
      try {
        await alerter.send({ text: out.text, urgent: out.urgent });
        book.delivered(out, at);
      } catch (err) {
        this.deps.log.error(`the watchdog could not send its message to ${alerter.name}; it tries again next run`, { error: this.deps.scrub(message(err)) });
      }
    }
  }
}

export function watchdogJob(deps: { watchdog: Watchdog; intervalMs: number }): Job {
  return {
    name: WATCHDOG_JOB,
    intervalMs: deps.intervalMs,
    async run(_ctx: JobContext) {
      await deps.watchdog.run();
    },
  };
}
