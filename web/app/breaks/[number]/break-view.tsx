"use client";

import { useCallback, useEffect, useState } from "react";
import { loadBreak } from "../../../lib/chain/load";
import { PUBLISHED_SETUP, SETUP } from "../../../lib/site";
import { BreakDetails, type Loaded } from "./details";

type State = { state: "loading" } | { state: "error"; message: string } | { state: "loaded"; loaded: Loaded; readAt: number };

const nowSecs = () => Math.floor(Date.now() / 1000);

export function BreakView({ number }: { number: number }) {
  const [view, setView] = useState<State>({ state: "loading" });
  const [now, setNow] = useState(nowSecs);

  const load = useCallback(async () => {
    if (SETUP.kind !== "on") return;
    setView({ state: "loading" });
    try {
      const loaded = await loadBreak({ ...SETUP.config, number });
      setView({ state: "loaded", loaded, readAt: nowSecs() });
    } catch (err) {
      setView({ state: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }, [number]);

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
          {view.state === "loaded" && <BreakDetails loaded={view.loaded} now={now} readAt={view.readAt} program={SETUP.config.breaksProgram} refresh={() => void load()} publishedUrl={PUBLISHED_SETUP.kind === "on" ? PUBLISHED_SETUP.config.baseUrl : undefined} />}
        </div>
      )}
    </>
  );
}
