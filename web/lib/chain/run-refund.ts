// One refund, from the click to the page showing the spot as refunded. The wallet and the node are behind `refund` and `follow`, so
// the order of things (one refund at a time, an unexpected failure told as such, the page told only about its own refund) is tested
// without either. The same shape as run-purchase.ts.

import type { Address } from "./address";
import type { PurchaseStep } from "./purchase";
import type { RefundResult } from "./refund";
import type { RefundAction } from "./refund-state";
import { errorText } from "../wallet/wallets";

export interface RefundRun {
  address: Address;
  breakNumber: number;
  index: number;
  /** Runs the refund (`refundSpot`), reporting each step. */
  refund: (onStep: (step: PurchaseStep) => void) => Promise<RefundResult>;
  dispatch: (action: RefundAction) => void;
  /** Waits for the page to show the spot as refunded (`waitForRefund`). */
  follow: () => Promise<"seen" | "not-yet">;
  /** Set while a refund is on its way to its result: a second click while it is set does nothing, even before the page has redrawn. */
  guard: { current: boolean };
}

export async function runRefund(r: RefundRun): Promise<void> {
  if (r.guard.current) return;
  r.guard.current = true;
  r.dispatch({ type: "start", address: r.address, breakNumber: r.breakNumber, index: r.index });

  let result: RefundResult;
  try {
    result = await r.refund((step) => r.dispatch({ type: "step", step }));
  } catch (err) {
    // `refundSpot` reports its failures as results, so this is a mistake in the page. The wallet may have been asked: say so.
    result = { kind: "declined", reason: `Something went wrong on this page: ${errorText(err)}. If you approved a transaction, check your wallet's history before trying again.` };
  } finally {
    r.guard.current = false;
  }
  r.dispatch({ type: "finished", result });
  if (result.kind !== "refunded") return;

  if ((await r.follow()) === "seen") r.dispatch({ type: "seen", signature: result.signature });
}
