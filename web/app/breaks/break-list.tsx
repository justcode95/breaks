"use client";

import { useCallback, useEffect, useState } from "react";
import { type BreakRow, loadBreakList } from "../../lib/chain/list";
import { SETUP } from "../../lib/site";
import { BreakRows } from "./rows";

const PAGE = 20;

type State =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "loaded"; total: number; rows: BreakRow[]; older: number | undefined; more: "idle" | "loading" | { error: string }; readAt: number };

const nowSecs = () => Math.floor(Date.now() / 1000);

export function BreakList() {
  const [view, setView] = useState<State>({ state: "loading" });

  const load = useCallback(async () => {
    if (SETUP.kind !== "on") return;
    setView({ state: "loading" });
    try {
      const list = await loadBreakList({ ...SETUP.config, count: PAGE });
      setView({ state: "loaded", total: list.total, rows: list.rows, older: list.older, more: "idle", readAt: nowSecs() });
    } catch (err) {
      setView({ state: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const showOlder = async () => {
    if (SETUP.kind !== "on" || view.state !== "loaded" || view.older === undefined) return;
    const { rows, older } = view;
    setView({ ...view, more: "loading" });
    try {
      const list = await loadBreakList({ ...SETUP.config, count: PAGE, before: older });
      // The total can have grown since the first read; the older breaks do not change, so they just continue the list.
      setView((v) => (v.state === "loaded" ? { ...v, rows: [...rows, ...list.rows], older: list.older, more: "idle" } : v));
    } catch (err) {
      setView((v) => (v.state === "loaded" ? { ...v, more: { error: err instanceof Error ? err.message : String(err) } } : v));
    }
  };

  if (SETUP.kind === "off") return <p>This site is not set up to read the chain yet, so there is nothing to show.</p>;
  if (SETUP.kind === "problem") return <p className="problem" role="alert">The site's chain settings are wrong: {SETUP.problem}</p>;
  return (
    <div aria-live="polite">
      {view.state === "loading" && <p>Reading the breaks from the chain…</p>}
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
          {view.rows.length === 0 ? (
            <p>No break has been made yet. The first one opens by itself when the reserve can pay for it.</p>
          ) : (
            <>
              <p>
                {view.total} {view.total === 1 ? "break has" : "breaks have"} been made. Select one to see where it stands and to check its draw.
              </p>
              <BreakRows rows={view.rows} now={nowSecs()} />
            </>
          )}
          {typeof view.more === "object" && <p className="problem">{view.more.error}</p>}
          <div className="actions">
            {view.older !== undefined && (
              <button type="button" onClick={() => void showOlder()} disabled={view.more === "loading"}>
                {view.more === "loading" ? "Loading…" : "Show older breaks"}
              </button>
            )}
            <button type="button" className="secondary" onClick={() => void load()}>Refresh</button>
          </div>
          <p className="hint">Read from the chain (finalized). Nothing here comes from a server of ours.</p>
        </>
      )}
    </div>
  );
}
