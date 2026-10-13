// The pack buyer: one pack per spot, bought from the buyer wallet, without ever buying one twice.
//
// Per pack, a state machine whose every step is saved before the next one starts:
//
//   planned ──prepare, save attempt, submit──▶ submitted ──status──▶ confirmed ──reveal──▶ pulled
//      ▲                                          │ expired / failed
//      └──────────────────────────────────────────┘ (a new attempt, up to `maxAttempts`, then `failed`)
//
// The rules that keep money safe (CLAUDE.md, "Pack buyer"):
//  - An attempt (its signature and expiry) is saved BEFORE the purchase is sent. After any crash the saved
//    signature says what to look for, so nothing is ever sent "blind".
//  - A new purchase for an index is only built when the saved one is known to have failed or can never land
//    (`expired`), and only after the buyer wallet's history has been searched for this index.
//  - Starting an attempt is a compare-and-set in the store, so two workers cannot both buy for one index.
//  - The live price is checked against the cap by the provider and again here.

import type { Job, JobContext, Logger } from "../job.js";
import { type PackKey, type PackProvider, PriceAboveCapError, keyString } from "./provider.js";
import type { PackRow, PackStore } from "./store.js";

export interface BreakPlan {
  /** `breaks.id` as text. */
  breakId: string;
  /** Packs to buy: sold paid spots plus drawn free spots (`pool_size` on-chain). */
  poolSize: number;
  machine: string;
  /** `max_pack_price` of the break, micro-USDC. */
  maxPackPrice: bigint;
  /** What the buyer wallet was funded with: `pool_size × max_pack_price`. */
  packBudget: bigint;
}

export interface BreakProgress {
  total: number;
  pulled: number;
  /** Purchases sent or confirmed that are not pulled yet. */
  inFlight: number;
  /** Not started, or waiting for a retry; see `PackRow.lastError`. */
  waiting: number;
  /** Given up after too many attempts. A policy decision (CLAUDE.md, "Partial-failure policy"), not the buyer's. */
  failed: number;
  /** Every pack pulled. */
  complete: boolean;
  /** Card mints of the pulled packs, in pack order. */
  cards: string[];
  /** Things that need a human, e.g. a pack that was bought twice. */
  anomalies: string[];
  packs: PackRow[];
}

export interface BuyerDeps {
  provider: PackProvider;
  store: PackStore;
  log: Logger;
  /** Purchases started per pack before it is given up. Default 5. */
  maxAttempts?: number;
}

interface Hop {
  row: PackRow;
  progressed: boolean;
}

/** What one `buyBreak` call knows. Kept off the instance so calls for different breaks can overlap. */
interface Run {
  plan: BreakPlan;
  anomalies: string[];
}

export class PackBuyer {
  private readonly maxAttempts: number;

  constructor(private readonly deps: BuyerDeps) {
    this.maxAttempts = deps.maxAttempts ?? 5;
  }

  /** Moves every pack of the break as far as it can go right now. Safe to call as often as you like. */
  async buyBreak(plan: BreakPlan): Promise<BreakProgress> {
    checkPlan(plan);
    const run: Run = { plan, anomalies: [] };
    for (let index = 0; index < plan.poolSize; index++) {
      const key = { breakId: plan.breakId, index };
      try {
        await this.advance(run, key);
      } catch (err) {
        // One pack's trouble (an RPC error, say) must not stop the others. The next run picks it up again.
        const message = err instanceof Error ? err.message : String(err);
        this.deps.log.error("pack step failed", { pack: keyString(key), error: message });
        await this.deps.store.setError(key, message);
      }
    }
    return this.progress(run);
  }

  private async progress({ plan, anomalies }: Run): Promise<BreakProgress> {
    const packs = await this.deps.store.listForBreak(plan.breakId);
    const count = (...s: PackRow["status"][]) => packs.filter((p) => s.includes(p.status)).length;
    const pulled = count("pulled");
    return {
      total: plan.poolSize,
      pulled,
      inFlight: count("submitted", "confirmed"),
      waiting: count("planned"),
      failed: count("failed"),
      complete: plan.poolSize > 0 && pulled === plan.poolSize,
      cards: packs.flatMap((p) => (p.status === "pulled" && p.cardMint ? [p.cardMint] : [])),
      anomalies,
      packs,
    };
  }

