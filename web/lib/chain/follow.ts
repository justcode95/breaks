// After a purchase is confirmed, the pages still read at `finalized`, which is a few seconds behind. This reads the break again
// until the new spot shows up as the buyer's, so the page does not keep showing the old count.

import type { Address } from "./address";
import type { Loaded } from "./load";

export interface FollowOptions {
  /** Reads the break again (and lets the page show it). May fail: a failed read is tried again. */
  load: () => Promise<Loaded>;
  /** The spot that was bought, counting from 0, and who bought it. */
  index: number;
  owner: Address;
  /** How many reads at most, and the pause between them. */
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Asked before every read; the wait ends when it says to stop (the page went away). */
  stop?: () => boolean;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Whether the chain shows the spot as the buyer's. `"not-yet"` does not mean it failed: the purchase was confirmed, it is only not finalized. */
export async function waitForSpot(o: FollowOptions): Promise<"seen" | "not-yet"> {
  const attempts = o.attempts ?? 12;
  const delayMs = o.delayMs ?? 5000;
  const sleep = o.sleep ?? wait;
  for (let i = 0; i < attempts; i++) {
    if (o.stop?.()) return "not-yet";
    try {
      const loaded = await o.load();
      if (loaded.paidOwners[o.index] === o.owner) return "seen";
    } catch {
      // The node may be busy; the next read asks again.
    }
    if (i < attempts - 1) await sleep(delayMs);
  }
  return "not-yet";
}
