// The break scheduler: creates the next break when the treasury can pay for its worst case.
//
// Rules (CLAUDE.md, "Breaks are fee-funded from the first one"): no team pre-funding, so a break is only created when
// the buckets can cover `paid_spots × (max_pack_price − spot_price)` and `free_spots × max_pack_price`; the program
// checks that itself (the treasury refuses the lock), this checks first so it never sends a transaction that cannot
// work. One break sells at a time: the next one starts when the previous sale has ended, if the reserve allows.
//
// It starts every run from the chain, never from notes of its own:
//   1. every break the chain has and the database lacks is copied into the database (a break created by an
//      interrupted run, or by hand with the keeper key, is picked up, with the chain's values);
//   2. nothing is created while a break is still selling;
//   3. the keeper's wallet must hold enough SOL for the rent of what `create_break` makes (a break and its escrow), the fee
//      and what a wallet has to keep; if not, nothing is sent and the job says to top it up (the program would refuse it);
//   4. `create_break` is sent for exactly the next id. A resend of the same send is safe: the break account is a PDA of
//      the next id, so once one lands every other attempt at that id is refused by the program.

import type { Job } from "../job.js";
import type { ChainClient } from "../pipeline/chain.js";
import { type BreakAccount, type BreaksConfigAccount, type Programs, breakAddress, configAddress, createBreak, decodeBreak, decodeBreaksConfig } from "../solana/breaks.js";
import type { Address } from "../solana/pubkey.js";
import { createBreakCost } from "../solana/rent.js";
import type { WalletReader } from "../sweep/wallet.js";
import { type BreakTemplate, type ReserveProgress, templateProblem } from "./policy.js";
import { readReserve } from "./reserve.js";
import type { SchedulerStore } from "./store.js";

export type SchedulerOutcome =
  /** Nothing to do, and why (the program is not initialized, it is paused, automatic creation is off). */
  | { kind: "idle"; reason: string }
  /** A break is still selling. */
  | { kind: "selling"; breakId: bigint }
  /** The reserve cannot pay for the worst case yet. */
  | { kind: "reserve"; progress: ReserveProgress }
  /** The keeper's wallet does not hold enough SOL for the rent of a new break. Needs a person. */
  | { kind: "funds"; have: bigint; needed: bigint }
  /** `create_break` landed. */
  | { kind: "created"; breakId: bigint; signature: string }
  /** `create_break` was sent and nothing is known about it yet; the next run finds out from the chain. */
  | { kind: "pending"; breakId: bigint; signature?: string }
  /** `create_break` was refused or reverted. It is tried again after `retryAfterMs`. */
  | { kind: "failed"; breakId: bigint; reason: string }
  /** A failed attempt is being waited out. */
  | { kind: "backoff"; breakId: bigint }
  /** The configured break is not one the program accepts, or the chain does not add up. Needs a person. */
  | { kind: "problem"; problem: string };

export type SchedulerReport = SchedulerOutcome & {
  /** Breaks copied from the chain into the database during this run. */
  recorded: bigint[];
};

export interface SchedulerDeps {
  chain: ChainClient;
  programs: Programs;
  keeper: Address;
  store: SchedulerStore;
  template: BreakTemplate;
  /** False: breaks are still copied from the chain, but none is created. */
  enabled: boolean;
  /** Reads the keeper's SOL. Without it the scheduler does not check, and a break the keeper cannot pay for is refused by the program. */
  wallet?: WalletReader;
  now?: () => Date;
  /** How long to wait after a refused `create_break` before trying again. Default 60 s. */
  retryAfterMs?: number;
}

/** How often the job repeats that the keeper's wallet is short of SOL while it stays that way. */
const SHORT_REMINDER_MS = 3_600_000;

/** Most breaks copied from the chain in one run. */
const MAX_RECORDED_PER_RUN = 25;

export class BreakScheduler {
  private readonly now: () => Date;
  private readonly retryAfterMs: number;
  /** Signatures of the `create_break` sends, by break id, to note them when the break is recorded. */
  private readonly sent = new Map<bigint, string>();
  private failedUntil: { breakId: bigint; at: number } | undefined;

  constructor(private readonly deps: SchedulerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.retryAfterMs = deps.retryAfterMs ?? 60_000;
  }

  async run(): Promise<SchedulerReport> {
    const { chain, programs, store, template } = this.deps;
    const raw = await chain.getAccountData(configAddress(programs));
    if (!raw) return { kind: "idle", reason: "the breaks program is not initialized", recorded: [] };
    const config = decodeBreaksConfig(raw);

    const recorded = await this.record(config);
    const decide = async (): Promise<SchedulerOutcome> => {
      if (!this.deps.enabled) return { kind: "idle", reason: "automatic break creation is off" };
      if (config.paused) return { kind: "idle", reason: "the breaks program is paused" };
      const problem = templateProblem(template, config);
      if (problem) return { kind: "problem", problem };

      const nowSecs = BigInt(Math.floor(this.now().getTime() / 1000));
      for (const id of await store.openOnchainIds()) {
        const b = await this.readBreak(id);
        if (b?.status === "Open" && nowSecs < b.closesAt) return { kind: "selling", breakId: id };
      }

      const progress = await this.reserve();
      if (!progress.enough) return { kind: "reserve", progress };

      if (this.deps.wallet) {
        const have = await this.deps.wallet.lamports(this.deps.keeper);
        const needed = createBreakCost().total;
        if (have < needed) return { kind: "funds", have, needed };
      }

      return this.create(config, nowSecs);
    };
    return { ...(await decide()), recorded };
  }

