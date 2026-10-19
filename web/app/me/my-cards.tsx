"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Address } from "../../lib/chain/address";
import type { Mine } from "../../lib/chain/mine";
import { toHex } from "../../lib/draw/bytes";
import type { Ledger } from "../../lib/ledger";
import { type MyCards as Cards, cardBreaks, loadMyCards } from "../../lib/my-cards";
import { PUBLISHED_SETUP, SETUP } from "../../lib/site";
import { MyCardsView } from "./cards-view";

/** Checked ledgers, for the rest of the visit: a checked ledger never changes, so re-reads and other wallets do not fetch it again. */
const LEDGERS = new Map<string, Ledger>();

/**
 * The connected wallet's cards, from the ledgers of the drawn breaks it has spots in. Reads again only when that set of breaks
 * changes (or on "Read the ledgers again"), never shows another wallet's cards, and keeps the ledgers it has checked.
 */
export function MyCards({ owner, mine }: { owner: Address; mine: Mine }) {
  const [view, setView] = useState<{ owner: Address; cards: Cards } | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const latestMine = useRef(mine);
  latestMine.current = mine;
  const newest = useRef(0);
  const key = [owner, ...cardBreaks(mine).map((b) => `${b.number}:${b.break.status}:${toHex(b.break.poolHash)}`)].join("|");

  useEffect(() => {
    if (PUBLISHED_SETUP.kind !== "on" || SETUP.kind !== "on") return;
    const mineRead = ++newest.current;
    void loadMyCards({ ...SETUP.config, baseUrl: PUBLISHED_SETUP.config.baseUrl, owner, mine: latestMine.current, cache: LEDGERS }).then(
      (cards) => mineRead === newest.current && setView({ owner, cards }),
    );
  }, [key, owner, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  if (PUBLISHED_SETUP.kind !== "on") {
    return (
      <section className="card">
        <h2>Your cards</h2>
        {PUBLISHED_SETUP.kind === "off" ? (
          <p>This site is not set up to read the published lists, so your cards cannot be shown here.</p>
        ) : (
          <p className="problem" role="alert">The site's setting for the published lists is wrong: {PUBLISHED_SETUP.problem}</p>
        )}
      </section>
    );
  }
  // Another wallet's cards are never shown, even for a moment.
  const state = view && view.owner === owner ? { kind: "loaded" as const, cards: view.cards } : { kind: "loading" as const };
  return <MyCardsView state={state} host={new URL(PUBLISHED_SETUP.config.baseUrl).host} onRetry={retry} />;
}
