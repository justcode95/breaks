// What the deliverer needs from "the thing that moves a card to a wallet".
//
// Whether a Collector Crypt card can be moved like any other asset (a programmable NFT with a rule set, a
// Metaplex Core asset, ...) and whether it can still be sold back afterwards is a Phase 0 question
// (CLAUDE.md), so the deliverer is written against these steps and tested against a mock.

import type { Address } from "../solana/pubkey.js";
import type { SpotRef } from "./plan.js";

export interface DeliveryRequest {
  breakId: string;
  spot: SpotRef;
  /** Wallet that holds the card now (the buyer wallet). */
  from: Address;
  /** Wallet that gets it. The recipient's token account is created if needed; the keeper pays the rent. */
  recipient: Address;
  cardMint: Address;
}

/** A signed transfer that has not been sent. Preparing one spends nothing. */
export interface PreparedTransfer {
  request: DeliveryRequest;
  /** Known before sending, so it can be stored first. */
  signature: string;
  /** Opaque: when this transfer can no longer land (on Solana, the last valid block height). */
  expiry: string;
  payload?: unknown;
}

export type TransferStatus =
  /** May still land (or has not been sent). */
  | { state: "pending" }
  /** Landed and succeeded. */
  | { state: "confirmed" }
  /** Landed and reverted: the card did not move. */
  | { state: "failed"; reason: string }
  /** It can never land. Only then is it safe to build another transfer. When in doubt a provider answers `pending`. */
  | { state: "expired" };

export interface CardTransfer {
  /**
   * The wallet that owns the card right now, read from the chain, or undefined when the card cannot be found.
   * This is the source of truth: the deliverer sends nothing unless the owner is the buyer wallet, and counts a
   * card as delivered when its owner is the recipient, whatever its notes say.
   */
  ownerOf(cardMint: Address): Promise<Address | undefined>;

  prepare(request: DeliveryRequest): Promise<PreparedTransfer>;

  /** Sends a prepared transfer. Sending the same one twice is harmless. May throw after the transaction landed. */
  submit(transfer: PreparedTransfer): Promise<void>;

  status(signature: string, expiry: string): Promise<TransferStatus>;
}