  private async advance(run: Run, key: PackKey): Promise<PackRow> {
    let row = await this.deps.store.ensure(key);
    // A pack can pass several states in one call (planned → submitted → confirmed → pulled); the cap only
    // guards against a loop that never settles.
    for (let hops = 0; hops < 8; hops++) {
      const next = await this.hop(run, row);
      row = next.row;
      if (!next.progressed) break;
    }
    return row;
  }

  private async hop(run: Run, row: PackRow): Promise<Hop> {
    switch (row.status) {
      case "planned":
        return this.startPurchase(run, row);
      case "submitted":
        return this.checkPurchase(run, row);
      case "confirmed":
        return this.revealCard(row);
      default:
        return { row, progressed: false };
    }
  }

  private async reload(key: PackKey): Promise<PackRow> {
    const row = await this.deps.store.get(key);
    if (!row) throw new Error(`pack ${keyString(key)} vanished`);
    return row;
  }

  /** planned → submitted. Looks in the wallet history first; builds a purchase only if there is none. */
  private async startPurchase(run: Run, row: PackRow): Promise<Hop> {
    const { plan } = run;
    const { provider, store, log } = this.deps;
    const key = row.key;

    const adopted = await this.adoptExisting(run, key);
    if (adopted) {
      const won = await store.startAttempt(key, { signature: adopted.signature, expiry: adopted.expiry });
      return { row: await this.reload(key), progressed: won };
    }

    let prepared;
    try {
      prepared = await provider.prepare(key, { machine: plan.machine, maxPrice: plan.maxPackPrice });
    } catch (err) {
      if (err instanceof PriceAboveCapError) {
        log.info("pack not bought: price above the cap", { pack: keyString(key), live: String(err.livePrice) });
        await store.setError(key, err.message);
        return { row: await this.reload(key), progressed: false };
      }
      throw err;
    }
    // Do not trust the provider with the money: re-check what it built.
    if (prepared.price <= 0n || prepared.price > plan.maxPackPrice) {
      throw new Error(`provider built a purchase for ${prepared.price}, outside 1..${plan.maxPackPrice}`);
    }
    if (!prepared.signature || !prepared.expiry) throw new Error("provider built a purchase without a signature or expiry");

    // Saved before anything is sent. Losing the race means another worker is buying this pack.
    const won = await store.startAttempt(key, {
      signature: prepared.signature,
      expiry: prepared.expiry,
      price: prepared.price,
    });
    if (!won) return { row: await this.reload(key), progressed: false };

    try {
      await provider.submit(prepared);
    } catch (err) {
      // It may or may not have landed. Not knowing is fine: `status` decides, and nothing is rebuilt until it does.
      const message = err instanceof Error ? err.message : String(err);
      log.error("pack purchase: submit failed, will check its status", { pack: keyString(key), error: message });
      await store.setError(key, `submit failed: ${message}`);
    }
    return { row: await this.reload(key), progressed: true };
  }

  /**
   * A purchase for this pack that is already on the chain, or on its way. Found by memo in the wallet history,
   * so a crash that lost our notes cannot lead to a second purchase.
   */
  private async adoptExisting(run: Run, key: PackKey): Promise<{ signature: string; expiry: string } | undefined> {
    const { confirmed, pending } = await this.history(run, key);
    return confirmed[0] ?? pending[0];
  }

  /** The purchases for `key` in the wallet history, sorted by what they came to. Reports a double purchase. */
  private async history(run: Run, key: PackKey) {
    const { provider, log, store } = this.deps;
    const found = await provider.findExisting(key);
    const confirmed: typeof found = [];
    const pending: typeof found = [];
    for (const f of found) {
      const st = await provider.status(f.signature, f.expiry);
      if (st.state === "confirmed") confirmed.push(f);
      else if (st.state === "pending") pending.push(f);
    }
    if (confirmed.length > 1) {
      const message = `DOUBLE PURCHASE for ${keyString(key)}: ${confirmed.map((c) => c.signature).join(", ")}`;
      log.error(message);
      if (!run.anomalies.includes(message)) run.anomalies.push(message);
      await store.setError(key, message);
    }
    return { confirmed, pending };
  }

