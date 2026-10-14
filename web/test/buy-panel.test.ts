import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BuyPanelView, type BuyPanelViewProps } from "../app/breaks/[number]/buy-panel-view";
import { decodeBreak } from "../lib/chain/accounts";
import { type BuyState, idleBuy } from "../lib/chain/buy-state";
import type { PurchaseResult } from "../lib/chain/purchase";
import { type BreakFields, breakFieldsFromVector, encodeBreak } from "./support/accounts";
import { buttons } from "./support/tree";
import { fill } from "./support/wallet";

const vectors: { cases: { name: string; outputs: Record<string, any> | null }[] } = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "programs", "breaks", "instruction-vectors.json"), "utf8"),
);
const SAMPLE = breakFieldsFromVector(vectors.cases.find((c) => c.name === "breaks.account.Break")?.outputs as Record<string, any>);
// The sample sale runs 2027-01-15 08:00 to 14:00 UTC; ten paid spots at $20.
const OPENS = 1_800_000_000;
const CLOSES = 1_800_021_600;
const WITHIN = OPENS + 3600;

const brk = (over: Partial<BreakFields> = {}) => decodeBreak(encodeBreak({ ...SAMPLE, status: "Open", spotsSold: 3, freeWinnerCount: 0, freeWinners: [], ...over }));
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
const SIGNATURE = "5".repeat(87);
const ADDRESS = fill(4);
const SHORT = `${ADDRESS.slice(0, 4)}…${ADDRESS.slice(-4)}`;

const props = (over: Partial<BuyPanelViewProps> = {}): BuyPanelViewProps => ({
  b: brk(),
  now: WITHIN,
  terms: { kind: "loaded", terms: { paused: false, solCost: 1_313_480n } },
  wallet: { kind: "none" },
  usdc: { kind: "loading" },
  buy: idleBuy,
  onBuy: () => {},
  onRetry: () => {},
  onDismiss: () => {},
  ...over,
});
const view = (over: Partial<BuyPanelViewProps> = {}) => renderToStaticMarkup(createElement(BuyPanelView, props(over)));
const connected = { kind: "connected", address: ADDRESS } as const;
const finished = (result: PurchaseResult, seen = false): BuyState => ({ status: "finished", address: ADDRESS, result, seen });

describe("when the card is there", () => {
  it("is not there for a break that is not on sale, and is there for one that is", () => {
    for (const status of ["Closed", "EligibilityCommitted", "Funded", "PoolCommitted", "RandomnessRequested", "Settled", "Drawn", "Cancelled"] as const) {
      expect(view({ b: brk({ status }) }), status).toBe("");
    }
    expect(view({ b: brk({ status: "Open" }) })).toContain("Buy a spot");
  });

  it("stays for a purchase made here, whatever the break has become since", () => {
    const bought = finished({ kind: "bought", signature: SIGNATURE, index: 9, price: 20_000_000n });
    expect(text(view({ b: brk({ status: "Closed", spotsSold: 10 }), buy: bought }))).toContain("Spot #10 is yours.");
    expect(view({ b: brk({ status: "Cancelled" }), buy: { status: "running", address: ADDRESS, step: "checking" } })).toContain("Buy a spot");
  });
});

describe("the price, before anything is asked of the wallet", () => {
  it("says what the spot costs in USDC, how many are left, and the SOL on top, in full", () => {
    const t = text(view());
    expect(t).toContain("$20 in USDC for a paid spot");
    expect(t).toContain("7 of 10 left, plus about 0.00131348 SOL for the new spot's account and the network fee.");
    expect(t).toContain("Your wallet shows the final amounts before you approve.");
  });

  it("does not claim an amount of SOL it has not read, and says why when it could not", () => {
    expect(text(view({ terms: { kind: "loading" } }))).toContain("7 of 10 left, plus a little devnet SOL for the new spot's account and the network fee.");
    expect(text(view({ terms: { kind: "loading" } }))).not.toContain("about");
    const failed = text(view({ terms: { kind: "error", message: "the node answered 503" } }));
    expect(failed).toContain("plus a little devnet SOL");
    expect(failed).toContain("Could not read the exact SOL amount: the node answered 503");
  });

  it("shows the price of this break, not another", () => {
    expect(text(view({ b: brk({ spotPrice: 12_500_000n }) }))).toContain("$12.50 in USDC for a paid spot");
    expect(text(view({ b: brk({ paidSpots: 12, spotsSold: 11 }) }))).toContain("1 of 12 left");
  });
});

