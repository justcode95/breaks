"use client";

import { useCallback, useEffect, useState } from "react";
import { loadBreak } from "../../../lib/chain/load";
import { PUBLISHED_SETUP, SETUP } from "../../../lib/site";
import { BuyPanel } from "./buy-panel";
import { BreakDetails, type Loaded } from "./details";
import { LedgerCard } from "./ledger-card";
import { RandomnessCard } from "./randomness-card";

/** `refreshError` is why the last read failed, while the break read before is still on show. */
type State = { state: "loading" } | { state: "error"; message: string } | { state: "loaded"; loaded: Loaded; readAt: number; refreshError?: string };

const nowSecs = () => Math.floor(Date.now() / 1000);

export function BreakView({ number }: { number: number }) {
  const [view, setView] = useState<State>({ state: "loading" });
  const [now, setNow] = useState(nowSecs);

  // Reads the break and shows it, without taking the page away: a purchase in progress lives on this page and must not be lost
  // to a refresh. Throws when the read fails, for whoever is following a purchase.
  const reload = useCallback(async (): Promise<Loaded> => {
    if (SETUP.kind !== "on") throw new Error("This site is not set up to read the chain.");
    const loaded = await loadBreak({ ...SETUP.config, number });
    setView({ state: "loaded", loaded, readAt: nowSecs() });
    return loaded;
  }, [number]);

  const load = useCallback(async () => {
    if (SETUP.kind !== "on") return;
    // Only a page that has nothing to show yet is replaced by "Reading…"; a break already on show stays while it is read again.
    setView((v) => (v.state === "loaded" ? v : { state: "loading" }));
    try {
      await reload();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setView((v) => (v.state === "loaded" ? { ...v, refreshError: message } : { state: "error", message }));
    }
  }, [reload]);

  useEffect(() => {
    // Loading starts the moment the page opens; a reply for a page that is already gone is thrown away by React.
    void load();
  }, [load]);

  // A countdown that stops moving would be a wrong answer after a while.
  useEffect(() => {
    const timer = setInterval(() => setNow(nowSecs()), 30_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <>
      <h1>Break #{number}</h1>
      {SETUP.kind === "off" && <p>This site is not set up to read the chain yet, so there is nothing to show.</p>}
      {SETUP.kind === "problem" && <p className="problem" role="alert">The site's chain settings are wrong: {SETUP.problem}</p>}
      {SETUP.kind === "on" && (
        <div aria-live="polite">
          {view.state === "loading" && <p>Reading break #{number} from the chain…</p>}
          {view.state === "error" && (
            <>
              <p className="problem">{view.message}</p>
              <div className="actions">
                <button type="button" onClick={() => void load()}>Try again</button>
              </div>
            </>
          )}
          {view.state === "loaded" && (
            <>
              <BreakDetails
                loaded={view.loaded}
                now={now}
                readAt={view.readAt}
                program={SETUP.config.breaksProgram}
                refresh={() => void load()}
                publishedUrl={PUBLISHED_SETUP.kind === "on" ? PUBLISHED_SETUP.config.baseUrl : undefined}
                buy={<BuyPanel b={view.loaded.break} number={number} now={now} config={SETUP.config} reload={reload} />}
                randomness={<RandomnessCard b={view.loaded.break} config={SETUP.config} />}
                ledger={<LedgerCard loaded={view.loaded} config={SETUP.config} publishedUrl={PUBLISHED_SETUP.kind === "on" ? PUBLISHED_SETUP.config.baseUrl : undefined} />}
              />
              {view.refreshError && <p className="problem">Could not read the break again: {view.refreshError}</p>}
            </>
          )}
        </div>
      )}
    </>
  );
}
