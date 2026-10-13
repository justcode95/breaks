// What the pack buyer needs from "the thing that buys Collector Crypt packs".
//
// The real implementation cannot be written until Phase 0 (CLAUDE.md) says how a purchase works. The buyer
// is therefore written against these steps, which hold for any chain-based purchase, and tested against a
// mock that can drop, revert and half-fail transactions on demand.

export interface PackKey {
  /** `breaks.id` in the database, as text. */
  breakId: string;
  /** Position of the pack within the break (one pack per spot). */
  index: number;
}

export const keyString = (k: PackKey): string => `${k.breakId}:${k.index}`;

/**
 * The text every purchase for `key` must carry (a memo instruction on Solana), so the buyer wallet's history
 * can be searched for it after a crash.
 */
export const packMemo = (k: PackKey): string => `breaks:pack:${k.breakId}:${k.index}`;

export interface BuyOptions {
  machine: string;
  /** Hard cap in micro-USDC. A live price above this must fail `prepare`. */
  maxPrice: bigint;
}

/** A signed purchase that has not been sent. Preparing one spends nothing. */
export interface PreparedPurchase {
  key: PackKey;
  /** Known before sending (a Solana signature is the transaction's first signature), so it can be stored first. */
  signature: string;
  /**
   * Opaque to the buyer: when this purchase can no longer land (on Solana, the last valid block height).
   * Stored with the pack and handed back to `status`.
   */
  expiry: string;
  /** What the purchase charges, micro-USDC. */
  price: bigint;
  /** Whatever `submit` needs to send it. Not stored: after a restart the buyer only polls `status`. */
  payload?: unknown;
}

export type PurchaseStatus =
  /** May still land (or has not been sent). */
  | { state: "pending" }
  /** Landed and succeeded: the pack is bought. */
  | { state: "confirmed" }
  /** Landed and reverted: nothing was bought. */
  | { state: "failed"; reason: string }
  /**
   * It can never land: the expiry passed and a lookup at the strongest commitment found nothing. Only then
   * is it safe to build another purchase. When in doubt a provider answers `pending`.
   */
  | { state: "expired" };

/** A purchase found in the wallet's history. */
export interface ExistingPurchase {
  signature: string;
  expiry: string;
}

export interface PackReveal {
  cardMint: string;
  /** Pointer to the Collector Crypt VRF proof of this pull. */
  proofRef?: string;
  /** What was actually charged, micro-USDC. */
  price: bigint;
}

/** The live price of the machine is above the cap in `BuyOptions`. Nothing was bought. */
export class PriceAboveCapError extends Error {
  constructor(
    readonly livePrice: bigint,
    readonly maxPrice: bigint,
  ) {
    super(`live pack price ${livePrice} is above the cap ${maxPrice}`);
    this.name = "PriceAboveCapError";
  }
}

/**
 * Real purchases cost real money, so the contract is built around not buying twice:
 * `prepare` and `findExisting` spend nothing, and only `submit` sends money.
 */
export interface PackProvider {
  /**
   * Purchases for `key` that reached the chain (landed, confirmed or reverted), oldest first, found by their
   * memo (`packMemo`) in the buyer wallet's history. The buyer calls this before every `prepare`.
   */
  findExisting(key: PackKey): Promise<ExistingPurchase[]>;

  /** Builds and signs a purchase. Throws `PriceAboveCapError` when the live price is above `opts.maxPrice`. */
  prepare(key: PackKey, opts: BuyOptions): Promise<PreparedPurchase>;

  /** Sends a prepared purchase. Sending the same one twice is harmless (same signature). May throw after the transaction landed. */
  submit(purchase: PreparedPurchase): Promise<void>;

  status(signature: string, expiry: string): Promise<PurchaseStatus>;

  /** The pulled card of a confirmed purchase, or undefined while the pull cannot be read yet. */
  reveal(signature: string): Promise<PackReveal | undefined>;
}
