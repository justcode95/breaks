import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReserveCard } from "../app/reserve-card";
import type { BreakShape } from "../lib/chain/reserve";

const SHAPE: BreakShape = { paidSpots: 10, freeSpots: 2, spotPrice: 20_000_000n, maxPackPrice: 25_000_000n }; // needs $50 and $50
const treasury = (subsidy: bigint, holder: bigint) => ({ subsidy: { available: subsidy }, holder: { available: holder } }) as never;
const card = (t: ReturnType<typeof treasury>, shape: BreakShape = SHAPE) => renderToStaticMarkup(createElement(ReserveCard, { shape, treasury: t }));
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

describe("the reserve card", () => {
  it("shows the percent, a bar of that width, and says so to a screen reader", () => {
    const html = card(treasury(25_000_000n, 40_000_000n));
    expect(text(html)).toContain("50% of what the next break needs");
    expect(html).toContain('<div class="bar" role="img" aria-label="The reserve is at 50 percent of what the next break needs">');
    expect(html).toContain('<span style="width:50%"></span>');
    expect(html).toContain('aria-labelledby="reserve-title"');
    expect(html).toContain('<h2 id="reserve-title">Reserve for the next break</h2>');
  });

  it("is empty at zero and full at a hundred", () => {
    expect(card(treasury(0n, 0n))).toContain('<span style="width:0%"></span>');
    const full = card(treasury(50_000_000n, 50_000_000n));
    expect(full).toContain('<span style="width:100%"></span>');
    expect(text(full)).toContain("100% of what the next break needs");
  });

  it("says the next break opens by itself when the reserve can pay for it, and names nothing as missing", () => {
    const t = text(card(treasury(60_000_000n, 50_000_000n)));
    expect(t).toContain("The reserve can pay for the next break. It opens by itself as soon as the sale before it has ended.");
    expect(t).not.toContain("Still missing");
  });

  it("says what is still missing, per bucket, when it cannot", () => {
    expect(text(card(treasury(20_000_000n, 10_000_000n)))).toContain("The next break opens by itself once both buckets can pay for it. Still missing: $30 in the subsidy bucket and $40 in the holder bucket.");
    expect(text(card(treasury(20_000_000n, 50_000_000n)))).toContain("Still missing: $30 in the subsidy bucket.");
    expect(text(card(treasury(50_000_000n, 49_999_999n)))).toContain("Still missing: $0.000001 in the holder bucket.");
    expect(text(card(treasury(50_000_000n, 49_999_999n)))).not.toContain("subsidy bucket.");
  });

  it("is decided by the worse bucket, not the better one", () => {
    const t = card(treasury(900_000_000n, 0n));
    expect(text(t)).toContain("0% of what the next break needs");
    expect(text(t)).toContain("Still missing: $50 in the holder bucket.");
  });

  it("lists each bucket against what the break needs from it", () => {
    const html = card(treasury(12_500_000n, 50_000_000n));
    expect(text(html)).toContain("Subsidy bucket $12.50 available of $50 needed.");
    expect(text(html)).toContain("Holder bucket $50 available of $50 needed.");
  });

  it("says a bucket that is not needed is not needed, whatever it holds", () => {
    const t = text(card(treasury(0n, 25_000_000n), { ...SHAPE, spotPrice: 25_000_000n }));
    expect(t).toContain("Subsidy bucket Nothing needed from this bucket.");
    expect(t).toContain("50% of what the next break needs");
    expect(text(card(treasury(5n, 0n), { ...SHAPE, freeSpots: 0 }))).toContain("Holder bucket Nothing needed from this bucket.");
  });

  it("states the shape it is measured against, in the singular and the plural, since the site was told it and the chain was not", () => {
    expect(text(card(treasury(0n, 0n)))).toContain("Worst case for 10 paid spots at $20 and 2 free spots, with packs up to $25");
    expect(text(card(treasury(0n, 0n), { paidSpots: 1, freeSpots: 1, spotPrice: 5_000_000n, maxPackPrice: 7_500_000n }))).toContain("Worst case for 1 paid spot at $5 and 1 free spot, with packs up to $7.50");
    expect(text(card(treasury(0n, 0n)))).toContain("the subsidy bucket must be able to top up every paid spot ($50) and the holder bucket to pay a whole pack for every free spot ($50)");
    expect(text(card(treasury(0n, 0n), { ...SHAPE, spotPrice: 25_000_000n }))).toContain("top up every paid spot (nothing)");
    expect(text(card(treasury(0n, 0n)))).toContain("This is the shape the site was set up with for the next break.");
  });
});
