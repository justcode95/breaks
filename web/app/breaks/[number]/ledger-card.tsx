"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChainConfig } from "../../../lib/config";
import { toHex } from "../../../lib/draw/bytes";
import { loadLedger } from "../../../lib/ledger";
import { publishedFileUrl } from "../../../lib/published";
import type { Loaded } from "./details";
import { LedgerSection, type LedgerViewState } from "./ledger-view";

/**
 * Reads a drawn break's ledger from the published files and checks it against the chain. It reads again only when the break's
 * stage or pool changes (a refresh of the page that finds the same break reads nothing), or when asked to.
 */
export function LedgerCard({ loaded, config, publishedUrl }: { loaded: Loaded; config: ChainConfig; publishedUrl: string | undefined }) {
  const b = loaded.break;
  const poolHash = toHex(b.poolHash);
  const [state, setState] = useState<LedgerViewState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const latest = useRef(loaded);
  latest.current = loaded;
  const newest = useRef(0);
  const drawn = b.status === "Drawn";

  useEffect(() => {
    if (!drawn || !publishedUrl) return;
    const mine = ++newest.current;
    // A ledger already on show stays while it is read again.
    setState((s) => (s.kind === "checked" ? s : { kind: "loading" }));
    void loadLedger({ ...config, baseUrl: publishedUrl, loaded: latest.current }).then((r) => mine === newest.current && setState(r));
  }, [drawn, poolHash, publishedUrl, config, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  if (!drawn) return null;
  if (!publishedUrl) return <LedgerSection state={{ kind: "off" }} host="" budget={b.packBudget} />;
  return (
    <LedgerSection
      state={state}
      host={new URL(publishedUrl).host}
      {...(publishedFileUrl(publishedUrl, "ledger", poolHash) ? { fileUrl: publishedFileUrl(publishedUrl, "ledger", poolHash) as string } : {})}
      budget={b.packBudget}
      onRetry={retry}
    />
  );
}