  /** submitted → confirmed, or back to planned (expired / reverted), or failed after too many attempts. */
  private async checkPurchase(run: Run, row: PackRow): Promise<Hop> {
    const { provider, store, log } = this.deps;
    const key = row.key;
    const signature = row.signature;
    const expiry = row.expiry;
    if (!signature || !expiry) throw new Error(`pack ${keyString(key)} is submitted without a signature`);

    const st = await provider.status(signature, expiry);
    switch (st.state) {
      case "pending":
        return { row, progressed: false };
      case "confirmed": {
        const moved = await store.resolveAttempt(key, signature, { to: "confirmed" });
        // Once per pack, when it is bought: make sure nothing else was bought for the same index.
        if (moved) await this.history(run, key);
        return { row: await this.reload(key), progressed: moved };
      }
      case "expired":
      case "failed": {
        const reason = st.state === "failed" ? `purchase reverted: ${st.reason}` : "purchase expired without landing";
        const giveUp = row.attempt >= this.maxAttempts;
        log.info("pack purchase did not go through", { pack: keyString(key), attempt: row.attempt, reason });
        const moved = await store.resolveAttempt(key, signature, {
          to: giveUp ? "failed" : "planned",
          why: st.state,
          reason: giveUp ? `${reason}; gave up after ${row.attempt} attempts` : reason,
        });
        return { row: await this.reload(key), progressed: moved && !giveUp };
      }
    }
  }

  /** confirmed → pulled, once the card can be read. */
  private async revealCard(row: PackRow): Promise<Hop> {
    const { provider, store } = this.deps;
    const key = row.key;
    if (!row.signature) throw new Error(`pack ${keyString(key)} is confirmed without a signature`);
    const reveal = await provider.reveal(row.signature);
    if (!reveal) return { row, progressed: false };
    if (!reveal.cardMint) throw new Error(`pull of ${keyString(key)} came back without a card`);
    const moved = await store.complete(key, reveal);
    return { row: await this.reload(key), progressed: moved };
  }
}

function checkPlan(plan: BreakPlan): void {
  if (!Number.isInteger(plan.poolSize) || plan.poolSize < 0 || plan.poolSize > 0xffff) {
    throw new RangeError(`bad pool size ${plan.poolSize}`);
  }
  if (plan.maxPackPrice <= 0n) throw new RangeError("max pack price must be positive");
  if (plan.packBudget !== plan.maxPackPrice * BigInt(plan.poolSize)) {
    // The program funds exactly pool_size × max_pack_price. Anything else means the plan came from bad data.
    throw new RangeError(`pack budget ${plan.packBudget} is not pool size × max pack price`);
  }
}

/** Where the job gets the breaks that need packs, and where it reports progress. The pipeline provides one. */
export interface BreakSource {
  /** Breaks that are funded (`fund_purchases` done) and not fully pulled yet. */
  breaksToBuy(): Promise<BreakPlan[]>;
  report(plan: BreakPlan, progress: BreakProgress): Promise<void>;
}

export function packBuyerJob(deps: { buyer: PackBuyer; source: BreakSource; intervalMs: number }): Job {
  return {
    name: "pack-buyer",
    intervalMs: deps.intervalMs,
    async run(ctx: JobContext) {
      for (const plan of await deps.source.breaksToBuy()) {
        try {
          const progress = await deps.buyer.buyBreak(plan);
          ctx.log.info("pack buyer", {
            break: plan.breakId,
            pulled: progress.pulled,
            total: progress.total,
            inFlight: progress.inFlight,
            waiting: progress.waiting,
            failed: progress.failed,
          });
          await deps.source.report(plan, progress);
        } catch (err) {
          // A bad plan for one break must not hold up the others.
          ctx.log.error("pack buyer: break failed", {
            break: plan.breakId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    },
  };
}
