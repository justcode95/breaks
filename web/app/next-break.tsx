"use client";

import { useEffect, useState } from "react";
import { type Treasury, loadTreasury } from "../lib/chain/treasury";
import { BREAK_SHAPE, TREASURY_SETUP } from "../lib/site";
import { ReserveCard } from "./reserve-card";

type State = { state: "loading" } | { state: "error"; message: string } | { state: "loaded"; treasury: Treasury };

/** The reserve bar on the home page. Nothing unless the site is told both where the treasury is and what the next break is like. */
export function NextBreak() {
  const [view, setView] = useState<State>({ state: "loading" });
  const ready = TREASURY_SETUP.kind === "on" && BREAK_SHAPE.kind === "on";

  useEffect(() => {
    if (TREASURY_SETUP.kind !== "on" || BREAK_SHAPE.kind !== "on") return;
    let gone = false;
    loadTreasury({ rpcUrl: TREASURY_SETUP.config.rpcUrl, treasuryProgram: TREASURY_SETUP.config.treasuryProgram }).then(
      (treasury) => !gone && setView({ state: "loaded", treasury }),
      (err: unknown) => !gone && setView({ state: "error", message: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      gone = true;
    };
  }, []);

  if (BREAK_SHAPE.kind === "problem") return <p className="problem" role="alert">The site's settings for the next break are wrong: {BREAK_SHAPE.problem}</p>;
  if (!ready || BREAK_SHAPE.kind !== "on") return null;
  return (
    <div aria-live="polite">
      {view.state === "loading" && <p>Reading the treasury…</p>}
      {view.state === "error" && <p className="problem">{view.message}</p>}
      {view.state === "loaded" && <ReserveCard shape={BREAK_SHAPE.config} treasury={view.treasury} />}
    </div>
  );
}
