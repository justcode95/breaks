"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { loadUsdcBalance } from "../lib/chain/balance";
import { SETUP } from "../lib/site";
import { useWallet } from "../lib/wallet/provider";
import { type BalanceView, WalletMenu } from "./wallet-menu";

/** The header's wallet button: connect, see the address and the USDC balance, disconnect. Nothing here sends anything. */
export function WalletButton() {
  const { state, connect, disconnect } = useWallet();
  const [open, setOpen] = useState(false);
  const [balance, setBalance] = useState<BalanceView>({ kind: "off" });
  const box = useRef<HTMLDivElement>(null);
  const address = state.connected?.account.address;

  // Only the newest read may set the balance: a slow reply for the account the wallet had before must not land on the new one.
  const newest = useRef(0);
  const refresh = useCallback(() => {
    const mine = ++newest.current;
    if (!address || SETUP.kind !== "on") {
      setBalance({ kind: "off" });
      return;
    }
    setBalance({ kind: "loading" });
    loadUsdcBalance({ rpcUrl: SETUP.config.rpcUrl, program: SETUP.config.breaksProgram, owner: address }).then(
      (b) => mine === newest.current && setBalance({ kind: "loaded", balance: b.balance }),
      (err: unknown) => mine === newest.current && setBalance({ kind: "error", message: err instanceof Error ? err.message : String(err) }),
    );
  }, [address]);

  // Read the balance when a wallet connects or its account changes.
  useEffect(() => refresh(), [refresh]);

  // The panel opens on a click and closes on Escape, on a click elsewhere, and when a wallet has just connected.
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const away = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("keydown", key);
    document.addEventListener("mousedown", away);
    return () => {
      document.removeEventListener("keydown", key);
      document.removeEventListener("mousedown", away);
    };
  }, [open]);
  useEffect(() => {
    if (state.status === "connected") setOpen(false);
  }, [state.status]);

  return (
    <div ref={box} className="wallet-box">
      <WalletMenu
        state={state}
        balance={balance}
        open={open}
        onToggle={() => setOpen((o) => !o)}
        onConnect={(w) => void connect(w)}
        onDisconnect={() => {
          setOpen(false);
          void disconnect();
        }}
        onRefresh={refresh}
      />
    </div>
  );
}
