import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { HoldingView, minimumText, saleText } from "../app/me/holding-view";
import { decodeBreak } from "../lib/chain/accounts";
import { TOKEN_PROGRAM } from "../lib/chain/address";
import { type Holding, type SaleFloor, saleFloor } from "../lib/chain/holding";
import type { BreakRow } from "../lib/chain/list";
import { type BreakFields, breakFieldsFromVector, encodeBreak } from "./support/accounts";
import { buttons } from "./support/tree";
import { fill } from "./support/wallet";

const SAMPLE = breakFieldsFromVector(
  (JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "programs", "breaks", "instruction-vectors.json"), "utf8")) as { cases: { name: string; outputs: any }[] }).cases.find(
    (c) => c.name === "breaks.account.Break",
  )?.outputs,
);
// 2027-01-15 08:00 UTC to 14:00 UTC: a six-hour sale.
const OPENS = 1_800_000_000n;
const CLOSES = OPENS + 21_600n;
const row = (id: number, over: Partial<BreakFields> = {}): BreakRow => ({
  number: id + 1,
  break: decodeBreak(encodeBreak({ ...SAMPLE, id: BigInt(id), status: "Open", opensAt: OPENS, closesAt: CLOSES, ...over })),
});
const holding = (total: bigint, over: Partial<Holding> = {}): Holding => ({
  mint: { address: fill(31), program: TOKEN_PROGRAM, decimals: 6, supply: 10n ** 15n },
  total,
  accounts: total === 0n ? 0 : 1,
  slot: 7,
  time: Number(OPENS) + 10_800,
  ...over,
});
const M = 1_000_000n; // one token, in units
const text = (h: string) => h.replace(/<[^>]*>/g, "").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
const render = (props: Parameters<typeof HoldingView>[0]) => renderToStaticMarkup(createElement(HoldingView, props));

describe("what the card says about the sale that is on", () => {
  const h = holding(3_000_000n * M);
  const at = (rows: BreakRow[], hh: Holding = h) => saleText(saleFloor(rows, hh.total, hh.time), hh);

  it("with no sale, that a whole sale counts in full", () => {
    expect(at([row(2, { status: "Drawn" })])).toBe(
      "No sale is on right now. A sale's average balance runs from its opening to its close, so tokens held through a whole sale count in full.",
    );
  });

  it("during a sale, the least average these tokens give if they stay, and the part of the sale they count for", () => {
    expect(at([row(4)])).toBe(
      "Break #5 is on sale until 2027-01-15 14:00 UTC. If these tokens stay in this wallet until then, its average balance over the sale will be at least 1,500,000 tokens: they count for the 50% of the sale still to come, and what the wallet held earlier in the sale counts too.",
    );
    expect(at([row(4)], holding(3n * M, { time: Number(CLOSES) - 60 }))).toContain("at least 0.008333 tokens: they count for the under 1% of the sale still to come");
    expect(at([row(4)], holding(M, { time: Number(OPENS) }))).toContain("at least 1 token: they count for the 100% of the sale");
  });

  it("during a sale with nothing held, that nothing is added but the earlier part still counts", () => {
    expect(at([row(4)], holding(0n))).toBe(
      "Break #5 is on sale until 2027-01-15 14:00 UTC. This wallet holds none of the token now, so it adds nothing for the rest of the sale; what it held earlier in the sale still counts.",
    );
  });

  it("before the sale opens, that tokens held over all of it count in full", () => {
    const early = holding(2n * M, { time: Number(OPENS) - 5 });
    expect(at([row(4)], early)).toBe(
      "The sale of break #5 opens at 2027-01-15 08:00 UTC and closes at 2027-01-15 14:00 UTC. If these tokens stay in this wallet over the whole sale, its average balance over it will be at least 2 tokens.",
    );
    expect(at([row(4)], holding(0n, { time: Number(OPENS) - 5 }))).toBe(
      "The sale of break #5 opens at 2027-01-15 08:00 UTC and closes at 2027-01-15 14:00 UTC; tokens held over the whole sale count in full.",
    );
  });

  it("once the sale has closed by the chain's clock, that the list is made from it", () => {
    expect(at([row(4)], holding(M, { time: Number(CLOSES) }))).toBe("The sale of break #5 closed at 2027-01-15 14:00 UTC; its list is made from the balances over it.");
  });

  it("without the time of the balances, that it cannot say what they add", () => {
    expect(at([row(4)], holding(M, { time: null }))).toBe(
      "Break #5 is on sale, but the node could not say when these balances are from, so what they add to the sale's average is not shown.",
    );
  });
});

