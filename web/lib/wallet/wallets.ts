// Connecting a wallet: the logic. Wallets are found and driven through the Wallet Standard, the way Phantom, Solflare, Backpack and
// the others register themselves with a page, so nothing here is specific to one wallet. Everything is a plain function over wallet
// objects (tested with pretend wallets); the React side in provider.tsx only holds the state and calls these.

import { SolanaSignAndSendTransaction } from "@solana/wallet-standard-features";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import {
  StandardConnect,
  type StandardConnectFeature,
  StandardDisconnect,
  type StandardDisconnectFeature,
  StandardEvents,
  type StandardEventsFeature,
} from "@wallet-standard/features";
import { addressToBytes } from "../chain/address";
import { equalBytes } from "../draw/bytes";

/** The one network this site works on. The wallet is told this chain with every request, and wallets that cannot do it are not offered. */
export const CHAIN = "solana:devnet";

/** A wallet's name as shown: wallets choose their own text, so it is cut to a sensible length and never read as markup (React escapes it). */
export const displayName = (wallet: Pick<Wallet, "name">): string => (wallet.name.length > 40 ? `${wallet.name.slice(0, 39)}…` : wallet.name);

/** "4vJ9…LKi": enough of an address to recognise it. */
export const shortAddress = (address: string): string => (address.length <= 9 ? address : `${address.slice(0, 4)}…${address.slice(-4)}`);

const ICON = /^data:image\/(svg\+xml|webp|png|gif);base64,[A-Za-z0-9+/]+=*$/;
/** The most an icon may be: wallets send theirs as a data address, and a page should not swallow an enormous one. */
const MAX_ICON = 100_000;

/** A wallet's icon if it is an image sent inline as the standard says, and nothing otherwise (never a link to somewhere else). */
export const safeIcon = (icon: unknown): string | undefined => (typeof icon === "string" && icon.length <= MAX_ICON && ICON.test(icon) ? icon : undefined);

/** Why a wallet cannot be used on this site, or `undefined` when it can. */
export function walletProblem(wallet: Wallet): string | undefined {
  if (!(StandardConnect in wallet.features)) return "it cannot connect to a website";
  if (!(SolanaSignAndSendTransaction in wallet.features)) return "it cannot send Solana transactions";
  if (!wallet.chains.includes(CHAIN)) return "it does not support Solana devnet";
  return undefined;
}

export interface Skipped {
  name: string;
  reason: string;
}

/** The wallets of a browser split into those this site can use and those it cannot (with why). Sorted by name; a name listed twice counts once. */
export function sortWallets(all: readonly Wallet[]): { usable: Wallet[]; skipped: Skipped[] } {
  const seen = new Set<string>();
  const usable: Wallet[] = [];
  const skipped: Skipped[] = [];
  for (const wallet of [...all].sort((a, b) => a.name.localeCompare(b.name))) {
    if (seen.has(wallet.name)) continue;
    seen.add(wallet.name);
    const problem = walletProblem(wallet);
    if (problem) skipped.push({ name: displayName(wallet), reason: problem });
    else usable.push(wallet);
  }
  return { usable, skipped };
}

/** The account to act as: the first one that can send devnet transactions and whose address and key agree. */
export function pickAccount(accounts: readonly WalletAccount[]): WalletAccount | undefined {
  return accounts.find((a) => {
    if (!a.chains.includes(CHAIN) || !a.features.includes(SolanaSignAndSendTransaction)) return false;
    try {
      return equalBytes(addressToBytes(a.address), Uint8Array.from(a.publicKey));
    } catch {
      return false;
    }
  });
}

/** What a wallet said went wrong, cut down to one short line. */
export function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const line = text.replace(/\s+/g, " ").trim();
  return line === "" ? "no reason given" : line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/** Ends a line of someone else's words with a full stop, unless it already ends the sentence. */
const endSentence = (text: string): string => (/[.!?…]$/.test(text) ? text : `${text}.`);

export type ConnectResult = { ok: true; account: WalletAccount } | { ok: false; reason: string };

/**
 * Asks a wallet for an account. `silent` only reconnects a wallet this site was already allowed to use, without a pop-up.
 * A wallet that refuses, fails or offers nothing usable gives a reason in words.
 */
