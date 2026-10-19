// The cards a wallet got, from the per-spot ledgers the keeper publishes once a break's cards are delivered
// (`ledger/<pool hash>.json`, docs/PUBLISHED.md). Cards are not on chain, so a ledger is used only once it agrees with the chain
// and the draw (`checkLedger`, the same check the break's page makes): its cards are the committed pool, and each spot's card is
// the one the draw gives that spot. Which card is this wallet's is then the draw's word; the delivery transactions are the
// keeper's (they can be looked up).

import type { BreakAccount } from "./chain/accounts";
import type { Address } from "./chain/address";
import { loadBreak } from "./chain/load";
import type { Mine } from "./chain/mine";
import { toHex } from "./draw/bytes";
import { type Ledger, type LedgerPack, type LedgerState, loadLedger } from "./ledger";

/** How many of the drawn breaks the wallet has a spot in are looked at, newest first. */
export const CARD_BREAKS = 10;

export interface MyCard {
  kind: "paid" | "free";
  /** Which paid or free spot of the break, counting from 0. */
  index: number;
  card: Address;
  /** The transaction that sent the card; undefined when it was found at the wallet without a transfer on record. */
  deliveryTx?: string;
  /** The pack the card came out of. */
  pack?: LedgerPack;
}

export type BreakCards = { number: number; break: BreakAccount } & (
  | { kind: "cards"; cards: MyCard[] }
  | { kind: "unavailable"; why: "missing" | "unreachable" | "invalid"; message: string }
  /** The ledger does not agree with the chain or the draw: not used. */
  | { kind: "wrong"; problems: string[] }
);

export interface MyCards {
  /** Newest break first. */
  breaks: BreakCards[];
  /** How many drawn breaks with a spot of this wallet were left out (older than the newest `CARD_BREAKS`). */
  more: number;
}

/**
 * The drawn breaks the wallet has a spot in (a paid spot that was not refunded, or a free spot it won), newest first, without
 * repeats. Only a drawn break can have a ledger.
 */
export function cardBreaks(mine: Mine): { number: number; break: BreakAccount }[] {
  const seen = new Map<number, BreakAccount>();
  for (const s of mine.spots) if (!s.refunded && s.break.status === "Drawn") seen.set(s.breakNumber, s.break);
  for (const w of mine.freeWins) if (w.break.status === "Drawn") seen.set(w.breakNumber, w.break);
  return [...seen].sort(([a], [b]) => b - a).map(([number, b]) => ({ number, break: b }));
}

/** This wallet's spots in a checked ledger, with their cards. */
export function cardsOf(ledger: Ledger, owner: Address): MyCard[] {
  const packs = new Map(ledger.packs.map((p) => [p.card, p]));
  return ledger.spots
    .filter((s) => s.wallet === owner)
    .map((s) => {
      const pack = packs.get(s.card);
      return { kind: s.kind, index: s.index, card: s.card, ...(s.deliveryTx !== undefined ? { deliveryTx: s.deliveryTx } : {}), ...(pack ? { pack } : {}) };
    });
}

/** What a ledger's state means for this wallet. */
export function breakCards(at: { number: number; break: BreakAccount }, state: LedgerState, owner: Address): BreakCards {
  switch (state.kind) {
    case "checked":
      return { ...at, kind: "cards", cards: cardsOf(state.ledger, owner) };
    case "wrong":
      return { ...at, kind: "wrong", problems: state.problems };
    case "unavailable":
      return { ...at, kind: "unavailable", why: state.why, message: state.message };
    case "not-drawn":
      // The break was read again for its spots and is somehow no longer drawn: there is nothing to show yet.
      return { ...at, kind: "unavailable", why: "unreachable", message: "the break is not drawn on chain" };
  }
}

export interface MyCardsOptions {
  rpcUrl: string;
  breaksProgram: Address;
  baseUrl: string;
  owner: Address;
  mine: Mine;
  fetch?: typeof fetch;
  /**
   * Checked ledgers already read, by break number and pool hash: a checked ledger never changes, so reading the page again does
   * not fetch it again. Only checked ones are kept.
   */
  cache?: Map<string, Ledger>;
}

/** The wallet's cards in the newest drawn breaks it has a spot in. Never throws: what goes wrong is said per break. */
export async function loadMyCards(opts: MyCardsOptions): Promise<MyCards> {
  const all = cardBreaks(opts.mine);
  const net = { ...(opts.fetch ? { fetch: opts.fetch } : {}) };
  const breaks = await Promise.all(
    all.slice(0, CARD_BREAKS).map(async (at): Promise<BreakCards> => {
      const key = `${at.number}:${toHex(at.break.poolHash)}`;
      const hit = opts.cache?.get(key);
      if (hit) return { ...at, kind: "cards", cards: cardsOf(hit, opts.owner) };
      try {
        // The ledger is checked against every paid spot's owner, not only this wallet's: the break is read with all its spots.
        const loaded = await loadBreak({ rpcUrl: opts.rpcUrl, breaksProgram: opts.breaksProgram, number: at.number, ...net });
        const state = await loadLedger({ rpcUrl: opts.rpcUrl, breaksProgram: opts.breaksProgram, baseUrl: opts.baseUrl, loaded, ...net });
        if (state.kind === "checked") opts.cache?.set(key, state.ledger);
        return breakCards({ number: at.number, break: loaded.break }, state, opts.owner);
      } catch (err) {
        return { ...at, kind: "unavailable", why: "unreachable", message: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
  return { breaks, more: Math.max(0, all.length - CARD_BREAKS) };
}
