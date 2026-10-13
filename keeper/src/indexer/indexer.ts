// The balance indexer: keeps `balance_events` complete and says, in `indexer_state`, up to when.
//
// How it stays complete. Tokens of a mint can only reach a token account from the mint (mint-to) or from another token
// account of the mint, and every such transaction names both accounts. So reading the mint and then every token
// account that shows up, each from its first transaction, reads every transfer; nothing needs to be guessed or
// discovered in any other way. An account that holds nothing cannot send anything, so it is only read again after a
// transaction gave it tokens.
//
// Work is cut into small steps (one page of signatures for one account), each saved before the next, so a crash or a
// failing node only costs the step in progress. Everything it reads is finalized.

import type { BalanceEvent } from "../eligibility/twab.js";
import type { Job, Logger } from "../job.js";
import type { Address } from "../solana/pubkey.js";
import { readTransaction } from "./parse.js";
import type { TokenReader } from "./reader.js";
import type { IndexedAccount, SqlIndexStore } from "./store.js";

export interface IndexerOptions {
  mint: Address;
  /** Account passes are repeated at least this often (seconds). */
  intervalSecs: number;
  /**
   * A pass only claims what happened this long before it started, so a transaction that had not finalized when the
   * pass began is still covered by the claim. Also covers a keeper clock that runs a little ahead of the chain's.
   */
  lagSecs: number;
  /** How long after a break's window the eligibility job waits (`INDEXER_SETTLE_SECS`): the indexer must reach it. */
  settleSecs: number;
  /** Node calls per run, a signature page or a transaction each. A step finishes even if it goes over. */
  callsPerRun: number;
  /** Signatures read per page. */
  pageSize: number;
}

export interface IndexerReport {
  steps: number;
  calls: number;
  events: number;
  indexedUntil: number | undefined;
}

export class TokenIndexer {
  constructor(
    private readonly deps: { reader: TokenReader; store: SqlIndexStore; log: Logger; options: IndexerOptions },
  ) {}

  /** One run: reads what is due until the call budget is used, then moves the watermark. `now` is unix seconds. */
  async run(now: number): Promise<IndexerReport> {
    const { store, options } = this.deps;
    await store.ensureMint(options.mint);

    // Normally every account is read again after `intervalSecs`. A break whose window has ended needs the indexer to
    // have covered the end of the window plus the settle margin, so it is read right away, once that time is safely past.
    let target = now - options.lagSecs - options.intervalSecs;
    for (const end of await store.pendingWindowEnds()) {
      const needed = end + options.settleSecs;
      if (needed <= now - options.lagSecs) target = Math.max(target, needed);
    }

    const report: IndexerReport = { steps: 0, calls: 0, events: 0, indexedUntil: undefined };
    while (report.calls < options.callsPerRun) {
      const account = await store.next(target);
      if (!account) break;
      const used = await this.step(account, now, report);
      report.calls += used;
      report.steps += 1;
    }
    report.indexedUntil = await store.advanceWatermark();
    return report;
  }

  /** Reads one page of one account's signatures. Returns the node calls it made. */
  private async step(account: IndexedAccount, now: number, report: IndexerReport): Promise<number> {
    const { reader, store, options } = this.deps;
    const cover = account.passCover ?? now - options.lagSecs;

    const page = await reader.signatures(account.address, {
      limit: options.pageSize,
      ...(account.resumeBefore !== undefined ? { before: account.resumeBefore } : {}),
      ...(account.untilSig !== undefined ? { until: account.untilSig } : {}),
    });
    let calls = 1;

    // Failed transactions changed no balance. Transactions already stored (an earlier account's pass found them) are not fetched again.
    const worth = page.filter((s) => !s.failed);
    const have = await store.known(worth.map((s) => s.signature));
    const wanted = worth.filter((s) => !have.has(s.signature)).map((s) => s.signature);
    if (wanted.length > 0) {
      const transactions = await reader.transactions(wanted);
      calls += wanted.length;
      const events: BalanceEvent[] = [];
      const found: Address[] = [];
      transactions.forEach((tx, i) => {
        const effects = readTransaction(tx, options.mint, wanted[i] as string);
        events.push(...effects.events);
        found.push(...effects.accounts);
      });
      // The accounts they name first, then the events, then the cursor. A crash in between repeats work and never skips
      // it: a transaction whose events are stored is not fetched again, so its accounts must already be noted by then.
      await store.addAccounts(found);
      await store.addEvents(events);
      report.events += events.length;
    }

    const newest = account.passNewest ?? page[0]?.signature;
    const last = page[page.length - 1];
    if (page.length >= options.pageSize && last) {
      await store.saveProgress(account.address, { resumeBefore: last.signature, passNewest: newest as string, passCover: cover });
    } else {
      await store.finishPass(account.address, { untilSig: newest, cover });
    }
    return calls;
  }
}

/** The indexer as a keeper job. */
export function indexerJob(opts: { indexer: TokenIndexer; intervalMs: number; log: Logger }): Job {
  return {
    name: "indexer",
    intervalMs: opts.intervalMs,
    async run(ctx) {
      const report = await opts.indexer.run(Math.floor(ctx.now().getTime() / 1000));
      if (report.steps > 0) opts.log.info("indexer ran", { ...report });
    },
  };
}
