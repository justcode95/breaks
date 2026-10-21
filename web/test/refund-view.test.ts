import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RefundStatusView } from "../app/me/refund-status";
import type { RefundResult } from "../lib/chain/refund";
import { type RefundState, idleRefund } from "../lib/chain/refund-state";
import { buttons } from "./support/tree";
import { fill } from "./support/wallet";

const ADDRESS = fill(4);
const SHORT = `${ADDRESS.slice(0, 4)}…${ADDRESS.slice(-4)}`;
const SIGNATURE = "5".repeat(87);
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
const finished = (result: RefundResult, seen = false): RefundState => ({ status: "finished", result, seen, address: ADDRESS, breakNumber: 3, index: 0 });
const view = (state: RefundState, onDismiss = () => {}) => ({ html: renderToStaticMarkup(createElement(RefundStatusView, { state, onDismiss })), found: buttons(createElement(RefundStatusView, { state, onDismiss })) });

describe("the refund status", () => {
  it("is nothing while nothing is happening", () => {
    expect(view(idleRefund).html).toBe("");
  });

  it("says which spot is being refunded and each step, with no button while it runs", () => {
    const steps = {
      checking: "Checking the break, the spot and your balances…",
      "waiting-for-wallet": "Approve the refund in your wallet. Nothing is sent until you do.",
      confirming: "Sent. Waiting for the network to confirm it…",
    } as const;
    for (const [step, words] of Object.entries(steps)) {
      const { html, found } = view({ status: "running", step: step as keyof typeof steps, address: ADDRESS, breakNumber: 3, index: 1 });
      expect(text(html)).toContain("Refunding spot #2 of break #3.");
      expect(text(html)).toContain(words);
      expect(html).toContain('role="status"');
      expect(found).toEqual([]);
    }
  });

  it("says a refund is done by the amount, the wallet and the spot, and whether the page already shows it", () => {
    const done: RefundResult = { kind: "refunded", signature: SIGNATURE, amount: 20_000_000n, opened: false };
    const early = view(finished(done));
    expect(text(early.html)).toContain(`Refunded. $20 is back in the USDC account of ${SHORT} for spot #1 of break #3.`);
    expect(text(early.html)).toContain("The chain is still finalizing it; the list below updates in a few seconds.");
    expect(early.html).toContain('role="status"');
    const later = view(finished(done, true));
    expect(text(later.html)).toContain("The list below now shows it as refunded.");
    expect(text(later.html)).not.toContain("still finalizing");
  });

  it("says when the refund opened the wallet's USDC account first, and only then", () => {
    const opened = text(view(finished({ kind: "refunded", signature: SIGNATURE, amount: 20_000_000n, opened: true })).html);
    expect(opened).toContain(`Refunded. $20 is back in the USDC account of ${SHORT} for spot #1 of break #3.`);
    expect(opened).toContain("The wallet had no USDC account, so this refund opened one first. The SOL paid for its rent stays in that account, which is the wallet's.");
    expect(text(view(finished({ kind: "refunded", signature: SIGNATURE, amount: 20_000_000n, opened: false })).html)).not.toContain("opened one");
  });

  it("links the transaction on the devnet explorer, and never from text that is not a signature", () => {
    const html = view(finished({ kind: "refunded", signature: SIGNATURE, amount: 1n, opened: false })).html;
    expect(html).toContain(`<a href="https://explorer.solana.com/tx/${SIGNATURE}?cluster=devnet" target="_blank" rel="noopener noreferrer">`);
    for (const signature of ["", "abc", `${"5".repeat(70)}"><script>`, "javascript:alert(1)", "0".repeat(87)]) {
      const bad = view(finished({ kind: "failed", signature, reason: "x" })).html;
      expect(bad, signature).not.toContain("<a ");
    }
  });

  it("says a refusal came before the wallet was asked", () => {
    const { html } = view(finished({ kind: "refused", reason: "This spot was already refunded." }));
    expect(text(html)).toContain("Not refunded. This spot was already refunded.");
    expect(text(html)).toContain("Your wallet was not asked to sign anything.");
    expect(html).toContain('role="alert"');
  });

  it("does not say 'not refunded' when the wallet may have sent it", () => {
    const { html } = view(finished({ kind: "declined", reason: "Pretend did not send the transaction: closed. If you approved it, check your wallet's history before trying again." }));
    expect(text(html)).toContain("The wallet did not confirm sending it. Pretend did not send the transaction: closed. If you approved it, check your wallet's history before trying again.");
    expect(text(html)).not.toContain("Not refunded");
    expect(text(html)).not.toContain("No USDC was moved");
  });

  it("says a network failure refunded nothing and moved no USDC, with the transaction to look at", () => {
    const { html } = view(finished({ kind: "failed", signature: SIGNATURE, reason: "This spot was already refunded." }));
    expect(text(html)).toContain("Not refunded. This spot was already refunded.");
    expect(text(html)).toContain("No USDC was moved by this attempt.");
    expect(html).toContain("explorer.solana.com");
  });

  it("does not claim either way when the network has not answered", () => {
    const { html } = view(finished({ kind: "unconfirmed", signature: SIGNATURE, reason: "The network has not confirmed the transaction yet. It may still land." }));
    expect(text(html)).toContain("Not confirmed yet. The network has not confirmed the transaction yet. It may still land.");
    expect(text(html)).not.toContain("No USDC was moved");
    expect(text(html)).not.toContain("Refunded.");
    expect(html).toContain("explorer.solana.com");
  });

  it("closes a result with the dismiss handler, whatever the result", () => {
    for (const result of [
      { kind: "refunded", signature: SIGNATURE, amount: 1n, opened: false },
      { kind: "refused", reason: "x" },
      { kind: "declined", reason: "x" },
      { kind: "failed", signature: SIGNATURE, reason: "x" },
      { kind: "unconfirmed", signature: SIGNATURE, reason: "x" },
    ] as const) {
      const onDismiss = vi.fn();
      const { found } = view(finished(result), onDismiss);
      expect(found.map((b) => b.text), result.kind).toEqual(["Close"]);
      found[0]?.onClick?.();
      expect(onDismiss, result.kind).toHaveBeenCalledOnce();
    }
  });

  it("shows words from a wallet and the network as text, never as markup", () => {
    const evil = '<img src=x onerror=alert(1)> & "quotes"';
    for (const r of [
      { kind: "refused", reason: evil },
      { kind: "declined", reason: evil },
      { kind: "failed", signature: SIGNATURE, reason: evil },
      { kind: "unconfirmed", signature: SIGNATURE, reason: evil },
    ] as const) {
      const html = view(finished(r)).html;
      expect(html, r.kind).not.toContain("<img");
      expect(text(html), r.kind).toContain(evil);
    }
  });
});
