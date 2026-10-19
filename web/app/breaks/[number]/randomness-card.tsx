"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BreakAccount } from "../../../lib/chain/accounts";
import { loadRandomness } from "../../../lib/chain/randomness";
import type { ChainConfig } from "../../../lib/config";
import { toHex } from "../../../lib/draw/bytes";
import { RandomnessSection, type RandomnessViewState } from "./randomness-view";

const STAGES = new Set(["RandomnessRequested", "Settled", "Drawn"]);

/**
 * Reads a break's randomness request and checks it. It reads again only when the break's stage, attempt or seed changes, so a
 * refresh of the page that finds the same break asks the node for nothing more.
 */
export function RandomnessCard({ b, config }: { b: BreakAccount; config: ChainConfig }) {
  const [view, setView] = useState<RandomnessViewState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const latest = useRef(b);
  latest.current = b;
  const newest = useRef(0);
  const asked = STAGES.has(b.status);
  const key = `${b.id}:${b.status}:${b.randomnessAttempt}:${toHex(b.randomnessRequestId)}:${toHex(b.seed)}`;

  useEffect(() => {
    if (!asked) return;
    const mine = ++newest.current;
    // What is on show stays while it is read again.
    setView((v) => (v.kind === "checked" ? v : { kind: "loading" }));
    void loadRandomness({ ...config, break: latest.current }).then((r) => mine === newest.current && setView(r));
  }, [asked, key, config, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  if (!asked) return null;
  return <RandomnessSection view={view} b={b} onRetry={retry} />;
}
