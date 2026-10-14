// One purchase, from the click to the page showing the new spot. The wallet and the node are behind `buy` and `follow`, so the
// order of things (one purchase at a time, an unexpected failure told as such, the page told only about its own purchase) is
// tested without either.

import type { Address } from "./address";
import type { BuyAction } from "./buy-state";
import type { PurchaseResult, PurchaseStep } from "./purchase";
import { errorText } from "../wallet/wallets";

export interface PurchaseRun {
  /** The wallet account the purchase is made with. */
  address: Address;
  /** Runs the purchase (`buySpot`), reporting each step. */
  buy: (onStep: (step: PurchaseStep) => void) => Promise<PurchaseResult>;
  dispatch: (action: BuyAction) => void;
  /** Waits for the page to show the spot with this index as the buyer's (`waitForSpot`). */
  follow: (index: number) => Promise<"seen" | "not-yet">;
  /** Called once a purchase is confirmed, for the things the purchase changed (the wallet's balance). */
  afterBought?: () => void;
  /**
   * Set while a purchase is on its way to its result. A second click while it is set does nothing, even before the page has
   * redrawn, so one click can never buy two spots.
   */
  guard: { current: boolean };
}

export async function runPurchase(r: PurchaseRun): Promise<void> {
  if (r.guard.current) return;
  r.guard.current = true;
  r.dispatch({ type: "start", address: r.address });

  let result: PurchaseResult;
  try {
    result = await r.buy((step) => r.dispatch({ type: "step", step }));
  } catch (err) {
    // `buySpot` reports its failures as results, so this is a mistake in the page. The wallet may have been asked: say so.
    result = { kind: "declined", reason: `Something went wrong on this page: ${errorText(err)}. If you approved a transaction, check your wallet's history before trying again.` };
  } finally {
    r.guard.current = false;
  }
  r.dispatch({ type: "finished", result });
  if (result.kind !== "bought") return;

  r.afterBought?.();
  if ((await r.follow(result.index)) === "seen") r.dispatch({ type: "seen", signature: result.signature });
}
