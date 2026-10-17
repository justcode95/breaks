// The per-spot ledger of a break whose cards are all delivered: for every pack the keeper bought, the price it paid, the
// purchase transaction and the card that came out; for every spot, the wallet, the card the draw gave it and the transaction
// that sent the card there. It is how a reader follows each spot from the money to the card, and sees any gap.
//
// The chain does not commit the ledger itself, so it goes out only when what the keeper holds agrees with everything the chain
// does commit: the break is drawn, the packs are exactly the first `pool_size` of its list and none cost more than its cap, their
// cards are the committed pool, and every spot's card and wallet are the ones the draw assigns (`buildDeliveryPlan`, from the
// seed, the paid spots and the free winners on chain). The transactions are the keeper's word: a reader looks them up on chain.

import { toHex } from "../draw/bytes.js";
import { buildDeliveryPlan, PlanError } from "../delivery/plan.js";
import { type BreakAccount, type SpotAccount, packPrices } from "../solana/breaks.js";
import type { Address } from "../solana/pubkey.js";

/** A pack as the pack buyer stored it. */
export interface StoredPack {
  index: number;
  status: string;
  purchaseSig?: string;
  /** What the provider said the pack cost; unknown for a purchase that was found in the wallet's history. */
  price?: bigint;
  cardMint?: string;
  proofRef?: string;
}

/** A delivery as the deliverer stored it, with the spot it is for. */
export interface StoredDelivery {
  kind: "paid" | "free";
  /** Purchase order (paid) or draw order (free), from 0. */
  idx: number;
  recipient?: string;
  cardMint: string;
  status: string;
  txSig?: string;
  /** The card was found at its recipient without a transfer of ours on record (after lost notes). */
  adopted: boolean;
}

export interface LedgerPack {
  index: number;
  price: bigint | undefined;
  purchaseTx: string;
  card: Address;
  proof: string | undefined;
}

export interface LedgerSpot {
  kind: "paid" | "free";
  index: number;
  wallet: Address;
  card: Address;
  /** Undefined when the card was found at the wallet without a transfer of ours on record. */
  deliveryTx: string | undefined;
}

export interface Ledger {
  poolHash: string;
  /** The buyer wallet the program names: it paid for the packs, held the cards and sent them. */
  buyer: Address;
  /** In the order of the break's pack list. */
  packs: LedgerPack[];
  /** Paid spots in purchase order, then free spots in draw order. */
  spots: LedgerSpot[];
}

export interface LedgerInput {
  /** The break's account, read at `finalized`. */
  chain: BreakAccount;
  /** The configured buyer wallet, which held the cards. */
  buyer: Address;
  /** The break's `Spot` accounts, in index order. */
  paidSpots: readonly SpotAccount[];
  packs: readonly StoredPack[];
  deliveries: readonly StoredDelivery[];
}

/** The ledger, or an error that names the first thing that does not agree with the chain or is not done. */
export function buildLedger(input: LedgerInput): Ledger {
  const { chain } = input;
  if (chain.status !== "Drawn") throw new Error(`the break is ${chain.status} on chain, not drawn`);

  const packs = [...input.packs].sort((a, b) => a.index - b.index);
  if (packs.length !== chain.poolSize) throw new Error(`${packs.length} packs are stored but the pool has ${chain.poolSize}`);
  const caps = packPrices(chain);
  const ledgerPacks = packs.map((p, i): LedgerPack => {
    if (p.index !== i) throw new Error(`pack ${i} is missing`);
    if (p.status !== "pulled") throw new Error(`pack ${i} is ${p.status}, not pulled`);
    if (p.cardMint === undefined) throw new Error(`pack ${i} has no card`);
    if (p.purchaseSig === undefined) throw new Error(`pack ${i} has no purchase transaction`);
    const cap = caps[i];
    if (cap === undefined) throw new Error(`pack ${i} is not in the break's pack list`);
    if (p.price !== undefined && p.price > cap) throw new Error(`pack ${i} cost ${p.price}, above its cap of ${cap}`);
    return { index: i, price: p.price, purchaseTx: p.purchaseSig, card: p.cardMint, proof: p.proofRef };
  });

  // Who gets which card, from the chain alone; it also checks the cards are the committed pool.
  let plan: ReturnType<typeof buildDeliveryPlan>;
  try {
    plan = buildDeliveryPlan({ breakId: "", buyer: input.buyer, chain, paidSpots: input.paidSpots, cards: ledgerPacks.map((p) => p.card) });
  } catch (err) {
    throw new Error(err instanceof PlanError ? err.message : `the draw's assignment cannot be worked out: ${err instanceof Error ? err.message : String(err)}`);
  }

  const stored = new Map(input.deliveries.map((d) => [`${d.kind}:${d.idx}`, d]));
  if (stored.size !== input.deliveries.length) throw new Error("a spot has two deliveries");
  if (stored.size !== plan.deliveries.length) throw new Error(`${stored.size} deliveries are stored but the break has ${plan.deliveries.length} spots`);
  const spots = plan.deliveries.map((p): LedgerSpot => {
    const name = `${p.spot.kind} spot ${p.spot.idx}`;
    const d = stored.get(`${p.spot.kind}:${p.spot.idx}`);
    if (!d) throw new Error(`${name} has no delivery`);
    if (d.cardMint !== p.cardMint) throw new Error(`${name} was sent card ${d.cardMint}, but the draw gives it ${p.cardMint}`);
    if (d.recipient !== p.recipient) throw new Error(`${name} was sent to ${d.recipient ?? "nobody"}, but the draw gives its card to ${p.recipient}`);
    if (d.status !== "confirmed") throw new Error(`the delivery of ${name} is ${d.status}, not confirmed`);
    if (d.txSig === undefined && !d.adopted) throw new Error(`the delivery of ${name} has no transaction`);
    return { kind: p.spot.kind, index: p.spot.idx, wallet: p.recipient, card: p.cardMint, deliveryTx: d.txSig };
  });
  return { poolHash: toHex(chain.poolHash), buyer: input.buyer, packs: ledgerPacks, spots };
}
