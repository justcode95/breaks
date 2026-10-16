// Gives the buyers of a cancelled break their USDC back. `refund_spot` can be sent by anyone and always pays the spot's owner, so
// the keeper only spends the network fee; without this job a buyer would have to come back to the website to get their own money.
//
// Every run starts from the chain, never from notes of its own: the database only says which breaks were cancelled and which are
// finished (`refunded`). A break is finished when, at the start of a run, every spot it sold reads as refunded on chain; a run that
// sent refunds therefore ends without marking it, and the next run reads the chain again and does. Sending the same refund twice
// is harmless (the program refuses the second with `AlreadyRefunded`), so nothing needs remembering between runs.
//
// The money goes to the owner's associated USDC account and nowhere else. The keeper does not create that account (the rent is
// real SOL and buyers' accounts are not its business): a spot whose owner has no usable one is reported, left alone, and the
// break stays `cancelled` until the owner has one (or refunds it themselves from another account on the website).

import type { Job, JobContext, Logger } from "../job.js";
import type { ChainClient } from "../pipeline/chain.js";
import type { ActiveBreak } from "../pipeline/pipeline.js";
import type { DbBreakStatus } from "../pipeline/repo.js";
import {
  type Programs,
  breakAddress,
  configAddress,
  decodeBreak,
  decodeBreaksConfig,
  decodeSpot,
  refundSpot,
  spotAddress,
} from "../solana/breaks.js";
import { type Address, associatedTokenAddress } from "../solana/pubkey.js";
import { decodeTokenAccount, tokenAccountState } from "../solana/token.js";

export interface RefundRepo {
  /** Breaks the database knows to be cancelled and not yet finished. */
  cancelledBreaks(): Promise<ActiveBreak[]>;
  setStatus(id: string, status: DbBreakStatus): Promise<void>;
}

export interface RefundDeps {
  chain: ChainClient;
  programs: Programs;
  repo: RefundRepo;
  log: Logger;
}

export interface SpotRefundReport {
  index: number;
  owner?: Address;
  /** What the run did about this spot. */
  result: "already-refunded" | "sent" | "not-sent";
  /** Why a spot could not be refunded, or why a send did not land. */
  problem?: string;
}

export interface BreakRefundReport {
  breakId: string;
  /** Spots the break sold. */
  spots: number;
  /** Refunds read as already paid at the start of the run. */
  refunded: number;
  /** Refunds this run sent that the chain confirmed. */
  sent: number;
  /** The break is finished: every spot was read as refunded and the database now says `refunded`. */
  done: boolean;
  /** Set when the break could not be looked at at all. */
  problem?: string;
  details: SpotRefundReport[];
}

export class BreakRefunder {
  constructor(private readonly deps: RefundDeps) {}

  async run(): Promise<BreakRefundReport[]> {
    const reports: BreakRefundReport[] = [];
    for (const active of await this.deps.repo.cancelledBreaks()) {
      try {
        reports.push(await this.refundBreak(active));
      } catch (err) {
        // One break must not hold up the others.
        const problem = err instanceof Error ? err.message : String(err);
        this.deps.log.error("refunds: break failed", { break: active.id, error: problem });
        reports.push({ breakId: active.id, spots: 0, refunded: 0, sent: 0, done: false, problem, details: [] });
      }
    }
    return reports;
  }

  private async refundBreak(active: ActiveBreak): Promise<BreakRefundReport> {
    const { chain, programs, repo, log } = this.deps;
    const report: BreakRefundReport = { breakId: active.id, spots: 0, refunded: 0, sent: 0, done: false, details: [] };
    const stop = (problem: string): BreakRefundReport => {
      log.error("refunds: needs attention", { break: active.id, problem });
      return { ...report, problem };
    };

    const breakData = await chain.getAccountData(breakAddress(programs, active.onchainId));
    if (!breakData) return stop(`break ${active.onchainId} does not exist on chain`);
    const b = decodeBreak(breakData);
    // The chain is the truth: a break the database calls cancelled but the chain does not is not refunded.
    if (b.status !== "Cancelled") return stop(`the database says cancelled but the chain says ${b.status}`);
    report.spots = b.spotsSold;

    const configData = await chain.getAccountData(configAddress(programs));
    if (!configData) return stop("the breaks program is not initialized");
    const mint = decodeBreaksConfig(configData).usdcMint;

    const breakKey = breakAddress(programs, active.onchainId);
    // First read every spot, then send: what the run sends never depends on an earlier send of the same run.
    const spots = [];
    for (let i = 0; i < b.spotsSold; i++) {
      const data = await chain.getAccountData(spotAddress(programs, breakKey, i));
      if (!data) return stop(`spot ${i} of break ${active.onchainId} does not exist on chain`);
      spots.push(decodeSpot(data));
    }

    for (const spot of spots) {
      if (spot.refunded) {
        report.refunded++;
        report.details.push({ index: spot.index, owner: spot.owner, result: "already-refunded" });
        continue;
      }
      const ownerUsdc = associatedTokenAddress(spot.owner, mint);
      const unusable = await this.problemWith(ownerUsdc, spot.owner, mint);
      if (unusable) {
        log.error("refunds: a spot cannot be refunded yet", { break: active.id, spot: spot.index, owner: spot.owner, problem: unusable });
        report.details.push({ index: spot.index, owner: spot.owner, result: "not-sent", problem: unusable });
        continue;
      }
      const sent = await chain.sendAndConfirm([refundSpot(programs, { breakId: active.onchainId, index: spot.index, ownerUsdc })]);
      if (sent.outcome === "confirmed") {
        report.sent++;
        report.details.push({ index: spot.index, owner: spot.owner, result: "sent" });
        log.info("refunds: spot refunded", { break: active.id, spot: spot.index, owner: spot.owner, paid: spot.paid.toString(), signature: sent.signature });
      } else {
        // `failed` changed nothing; `unknown` may still land. Either way the next run reads the spot again.
        const problem = `${sent.outcome}: ${sent.reason}`;
        log.error("refunds: a refund did not go through", { break: active.id, spot: spot.index, owner: spot.owner, problem });
        report.details.push({ index: spot.index, owner: spot.owner, result: "not-sent", problem });
      }
    }

    // Finished only from what was read at the start: every spot was already refunded, so nothing was left to send.
    if (report.refunded === b.spotsSold) {
      await repo.setStatus(active.id, "refunded");
      report.done = true;
      log.info("refunds: every spot of the break is refunded", { break: active.id, spots: b.spotsSold });
    }
    return report;
  }

  /** Why the owner's associated USDC account cannot receive the refund, or undefined when it can. */
  private async problemWith(account: Address, owner: Address, mint: Address): Promise<string | undefined> {
    const data = await this.deps.chain.getAccountData(account);
    if (!data) return `${owner} has no USDC account (${account}); it is not created for them`;
    let token;
    try {
      token = decodeTokenAccount(data);
    } catch {
      return `${account} is not a token account`;
    }
    if (token.mint !== mint) return `${account} holds another token`;
    if (token.owner !== owner) return `${account} belongs to ${token.owner}, not to ${owner}`;
    const state = tokenAccountState(data);
    if (state !== "initialized") return `${account} is ${state === "frozen" ? "frozen" : "not initialized"}`;
    return undefined;
  }
}

/** Sends the refunds of every cancelled break on each tick; reports only what it did or what needs attention. */
export function refundJob(deps: { refunder: BreakRefunder; intervalMs: number }): Job {
  return {
    name: "refunds",
    intervalMs: deps.intervalMs,
    async run(_ctx: JobContext) {
      await deps.refunder.run();
    },
  };
}
