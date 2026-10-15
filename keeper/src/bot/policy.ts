// What the X bot should post, decided from a snapshot of the world. Pure: no clock, no network, no database.
//
// Everything about a break comes from its account on chain as the bot read it at `finalized`, so nothing is announced
// that could still roll back (CLAUDE.md: "never post before the on-chain event is finalized"). The only facts that
// are not on chain are the ones the keeper's own database holds: which wallets agreed to be tagged, and which cards
// have been delivered.
//
// Each post has a dedupe key, so asking again never makes a second post. A post that is no longer worth sending
// (the sale is over, the draw was long ago) is not made at all: a bot that has been off for a day does not announce
// yesterday.

import { packMachineLabel } from "../scheduler/machine.js";
import type { BreakAccount } from "../solana/breaks.js";
import type { Address } from "../solana/pubkey.js";
import { openPost, reminderPost, reservePost, resultsPost, shortWallet, winnersPost } from "./templates.js";

/** What the open post says about the packs: the machine's name, or how many machines when there are several. */
function machinesInPost(b: BreakAccount): string {
  const names = new Set(b.tiers.map((t) => packMachineLabel(t.machine)));
  return names.size === 1 ? ([...names][0] as string) : `${names.size} machines`;
}

export type PostKind = "reserve" | "open" | "reminder" | "winners" | "results";

export interface BotSettings {
  /** Percentages (ascending, each below 100) at which the progress of the next break is announced. */
  milestones: readonly number[];
  /** Hours before a sale closes at which spots left are announced. */
  reminderHours: readonly number[];
  /** Seconds a delivery must have settled before the results are announced. */
  finalityMarginSecs: number;
  /** Where the results page is, if there is one: the results post links to `<siteUrl>/breaks/<number>`. */
  siteUrl?: string;
}

export interface DeliveredFacts {
  /** On-chain id of the break. */
  breakId: bigint;
  cards: number;
  wallets: number;
  /** When the last card of the break was confirmed delivered. */
  lastDeliveredAt: Date;
  /** The best card and who got it, if a card catalogue can say. */
  topHit?: { name: string; winner: Address };
}

export interface World {
  now: Date;
  /** The next break to be created and how far its reserve is. Absent when the treasury cannot be read. */
  reserve?: { nextBreakId: bigint; percent: number; enough: boolean; target: bigint };
  /** The latest breaks as they are on chain at `finalized`. */
  breaks: readonly BreakAccount[];
  /** X handles of wallets that agreed to be tagged (already checked to be valid handles). */
  handles: ReadonlyMap<Address, string>;
  delivered: readonly DeliveredFacts[];
  /** Dedupe keys the bot already has (queued, posted or dropped). */
  keys: ReadonlySet<string>;
}

export interface Draft {
  kind: PostKind;
  /** On-chain id of the break the post is about. */
  breakId: bigint;
  dedupeKey: string;
  body: string;
  /** After this the post is stale. */
  validUntil: Date;
}

const HOUR_MS = 3_600_000;
/** How long after a draw or a delivery it is still news. */
const NEWS_MS = 48 * HOUR_MS;
/** A milestone is only news until the break it is for exists, and not for long after it is reached. */
const MILESTONE_MS = 3 * HOUR_MS;

export function desiredPosts(world: World, settings: BotSettings): Draft[] {
  const drafts: Draft[] = [];
  const nowMs = world.now.getTime();
  const nowSecs = BigInt(Math.floor(nowMs / 1000));

  // 1. How far the next break's reserve is: the highest milestone reached, unless a higher one was already announced.
  const r = world.reserve;
  if (r && !r.enough) {
    const reached = [...settings.milestones].filter((m) => m <= r.percent).sort((a, b) => b - a)[0];
    if (reached !== undefined) {
      const higherDone = settings.milestones.some((m) => m >= reached && world.keys.has(`reserve:${r.nextBreakId}:${m}`));
      if (!higherDone) {
        drafts.push({
          kind: "reserve",
          breakId: r.nextBreakId,
          dedupeKey: `reserve:${r.nextBreakId}:${reached}`,
          body: reservePost({ breakId: r.nextBreakId, percent: reached, target: r.target }),
          validUntil: new Date(nowMs + MILESTONE_MS),
        });
      }
    }
  }

  for (const b of world.breaks) {
    const closesMs = Number(b.closesAt) * 1000;

    // 2. A sale that is on: it is live, and then how many spots are left as the end comes near.
    if (b.status === "Open" && nowSecs < b.closesAt) {
      drafts.push({
        kind: "open",
        breakId: b.id,
        dedupeKey: `open:${b.id}`,
        body: openPost({
          breakId: b.id,
          paid: b.paidSpots,
          free: b.freeSpots,
          price: b.spotPrice,
          machine: machinesInPost(b),
          closesAt: b.closesAt,
        }),
        validUntil: new Date(closesMs),
      });

      const left = b.paidSpots - b.spotsSold;
      const window = Number(b.closesAt - b.opensAt);
      const secsLeft = Number(b.closesAt - nowSecs);
      // Only reminders that come well after the start (at most half the window before the end), and only the nearest
      // threshold that has passed: a bot that was off does not catch up on the earlier ones.
      const thresholds = [...settings.reminderHours].filter((h) => h * 3_600 <= window / 2).sort((a, c) => a - c);
      const due = thresholds.find((h) => secsLeft <= h * 3_600);
      if (due !== undefined && left > 0) {
        drafts.push({
          kind: "reminder",
          breakId: b.id,
          dedupeKey: `reminder:${b.id}:${due}`,
          body: reminderPost({ breakId: b.id, left, secsLeft }),
          validUntil: new Date(closesMs),
        });
      }
    }

    // 3. The free spots are drawn: who won them.
    if (b.status === "Drawn" && b.freeWinnerCount > 0 && nowMs < Number(b.seededAt) * 1000 + NEWS_MS) {
      const names = b.freeWinners.slice(0, b.freeWinnerCount).map((w) => {
        const handle = world.handles.get(w.wallet);
        return handle ? `@${handle}` : shortWallet(w.wallet);
      });
      drafts.push({
        kind: "winners",
        breakId: b.id,
        dedupeKey: `winners:${b.id}`,
        body: winnersPost({ breakId: b.id, names }),
        validUntil: new Date(Number(b.seededAt) * 1000 + NEWS_MS),
      });
    }
  }

  // 4. Every card is delivered (and long enough ago to be final): the results.
  for (const d of world.delivered) {
    const at = d.lastDeliveredAt.getTime();
    if (nowMs < at + settings.finalityMarginSecs * 1000 || nowMs >= at + NEWS_MS) continue;
    const winner = d.topHit && (world.handles.has(d.topHit.winner) ? `@${world.handles.get(d.topHit.winner)}` : shortWallet(d.topHit.winner));
    drafts.push({
      kind: "results",
      breakId: d.breakId,
      dedupeKey: `results:${d.breakId}`,
      body: resultsPost({
        breakId: d.breakId,
        cards: d.cards,
        wallets: d.wallets,
        ...(settings.siteUrl ? { link: `${settings.siteUrl.replace(/\/+$/, "")}/breaks/${d.breakId + 1n}` } : {}),
        ...(d.topHit && winner ? { topHit: { name: d.topHit.name, winner } } : {}),
      }),
      validUntil: new Date(at + NEWS_MS),
    });
  }

  return drafts;
}
