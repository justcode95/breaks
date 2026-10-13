// Who gets which card. Built only from things that are committed on-chain, and refuses to build anything
// that does not add up: a card sent to the wrong wallet cannot be taken back.

import { assignCards, poolHash } from "../draw/pool.js";
import { equalBytes, toHex } from "../draw/bytes.js";
import type { BreakAccount, SpotAccount } from "../solana/breaks.js";
import { type Address, addressToBytes } from "../solana/pubkey.js";

export type PlanErrorCode =
  /** The break is not in the `Drawn` state, so the winners and the seed are not final. */
  | "not_drawn"
  | "bad_seed"
  /** The paid spots read from the chain do not match what the break says was sold. */
  | "spots"
  /** The free-spot winners do not match what the break says was drawn. */
  | "winners"
  /** The cards we hold are not a valid pool of the committed size. */
  | "cards"
  /** The cards we hold are not the pool that was committed on-chain before the draw. */
  | "pool_hash"
  | "address";

export class PlanError extends Error {
  constructor(
    readonly code: PlanErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PlanError";
  }
}

export interface SpotRef {
  kind: "paid" | "free";
  /** Purchase order (paid) or draw order (free). */
  idx: number;
}

export interface Delivery {
  spot: SpotRef;
  /** Wallet that gets the card. */
  recipient: Address;
  cardMint: Address;
}

export interface DeliveryPlan {
  /** `breaks.id` in the database, as text. */
  breakId: string;
  /** The wallet that holds the cards (the buyer wallet). */
  buyer: Address;
  deliveries: Delivery[];
}

export interface PlanInput {
  breakId: string;
  buyer: Address;
  /** The decoded on-chain `Break` account. */
  chain: BreakAccount;
  /** The `Spot` accounts of the break, in index order. */
  paidSpots: readonly SpotAccount[];
  /** Mints of the pulled cards, in any order. */
  cards: readonly Address[];
}

const isZero = (b: Uint8Array) => b.every((x) => x === 0);

function requireAddress(a: Address, what: string): Uint8Array {
  try {
    return addressToBytes(a);
  } catch {
    throw new PlanError("address", `${what} is not a valid address: ${a}`);
  }
}

/**
 * Checks everything the chain commits to and works out the delivery of every card. Throws a `PlanError`
 * naming the first thing that does not add up.
 */
export function buildDeliveryPlan(input: PlanInput): DeliveryPlan {
  const { chain, paidSpots, cards } = input;

  if (chain.status !== "Drawn") throw new PlanError("not_drawn", `break ${chain.id} is ${chain.status}, not Drawn`);
  if (isZero(chain.seed)) throw new PlanError("bad_seed", "the draw seed is empty");
  requireAddress(input.buyer, "the buyer wallet");

  if (paidSpots.length !== chain.spotsSold) {
    throw new PlanError("spots", `${paidSpots.length} spots given but ${chain.spotsSold} were sold`);
  }
  const paidOwners = paidSpots.map((s, i) => {
    if (s.breakId !== chain.id || s.index !== i) throw new PlanError("spots", `spot ${i} is out of place`);
    if (s.refunded) throw new PlanError("spots", `spot ${i} was refunded`);
    requireAddress(s.owner, `owner of spot ${i}`);
    return s.owner;
  });

  const expectedFree = chain.poolSize - chain.spotsSold;
  if (expectedFree < 0 || chain.freeWinnerCount !== expectedFree) {
    throw new PlanError("winners", `${chain.freeWinnerCount} free winners recorded but ${expectedFree} expected`);
  }
  const freeWinners = chain.freeWinners.slice(0, chain.freeWinnerCount).map((w, i) => {
    if (isZero(requireAddress(w.wallet, `free winner ${i}`))) throw new PlanError("winners", `free winner ${i} is empty`);
    return w.wallet;
  });

  if (cards.length !== chain.poolSize) {
    throw new PlanError("cards", `${cards.length} cards but the pool has ${chain.poolSize}`);
  }
  const mints = cards.map((c) => requireAddress(c, "a card mint"));
  let hash: Uint8Array;
  try {
    hash = poolHash(mints);
  } catch (err) {
    throw new PlanError("cards", err instanceof Error ? err.message : String(err));
  }
  if (!equalBytes(hash, chain.poolHash)) {
    throw new PlanError("pool_hash", "the cards are not the pool that was committed on-chain");
  }

  const byBytes = new Map(cards.map((c) => [toHex(addressToBytes(c)), c] as const));
  const assigned = assignCards(chain.seed, mints, paidOwners, freeWinners);
  const deliveries = assigned.map((a): Delivery => {
    const cardMint = byBytes.get(toHex(a.card));
    if (!cardMint) throw new PlanError("cards", "an assigned card is not in the pool");
    return {
      spot: { kind: a.kind, idx: a.kind === "paid" ? a.spot : a.spot - chain.spotsSold },
      recipient: a.owner,
      cardMint,
    };
  });
  return { breakId: input.breakId, buyer: input.buyer, deliveries };
}
