// What is wrong right now, in words: the watchdog's rules. Pure: each takes what was read and the time, and gives the alerts
// that should be open. An alert's key is what makes it the same alert from one run to the next, so it is opened once and
// cleared once; its text may change in between (a duration that grows, a balance that moves) without being sent again.

import { type BreakStatus, MAX_RANDOMNESS_ATTEMPTS } from "../solana/breaks.js";
import type { Address } from "../solana/pubkey.js";
import { sol } from "../setup/run.js";
import type { JobStatus } from "./health.js";

export interface Alert {
  key: string;
  text: string;
}

export interface WatchLimits {
  /** How long something must stay wrong before it is reported. */
  afterMs: number;
  /** INDEXER_SETTLE_SECS: the planner waits this long past a sale's end before it makes the list. */
  settleSecs: number;
}

/** The watchdog's own job: it cannot report on itself (a watchdog that is stuck sends nothing). */
export const WATCHDOG_JOB = "watchdog";

/**
 * Collector Crypt's sellback window, counted from the pull: about 72 hours per Jupiter's docs, NOT confirmed (Phase 0,
 * docs/PHASE0.md). Only used to say how much of it may be left.
 */
export const SELLBACK_HOURS = 72;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * "1 min", "47 min", "2 h", "3 h 5 min", "2 days 4 h"; never less than a minute. Rounded down for how long something has
 * lasted, and up for a time that is at most this long (from two days on, to the hour).
 */
