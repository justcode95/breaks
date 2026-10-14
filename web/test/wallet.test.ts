import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { describe, expect, it } from "vitest";
import {
  CHAIN,
  type WalletAction,
  type WalletState,
  connectWallet,
  disconnectWallet,
  displayName,
  errorText,
  initialWalletState,
  pickAccount,
  rememberWallet,
  rememberedWallet,
  safeIcon,
  shortAddress,
  sortWallets,
  walletProblem,
  walletReducer,
  watchAccounts,
} from "../lib/wallet/wallets";
import { PNG, fill, pretendAccount, pretendWallet } from "./support/wallet";

describe("which wallets can be used here", () => {
  it("accepts a wallet that connects, sends Solana transactions and supports devnet", () => {
    expect(CHAIN).toBe("solana:devnet");
    expect(walletProblem(pretendWallet())).toBeUndefined();
  });

  it("says why a wallet cannot be used", () => {
    expect(walletProblem(pretendWallet({ only: ["send", "events"] }))).toBe("it cannot connect to a website");
    expect(walletProblem(pretendWallet({ only: ["connect", "events"] }))).toBe("it cannot send Solana transactions");
    expect(walletProblem(pretendWallet({ chains: ["solana:mainnet"] }))).toBe("it does not support Solana devnet");
  });

  it("splits a browser's wallets into usable ones and skipped ones, sorted by name, each name once", () => {
    const { usable, skipped } = sortWallets([
      pretendWallet({ name: "Zed" }),
      pretendWallet({ name: "Alpha" }),
      pretendWallet({ name: "Mainnet only", chains: ["solana:mainnet"] }),
      pretendWallet({ name: "Alpha" }),
      pretendWallet({ name: "No connect", only: ["send"] }),
    ]);
    expect(usable.map((w) => w.name)).toEqual(["Alpha", "Zed"]);
    expect(skipped).toEqual([
      { name: "Mainnet only", reason: "it does not support Solana devnet" },
      { name: "No connect", reason: "it cannot connect to a website" },
    ]);
  });

  it("cuts a very long wallet name where it is shown", () => {
    expect(displayName({ name: "Short" })).toBe("Short");
    expect(displayName({ name: "x".repeat(40) })).toBe("x".repeat(40));
    expect(displayName({ name: "x".repeat(41) })).toBe(`${"x".repeat(39)}…`);
    expect(sortWallets([pretendWallet({ name: "y".repeat(80), chains: [] })]).skipped[0]?.name).toBe(`${"y".repeat(39)}…`);
  });
});

describe("which account is used", () => {
  it("takes the first account that can send devnet transactions", () => {
    expect(pickAccount([pretendAccount(2, { chains: ["solana:mainnet"] }), pretendAccount(3, { features: [] }), pretendAccount(4), pretendAccount(5)])?.address).toBe(fill(4));
    expect(pickAccount([])).toBeUndefined();
  });

  it("refuses an account whose address is not its key", () => {
    expect(pickAccount([pretendAccount(2, { publicKey: new Uint8Array(32).fill(9) })])).toBeUndefined();
    expect(pickAccount([pretendAccount(2, { publicKey: new Uint8Array(31).fill(2) })])).toBeUndefined();
    const notAnAddress = { ...pretendAccount(2), address: "not-an-address" };
    expect(pickAccount([notAnAddress])).toBeUndefined();
  });
});

describe("connecting", () => {
  it("returns the account the wallet shares and passes on whether to stay silent", async () => {
    const w = pretendWallet({ accounts: [pretendAccount(7)] });
    expect(await connectWallet(w, false)).toEqual({ ok: true, account: pretendAccount(7) });
    await connectWallet(w, true);
    expect(w.connectCalls).toEqual([{ silent: false }, { silent: true }]);
  });

  it("uses the wallet's own accounts when connecting returns none", async () => {
    const w = pretendWallet({ connect: async () => ({ accounts: [] }) });
    Object.assign(w, { accounts: [pretendAccount(8)] });
    expect(await connectWallet(w, false)).toEqual({ ok: true, account: pretendAccount(8) });
  });

  it("says in words what a refusing wallet said, on one short line", async () => {
    const refuse = (err: unknown) => pretendWallet({ name: "Pretend", connect: async () => Promise.reject(err) });
    expect(await connectWallet(refuse(new Error("User rejected the request.")), false)).toEqual({ ok: false, reason: "Pretend did not connect: User rejected the request." });
    expect(await connectWallet(refuse(new Error("line one\n   line two")), false)).toMatchObject({ reason: "Pretend did not connect: line one line two." });
    expect(await connectWallet(refuse("plain text"), false)).toMatchObject({ reason: "Pretend did not connect: plain text." });
    expect(await connectWallet(refuse({ weird: true }), false)).toMatchObject({ reason: "Pretend did not connect: no reason given." });
    const long = (await connectWallet(refuse(new Error("e".repeat(500))), false)) as { reason: string };
    expect(long.reason).toBe(`Pretend did not connect: ${"e".repeat(199)}…`);
    expect(await connectWallet(refuse(new Error("Rejected!")), false)).toMatchObject({ reason: "Pretend did not connect: Rejected!" });
  });

  it("says so when the wallet shares no account that works", async () => {
    const w = pretendWallet({ name: "Pretend", accounts: [pretendAccount(2, { chains: ["solana:mainnet"] })] });
    expect(await connectWallet(w, false)).toEqual({ ok: false, reason: "Pretend shared no account that can send devnet transactions." });
  });

  it("does not try a wallet that cannot connect", async () => {
    expect(await connectWallet(pretendWallet({ name: "Pretend", only: ["send"] }), false)).toEqual({ ok: false, reason: "Pretend cannot connect to a website." });
  });

  it("turns any error into one short line", () => {
    expect(errorText(new Error("  a \n b  "))).toBe("a b");
    expect(errorText(new Error(""))).toBe("no reason given");
    expect(errorText(undefined)).toBe("no reason given");
    expect(errorText("x".repeat(200))).toBe("x".repeat(200));
    expect(errorText("x".repeat(201))).toBe(`${"x".repeat(199)}…`);
  });
});

