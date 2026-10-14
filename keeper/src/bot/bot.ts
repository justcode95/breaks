// The X bot: looks at the world, saves the posts it should make, and sends them one at a time within its limits.
//
// Every run starts from the chain (finalized) and its own table, never from memory, so it is safe to run as often
// as you like and across restarts:
//   1. read the world and work out which posts should exist (`desiredPosts`);
//   2. save the ones that are not saved yet: the dedupe key makes a second save do nothing, and the text is frozen
//      here, so a retry sends exactly the same words;
//   3. drop saved posts that went stale while they waited;
//   4. send the oldest one that is due, if the minimum gap since the last post and the daily budget allow.
// A send with no verdict (a timeout, a server error) is repeated with the same text after a wait. X refuses a
// duplicate, which is read as "the first send did land", so a lost answer does not make a second post.

import type { Job, Logger } from "../job.js";
import type { BotSettings } from "./policy.js";
import { desiredPosts } from "./policy.js";
import type { Poster } from "./poster.js";
import type { BotStore } from "./store.js";
import type { WorldReader } from "./world.js";

export interface BotLimits {
  /** Seconds between two posts. */
  minGapSecs: number;
  /** Posts in any 24 hours: the budget of a pay-per-post account. */
  maxPerDay: number;
  /** Sends without a verdict before a post is given up. */
  maxAttempts: number;
  /** A post that got no verdict waits `attempts × retryStepSecs` before the next send. */
  retryStepSecs: number;
}

export interface BotDeps {
  /**
   * Names the deployment the bot speaks for (the breaks program's address). Break ids start at 0 again on a fresh
   * deployment, so without it the keys of an earlier one (`open:0`) would stop every new announcement; and the
   * saved posts of another deployment are never sent.
   */
  scope: string;
  world: WorldReader;
  store: BotStore;
  poster: Poster;
  settings: BotSettings;
  limits: BotLimits;
  log: Logger;
  now?: () => Date;
}

export type BotReport = {
  /** Dedupe keys saved in this run. */
  queued: string[];
  /** Posts dropped for being stale. */
  expired: number;
} & (
  | { sent?: undefined; waiting?: string }
  | { sent: { dedupeKey: string; outcome: "posted" | "duplicate" | "rejected" | "retry" | "gave-up"; detail?: string }; waiting?: undefined }
);

const DAY_MS = 86_400_000;
/** Dedupe keys are only looked at for this long back. */
const KEY_MEMORY_MS = 7 * DAY_MS;

export class XBot {
  private readonly now: () => Date;

  constructor(private readonly deps: BotDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async run(): Promise<BotReport> {
    const { world, store, poster, settings, limits, scope } = this.deps;
    const now = this.now();
    const prefix = `${scope}:`;

    const keys = await store.keysSince(new Date(now.getTime() - KEY_MEMORY_MS), prefix);
    const snapshot = await world.read(now);
    const queued: string[] = [];
    for (const draft of desiredPosts({ ...snapshot, keys }, settings)) {
      if (await store.enqueue({ ...draft, dedupeKey: prefix + draft.dedupeKey }, now)) queued.push(draft.dedupeKey);
    }
    const expired = await store.expireStale(now);
    const base = { queued, expired };

    const found = await store.due(now, limits.retryStepSecs, prefix);
    if (!found) return base;
    const post = { ...found, dedupeKey: found.dedupeKey.slice(prefix.length) };

    const last = await store.lastPostedAt();
    if (last && now.getTime() - last.getTime() < limits.minGapSecs * 1000) return { ...base, waiting: "the minimum gap since the last post" };
    if ((await store.postedSince(new Date(now.getTime() - DAY_MS))) >= limits.maxPerDay) return { ...base, waiting: "the daily limit of posts" };

    let result: Awaited<ReturnType<Poster["post"]>>;
    try {
      result = await poster.post(post.body);
    } catch (err) {
      result = { outcome: "retry", reason: `the poster failed: ${err instanceof Error ? err.message : String(err)}` };
    }

    switch (result.outcome) {
      case "posted":
        await store.markPosted(post.id, result.id, now);
        return { ...base, sent: { dedupeKey: post.dedupeKey, outcome: "posted", ...(result.id ? { detail: result.id } : {}) } };
      case "duplicate":
        await store.markPosted(post.id, undefined, now, "X refused it as a duplicate: assumed already posted by an earlier send");
        return { ...base, sent: { dedupeKey: post.dedupeKey, outcome: "duplicate" } };
      case "rejected":
        await store.markFailed(post.id, result.reason, now);
        return { ...base, sent: { dedupeKey: post.dedupeKey, outcome: "rejected", detail: result.reason } };
      case "retry": {
        const attempts = await store.markRetry(post.id, result.reason, now);
        if (attempts >= limits.maxAttempts) {
          await store.markFailed(post.id, `given up after ${attempts} sends without a verdict: ${result.reason}`, now);
          return { ...base, sent: { dedupeKey: post.dedupeKey, outcome: "gave-up", detail: result.reason } };
        }
        return { ...base, sent: { dedupeKey: post.dedupeKey, outcome: "retry", detail: result.reason } };
      }
    }
  }
}

/** The bot as a keeper job; it says what happened, and a wait only when it starts. */
export function botJob(opts: { bot: XBot; intervalMs: number }): Job {
  let lastWaiting: string | undefined;
  return {
    name: "x-bot",
    intervalMs: opts.intervalMs,
    async run(ctx) {
      const r = await opts.bot.run();
      for (const key of r.queued) ctx.log.info("X post saved", { key });
      if (r.expired > 0) ctx.log.info("X posts dropped for being stale", { count: r.expired });
      if (r.waiting !== lastWaiting) {
        lastWaiting = r.waiting;
        if (r.waiting) ctx.log.info("an X post is waiting for", { limit: r.waiting });
      }
      if (!r.sent) return;
      const fields = { key: r.sent.dedupeKey, ...(r.sent.detail ? { detail: r.sent.detail } : {}) };
      if (r.sent.outcome === "posted" || r.sent.outcome === "duplicate") ctx.log.info(`X post ${r.sent.outcome}`, fields);
      else ctx.log.error(`X post ${r.sent.outcome}`, fields);
    },
  };
}
