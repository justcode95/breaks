// What the refund panel is doing: nothing, a refund in progress, or a refund that has ended (with how). The same rules as the buy
// panel's (buy-state.ts): one refund at a time, a step or result that arrives when nothing is running is ignored, and "the page
// shows it now" only counts for the refund it is about.

import type { Address } from "./address";
import type { PurchaseStep } from "./purchase";
import type { RefundResult } from "./refund";

interface Which {
  /** The wallet account the refund was sent with. */
  address: Address;
  /** The break number people see, and the spot counting from 0. */
  breakNumber: number;
  index: number;
}

export type RefundState =
  | { status: "idle" }
  | ({ status: "running"; step: PurchaseStep } & Which)
  /** `seen` is true once the page has read the spot back from the chain as refunded. */
  | ({ status: "finished"; result: RefundResult; seen: boolean } & Which);

export const idleRefund: RefundState = { status: "idle" };

export type RefundAction =
  | ({ type: "start" } & Which)
  | { type: "step"; step: PurchaseStep }
  | { type: "finished"; result: RefundResult }
  /** The page read the spot of the refund with this signature back from the chain as refunded. */
  | { type: "seen"; signature: string }
  | { type: "dismiss" };

export function refundReducer(state: RefundState, action: RefundAction): RefundState {
  switch (action.type) {
    case "start":
      // One refund at a time: while one runs, another start is ignored.
      return state.status === "running" ? state : { status: "running", step: "checking", address: action.address, breakNumber: action.breakNumber, index: action.index };
    case "step":
      return state.status === "running" ? { ...state, step: action.step } : state;
    case "finished":
      return state.status === "running"
        ? { status: "finished", result: action.result, seen: false, address: state.address, breakNumber: state.breakNumber, index: state.index }
        : state;
    case "seen":
      // Only for the refund it is about: the result on show may be a later one.
      return state.status === "finished" && state.result.kind === "refunded" && state.result.signature === action.signature ? { ...state, seen: true } : state;
    case "dismiss":
      // A refund in progress cannot be dismissed: the wallet may still be about to send it.
      return state.status === "finished" ? idleRefund : state;
  }
}