describe("disconnecting and watching a wallet", () => {
  it("tells the wallet it is disconnected, and forgets it anyway when the wallet cannot say or fails", async () => {
    const w = pretendWallet();
    await disconnectWallet(w);
    expect(w.disconnectCalls).toBe(1);
    await expect(disconnectWallet(pretendWallet({ only: ["connect"] }))).resolves.toBeUndefined();
    await expect(disconnectWallet(pretendWallet({ disconnect: async () => Promise.reject(new Error("boom")) }))).resolves.toBeUndefined();
  });

  it("passes on changes of the wallet's accounts, until told to stop", () => {
    const w = pretendWallet();
    const seen: string[][] = [];
    const stop = watchAccounts(w, (accounts) => seen.push(accounts.map((a) => a.address)));
    expect(w.listeners).toBe(1);
    w.emit([pretendAccount(3)]);
    expect(seen).toEqual([[fill(3)]]);
    stop();
    expect(w.listeners).toBe(0);
    w.emit([pretendAccount(4)]);
    expect(seen).toHaveLength(1);
  });

  it("ignores a change that says nothing about accounts, and a wallet that has no events", () => {
    const w = pretendWallet();
    const seen: unknown[] = [];
    watchAccounts(w, (a) => seen.push(a));
    // A change of something else (the chains, say) arrives without accounts in it.
    w.emit(undefined as unknown as readonly WalletAccount[]);
    expect(seen).toEqual([]);
    w.emit([pretendAccount(3)]);
    expect(seen).toHaveLength(1);
    expect(() => watchAccounts(pretendWallet({ only: ["connect"] }), () => {})()).not.toThrow();
  });
});

describe("a wallet's icon", () => {
  it("is used only when it is an image sent inline", () => {
    expect(safeIcon(PNG)).toBe(PNG);
    expect(safeIcon("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")).toBeDefined();
    expect(safeIcon("data:image/webp;base64,UklGRg==")).toBeDefined();
    expect(safeIcon("data:image/gif;base64,R0lGODlh")).toBeDefined();
  });

  it("is never a link to somewhere else, a script, another kind of data, or something huge", () => {
    expect(safeIcon("https://example.com/icon.png")).toBeUndefined();
    expect(safeIcon("javascript:alert(1)")).toBeUndefined();
    expect(safeIcon("data:text/html;base64,PHNjcmlwdD4=")).toBeUndefined();
    expect(safeIcon("data:image/png;base64,abc def")).toBeUndefined();
    expect(safeIcon('data:image/png;base64,abc"onerror="x')).toBeUndefined();
    expect(safeIcon(`data:image/png;base64,${"A".repeat(100_000)}`)).toBeUndefined();
    expect(safeIcon(undefined)).toBeUndefined();
    expect(safeIcon(42)).toBeUndefined();
  });

  it("shortens an address to its first and last four characters", () => {
    expect(shortAddress("4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi")).toBe("4vJ9…kLKi");
    expect(shortAddress("abcdefghi")).toBe("abcdefghi");
    expect(shortAddress("abcdefghij")).toBe("abcd…ghij");
  });
});

