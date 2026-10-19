"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { type HistoryOptions, loadTreasuryHistory } from "../../lib/chain/treasury-history";
import { SETUP, TREASURY_SETUP } from "../../lib/site";
import { HistoryCard, type HistoryState } from "./history-view";

/** Reads the treasury's history, a page at a time; the page puts a new one in place (a new `key`) to read it again from the top. */
export function TreasuryHistory() {
  const [view, setView] = useState<HistoryState>({ state: "loading" });
  const busy = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const options = (): HistoryOptions | undefined =>
    TREASURY_SETUP.kind === "on"
      ? { rpcUrl: TREASURY_SETUP.config.rpcUrl, treasuryProgram: TREASURY_SETUP.config.treasuryProgram, ...(SETUP.kind === "on" ? { breaksProgram: SETUP.config.breaksProgram } : {}) }
      : undefined;

  const first = useCallback(async () => {
    const opts = options();
    if (!opts || busy.current) return;
    busy.current = true;
    setView({ state: "loading" });
    try {
      const page = await loadTreasuryHistory(opts);
      if (alive.current) setView({ state: "loaded", pages: [page] });
    } catch (err) {
      if (alive.current) setView({ state: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    void first();
  }, [first]);

  const older = async () => {
    const opts = options();
    if (!opts || busy.current || view.state !== "loaded") return;
    const cursor = view.pages[view.pages.length - 1]?.cursor;
    if (!cursor) return;
    busy.current = true;
    const pages = view.pages;
    setView({ state: "loaded", pages, more: "loading" });
    try {
      const page = await loadTreasuryHistory(opts, cursor);
      if (alive.current) setView({ state: "loaded", pages: [...pages, page] });
    } catch (err) {
      if (alive.current) setView({ state: "loaded", pages, more: { error: err instanceof Error ? err.message : String(err) } });
    } finally {
      busy.current = false;
    }
  };

  return <HistoryCard view={view} showOlder={() => void older()} retry={() => void first()} />;
}