  /** Copies the breaks the chain has and the database lacks. Returns their ids. */
  private async record(config: BreaksConfigAccount): Promise<bigint[]> {
    const { store } = this.deps;
    const highest = await store.highestOnchainId();
    // A database that has none is new (or restored): take everything the chain has. Otherwise only what came after.
    let id = highest === undefined ? 0n : highest + 1n;
    const done: bigint[] = [];
    while (id < config.nextBreakId && done.length < MAX_RECORDED_PER_RUN) {
      const b = await this.readBreak(id);
      if (!b) throw new Error(`break ${id} should exist (the next id is ${config.nextBreakId}) but its account is missing`);
      await store.recordBreak(b, this.sent.get(id));
      this.sent.delete(id);
      done.push(id);
      id += 1n;
    }
    return done;
  }

  private async readBreak(id: bigint): Promise<BreakAccount | undefined> {
    const data = await this.deps.chain.getAccountData(breakAddress(this.deps.programs, id));
    return data ? decodeBreak(data) : undefined;
  }

  /** What each bucket has that is not locked for a break, against the worst case of the configured break. */
  private reserve(): Promise<ReserveProgress> {
    return readReserve(this.deps.chain, this.deps.programs, this.deps.template);
  }

  private async create(config: BreaksConfigAccount, nowSecs: bigint): Promise<SchedulerOutcome> {
    const { chain, programs, keeper, template } = this.deps;
    const breakId = config.nextBreakId;
    if (this.failedUntil && this.failedUntil.breakId === breakId && this.now().getTime() < this.failedUntil.at) {
      return { kind: "backoff", breakId };
    }

    const instruction = createBreak(programs, {
      keeper,
      usdcMint: config.usdcMint,
      breakId,
      paidSpots: template.paidSpots,
      freeSpots: template.freeSpots,
      spotPrice: template.spotPrice,
      // One machine for every pack: the template has one price. The program takes any cheapest-first list.
      tiers: [{ machine: template.packMachine, maxPrice: template.maxPackPrice }],
      packs: Array<number>(template.paidSpots + template.freeSpots).fill(0),
      opensAt: nowSecs,
      closesAt: nowSecs + template.windowSecs,
    });
    const result = await chain.sendAndConfirm([instruction]);
    if (result.signature !== undefined) this.sent.set(breakId, result.signature);
    switch (result.outcome) {
      case "confirmed":
        this.failedUntil = undefined;
        return { kind: "created", breakId, signature: result.signature };
      case "failed":
        this.failedUntil = { breakId, at: this.now().getTime() + this.retryAfterMs };
        this.sent.delete(breakId);
        return { kind: "failed", breakId, reason: result.reason };
      default:
        // Unknown: it may still land. The next run reads the chain; a break at this id is then recorded, and if none
        // appears the same id is sent again, which the program only accepts once.
        return { kind: "pending", breakId, ...(result.signature !== undefined ? { signature: result.signature } : {}) };
    }
  }
}

/** The scheduler as a keeper job: runs it and says what is worth saying (not the same thing every few seconds). */
export function schedulerJob(opts: { scheduler: BreakScheduler; intervalMs: number }): Job {
  let lastPercent: number | undefined;
  let lastProblem: string | undefined;
  let lastShort: { have: bigint; at: number } | undefined;
  return {
    name: "scheduler",
    intervalMs: opts.intervalMs,
    async run(ctx) {
      const r = await opts.scheduler.run();
      for (const id of r.recorded) ctx.log.info("break recorded from the chain", { break: String(id) });
      if (r.kind !== "problem") lastProblem = undefined;
      if (r.kind !== "funds") lastShort = undefined;
      switch (r.kind) {
        case "created":
          lastPercent = undefined;
          ctx.log.info("break created", { break: String(r.breakId), signature: r.signature });
          break;
        case "pending":
          ctx.log.info("break creation sent, result not known yet", { break: String(r.breakId), ...(r.signature ? { signature: r.signature } : {}) });
          break;
        case "failed":
          ctx.log.error("break creation failed", { break: String(r.breakId), reason: r.reason });
          break;
        case "reserve":
          // The public progress bar ("Break #n unlocks at $X, currently Y%"): say it when it moves.
          if (r.progress.percent !== lastPercent) {
            lastPercent = r.progress.percent;
            ctx.log.info("waiting for the reserve", {
              percent: r.progress.percent,
              subsidy: `${r.progress.availableSubsidy}/${r.progress.requiredSubsidy}`,
              holder: `${r.progress.availableHolder}/${r.progress.requiredHolder}`,
            });
          }
          break;
        case "funds": {
          // Said when it starts, when the balance moves and once an hour after that: the operator has to act, and a log that
          // repeats every few seconds would bury everything else.
          const at = ctx.now().getTime();
          if (!lastShort || lastShort.have !== r.have || at - lastShort.at >= SHORT_REMINDER_MS) {
            lastShort = { have: r.have, at };
            ctx.log.error("the keeper wallet cannot pay for a new break: top it up with SOL", { lamports: String(r.have), needed: String(r.needed) });
          }
          break;
        }
        case "problem":
          if (r.problem !== lastProblem) {
            lastProblem = r.problem;
            ctx.log.error("the scheduler cannot create the configured break", { problem: r.problem });
          }
          break;
        default:
          break;
      }
    },
  };
}
