// What the buy panel is doing: nothing, a purchase in progress, or a purchase that has ended (with how). Plain rules over plain
// data so they can be tested without a page. The important ones: only one purchase at a time (a second click while one is running
// does nothing), and an answer that arrives when it is no longer wanted is ignored.

import type { Address } from "./address";
import type { PurchaseResult, PurchaseStep } from "./purchase";

export type BuyState =
  | { status: "idle" }
  /** `address` is the wallet account the purchase was made with. */
  | { status: "running"; address: Address; step: PurchaseStep }
  /** `seen` is true once the page has read the new spot back from the chain. */
  | { status: "finished"; address: Address; result: PurchaseResult; seen: boolean };

export const idleBuy: BuyState = { status: "idle" };

export type BuyAction =
  | { type: "start"; address: Address }
  | { type: "step"; step: PurchaseStep }
  | { type: "finished"; result: PurchaseResult }
  /** The page read the spot of the purchase with this signature back from the chain. */
  | { type: "seen"; signature: string }
  | { type: "dismiss" };

export function buyReducer(state: BuyState, action: BuyAction): BuyState {
  switch (action.type) {
    case "start":
      // One purchase at a time: while one runs, another start is ignored.
      return state.status === "running" ? state : { status: "running", address: action.address, step: "checking" };
    case "step":
      return state.status === "running" ? { ...state, step: action.step } : state;
    case "finished":
      return state.status === "running" ? { status: "finished", address: state.address, result: action.result, seen: false } : state;
    case "seen":
      // Only for the purchase it is about: the result on show may be a later one.
      return state.status === "finished" && state.result.kind === "bought" && state.result.signature === action.signature ? { ...state, seen: true } : state;
    case "dismiss":
      // A purchase in progress cannot be dismissed: the wallet may still be about to send it.
      return state.status === "finished" ? idleBuy : state;
  }
}
