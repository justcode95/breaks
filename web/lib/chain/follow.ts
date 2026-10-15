// After a purchase is confirmed, the pages still read at `finalized`, which is a few seconds behind. This reads the break again
// until the new spot shows up as the buyer's, so the page does not keep showing the old count.

import type { Address } from "./address";
import type { Loaded } from "./load";
import type { Mine } from "./mine";

export interface PollOptions {
  /** How many reads at most, and the pause between them. */
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Asked before every read; the wait ends when it says to stop (the page went away). */
  stop?: () => boolean;
}

export interface FollowOptions extends PollOptions {
  /** Reads the break again (and lets the page show it). May fail: a failed read is tried again. */
  load: () => Promise<Loaded>;
  /** The spot that was bought, counting from 0, and who bought it. */
  index: number;
  owner: Address;
}

export interface FollowRefundOptions extends PollOptions {
  /** Reads the wallet's spots again (and lets the page show them). May fail: a failed read is tried again. */
  load: () => Promise<Mine>;
  /** The break number people see, and the spot that was refunded, counting from 0. */
  breakNumber: number;
  index: number;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Asks `check` until it says yes, at most `attempts` times with a pause between. A failed read is asked again. */
async function pollUntil(o: PollOptions, check: () => Promise<boolean>): Promise<"seen" | "not-yet"> {
  const attempts = o.attempts ?? 12;
  const delayMs = o.delayMs ?? 5000;
  const sleep = o.sleep ?? wait;
  for (let i = 0; i < attempts; i++) {
    if (o.stop?.()) return "not-yet";
    try {
      if (await check()) return "seen";
    } catch {
      // The node may be busy; the next read asks again.
    }
    if (i < attempts - 1) await sleep(delayMs);
  }
  return "not-yet";
}

/** Whether the chain shows the spot as the buyer's. `"not-yet"` does not mean it failed: the purchase was confirmed, it is only not finalized. */
export const waitForSpot = (o: FollowOptions): Promise<"seen" | "not-yet"> => pollUntil(o, async () => (await o.load()).paidOwners[o.index] === o.owner);

/** Whether the chain shows the spot as refunded. `"not-yet"` does not mean it failed: the refund was confirmed, it is only not finalized. */
export const waitForRefund = (o: FollowRefundOptions): Promise<"seen" | "not-yet"> =>
  pollUntil(o, async () => (await o.load()).spots.some((s) => s.breakNumber === o.breakNumber && s.index === o.index && s.refunded));
