// The glue between the chain, the database and the other jobs: which breaks the pack buyer and the deliverer
// should work on right now. Both read the chain themselves each time, so they need no notes of their own.

import type { BreakPlan, BreakProgress, BreakSource } from "../packs/buyer.js";
import type { DeliveryPlan } from "../delivery/plan.js";
import { buildDeliveryPlan } from "../delivery/plan.js";
import type { DeliveryProgress, DeliverySource } from "../delivery/deliverer.js";
import type { Logger } from "../job.js";
import type { PackStore } from "../packs/store.js";
import {
  type BreakAccount,
  type Programs,
  breakAddress,
  configAddress,
  decodeBreak,
  decodeBreaksConfig,
  decodeSpot,
  spotAddress,
} from "../solana/breaks.js";
import type { Address } from "../solana/pubkey.js";
import type { ChainClient } from "./chain.js";
import type { ActiveBreak } from "./pipeline.js";
import type { BreakRepo } from "./repo.js";

export interface SourceDeps {
  chain: ChainClient;
  programs: Programs;
  repo: BreakRepo;
  packs: PackStore;
  log: Logger;
}

async function readBreak(deps: SourceDeps, active: ActiveBreak): Promise<BreakAccount | undefined> {
  const data = await deps.chain.getAccountData(breakAddress(deps.programs, active.onchainId));
  return data ? decodeBreak(data) : undefined;
}

/** Breaks that are funded: the pack buyer buys their packs. The plan comes from the chain, not from the database. */
export class FundedBreaks implements BreakSource {
  constructor(private readonly deps: SourceDeps) {}

  async breaksToBuy(): Promise<BreakPlan[]> {
    const plans: BreakPlan[] = [];
    for (const active of await this.deps.repo.activeBreaks()) {
      const b = await readBreak(this.deps, active);
      if (b?.status !== "Funded") continue;
      plans.push({
        breakId: active.id,
        poolSize: b.poolSize,
        machine: active.machine,
        maxPackPrice: b.maxPackPrice,
        packBudget: b.packBudget,
      });
    }
    return plans;
  }

  async report(plan: BreakPlan, progress: BreakProgress): Promise<void> {
    if (progress.failed > 0 || progress.anomalies.length > 0) {
      this.deps.log.error("pack buyer needs attention", {
        break: plan.breakId,
        failed: progress.failed,
        anomalies: progress.anomalies,
      });
    }
  }
}

/** Breaks that are `Drawn` and not fully delivered: the deliverer sends their cards. */
export class DrawnBreaks implements DeliverySource {
  constructor(private readonly deps: SourceDeps) {}

  async plansToDeliver(): Promise<DeliveryPlan[]> {
    const plans: DeliveryPlan[] = [];
    for (const active of await this.deps.repo.activeBreaks()) {
      try {
        const plan = await this.planFor(active);
        if (plan) plans.push(plan);
      } catch (err) {
        // A break whose plan does not add up must not hold up the others; it is reported and skipped until it does.
        this.deps.log.error("delivery plan refused", {
          break: active.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return plans;
  }

  private async planFor(active: ActiveBreak): Promise<DeliveryPlan | undefined> {
    const { chain, programs, packs } = this.deps;
    const b = await readBreak(this.deps, active);
    if (b?.status !== "Drawn") return undefined;

    const configData = await chain.getAccountData(configAddress(programs));
    if (!configData) throw new Error("the breaks program is not initialized");
    const buyer: Address = decodeBreaksConfig(configData).buyer;

    const breakKey = breakAddress(programs, active.onchainId);
    const paidSpots = [];
    for (let i = 0; i < b.spotsSold; i++) {
      const data = await chain.getAccountData(spotAddress(programs, breakKey, i));
      if (!data) throw new Error(`spot ${i} of break ${active.onchainId} does not exist on-chain`);
      paidSpots.push(decodeSpot(data));
    }
    const cards = (await packs.listForBreak(active.id)).flatMap((p) => (p.status === "pulled" && p.cardMint ? [p.cardMint] : []));
    const plan = buildDeliveryPlan({ breakId: active.id, buyer, chain: b, paidSpots, cards });

    // Only a verified plan is recorded. Deliveries refer to these rows, and so will the website.
    await this.deps.repo.recordSpots(active.id, [
      ...paidSpots.map((s) => ({ kind: "paid" as const, idx: s.index, wallet: s.owner, paid: s.paid })),
      ...b.freeWinners.slice(0, b.freeWinnerCount).map((w, i) => ({ kind: "free" as const, idx: i, wallet: w.wallet })),
    ]);
    return plan;
  }

  async report(plan: DeliveryPlan, progress: DeliveryProgress): Promise<void> {
    if (progress.complete) {
      await this.deps.repo.setStatus(plan.breakId, "delivered");
      this.deps.log.info("break delivered", { break: plan.breakId, cards: progress.delivered });
    } else if (progress.failed > 0 || progress.anomalies.length > 0) {
      this.deps.log.error("delivery needs attention", {
        break: plan.breakId,
        failed: progress.failed,
        anomalies: progress.anomalies,
      });
    }
  }
}