export function duration(ms: number, round: "down" | "up" = "down"): string {
  const r = round === "up" ? Math.ceil : Math.floor;
  const mins = Math.max(1, r(ms / MINUTE));
  if (mins < 60) return `${mins} min`;
  if (mins < 48 * 60) return mins % 60 === 0 ? `${mins / 60} h` : `${Math.floor(mins / 60)} h ${mins % 60} min`;
  const hours = r(mins / 60);
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days} days` : `${days} days ${hours % 24} h`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A job whose runs keep throwing, and a run that never ends. */
export function jobAlerts(jobs: readonly JobStatus[], now: Date, limits: WatchLimits): Alert[] {
  const out: Alert[] = [];
  for (const j of jobs) {
    if (j.name === WATCHDOG_JOB) continue;
    if (j.failingSince && j.failures >= 2 && now.getTime() - j.failingSince.getTime() >= limits.afterMs) {
      out.push({
        key: `job:${j.name}`,
        text: `The ${j.name} job has failed every run for ${duration(now.getTime() - j.failingSince.getTime())} (${plural(j.failures, "run", "runs")} in a row). Last error: ${j.lastError ?? "(none given)"}`,
      });
    }
    if (j.runningSince && now.getTime() - j.runningSince.getTime() >= limits.afterMs) {
      out.push({
        key: `job:${j.name}:hung`,
        text: `A run of the ${j.name} job started ${duration(now.getTime() - j.runningSince.getTime())} ago and has not finished: something it waits on (the node, the database) does not answer, and until it ends the keeper starts no other job.`,
      });
    }
  }
  return out;
}

/** What the watchdog knows about one break the keeper is still working on. */
export interface BreakFacts {
  /** The on-chain id. People see it as "Break #(id + 1)", like the X posts and the website. */
  id: bigint;
  /** Its status on chain, or `missing` when the database has it and the chain has no account for it. */
  status: BreakStatus | "missing";
  /** When the watchdog first saw it in this status (no earlier than the keeper's start). */
  seenSince: Date;
  /** From the break account; unix seconds. */
  closesAt: bigint;
  randomnessAttempt: number;
  randomnessRequestedAt: bigint;
  seededAt: bigint;
  poolSize: number;
  /** For a drawn break: how many of its cards the database has as delivered, when that could be read. */
  delivered?: number;
}

const secs = (unix: bigint) => Number(unix) * 1000;

/**
 * A break that has stayed too long where it is. Where the chain says when the stage began (the end of the sale, the
 * randomness request, the seed) that time is used; otherwise the time the watchdog first saw it there, which after a restart
 * is later than the truth, so the alert comes late rather than wrongly (and says "at least").
 */
export function breakAlert(b: BreakFacts, now: Date, limits: WatchLimits): Alert | undefined {
  const name = `Break #${b.id + 1n}`;
  const key = `break:${b.id}:${b.status}`;
  const t = now.getTime();
  const seen = b.seenSince.getTime();
  const over = (since: number) => t - since >= limits.afterMs;
  const log = "(see the keeper's log)";

  switch (b.status) {
    case "missing":
      return over(seen) ? { key, text: `${name} is in the keeper's database but has no account on chain: is BREAKS_PROGRAM_ID the program it was made with? ${log}` } : undefined;
    case "Open": {
      const end = secs(b.closesAt);
      return over(end) ? { key, text: `${name}'s sale ended ${duration(t - end)} ago and it is still open on chain: close_break has not landed ${log}.` } : undefined;
    }
    case "Closed": {
      const end = secs(b.closesAt);
      return over(end + limits.settleSecs * 1000)
        ? { key, text: `${name}'s sale ended ${duration(t - end)} ago and its eligibility list is not committed: the balance indexer may be behind, or the list cannot be made ${log}.` }
        : undefined;
    }
    case "EligibilityCommitted":
      return over(seen)
        ? { key, text: `${name} has had its eligibility list committed for at least ${duration(t - seen)} and is neither funded nor cancelled: is the program paused, or the buyer wallet's USDC account missing? ${log}` }
        : undefined;
    case "Funded":
      return over(seen)
        ? { key, text: `${name} has been funded for at least ${duration(t - seen)} and its pool is not committed: the packs are not all bought and pulled, or commit_pool has not landed ${log}.` }
        : undefined;
    case "PoolCommitted":
      return over(seen) ? { key, text: `${name}'s pool has been committed for at least ${duration(t - seen)} and no randomness has been asked for ${log}.` } : undefined;
    case "RandomnessRequested": {
      // A repeated request moves `randomnessRequestedAt`; the status does not change, so the first sighting is kept as well.
      const since = Math.min(seen, secs(b.randomnessRequestedAt));
      if (!over(since)) return undefined;
      const attempt = b.randomnessAttempt + 1;
      const last = attempt >= MAX_RANDOMNESS_ATTEMPTS ? ": that was the last request the program allows, so only the admin can go on, by switching the randomness program (set_randomness)" : "";
      return { key, text: `${name} has waited at least ${duration(t - since)} for ORAO's randomness, on request ${attempt} of ${MAX_RANDOMNESS_ATTEMPTS}${last} ${log}.` };
    }
    case "Settled": {
      const since = secs(b.seededAt);
      return over(since) ? { key, text: `${name}'s seed has been final for ${duration(t - since)} and its free-spot winners are not all recorded ${log}.` } : undefined;
    }
    case "Drawn": {
      const since = secs(b.seededAt);
      if (!over(since)) return undefined;
      const count = b.delivered === undefined ? "its cards are not all delivered" : `${b.delivered} of its ${plural(b.poolSize, "card is", "cards are")} delivered`;
      const left = SELLBACK_HOURS * HOUR - (t - since);
      const window = left > 0 ? `ends within ${duration(left, "up")}` : "has probably closed";
      return {
        key,
        text: `${name} was drawn ${duration(t - since)} ago and ${count} ${log}. Every card was pulled before the draw, so Collector Crypt's sellback window, about ${SELLBACK_HOURS} hours from the pull (not confirmed yet), ${window}.`,
      };
    }
    case "Cancelled":
      // The refund job pays the buyers back, and a spot whose owner cannot take the money is not the keeper's to fix.
      return undefined;
  }
}

/** The keeper's SOL against what a break costs it (`keeperSolNeed`): below what one whole break needs, it says so. */
export function keeperAlert(keeper: Address, lamports: bigint, need: { create: bigint; cycle: bigint }): Alert | undefined {
  if (lamports >= need.cycle) return undefined;
  const has = `The keeper wallet ${keeper} holds ${sol(lamports)}`;
  const text =
    lamports < need.create
      ? `${has}: creating a break needs ${sol(need.create)} and seeing one through about ${sol(need.cycle)}.`
      : `${has}: enough to create a break, not to see one through, which needs about ${sol(need.cycle)}.`;
  return { key: "keeper:sol", text: `${text} Top it up with devnet SOL.` };
}

export function pausedAlert(paused: boolean): Alert | undefined {
  return paused
    ? { key: "program:paused", text: "The breaks program is paused by its admin: no new breaks, spot sales or funding until it is unpaused (cancelling and refunds still work)." }
    : undefined;
}

/** The watchdog could not read something it needs, for long enough to say so. */
export function unreadAlert(source: "chain" | "database", since: Date, error: string, now: Date, limits: WatchLimits): Alert | undefined {
  const age = now.getTime() - since.getTime();
  if (age < limits.afterMs) return undefined;
  const what = source === "chain" ? "the node" : "the database";
  return { key: `watch:${source}`, text: `The watchdog has not been able to read ${what} for ${duration(age)}: ${error}` };
}
