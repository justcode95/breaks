"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { BreakAccount } from "../../../lib/chain/accounts";
import { loadUsdcBalance } from "../../../lib/chain/balance";
import { buyReducer, idleBuy } from "../../../lib/chain/buy-state";
import { waitForSpot } from "../../../lib/chain/follow";
import type { Loaded } from "../../../lib/chain/load";
import { buySpot, loadSaleTerms } from "../../../lib/chain/purchase";
import { runPurchase } from "../../../lib/chain/run-purchase";
import { useWallet } from "../../../lib/wallet/provider";
import { BuyPanelView, type TermsView, type UsdcView, type WalletView } from "./buy-panel-view";

export interface BuyPanelProps {
  b: BreakAccount;
  /** The number people see: the on-chain id + 1. */
  number: number;
  now: number;
  config: { rpcUrl: string; breaksProgram: string };
  /** Reads the break again and shows it on the page; used to follow a purchase until the chain shows it. */
  reload: () => Promise<Loaded>;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Runs the purchase for `BuyPanelView`: reads the sale terms and the wallet's USDC, and buys when the visitor clicks. */
export function BuyPanel({ b, number, now, config, reload }: BuyPanelProps) {
  const { state } = useWallet();
  const [terms, setTerms] = useState<TermsView>({ kind: "loading" });
  const [usdc, setUsdc] = useState<UsdcView>({ kind: "loading" });
  const [buy, dispatch] = useReducer(buyReducer, idleBuy);
  const connected = state.connected;
  const address = connected?.account.address;

  // The panel can go away in the middle of a purchase (the visitor leaves the page): nothing should go on polling for it then.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    let current = true;
    loadSaleTerms({ rpcUrl: config.rpcUrl, program: config.breaksProgram }).then(
      (t) => current && setTerms({ kind: "loaded", terms: t }),
      (err: unknown) => current && setTerms({ kind: "error", message: message(err) }),
    );
    return () => {
      current = false;
    };
  }, [config.rpcUrl, config.breaksProgram]);

  // Only the newest read may set the balance: a slow reply for the account the wallet had before must not land on the new one.
  const newest = useRef(0);
  const readUsdc = useCallback(() => {
    const mine = ++newest.current;
    if (!address) return;
    setUsdc({ kind: "loading" });
    // `confirmed`, as the purchase itself reads it: a balance a few seconds old would show money that is already spent.
    loadUsdcBalance({ rpcUrl: config.rpcUrl, program: config.breaksProgram, owner: address, commitment: "confirmed" }).then(
      (v) => mine === newest.current && setUsdc({ kind: "loaded", balance: v.balance }),
      (err: unknown) => mine === newest.current && setUsdc({ kind: "error", message: message(err) }),
    );
  }, [address, config.rpcUrl, config.breaksProgram]);
  useEffect(() => readUsdc(), [readUsdc]);

  const guard = useRef(false);
  const onBuy = useCallback(() => {
    if (!connected) return;
    const { wallet, account } = connected;
    void runPurchase({
      address: account.address,
      guard,
      dispatch,
      buy: (onStep) => buySpot({ rpcUrl: config.rpcUrl, program: config.breaksProgram, breakNumber: number, wallet, account, onStep }),
      follow: (index) => waitForSpot({ load: reload, index, owner: account.address, stop: () => !alive.current }),
      afterBought: readUsdc,
    });
  }, [connected, config.rpcUrl, config.breaksProgram, number, reload, readUsdc]);

  const wallet: WalletView = address ? { kind: "connected", address } : state.status === "connecting" ? { kind: "connecting" } : { kind: "none" };
  return <BuyPanelView b={b} now={now} terms={terms} wallet={wallet} usdc={usdc} buy={buy} onBuy={onBuy} onRetry={readUsdc} onDismiss={() => dispatch({ type: "dismiss" })} />;
}
