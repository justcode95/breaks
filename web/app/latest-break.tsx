"use client";

import { useEffect, useState } from "react";
import { loadBreakList } from "../lib/chain/list";
import { SETUP } from "../lib/site";
import { LatestSummary } from "./breaks/rows";

type State = { state: "loading" } | { state: "error"; message: string } | { state: "loaded"; latest: Parameters<typeof LatestSummary>[0]["latest"]; total: number };

/** The newest break in a line, under the intro. Shows nothing when the site is not set up to read the chain. */
export function LatestBreak() {
  const [view, setView] = useState<State>({ state: "loading" });

  useEffect(() => {
    if (SETUP.kind !== "on") return;
    let gone = false;
    loadBreakList({ ...SETUP.config, count: 1 }).then(
      (list) => !gone && setView({ state: "loaded", latest: list.rows[0], total: list.total }),
      (err: unknown) => !gone && setView({ state: "error", message: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      gone = true;
    };
  }, []);

  if (SETUP.kind !== "on") return null;
  return (
    <section aria-labelledby="latest-title" aria-live="polite">
      <h2 id="latest-title">Latest break</h2>
      {view.state === "loading" && <p>Reading the chain…</p>}
      {view.state === "error" && <p className="problem">{view.message}</p>}
      {view.state === "loaded" && <LatestSummary latest={view.latest} total={view.total} now={Math.floor(Date.now() / 1000)} />}
    </section>
  );
}
