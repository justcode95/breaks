// The deliverer: sends every pulled card to the wallet the draw assigned it to.
//
// Per delivery, a state machine whose every step is saved before the next one starts:
//
//   pending ──check owner, prepare, save attempt, submit──▶ submitted ──status──▶ confirmed
//      ▲                                                        │ expired / reverted
//      └────────────────────────────────────────────────────────┘ (a new attempt, up to `maxAttempts`, then `failed`)
//
// What can go wrong here is different from buying packs: sending a card twice is impossible (the second
// transfer fails, the buyer no longer owns it), but sending it to the wrong wallet cannot be undone. So:
//  - The plan (`buildDeliveryPlan`) is built only from what the chain committed, and refuses anything that
//    does not add up. The deliverer never invents a recipient.
//  - The chain is the source of truth for where a card is. Nothing is sent unless the buyer wallet owns the
//    card; a card found at its recipient counts as delivered; a card anywhere else stops that delivery and is
//    reported.
//  - The attempt (signature and expiry) is saved BEFORE the transfer is sent, and a new transfer is built
//    only when the saved one reverted or can never land.
//  - If the plan for a spot ever differs from what was recorded, that delivery stops (`PlanChangedError`).
//
// Cards must go out within minutes of the draw: Collector Crypt's sellback window is about 72 hours from the
// pull (CLAUDE.md). Tracking that deadline waits for Phase 0 to confirm it.

import type { Job, JobContext, Logger } from "../job.js";
import type { Delivery, DeliveryPlan } from "./plan.js";
import { type DeliveryKey, type DeliveryRow, type DeliveryStore, PlanChangedError, keyString } from "./store.js";
import type { CardTransfer } from "./transfer.js";

export interface DeliveryProgress {
  total: number;
  delivered: number;
  /** Transfers sent that are not confirmed yet. */
  inFlight: number;
  /** Not started, or waiting for a retry; see `DeliveryRow.lastError`. */
  waiting: number;
  /** Stopped: given up after too many attempts, or the card is not where it should be. A human decides. */
  failed: number;
  /** Every card delivered. */
  complete: boolean;
  /** Things that need a human, e.g. a card in an unexpected wallet. */
  anomalies: string[];
  deliveries: DeliveryRow[];
}

export interface DelivererDeps {
  transfer: CardTransfer;
  store: DeliveryStore;
  log: Logger;
  /** Transfers started per delivery before it is given up. Default 5. */
  maxAttempts?: number;
}

interface Run {
  plan: DeliveryPlan;
  anomalies: string[];
}

interface Hop {
  row: DeliveryRow;
  progressed: boolean;
}

export class Deliverer {
  private readonly maxAttempts: number;

  constructor(private readonly deps: DelivererDeps) {
    this.maxAttempts = deps.maxAttempts ?? 5;
  }

  /** Moves every delivery of the break as far as it can go right now. Safe to call as often as you like. */
  async deliverBreak(plan: DeliveryPlan): Promise<DeliveryProgress> {
    const run: Run = { plan, anomalies: [] };
    for (const delivery of plan.deliveries) {
      const key: DeliveryKey = { breakId: plan.breakId, spot: delivery.spot };
      try {
        await this.advance(run, delivery);
      } catch (err) {
        // One delivery's trouble (an RPC error, say) must not stop the others. The next run picks it up again.
        const message = err instanceof Error ? err.message : String(err);
        this.deps.log.error("delivery step failed", { delivery: keyString(key), error: message });
        if (err instanceof PlanChangedError) run.anomalies.push(message);
        else await this.deps.store.setError(key, message);
      }
    }
    return this.progress(run);
  }

  private async progress({ plan, anomalies }: Run): Promise<DeliveryProgress> {
    const rows = await this.deps.store.listForBreak(plan.breakId);
    const count = (...s: DeliveryRow["status"][]) => rows.filter((r) => s.includes(r.status)).length;
    const delivered = count("confirmed");
    return {
      total: plan.deliveries.length,
      delivered,
      inFlight: count("submitted"),
      waiting: count("pending"),
      failed: count("failed"),
      complete: plan.deliveries.length > 0 && delivered === plan.deliveries.length,
      anomalies,
      deliveries: rows,
    };
  }

  private async advance(run: Run, delivery: Delivery): Promise<DeliveryRow> {
    let row = await this.deps.store.ensure(run.plan.breakId, delivery);
    // A delivery can pass several states in one call; the cap only guards against a loop that never settles.
    for (let hops = 0; hops < 8; hops++) {
      const next = await this.hop(run, row);
      row = next.row;
      if (!next.progressed) break;
    }
    return row;
  }

  private async hop(run: Run, row: DeliveryRow): Promise<Hop> {
    switch (row.status) {
      case "pending":
        return this.startTransfer(run, row);
      case "submitted":
        return this.checkTransfer(run, row);
      default:
        return { row, progressed: false };
    }
  }

  private async reload(key: DeliveryKey): Promise<DeliveryRow> {
    const row = await this.deps.store.get(key);
    if (!row) throw new Error(`delivery ${keyString(key)} vanished`);
    return row;
  }

  private note(run: Run, message: string) {
    this.deps.log.error(message);
    if (!run.anomalies.includes(message)) run.anomalies.push(message);
  }