describe("the wallet state", () => {
  const A = pretendWallet({ name: "A" });
  const B = pretendWallet({ name: "B" });
  const run = (actions: WalletAction[], from: WalletState = initialWalletState) => actions.reduce(walletReducer, from);
  const connected = (wallet: Wallet, n = 1): WalletAction => ({ type: "connected", wallet, account: pretendAccount(n) });

  it("lists the usable wallets and the skipped ones as wallets come and go", () => {
    const s = run([{ type: "wallets", all: [B, A, pretendWallet({ name: "Old", chains: [] })] }]);
    expect(s.usable.map((w) => w.name)).toEqual(["A", "B"]);
    expect(s.skipped).toEqual([{ name: "Old", reason: "it does not support Solana devnet" }]);
    expect(s.status).toBe("idle");
  });

  it("goes from idle to connecting to connected, and clears an old error on the way", () => {
    let s = run([{ type: "wallets", all: [A] }, { type: "connecting", name: "A" }, { type: "failed", name: "A", reason: "no" }]);
    expect(s).toMatchObject({ status: "idle", error: "no" });
    s = run([{ type: "connecting", name: "A" }], s);
    expect(s).toMatchObject({ status: "connecting", connecting: "A" });
    expect(s.error).toBeUndefined();
    s = run([connected(A)], s);
    expect(s.status).toBe("connected");
    expect(s.connected?.account.address).toBe(fill(1));
    expect(s.connecting).toBeUndefined();
    expect(s.error).toBeUndefined();
  });

  it("ignores the late answer of a wallet that is no longer the one being asked", () => {
    const asking = run([{ type: "wallets", all: [A, B] }, { type: "connecting", name: "A" }, { type: "connecting", name: "B" }]);
    // A answers after B was chosen: neither its success nor its failure counts.
    expect(run([connected(A)], asking)).toBe(asking);
    expect(run([{ type: "failed", name: "A", reason: "late" }], asking)).toBe(asking);
    expect(run([connected(B)], asking).connected?.wallet).toBe(B);
    // Nobody is being asked: an answer from nowhere changes nothing.
    const idle = run([{ type: "wallets", all: [A] }]);
    expect(run([connected(A)], idle)).toBe(idle);
    expect(run([{ type: "failed", name: "A", reason: "x" }], idle)).toBe(idle);
  });

  it("shows no error for a quiet reconnect that did not work", () => {
    const s = run([{ type: "wallets", all: [A] }, { type: "connecting", name: "A" }, { type: "failed", name: "A" }]);
    expect(s).toMatchObject({ status: "idle" });
    expect("error" in s).toBe(false);
  });

  it("follows the connected wallet's account, and disconnects when it no longer shares a usable one", () => {
    const on = run([{ type: "wallets", all: [A] }, { type: "connecting", name: "A" }, connected(A, 1)]);
    const switched = run([{ type: "accounts", accounts: [pretendAccount(2)] }], on);
    expect(switched.connected?.account.address).toBe(fill(2));
    expect(switched.status).toBe("connected");
    const gone = run([{ type: "accounts", accounts: [] }], on);
    expect(gone.status).toBe("idle");
    expect(gone.connected).toBeUndefined();
    expect(gone.error).toBe("A no longer shares an account that can send devnet transactions.");
    // A change while nothing is connected is nothing.
    const idle = run([{ type: "wallets", all: [A] }]);
    expect(run([{ type: "accounts", accounts: [pretendAccount(2)] }], idle)).toBe(idle);
  });

  it("disconnects when asked, and when the connected wallet is removed from the browser", () => {
    const on = run([{ type: "wallets", all: [A, B] }, { type: "connecting", name: "A" }, connected(A)]);
    expect(run([{ type: "disconnected" }], on)).toMatchObject({ status: "idle" });
    expect(run([{ type: "disconnected" }], on).connected).toBeUndefined();
    // B arriving does not disturb A.
    expect(run([{ type: "wallets", all: [A, B, pretendWallet({ name: "C" })] }], on).connected?.wallet).toBe(A);
    const removed = run([{ type: "wallets", all: [B] }], on);
    expect(removed).toMatchObject({ status: "idle", error: "The wallet is no longer available." });
    expect(removed.connected).toBeUndefined();
  });
});

describe("remembering the wallet between visits", () => {
  const store = () => {
    const data = new Map<string, string>();
    return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
  };

  it("keeps only the wallet's name, and can forget it", () => {
    const s = store();
    expect(rememberedWallet(s)).toBeUndefined();
    rememberWallet("Pretend Wallet", s);
    expect([...s.data.entries()]).toEqual([["breaks.wallet", "Pretend Wallet"]]);
    expect(rememberedWallet(s)).toBe("Pretend Wallet");
    rememberWallet(undefined, s);
    expect(rememberedWallet(s)).toBeUndefined();
  });

  it("carries on when the browser blocks storage", () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => rememberWallet("A", blocked)).not.toThrow();
    expect(() => rememberWallet(undefined, blocked)).not.toThrow();
    expect(rememberedWallet(blocked)).toBeUndefined();
    // No storage at all (a server, or a browser with it switched off).
    expect(() => rememberWallet("A", undefined)).not.toThrow();
  });
});
