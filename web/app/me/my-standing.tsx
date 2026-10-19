"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Address } from "../../lib/chain/address";
import type { BreakRow } from "../../lib/chain/list";
import { PUBLISHED_SETUP } from "../../lib/site";
import { type BreakStanding, lastMinimum, loadStandings, standingsKey } from "../../lib/standing";
import type { EligibilityRecord } from "../../lib/twab/record";
import { StandingsView } from "./standing-view";

type State = { state: "loading" } | { state: "loaded"; owner: Address; standings: BreakStanding[] };

/**
 * The records that passed every check, for the rest of the visit, keyed by everything the break commits: a checked record does
 * not change, so Refresh, another wallet and the re-reads after a refund do not fetch it again.
 */
const RECORDS = new Map<string, EligibilityRecord>();

/**
 * Where the wallet stands on the free-spot lists of the breaks My spots has just read. Reads the published records again only
 * when something that decides it changes (another wallet, a break's stage, list or winners), and keeps the records it has
 * checked (`RECORDS`), so the re-reads of the spots cost nothing here. Tells `onMinimum` what the newest checked list asked for.
 */
export function MyStanding({ owner, rows, onMinimum }: { owner: Address; rows: readonly BreakRow[]; onMinimum?: (m: { number: number; minTwab: bigint }) => void }) {
  const [view, setView] = useState<State>({ state: "loading" });
  const latestRows = useRef(rows);
  latestRows.current = rows;
  const latestOnMinimum = useRef(onMinimum);
  latestOnMinimum.current = onMinimum;
  const newest = useRef(0);
  const [attempt, setAttempt] = useState(0);
  const key = standingsKey(owner, rows);

  useEffect(() => {
    if (PUBLISHED_SETUP.kind !== "on") return;
    const mine = ++newest.current;
    void loadStandings({ baseUrl: PUBLISHED_SETUP.config.baseUrl, owner, rows: latestRows.current, cache: RECORDS }).then((standings) => {
      if (mine !== newest.current) return;
      setView({ state: "loaded", owner, standings });
      // The last list's minimum, for the card about the wallet's tokens. When no record could be read this time, the one known
      // from before stays: a minimum belongs to a list, not to a wallet.
      const m = lastMinimum(standings);
      if (m) latestOnMinimum.current?.(m);
    });
  }, [key, owner, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  if (PUBLISHED_SETUP.kind === "off") {
    return (
      <section className="card">
        <h2>On the free-spot lists</h2>
        <p>This site is not set up to read the published lists, so where this wallet stands on them cannot be shown here.</p>
      </section>
    );
  }
  if (PUBLISHED_SETUP.kind === "problem") {
    return (
      <section className="card">
        <h2>On the free-spot lists</h2>
        <p className="problem" role="alert">The site's setting for the published lists is wrong: {PUBLISHED_SETUP.problem}</p>
      </section>
    );
  }
  // A wallet that has just been switched to must not be shown the last one's standings, even for a moment.
  if (view.state === "loading" || view.owner !== owner) {
    return (
      <section className="card">
        <h2>On the free-spot lists</h2>
        <p>Reading the published lists…</p>
      </section>
    );
  }
  return <StandingsView standings={view.standings} host={new URL(PUBLISHED_SETUP.config.baseUrl).host} onRetry={retry} />;
}
