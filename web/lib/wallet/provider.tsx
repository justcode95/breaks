"use client";

// The wallet state for the whole site: which wallets the browser has, which one is connected, and what happened last. The rules are
// in wallets.ts (pure and tested); this holds them in React, finds wallets as they register, reconnects the one used last time
// without a pop-up, and follows the connected wallet when its accounts change.

import { getWallets } from "@wallet-standard/app";
import type { Wallet } from "@wallet-standard/base";
import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from "react";
import {
  type WalletState,
  connectWallet,
  disconnectWallet,
  initialWalletState,
  rememberWallet,
  rememberedWallet,
  walletReducer,
  watchAccounts,
} from "./wallets";

interface WalletApi {
  state: WalletState;
  connect: (wallet: Wallet) => Promise<void>;
  disconnect: () => Promise<void>;
}

const WalletContext = createContext<WalletApi | undefined>(undefined);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(walletReducer, initialWalletState);

  // Wallets announce themselves to the page, before or after it loads; the standard's `getWallets` hears both.
  useEffect(() => {
    const registry = getWallets();
    const update = () => dispatch({ type: "wallets", all: registry.get() });
    update();
    const offRegister = registry.on("register", update);
    const offUnregister = registry.on("unregister", update);
    return () => {
      offRegister();
      offUnregister();
    };
  }, []);

  const connect = useCallback(async (wallet: Wallet, silent = false) => {
    dispatch({ type: "connecting", name: wallet.name });
    const result = await connectWallet(wallet, silent);
    if (result.ok) {
      dispatch({ type: "connected", wallet, account: result.account });
      rememberWallet(wallet.name);
    } else {
      dispatch({ type: "failed", name: wallet.name, ...(silent ? {} : { reason: result.reason }) });
    }
  }, []);

  // Once, when the wallet used last time shows up: reconnect it without asking, if the site is still allowed to use it.
  const triedRemembered = useRef(false);
  useEffect(() => {
    if (triedRemembered.current || state.status !== "idle") return;
    const name = rememberedWallet();
    const wallet = name === undefined ? undefined : state.usable.find((w) => w.name === name);
    if (!wallet) return;
    triedRemembered.current = true;
    void connect(wallet, true);
  }, [state.usable, state.status, connect]);

  // The user can switch account, or lock the wallet, from the wallet itself.
  const connectedWallet = state.connected?.wallet;
  useEffect(() => (connectedWallet ? watchAccounts(connectedWallet, (accounts) => dispatch({ type: "accounts", accounts })) : undefined), [connectedWallet]);

  const disconnect = useCallback(async () => {
    const wallet = connectedWallet;
    dispatch({ type: "disconnected" });
    rememberWallet(undefined);
    if (wallet) await disconnectWallet(wallet);
  }, [connectedWallet]);

  const api = useMemo<WalletApi>(() => ({ state, connect: (wallet) => connect(wallet, false), disconnect }), [state, connect, disconnect]);
  return <WalletContext.Provider value={api}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletApi {
  const api = useContext(WalletContext);
  if (!api) throw new Error("useWallet needs a WalletProvider around it");
  return api;
}
