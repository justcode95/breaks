"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Address } from "../../lib/chain/address";
import { loadHolding } from "../../lib/chain/holding";
import type { BreakRow } from "../../lib/chain/list";
import { SETUP, TOKEN_SETUP } from "../../lib/site";
import { type HoldingState, HoldingView } from "./holding-view";

type State = HoldingState & { owner?: Address };

/**
 * The connected wallet's coin, read at `finalized` when the wallet changes and on "Read the balance again". What it gives over
 * the sale that is on is worked out from `rows` (the newest breaks My spots has read) and the time of the balances, so a newer
 * list of breaks needs no new read.
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
  return <HoldingView view={shown} rows={rows} minimum={minimum} onRetry={retry} />;
}
