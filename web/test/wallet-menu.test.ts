import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type BalanceView, WalletMenu } from "../app/wallet-menu";
import { type WalletAction, type WalletState, initialWalletState, walletReducer } from "../lib/wallet/wallets";
import { PNG, fill, pretendAccount, pretendWallet } from "./support/wallet";

const run = (actions: WalletAction[]): WalletState => actions.reduce(walletReducer, initialWalletState);
const noop = () => {};
const render = (state: WalletState, over: { balance?: BalanceView; open?: boolean } = {}) =>
  renderToStaticMarkup(createElement(WalletMenu, { state, balance: over.balance ?? { kind: "off" }, open: over.open ?? true, onToggle: noop, onConnect: noop, onDisconnect: noop, onRefresh: noop }));
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

const A = pretendWallet({ name: "Alpha" });
const connected = run([{ type: "wallets", all: [A] }, { type: "connecting", name: "Alpha" }, { type: "connected", wallet: A, account: pretendAccount(4) }]);

describe("the wallet button", () => {
  it("offers to connect, and tells the screen reader whether the panel is open", () => {
    const closed = render(initialWalletState, { open: false });
    expect(closed).toContain("Connect wallet");
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).toContain('aria-controls="wallet-panel"');
    expect(closed).not.toContain('id="wallet-panel"');
    const open = render(initialWalletState);
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain('id="wallet-panel"');
  });

  it("shows a short address with the connection said aloud, once connected", () => {
    const html = render(connected, { open: false });
    expect(html).toContain('<span class="sr-only">Wallet connected: </span>');
    expect(html).toContain(`${fill(4).slice(0, 4)}…${fill(4).slice(-4)}`);
    expect(html).not.toContain("Connect wallet");
  });

  it("says it is connecting while a wallet is being asked", () => {
    const asking = run([{ type: "wallets", all: [A] }, { type: "connecting", name: "Alpha" }]);
    expect(render(asking, { open: false })).toContain("Connecting…");
    expect(text(render(asking))).toContain("Waiting for Alpha… approve the request in your wallet.");
    expect(render(asking)).not.toContain("wallet-list");
  });
});

describe("the panel when nothing is connected", () => {
  it("lists the wallets that can be used, with their icons, and says the site is devnet only", () => {
    const html = render(run([{ type: "wallets", all: [pretendWallet({ name: "Zed" }), A] }]));
    expect(text(html)).toContain("Choose a wallet. This site only works on Solana devnet.");
    expect([...html.matchAll(/<li><button[^>]*>(.*?)<\/button><\/li>/g)].map((m) => text(m[1] as string))).toEqual(["Alpha", "Zed"]);
    expect(html).toContain(`<img src="${PNG}" alt="" width="20" height="20"/>`);
  });

  it("shows no icon that is not an inline image", () => {
    const odd = pretendWallet({ name: "Odd" });
    Object.assign(odd, { icon: "https://example.com/tracker.png" });
    const html = render(run([{ type: "wallets", all: [odd] }]));
    expect(html).not.toContain("<img");
    expect(html).not.toContain("example.com");
    expect(text(html)).toContain("Odd");
  });

  it("says there is no usable wallet, and which ones were found but cannot be used", () => {
    const none = text(render(initialWalletState));
    expect(none).toContain("No wallet that works with Solana devnet was found in this browser. Use a Solana wallet extension that supports devnet, then reload this page.");
    const skipped = text(render(run([{ type: "wallets", all: [pretendWallet({ name: "Mainnet only", chains: ["solana:mainnet"] })] }])));
    expect(skipped).toContain("No wallet that works with Solana devnet");
    expect(skipped).toContain("Found, but not usable here: Mainnet only (it does not support Solana devnet).");
    expect(text(render(run([{ type: "wallets", all: [A] }])))).not.toContain("Found, but not usable");
  });

  it("shows why the last attempt failed", () => {
    const failed = run([{ type: "wallets", all: [A] }, { type: "connecting", name: "Alpha" }, { type: "failed", name: "Alpha", reason: "Alpha did not connect: User rejected the request." }]);
    const html = render(failed);
    expect(html).toContain('<p class="problem" role="alert">Alpha did not connect: User rejected the request.</p>');
    expect(html).toContain("wallet-list");
  });

  it("never reads a wallet's name as markup", () => {
    const evil = pretendWallet({ name: '<img src=x onerror="alert(1)">' });
    const html = render(run([{ type: "wallets", all: [evil] }]));
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });
});

describe("the panel once connected", () => {
  it("names the wallet, shows the whole address, and offers to disconnect", () => {
    const html = render(connected);
    expect(text(html)).toContain("Connected with Alpha on devnet.");
    expect(html).toContain(`<code class="mono wrap">${fill(4)}</code>`);
    expect(text(html)).toContain("Disconnect");
    expect(html).not.toContain("wallet-list");
    expect(text(html)).not.toContain("Choose a wallet");
  });

  it("reads out the USDC balance, in every state it can be in", () => {
    const said = (balance: BalanceView) => text(render(connected, { balance }));
    expect(said({ kind: "loaded", balance: 25_000_000n })).toContain("USDC balance: $25");
    expect(said({ kind: "loaded", balance: 20_500_000n })).toContain("USDC balance: $20.50");
    expect(said({ kind: "loaded", balance: 0n })).toContain("USDC balance: $0");
    expect(said({ kind: "loaded", balance: null })).toContain("USDC balance: none, this wallet has no USDC account yet.");
    expect(said({ kind: "loading" })).toContain("USDC balance: reading…");
    expect(said({ kind: "error", message: "the node answered 429" })).toContain("Could not read the USDC balance: the node answered 429");
  });

  it("offers a refresh only when the site reads balances at all", () => {
    expect(text(render(connected, { balance: { kind: "loaded", balance: 1n } }))).toContain("Refresh balance");
    const off = text(render(connected, { balance: { kind: "off" } }));
    expect(off).not.toContain("Refresh balance");
    expect(off).not.toContain("USDC balance");
  });

  it("does not list wallets or skipped ones while connected", () => {
    const withSkipped = run([{ type: "wallets", all: [A, pretendWallet({ name: "Old", chains: [] })] }, { type: "connecting", name: "Alpha" }, { type: "connected", wallet: A, account: pretendAccount(4) }]);
    expect(text(render(withSkipped))).not.toContain("Found, but not usable");
  });
});
