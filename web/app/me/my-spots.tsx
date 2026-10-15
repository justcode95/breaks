"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { type Mine, loadMine } from "../../lib/chain/mine";
import { SETUP } from "../../lib/site";
import { useWallet } from "../../lib/wallet/provider";
import { shortAddress } from "../../lib/wallet/wallets";
import { MySpotsView } from "./rows";

type State = { state: "loading" } | { state: "error"; message: string } | { state: "loaded"; mine: Mine; readAt: number };

const nowSecs = () => Math.floor(Date.now() / 1000);

/** The connected wallet's paid spots and free wins, read from the chain. Nothing is sent. */
export function MySpots() {
  const { state } = useWallet();
  const address = state.connected?.account.address;
  const [view, setView] = useState<State>({ state: "loading" });

  // Only the newest read may set the page: a slow reply for the account the wallet had before must not land on the new one.
  const newest = useRef(0);
  const load = useCallback(() => {
    const mine = ++newest.current;
    if (!address || SETUP.kind !== "on") return;
    setView({ state: "loading" });
    loadMine({ ...SETUP.config, owner: address }).then(
      (m) => mine === newest.current && setView({ state: "loaded", mine: m, readAt: nowSecs() }),
      (err: unknown) => mine === newest.current && setView({ state: "error", message: err instanceof Error ? err.message : String(err) }),
    );
  }, [address]);
  useEffect(() => load(), [load]);

  if (SETUP.kind === "off") return <p>This site is not set up to read the chain yet, so there is nothing to show.</p>;
  if (SETUP.kind === "problem") return <p className="problem" role="alert">The site's chain settings are wrong: {SETUP.problem}</p>;
  if (!address) {
    return <p>{state.status === "connecting" ? "Waiting for the wallet to connect…" : "Connect a wallet with the button at the top of the page to see its spots."}</p>;
  }
  return (
    <div aria-live="polite">
      <p className="hint">
        Wallet <code className="mono">{shortAddress(address)}</code>
      </p>
      {view.state === "loading" && <p>Reading this wallet's spots from the chain…</p>}
      {view.state === "error" && (
        <>
          <p className="problem">{view.message}</p>
          <div className="actions">
            <button type="button" onClick={load}>Try again</button>
          </div>
        </>
      )}
      {view.state === "loaded" && (
        <>
          <MySpotsView mine={view.mine} now={nowSecs()} />
          <div className="actions">
            <button type="button" className="secondary" onClick={load}>Refresh</button>
          </div>
          <p className="hint">Read from the chain (finalized). Nothing here comes from a server of ours.</p>
        </>
      )}
    </div>
  );
}
