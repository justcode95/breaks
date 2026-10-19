"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Address } from "../../lib/chain/address";
import { loadSaleHistory } from "../../lib/chain/history";
import { loadHolding, saleFloor } from "../../lib/chain/holding";
import type { BreakRow } from "../../lib/chain/list";
import { SETUP, TOKEN_SETUP } from "../../lib/site";
import { type HistoryState, type HoldingState, HoldingView } from "./holding-view";

type State = HoldingState & { owner?: Address };

/**
 * The connected wallet's coin, read at `finalized` when the wallet changes and on "Read the balance again". What it gives over
 * the sale that is on is worked out from `rows` (the newest breaks My spots has read) and the time of the balances, so a newer
 * list of breaks needs no new read. While a sale is on, the wallet's transactions of the coin since the opening are read after
 * the balances, for its average so far; each new read of the balances reads them again.
 */
export function MyHolding({ owner, rows, minimum }: { owner: Address; rows: readonly BreakRow[]; minimum?: { number: number; minTwab: bigint } | undefined }) {
  const [view, setView] = useState<State>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  // Only the newest read may set the card: a slow answer for the wallet before must not land on this one.
  const newest = useRef(0);

  useEffect(() => {
    if (TOKEN_SETUP.kind !== "on" || SETUP.kind !== "on") return;
    const mine = ++newest.current;
    setView({ state: "loading" });
    loadHolding({ rpcUrl: SETUP.config.rpcUrl, mint: TOKEN_SETUP.config.mint, owner }).then(
      (holding) => mine === newest.current && setView({ state: "loaded", holding, owner }),
      (err: unknown) => mine === newest.current && setView({ state: "error", message: err instanceof Error ? err.message : String(err), owner }),
    );
  }, [owner, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  // The sale that is on, for these balances: its history is read once per wallet, read of the balances and sale.
  const holding = view.state === "loaded" && view.owner === owner ? view.holding : undefined;
  const sale = holding ? saleFloor(rows, holding.total, holding.time) : undefined;
  const key = holding && sale?.kind === "on" ? `${owner}|${holding.slot}|${sale.number}|${sale.opensAt}|${sale.closesAt}` : undefined;
  const [history, setHistory] = useState<{ key: string; state: HistoryState } | undefined>(undefined);
  const newestHistory = useRef(0);
  useEffect(() => {
    if (!key || !holding || sale?.kind !== "on" || holding.time === null || TOKEN_SETUP.kind !== "on" || SETUP.kind !== "on") return;
    const mine = ++newestHistory.current;
    void loadSaleHistory({
      rpcUrl: SETUP.config.rpcUrl,
      owner,
      mint: TOKEN_SETUP.config.mint,
      sale: { opensAt: Number(sale.opensAt), closesAt: Number(sale.closesAt) },
      held: holding.held,
      slot: holding.slot,
      time: holding.time,
    }).then((h) => mine === newestHistory.current && setHistory({ key, state: { state: "done", history: h } }));
    // `key` names everything the read depends on.
  }, [key]);
  // A history read for other balances, another wallet or another sale is never shown.
  const shownHistory: HistoryState | undefined = key ? (history?.key === key ? history.state : { state: "reading" }) : undefined;

  if (TOKEN_SETUP.kind === "off") {
    return (
      <section className="card">
        <h2>This wallet's tokens</h2>
        <p>This site is not told which token is the coin, so this wallet's balance of it cannot be shown here.</p>
      </section>
    );
  }
  if (TOKEN_SETUP.kind === "problem") {
    return (
      <section className="card">
        <h2>This wallet's tokens</h2>
        <p className="problem" role="alert">The site's setting for the token is wrong: {TOKEN_SETUP.problem}</p>
      </section>
    );
  }
  // A wallet that has just been switched to must not be shown the last one's balance, even for a moment.
  const shown: HoldingState = view.state !== "loading" && view.owner !== owner ? { state: "loading" } : view;
  return <HoldingView view={shown} rows={rows} minimum={minimum} history={shownHistory} onRetry={retry} />;
}