export async function connectWallet(wallet: Wallet, silent: boolean): Promise<ConnectResult> {
  const feature = (wallet.features as Partial<StandardConnectFeature>)[StandardConnect];
  if (!feature) return { ok: false, reason: `${displayName(wallet)} cannot connect to a website.` };
  let accounts: readonly WalletAccount[];
  try {
    const out = await feature.connect({ silent });
    accounts = out.accounts.length > 0 ? out.accounts : wallet.accounts;
  } catch (err) {
    return { ok: false, reason: `${displayName(wallet)} did not connect: ${endSentence(errorText(err))}` };
  }
  const account = pickAccount(accounts);
  if (!account) return { ok: false, reason: `${displayName(wallet)} shared no account that can send devnet transactions.` };
  return { ok: true, account };
}

/** Tells a wallet this site is done with it. A wallet that cannot be told, or fails, is simply forgotten by the page. */
export async function disconnectWallet(wallet: Wallet): Promise<void> {
  const feature = (wallet.features as Partial<StandardDisconnectFeature>)[StandardDisconnect];
  if (!feature) return;
  try {
    await feature.disconnect();
  } catch {
    // The page forgets the wallet either way.
  }
}

/** Calls `listener` with the wallet's accounts whenever they change (the user switched account, or locked the wallet). Returns how to stop. */
export function watchAccounts(wallet: Wallet, listener: (accounts: readonly WalletAccount[]) => void): () => void {
  const feature = (wallet.features as Partial<StandardEventsFeature>)[StandardEvents];
  if (!feature) return () => {};
  return feature.on("change", ({ accounts }) => {
    if (accounts) listener(accounts);
  });
}

export interface Connected {
  wallet: Wallet;
  account: WalletAccount;
}

export interface WalletState {
  usable: Wallet[];
  skipped: Skipped[];
  status: "idle" | "connecting" | "connected";
  connected?: Connected;
  /** The name of the wallet being asked, while `status` is "connecting". */
  connecting?: string;
  /** Why the last attempt failed. Cleared by the next attempt. */
  error?: string;
}

export const initialWalletState: WalletState = { usable: [], skipped: [], status: "idle" };

export type WalletAction =
  | { type: "wallets"; all: readonly Wallet[] }
  | { type: "connecting"; name: string }
  | { type: "connected"; wallet: Wallet; account: WalletAccount }
  /** `reason` is left out for a quiet reconnect that did not work: nothing to tell the visitor. */
  | { type: "failed"; name: string; reason?: string }
  | { type: "accounts"; accounts: readonly WalletAccount[] }
  | { type: "disconnected" };

const idle = (state: WalletState, error?: string): WalletState => {
  const { connected: _c, connecting: _n, error: _e, ...rest } = state;
  return { ...rest, status: "idle", ...(error ? { error } : {}) };
};

/** How the wallet state changes. Late answers from a wallet that is no longer the one being asked are ignored. */
export function walletReducer(state: WalletState, action: WalletAction): WalletState {
  switch (action.type) {
    case "wallets": {
      const next = { ...state, ...sortWallets(action.all) };
      // A connected wallet that went away (unregistered, or its extension was removed) is no longer connected.
      if (next.connected && !action.all.includes(next.connected.wallet)) return idle(next, "The wallet is no longer available.");
      return next;
    }
    case "connecting":
      return { ...idle(state), status: "connecting", connecting: action.name };
    case "connected":
      if (state.status !== "connecting" || state.connecting !== action.wallet.name) return state;
      return { ...idle(state), status: "connected", connected: { wallet: action.wallet, account: action.account } };
    case "failed":
      if (state.status !== "connecting" || state.connecting !== action.name) return state;
      return idle(state, action.reason);
    case "accounts": {
      if (!state.connected) return state;
      const account = pickAccount(action.accounts);
      if (!account) return idle(state, `${displayName(state.connected.wallet)} no longer shares an account that can send devnet transactions.`);
      return { ...state, connected: { ...state.connected, account } };
    }
    case "disconnected":
      return idle(state);
  }
}

const KEY = "breaks.wallet";

/** The name of the wallet used last time, if the browser remembers one. Storage can be missing or blocked, so every use is guarded. */
export function rememberedWallet(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): string | undefined {
  try {
    return storage?.getItem(KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Remembers the wallet's name (not an address or anything else), or forgets it with `undefined`. */
export function rememberWallet(name: string | undefined, storage: Pick<Storage, "setItem" | "removeItem"> | undefined = safeStorage()): void {
  try {
    if (name === undefined) storage?.removeItem(KEY);
    else storage?.setItem(KEY, name);
  } catch {
    // Nothing is lost: the visitor connects again next time.
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