describe("what stands in the way", () => {
  const noButton = (html: string) => expect(html).not.toContain("<button");

  it("says in words when sales are paused, the window is over or not open, or all spots are taken, with no price and no button", () => {
    const cases: [Partial<BuyPanelViewProps>, string][] = [
      [{ terms: { kind: "loaded", terms: { paused: true, solCost: 1n } }, wallet: connected, usdc: { kind: "loaded", balance: 99_000_000n } }, "Sales are paused by the program's admin."],
      [{ now: CLOSES }, "The sale has ended."],
      [{ now: OPENS - 1 }, "The sale opens 2027-01-15 08:00 UTC."],
      [{ b: brk({ spotsSold: 10 }) }, "All paid spots are taken."],
    ];
    for (const [over, words] of cases) {
      const html = view(over);
      expect(text(html)).toContain(words);
      expect(text(html)).not.toContain("in USDC for a paid spot");
      noButton(html);
    }
  });

  it("does not hold back a sale because the terms could not be read: the purchase checks them again", () => {
    expect(text(view({ terms: { kind: "error", message: "x" }, wallet: connected, usdc: { kind: "loaded", balance: 25_000_000n } }))).toContain("in USDC for a paid spot");
  });

  it("asks a visitor with no wallet to connect one, and waits while one is connecting", () => {
    expect(text(view())).toContain("Connect a wallet with the button at the top of the page to buy a spot.");
    noButton(view());
    const connecting = view({ wallet: { kind: "connecting" } });
    expect(text(connecting)).toContain("Waiting for the wallet to connect…");
    expect(text(connecting)).not.toContain("Connect a wallet with");
    noButton(connecting);
  });

  it("says while the USDC is being read, and offers another try when it could not be", () => {
    const reading = view({ wallet: connected, usdc: { kind: "loading" } });
    expect(text(reading)).toContain("Reading your USDC balance…");
    noButton(reading);

    const onRetry = vi.fn();
    const failed = props({ wallet: connected, usdc: { kind: "error", message: "the node answered 503" }, onRetry });
    expect(text(renderToStaticMarkup(createElement(BuyPanelView, failed)))).toContain("Could not read your USDC balance: the node answered 503");
    const found = buttons(createElement(BuyPanelView, failed));
    expect(found.map((b) => b.text)).toEqual(["Try again"]);
    found[0]?.onClick?.();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("says why a wallet cannot pay: no USDC account, or a balance one micro-dollar short", () => {
    const none = view({ wallet: connected, usdc: { kind: "loaded", balance: null } });
    expect(text(none)).toContain("Your USDC: none");
    expect(text(none)).toContain("This wallet has no USDC account yet, so it has no USDC to pay with.");
    noButton(none);
    const short = view({ wallet: connected, usdc: { kind: "loaded", balance: 19_999_999n } });
    expect(text(short)).toContain("A spot costs $20 USDC and this wallet has $19.999999.");
    noButton(short);
  });
});

describe("the buy button", () => {
  it("appears for a wallet that can pay, down to the last micro-dollar, and shows the balance and which wallet", () => {
    for (const balance of [20_000_000n, 25_000_000n]) {
      const html = view({ wallet: connected, usdc: { kind: "loaded", balance } });
      expect(text(html)).toContain(`Your USDC: ${balance === 20_000_000n ? "$20" : "$25"} (${SHORT})`);
      expect(buttons(createElement(BuyPanelView, props({ wallet: connected, usdc: { kind: "loaded", balance } }))).map((b) => b.text)).toEqual(["Buy a spot for $20"]);
    }
  });

  it("calls the handler it was given, and only the main button is gold", () => {
    const onBuy = vi.fn();
    const onRetry = vi.fn();
    const onDismiss = vi.fn();
    const [button] = buttons(createElement(BuyPanelView, props({ wallet: connected, usdc: { kind: "loaded", balance: 25_000_000n }, onBuy, onRetry, onDismiss })));
    expect(button?.className).toBe("");
    button?.onClick?.();
    expect(onBuy).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("is not on offer while a purchase is running, and says each step", () => {
    const steps = {
      checking: "Checking the sale, your balances and the network…",
      "waiting-for-wallet": "Approve the purchase in your wallet. Nothing is bought until you do.",
      confirming: "Sent. Waiting for the network to confirm it…",
    } as const;
    for (const [step, words] of Object.entries(steps)) {
      const p = props({ wallet: connected, usdc: { kind: "loaded", balance: 25_000_000n }, buy: { status: "running", address: ADDRESS, step: step as keyof typeof steps } });
      const html = renderToStaticMarkup(createElement(BuyPanelView, p));
      expect(text(html)).toContain(words);
      expect(html).toContain('role="status"');
      expect(html).not.toContain("<button");
      expect(text(html)).not.toContain("in USDC for a paid spot");
    }
  });
});

describe("how a purchase ended", () => {
  const result = (r: PurchaseResult, seen = false, onDismiss = () => {}) => {
    const p = props({ buy: finished(r, seen), onDismiss });
    return { html: renderToStaticMarkup(createElement(BuyPanelView, p)), found: buttons(createElement(BuyPanelView, p)) };
  };

  it("congratulates a buyer by the number of the spot, the price and the wallet, and says whether the page already shows it", () => {
    const bought: PurchaseResult = { kind: "bought", signature: SIGNATURE, index: 3, price: 20_000_000n };
    const early = result(bought);
    expect(text(early.html)).toContain(`Spot #4 is yours. You paid $20 in USDC with ${SHORT}.`);
    expect(text(early.html)).toContain("The chain is still finalizing it; the page above updates in a few seconds.");
    const later = result(bought, true);
    expect(text(later.html)).toContain("The page above now shows it.");
    expect(text(later.html)).not.toContain("still finalizing");
    expect(later.html).toContain('role="status"');
  });

  it("links the transaction on the devnet explorer, opening a new tab without handing over the page", () => {
    const html = result({ kind: "bought", signature: SIGNATURE, index: 0, price: 1n }).html;
    expect(html).toContain(`<a href="https://explorer.solana.com/tx/${SIGNATURE}?cluster=devnet" target="_blank" rel="noopener noreferrer">`);
  });

  it("never builds a link from a signature that is not one", () => {
    for (const signature of ["", "abc", `${"5".repeat(70)}"><script>`, "javascript:alert(1)", "5".repeat(89), "0".repeat(87)]) {
      const html = result({ kind: "failed", signature, reason: "x" }).html;
      expect(html, signature).not.toContain("<a ");
      expect(html, signature).not.toContain("explorer.solana.com");
    }
  });

  it("says a refusal came before the wallet was asked, and offers to try again", () => {
    const onDismiss = vi.fn();
    const { html, found } = result({ kind: "refused", reason: "A spot costs $20 USDC and this wallet has $3." }, false, onDismiss);
    expect(text(html)).toContain("Not bought. A spot costs $20 USDC and this wallet has $3.");
    expect(text(html)).toContain("Your wallet was not asked to sign anything.");
    expect(html).toContain('role="alert"');
    expect(found.map((b) => b.text)).toEqual(["Try again"]);
    found[0]?.onClick?.();
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("does not say 'not bought' when the wallet may have sent it, and sends the buyer to the wallet's history", () => {
    const { html, found } = result({ kind: "declined", reason: "Pretend did not send the transaction: closed. If you approved it, check your wallet's history before trying again." });
    expect(text(html)).toContain("The wallet did not confirm sending it. Pretend did not send the transaction: closed. If you approved it, check your wallet's history before trying again.");
    expect(text(html)).not.toContain("Not bought");
    expect(found.map((b) => b.text)).toEqual(["Close"]);
  });

  it("says a network failure bought nothing and spent no USDC, with the transaction to look at", () => {
    const { html, found } = result({ kind: "failed", signature: SIGNATURE, reason: "All paid spots are taken." });
    expect(text(html)).toContain("Not bought. All paid spots are taken.");
    expect(text(html)).toContain("No USDC was spent.");
    expect(html).toContain("explorer.solana.com");
    expect(found.map((b) => b.text)).toEqual(["Try again"]);
  });

  it("does not claim either way when the network has not answered", () => {
    const { html, found } = result({ kind: "unconfirmed", signature: SIGNATURE, reason: "The network has not confirmed the transaction yet. It may still land." });
    expect(text(html)).toContain("Not confirmed yet. The network has not confirmed the transaction yet. It may still land.");
    expect(text(html)).not.toContain("No USDC was spent");
    expect(text(html)).not.toContain("is yours");
    expect(html).toContain("explorer.solana.com");
    expect(found.map((b) => b.text)).toEqual(["Close"]);
  });

  it("closes a result with the dismiss handler", () => {
    const onDismiss = vi.fn();
    const { found } = result({ kind: "bought", signature: SIGNATURE, index: 0, price: 1n }, false, onDismiss);
    expect(found.map((b) => b.text)).toEqual(["Close"]);
    found[0]?.onClick?.();
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("shows words from the wallet and the network as text, never as markup", () => {
    const evil = '<img src=x onerror=alert(1)> & "quotes"';
    for (const r of [
      { kind: "refused", reason: evil },
      { kind: "declined", reason: evil },
      { kind: "failed", signature: SIGNATURE, reason: evil },
      { kind: "unconfirmed", signature: SIGNATURE, reason: evil },
    ] as const) {
      const html = result(r).html;
      expect(html, r.kind).not.toContain("<img");
      expect(text(html), r.kind).toContain(evil);
    }
  });
});