  /** pending → submitted, after looking at where the card is. */
  private async startTransfer(run: Run, row: DeliveryRow): Promise<Hop> {
    const { transfer, store } = this.deps;
    const key = row.key;
    const owner = await transfer.ownerOf(row.cardMint);

    if (owner === row.recipient) {
      // Already there: a transfer of ours that landed without us noticing, or lost notes.
      const moved = await store.adopt(key);
      return { row: await this.reload(key), progressed: moved };
    }
    if (owner === undefined) {
      await store.setError(key, "card not found on-chain yet");
      return { row: await this.reload(key), progressed: false };
    }
    if (owner !== run.plan.buyer) {
      const message = `card ${row.cardMint} for ${keyString(key)} is held by ${owner}, not by the buyer wallet or the recipient`;
      this.note(run, message);
      await store.fail(key, message);
      return { row: await this.reload(key), progressed: false };
    }

    const prepared = await transfer.prepare({
      breakId: run.plan.breakId,
      spot: key.spot,
      from: run.plan.buyer,
      recipient: row.recipient,
      cardMint: row.cardMint,
    });
    if (!prepared.signature || !prepared.expiry) throw new Error("provider built a transfer without a signature or expiry");
    // The transfer must be the one we asked for: the recipient is the one thing that cannot be wrong.
    const asked = prepared.request;
    if (asked.recipient !== row.recipient || asked.cardMint !== row.cardMint || asked.from !== run.plan.buyer) {
      throw new Error(`provider built a transfer of ${asked.cardMint} to ${asked.recipient}, not the planned one`);
    }

    // Saved before anything is sent. Losing the race means another worker is delivering this card.
    const won = await store.startAttempt(key, { signature: prepared.signature, expiry: prepared.expiry });
    if (!won) return { row: await this.reload(key), progressed: false };

    try {
      await transfer.submit(prepared);
    } catch (err) {
      // It may or may not have landed. Not knowing is fine: `status` decides, and nothing is rebuilt until it does.
      const message = err instanceof Error ? err.message : String(err);
      this.deps.log.error("card transfer: submit failed, will check its status", { delivery: keyString(key), error: message });
      await store.setError(key, `submit failed: ${message}`);
    }
    return { row: await this.reload(key), progressed: true };
  }

  /** submitted → confirmed, or back to pending (expired / reverted), or failed after too many attempts. */
  private async checkTransfer(run: Run, row: DeliveryRow): Promise<Hop> {
    const { transfer, store, log } = this.deps;
    const key = row.key;
    const { signature, expiry } = row;
    if (!signature || !expiry) throw new Error(`delivery ${keyString(key)} is submitted without a signature`);

    const st = await transfer.status(signature, expiry);
    switch (st.state) {
      case "pending":
        return { row, progressed: false };
      case "confirmed": {
        // The chain says the transfer went through; make sure the card really is where it was meant to go.
        const owner = await transfer.ownerOf(row.cardMint);
        if (owner !== row.recipient) {
          const message = `transfer ${signature} is confirmed but card ${row.cardMint} is held by ${owner ?? "nobody found"}, not ${row.recipient}`;
          this.note(run, message);
          await store.resolveAttempt(key, signature, { to: "failed", why: "failed", reason: message });
          return { row: await this.reload(key), progressed: false };
        }
        const moved = await store.resolveAttempt(key, signature, { to: "confirmed" });
        return { row: await this.reload(key), progressed: moved };
      }
      case "expired":
      case "failed": {
        const reason = st.state === "failed" ? `transfer reverted: ${st.reason}` : "transfer expired without landing";
        const giveUp = row.attempt >= this.maxAttempts;
        log.info("card transfer did not go through", { delivery: keyString(key), attempt: row.attempt, reason });
        const moved = await store.resolveAttempt(key, signature, {
          to: giveUp ? "failed" : "pending",
          why: st.state,
          reason: giveUp ? `${reason}; gave up after ${row.attempt} attempts` : reason,
        });
        return { row: await this.reload(key), progressed: moved && !giveUp };
      }
    }
  }
}

/** Where the job gets the breaks whose cards are ready to go out, and where it reports progress. The pipeline provides one. */
export interface DeliverySource {
  /** Plans for breaks that are `Drawn` and not fully delivered yet; builds each with `buildDeliveryPlan`. */
  plansToDeliver(): Promise<DeliveryPlan[]>;
  report(plan: DeliveryPlan, progress: DeliveryProgress): Promise<void>;
}

export function deliveryJob(deps: { deliverer: Deliverer; source: DeliverySource; intervalMs: number }): Job {
  return {
    name: "delivery",
    intervalMs: deps.intervalMs,
    async run(ctx: JobContext) {
      for (const plan of await deps.source.plansToDeliver()) {
        try {
          const progress = await deps.deliverer.deliverBreak(plan);
          ctx.log.info("delivery", {
            break: plan.breakId,
            delivered: progress.delivered,
            total: progress.total,
            inFlight: progress.inFlight,
            waiting: progress.waiting,
            failed: progress.failed,
          });
          await deps.source.report(plan, progress);
        } catch (err) {
          // A bad plan for one break must not hold up the others.
          ctx.log.error("delivery: break failed", {
            break: plan.breakId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    },
  };
}
