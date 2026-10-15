import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MySpotsView } from "../app/me/rows";
import { decodeBreak } from "../lib/chain/accounts";
import type { Mine, MyFreeWin, MySpot } from "../lib/chain/mine";
import { type BreakFields, breakFieldsFromVector, encodeBreak } from "./support/accounts";
import { fill } from "./support/wallet";

const vectors: { cases: { name: string; outputs?: Record<string, any> | null }[] } = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "programs", "breaks", "instruction-vectors.json"), "utf8"),
);
const SAMPLE = breakFieldsFromVector(vectors.cases.find((c) => c.name === "breaks.account.Break")?.outputs as Record<string, any>);
const NOW = 1_800_030_000;

const brk = (id: number, over: Partial<BreakFields> = {}) => decodeBreak(encodeBreak({ ...SAMPLE, id: BigInt(id), status: "Drawn", freeWinnerCount: 0, freeWinners: [], ...over }));
const spot = (breakNumber: number, index: number, over: Partial<MySpot> & { status?: BreakFields["status"] } = {}): MySpot => ({
  breakNumber,
  index,
  paid: 20_000_000n,
  refunded: false,
  break: brk(breakNumber - 1, over.status ? { status: over.status } : {}),
  ...(({ status: _s, ...rest }) => rest)(over),
});
const win = (breakNumber: number, position: number, weight = 250n): MyFreeWin => ({
  breakNumber,
  position,
  weight,
  break: brk(breakNumber - 1, { freeSpots: 3, eligibilityTotalWeight: 1000n }),
});
const mine = (over: Partial<Mine> = {}): Mine => ({ spots: [], truncated: false, freeWins: [], searched: 5, totalBreaks: 5, ...over });
const render = (m: Mine) => renderToStaticMarkup(createElement(MySpotsView, { mine: m, now: NOW }));
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

describe("the page of a wallet's spots", () => {
  it("says so when the wallet has nothing, and shows no tables", () => {
    const html = render(mine());
    expect(text(html)).toContain("This wallet has no paid spots in any break.");
    expect(html).not.toContain("<table");
    expect(text(html)).toContain("Cards and their delivery are not on chain, so they are not shown here.");
  });

  it("counts the spots and the breaks they are in, in the singular and the plural", () => {
    expect(text(render(mine({ spots: [spot(3, 0)] })))).toContain("This wallet has 1 paid spot in 1 break.");
    expect(text(render(mine({ spots: [spot(3, 0), spot(3, 1), spot(2, 4)] })))).toContain("This wallet has 3 paid spots in 2 breaks.");
  });

  it("lists each paid spot with its break (a link), its number from 1, what was paid and where it stands", () => {
    const html = render(mine({ spots: [spot(3, 0, { status: "Open" }), spot(2, 4, { paid: 15_500_000n, status: "Funded" }), spot(1, 0)] }));
    const rows = [...html.matchAll(/<tr><th scope="row"><a href="([^"]*)">([^<]*)<\/a><\/th><td class="num">([^<]*)<\/td><td><span class="badge ([a-z]+)">([^<]*)<\/span><\/td><\/tr>/g)].map((m) => m.slice(1));
    expect(rows).toEqual([
      ["/breaks/3", "Break #3", "#1 ($20)", "waiting", "Sale over, closing"],
      ["/breaks/2", "Break #2", "#5 ($15.50)", "waiting", "Packs paid for"],
      ["/breaks/1", "Break #1", "#1 ($20)", "done", "Drawn"],
    ]);
    expect(html).toContain('aria-label="Paid spots"');
    expect(html).toContain('tabindex="0"');
  });

  it("marks a refunded spot and a refundable one, and explains the refund only when one is waiting", () => {
    const refunded = spot(2, 0, { status: "Cancelled", refunded: true });
    const refundable = spot(3, 0, { status: "Cancelled" });
    const html = render(mine({ spots: [refundable, refunded] }));
    expect(html).toContain('<span class="badge waiting">Cancelled: can be refunded</span>');
    expect(html).toContain('<span class="badge off">Refunded</span>');
    expect(text(html)).toContain("A cancelled break's spots are paid back to the wallet that bought them. Anyone can send the refund; this site cannot send it yet.");
    expect(text(render(mine({ spots: [refunded] })))).not.toContain("paid back to the wallet");
    expect(text(render(mine({ spots: [spot(3, 0)] })))).not.toContain("paid back to the wallet");
  });

  it("lists the free spots won, with the place in the draw, the share of the list and where the break stands", () => {
    const html = render(mine({ spots: [spot(3, 0)], freeWins: [win(5, 2), win(4, 1, 1000n)] }));
    expect(text(html)).toContain("This wallet has 1 paid spot in 1 break. It won 2 free spots.");
    const rows = [...html.matchAll(/<tr><th scope="row"><a href="([^"]*)">([^<]*)<\/a><\/th><td>([^<]*)<\/td><td><span class="badge ([a-z]+)">([^<]*)<\/span><\/td><\/tr>/g)].map((m) => m.slice(1));
    expect(rows.slice(-2)).toEqual([
      ["/breaks/5", "Break #5", "2 of 3 (25% of the list)", "done", "Drawn"],
      ["/breaks/4", "Break #4", "1 of 3 (100% of the list)", "done", "Drawn"],
    ]);
    expect(html).toContain('aria-label="Free spots won"');
  });

  it("says a single free win in the singular, and shows the free table without paid spots", () => {
    const html = render(mine({ freeWins: [win(5, 1)] }));
    expect(text(html)).toContain("This wallet has no paid spots in any break. It won 1 free spot.");
    expect(html).not.toContain('aria-label="Paid spots"');
    expect(html).toContain('aria-label="Free spots won"');
  });

  it("says how far the search for free spots went, only when it did not reach every break", () => {
    expect(text(render(mine({ searched: 50, totalBreaks: 120 })))).toContain("Free spots are looked for in the newest 50 of 120 breaks.");
    expect(text(render(mine({ searched: 5, totalBreaks: 5 })))).not.toContain("Free spots are looked for");
  });

  it("says when only the newest spots are shown", () => {
    expect(text(render(mine({ spots: [spot(3, 0)], truncated: true })))).toContain("Only the newest spots are shown.");
    expect(text(render(mine({ spots: [spot(3, 0)] })))).not.toContain("Only the newest spots are shown.");
  });
});
