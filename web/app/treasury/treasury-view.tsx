"use client";

import { useCallback, useEffect, useState } from "react";
import { type Treasury, loadTreasury } from "../../lib/chain/treasury";
import { BREAK_SHAPE, TREASURY_SETUP } from "../../lib/site";
import { TreasuryDetails } from "./details";

type State = { state: "loading" } | { state: "error"; message: string } | { state: "loaded"; treasury: Treasury; readAt: number };

const nowSecs = () => Math.floor(Date.now() / 1000);

export function TreasuryView() {
  const [view, setView] = useState<State>({ state: "loading" });
  const [now, setNow] = useState(nowSecs);

  const load = useCallback(async () => {
    if (TREASURY_SETUP.kind !== "on") return;
    setView({ state: "loading" });
    try {
      setView({ state: "loaded", treasury: await loadTreasury(TREASURY_SETUP.config), readAt: nowSecs() });
    } catch (err) {
      setView({ state: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The "read N ago" line would stop being true if it never moved.
  useEffect(() => {
    const timer = setInterval(() => setNow(nowSecs()), 30_000);
    return () => clearInterval(timer);
  }, []);

  if (TREASURY_SETUP.kind === "off") return <p>This site is not set up to read the chain yet, so there is nothing to show.</p>;
  if (TREASURY_SETUP.kind === "problem") return <p className="problem" role="alert">The site's chain settings are wrong: {TREASURY_SETUP.problem}</p>;
  return (
    <div aria-live="polite">
      {view.state === "loading" && <p>Reading the treasury from the chain…</p>}
      {view.state === "error" && (
        <>
          <p className="problem">{view.message}</p>
          <div className="actions">
            <button type="button" onClick={() => void load()}>Try again</button>
          </div>
        </>
      )}
      {BREAK_SHAPE.kind === "problem" && <p className="problem" role="alert">The site's settings for the next break are wrong: {BREAK_SHAPE.problem}</p>}
      {view.state === "loaded" && (
        <TreasuryDetails
          treasury={view.treasury}
          program={TREASURY_SETUP.config.treasuryProgram}
          now={now}
          readAt={view.readAt}
          refresh={() => void load()}
          {...(BREAK_SHAPE.kind === "on" ? { shape: BREAK_SHAPE.config } : {})}
        />
      )}
    </div>
  );
}
