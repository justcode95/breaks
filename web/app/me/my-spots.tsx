"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { waitForRefund } from "../../lib/chain/follow";
import { type Mine, type MySpot, loadMine } from "../../lib/chain/mine";
import { refundSpot } from "../../lib/chain/refund";
import { idleRefund, refundReducer } from "../../lib/chain/refund-state";
import { runRefund } from "../../lib/chain/run-refund";
import { SETUP } from "../../lib/site";
import { useWallet } from "../../lib/wallet/provider";
import { shortAddress } from "../../lib/wallet/wallets";
import { RefundStatusView } from "./refund-status";
import { MySpotsView } from "./rows";

type State = { state: "loading" } | { state: "error"; message: string } | { state: "loaded"; mine: Mine; readAt: number };

const nowSecs = () => Math.floor(Date.now() / 1000);

/** The connected wallet's paid spots and free wins, read from the chain, and the refund of a spot of a cancelled break. */
export function MySpots() {
  const { state } = useWallet();
  const connected = state.connected;
  const address = connected?.account.address;
  const [view, setView] = useState<State>({ state: "loading" });
  const [refund, dispatch] = useReducer(refundReducer, idleRefund);

  // The page can go away in the middle of a refund (the visitor leaves): nothing should go on polling for it then.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Only the newest read may set the page: a slow reply for the account the wallet had before must not land on the new one.
  const newest = useRef(0);
  // Reads the spots and shows them without taking the page away: a refund in progress must not be lost to a re-read.
  const reload = useCallback(async (): Promise<Mine> => {
    if (!address || SETUP.kind !== "on") throw new Error("There is no wallet or chain to read.");
    const mine = ++newest.current;
    const m = await loadMine({ ...SETUP.config, owner: address });
    if (mine === newest.current) setView({ state: "loaded", mine: m, readAt: nowSecs() });
    return m;
  }, [address]);

  // Reads the spots for a wallet that has just connected (or "Try again", "Refresh"): the page says it is reading meanwhile.
  const load = useCallback(() => {
    if (!address || SETUP.kind !== "on") return;
    setView({ state: "loading" });
    const mine = newest.current + 1;
    reload().catch((err: unknown) => mine === newest.current && setView({ state: "error", message: err instanceof Error ? err.message : String(err) }));
  }, [address, reload]);
  useEffect(() => load(), [load]);

  const guard = useRef(false);
  const onRefund = useCallback(
    (spot: MySpot) => {
      if (!connected || SETUP.kind !== "on") return;
      const { wallet, account } = connected;
      const config = SETUP.config;
      void runRefund({
        address: account.address,
        breakNumber: spot.breakNumber,
        index: spot.index,
        guard,
        dispatch,
        refund: (onStep) => refundSpot({ rpcUrl: config.rpcUrl, program: config.breaksProgram, breakNumber: spot.breakNumber, index: spot.index, wallet, account, onStep }),
        follow: () => waitForRefund({ load: reload, breakNumber: spot.breakNumber, index: spot.index, stop: () => !alive.current }),
      });
    },
    [connected, reload],
  );

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
      <RefundStatusView state={refund} onDismiss={() => dispatch({ type: "dismiss" })} />
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
          <MySpotsView mine={view.mine} now={nowSecs()} onRefund={onRefund} busy={refund.status === "running"} />
          <div className="actions">
            <button type="button" className="secondary" onClick={load}>Refresh</button>
          </div>
          <p className="hint">Read from the chain (finalized). Nothing here comes from a server of ours.</p>
        </>
      )}
    </div>
  );
}
