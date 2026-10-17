import { existsSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import HowItWorksPage, { metadata } from "../app/how-it-works/page";
import Home from "../app/page";
import { LINKS } from "../app/nav-links";

const html = renderToStaticMarkup(createElement(HowItWorksPage));
const text = (h: string) => h.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const body = text(html);
const APP = join(import.meta.dirname, "..", "app");

describe("the How it works page", () => {
  it("has one title, and the sections in order", () => {
    expect([...html.matchAll(/<h1[^>]*>(.*?)<\/h1>/g)].map((m) => m[1])).toEqual(["How it works"]);
    expect([...html.matchAll(/<h2[^>]*>(.*?)<\/h2>/g)].map((m) => m[1])).toEqual(["From a fee to a card", "What you can check yourself", "What you still have to trust", "Words"]);
    expect(metadata.title).toBe("How it works · BREAKS");
  });

  it("follows a fee to a card in five steps, in order, each with its own link", () => {
    const list = html.match(/<ol class="how long">(.*?)<\/ol>/s)?.[1] ?? "";
    const steps = [...list.matchAll(/<li>(.*?)<\/li>/gs)].map((m) => m[1] as string);
    expect(steps.map((s) => text(s.match(/<strong class="title">(.*?)<\/strong>/)?.[1] ?? ""))).toEqual([
      "Fees fill the reserve.",
      "A break opens when the reserve can pay for it.",
      "Paid spots and free spots.",
      "At the deadline: fix the lists, then draw.",
      "Cards go to the spots.",
    ]);
    for (const step of steps) expect([...step.matchAll(/<a /g)], text(step)).toHaveLength(1);
  });

  it("says first, and plainly, that this is a test version on devnet that is not connected to the real card service", () => {
    expect(html).toMatch(/<div class="callout" role="note">/);
    expect(body).toContain("This is a test version. It runs on Solana devnet with test money only.");
    expect(body).toContain("not connected to the real card service yet");
    expect(html.indexOf("This is a test version")).toBeLessThan(html.indexOf("From a fee to a card"));
  });

  it("describes the rules that are decided: the worst case a break must be able to pay, no team money, one pack per filled spot, and randomness only after the lists are fixed", () => {
    expect(body).toContain("every free spot plus the top-up of every paid spot, as if all of them sell");
    expect(body).toContain("No team money is put in.");
    expect(body).toContain("One pack is bought and pulled for every spot that was filled");
    expect(body).toContain("a paid spot nobody bought is simply not bought");
    expect(body).toContain("Only then is randomness requested, so nobody can know the answer before the lists are fixed.");
    expect(body).toContain("A break names its packs when it is created, from one machine or from several, and that list never changes.");
    expect(body).toContain("A break lists its packs from the cheapest to the most expensive and the first ones are the ones bought, so a break that does not fill loses its most expensive packs.");
    expect(body).toContain("If nobody joined, or the packs that would be bought are worth less than the spots cost on average, the break is cancelled before anything is bought and the spots are refunded.");
    expect(body).toContain("Anyone can send that cancellation, so such a break never waits for an admin.");
    expect(body).toContain("every paid spot can be refunded to the wallet that bought it");
  });

  it("says what is still undecided or not built, instead of describing it as done", () => {
    expect(body).toContain("the rule for very large holders is still being decided");
    expect(body).toContain("that list is meant to be public");
    expect(body).toContain("some of what is described below is designed but not built");
  });

  it("says where the ledger is and what it does not prove", () => {
    expect(body).toContain("Once a break's cards are all sent, its page shows a ledger, spot by spot");
    expect(body).toContain("with the transactions to look up yourself. A break with no ledger after its draw is a gap you can see.");
    expect(body).not.toContain("is planned");
  });

  it("names what you still have to trust: the keeper, ORAO, and who decides what is in a pack", () => {
    const trust = body.slice(body.indexOf("What you still have to trust"), body.indexOf("Words"));
    expect(trust).toContain("The chain cannot prove that the keeper really bought every pack or sent every card.");
    expect(trust).toContain("ORAO");
    expect(trust).toContain("whoever can upgrade its program");
    expect(trust).toContain("The card service's own randomness decides what is inside each pack. Ours only decides who gets which card.");
  });

  it("keeps out words that sound like a promise of returns, since the legal review is still open", () => {
    expect(body).not.toMatch(/guarantee|risk[- ]free|profit|invest|earn\b|passive|get rich|returns\b|payout|jackpot|odds/i);
    expect(body).not.toMatch(/\bprize/i);
  });

  it("links only to pages that exist", () => {
    const hrefs = [...new Set([...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1] as string))];
    expect(hrefs.sort()).toEqual(["/breaks", "/me", "/treasury", "/verify"]);
    for (const href of hrefs) expect(existsSync(join(APP, href, "page.tsx")), href).toBe(true);
  });

  it("explains the words it uses", () => {
    const terms = [...html.matchAll(/<dt>(.*?)<\/dt>/g)].map((m) => m[1]);
    expect(terms).toEqual(["Reserve", "Break", "Paid spot, free spot", "Average balance", "Fingerprint"]);
  });
});

describe("getting to the page", () => {
  it("is the first link of the navigation, and a page that exists", () => {
    expect(LINKS[0]).toEqual({ href: "/how-it-works", label: "How it works" });
    expect(existsSync(join(APP, "how-it-works", "page.tsx"))).toBe(true);
  });

  it("is offered from the home page's short version", () => {
    const home = renderToStaticMarkup(createElement(Home));
    expect(home).toContain('<a href="/how-it-works">Read the longer version</a>');
  });
});