describe("how that compares with what the last list asked for", () => {
  const on = (total: bigint, time = Number(OPENS) + 10_800) => {
    const h = holding(total, { time });
    return { sale: saleFloor([row(4)], h.total, h.time), h };
  };
  const minimum = { number: 4, minTwab: 1_000_000n * M };

  it("says when the floor alone reaches it, down to the last unit", () => {
    const { sale, h } = on(2_000_000n * M);
    expect(minimumText(sale, h, minimum)).toBe(
      "That is enough on its own for the minimum the last list asked for (break #4: 1,000,000 tokens on average), if the next list asks the same.",
    );
    const short = on(2_000_000n * M - 2n);
    expect((short.sale as Extract<SaleFloor, { kind: "on" }>).floor).toBe(1_000_000n * M - 1n);
    expect(minimumText(short.sale, short.h, minimum)).toBe(
      "That alone is below the minimum the last list asked for (break #4: 1,000,000 tokens on average); what the wallet held earlier in this sale counts too.",
    );
  });

  it("before the sale, says only that it is below, since nothing earlier counts", () => {
    const { sale, h } = on(M, Number(OPENS) - 1);
    expect(minimumText(sale, h, minimum)).toBe("That is below the minimum the last list asked for (break #4: 1,000,000 tokens on average).");
    expect(minimumText(sale, h, { number: 4, minTwab: M })).toContain("enough on its own");
  });

  it("never calls an average of zero enough, even for a minimum of zero", () => {
    // One unit, a minute before the close: it adds less than a unit, which rounds down to nothing.
    const { sale, h } = on(1n, Number(CLOSES) - 60);
    expect((sale as Extract<SaleFloor, { kind: "on" }>).floor).toBe(0n);
    expect(minimumText(sale, h, { number: 4, minTwab: 0n })).toContain("That alone is below the minimum");
  });

  it("says when no list's minimum could be read", () => {
    const { sale, h } = on(M);
    expect(minimumText(sale, h, undefined)).toBe("The minimum average balance a list asks for is stated in each list's record; none could be read here, so it is not compared.");
  });

  it("says nothing with no sale on, a closed sale, no time, or nothing held", () => {
    const h = holding(M);
    for (const sale of [saleFloor([], h.total, h.time), saleFloor([row(4)], h.total, Number(CLOSES)), saleFloor([row(4)], h.total, null)]) {
      expect(minimumText(sale, h, minimum), sale.kind).toBeUndefined();
    }
    const none = on(0n);
    expect(minimumText(none.sale, none.h, minimum)).toBeUndefined();
  });
});

describe("the card", () => {
  it("while reading, says so and offers nothing to click", () => {
    const html = render({ view: { state: "loading" }, rows: [], onRetry: () => {} });
    expect(html).toBe('<section class="card"><h2>This wallet&#x27;s tokens</h2><p>Reading this wallet&#x27;s tokens…</p></section>');
    expect(buttons(createElement(HoldingView, { view: { state: "loading" }, rows: [], onRetry: () => {} }))).toHaveLength(0);
  });

  it("shows a failure as text, never markup, and offers to read again", () => {
    const retry = vi.fn();
    const view = { state: "error" as const, message: "The node <b>refused</b>." };
    const html = render({ view, rows: [], onRetry: retry });
    expect(html).toContain('<p class="problem">The node &lt;b&gt;refused&lt;/b&gt;.</p>');
    const [button] = buttons(createElement(HoldingView, { view, rows: [], onRetry: retry }));
    expect(button?.text).toBe("Read the balance again");
    button?.onClick?.();
    expect(retry).toHaveBeenCalledOnce();
  });

  it("during a sale: the balance, what it gives, the comparison, when it was read, the units and that it is a floor", () => {
    const html = render({ view: { state: "loaded", holding: { ...holding(2_500_000n * M + 500_000n), accounts: 2 } }, rows: [row(4)], minimum: { number: 4, minTwab: 1_000_000n * M }, onRetry: () => {} });
    expect(html).toContain('<strong class="num">2,500,000.5 tokens</strong>, in 2 token accounts.');
    const body = text(html);
    expect(body).toContain("its average balance over the sale will be at least 1,250,000.25 tokens");
    expect(body).toContain("That is enough on its own for the minimum the last list asked for (break #4: 1,000,000 tokens on average)");
    expect(body).toContain("Read from the chain (finalized) as it stood at 2027-01-15 11:00 UTC.");
    expect(body).toContain("Amounts here are in whole tokens; the lists below count in the token's smallest units, 1,000,000 to a token.");
    expect(body).toContain("This is a floor, not a forecast: the keeper works each wallet's average out from every balance change during the sale, which this page does not read, and a wallet it leaves out on purpose is not on the list whatever it holds.");
    expect(body.endsWith("Read the balance again")).toBe(true);
  });

  it("before the sale opens, warns that the figure is a floor too", () => {
    const body = text(render({ view: { state: "loaded", holding: holding(M, { time: Number(OPENS) - 5 }) }, rows: [row(4)] }));
    expect(body).toContain("will be at least 1 token.");
    expect(body).toContain("This is a floor, not a forecast");
  });

  it("with one token account and one token, says it in the singular, and with no sale on, gives no floor and no warning about it", () => {
    const body = text(render({ view: { state: "loaded", holding: holding(M) }, rows: [] }));
    expect(body).toContain("1 token, in 1 token account.");
    expect(body).not.toContain("a floor, not a forecast");
    expect(text(render({ view: { state: "loaded", holding: holding(M, { time: Number(CLOSES) }) }, rows: [row(4)] }))).not.toContain("a floor, not a forecast");
  });

  it("with nothing held and no sale, says both and leaves out the floor's warning", () => {
    const body = text(render({ view: { state: "loaded", holding: holding(0n, { time: null }) }, rows: [] }));
    expect(body).toContain("This wallet holds none of the token.");
    expect(body).toContain("No sale is on right now.");
    expect(body).toContain("Read from the chain (finalized).");
    expect(body).not.toContain("as it stood at");
    expect(body).not.toContain("a floor, not a forecast");
    expect(body).not.toContain("minimum");
  });

  it("for a token without smaller units, says the lists count in whole tokens too", () => {
    const h = holding(5n);
    const body = text(render({ view: { state: "loaded", holding: { ...h, mint: { ...h.mint, decimals: 0 } } }, rows: [] }));
    expect(body).toContain("5 tokens, in 1 token account.");
    expect(body).toContain("The token has no smaller unit, so the lists below count in whole tokens too.");
  });

  it("has no button without something to call", () => {
    expect(buttons(createElement(HoldingView, { view: { state: "loaded", holding: holding(M) }, rows: [] }))).toHaveLength(0);
  });
});
