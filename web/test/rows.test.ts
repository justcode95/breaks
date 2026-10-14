import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BreakRows, LatestSummary } from "../app/breaks/rows";
import { decodeBreak } from "../lib/chain/accounts";
import type { BreakRow } from "../lib/chain/list";
import { stageLabel } from "../lib/chain/view";
import { type BreakFields, breakFieldsFromVector, encodeBreak } from "./support/accounts";

const vectors: { cases: { name: string; outputs: Record<string, any> | null }[] } = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "programs", "breaks", "instruction-vectors.json"), "utf8"),
);
const SAMPLE = breakFieldsFromVector(vectors.cases.find((c) => c.name === "breaks.account.Break")?.outputs as Record<string, any>);
// Sample window: 2027-01-15 08:00 to 14:00 UTC.
const CLOSES = 1_800_021_600;

const row = (number: number, over: Partial<BreakFields> = {}): BreakRow => ({ number, break: decodeBreak(encodeBreak({ ...SAMPLE, id: BigInt(number - 1), ...over })) });
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
/** Markup removed without leaving spaces, for a sentence that is cut up by links. */
const sentence = (html: string) => html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();

describe("the stage of a break in a list", () => {
  const stage = (over: Partial<BreakFields>, now = CLOSES + 10) => stageLabel(row(1, over).break, now);

  it("says where the sale or the settling stands", () => {
    expect(stage({ status: "Open" }, CLOSES - 60)).toBe("On sale");
    expect(stage({ status: "Open" })).toBe("Sale over, closing");
    expect(stage({ status: "Closed" })).toBe("Sale closed");
    expect(stage({ status: "EligibilityCommitted" })).toBe("Eligible holders committed");
    expect(stage({ status: "Funded" })).toBe("Packs paid for");
    expect(stage({ status: "PoolCommitted" })).toBe("Cards pulled and committed");
    expect(stage({ status: "RandomnessRequested" })).toBe("Randomness requested");
    expect(stage({ status: "Settled" })).toBe("Randomness received");
    expect(stage({ status: "Drawn" })).toBe("Drawn");
    expect(stage({ status: "Cancelled" })).toBe("Cancelled");
  });
});

describe("the table of breaks", () => {
  const rows = [row(3, { status: "Open", spotsSold: 4, spotPrice: 20_500_000n }), row(2, { status: "Drawn", spotsSold: 10, freeSpots: 3 }), row(1, { status: "Cancelled", spotsSold: 0 })];
  const html = renderToStaticMarkup(createElement(BreakRows, { rows, now: CLOSES - 60 }));

  it("lists the breaks in the order given, each linking to its page by number", () => {
    const links = [...html.matchAll(/<a href="([^"]+)">Break #(\d+)<\/a>/g)].map((m) => [m[1], m[2]]);
    expect(links).toEqual([["/breaks/3", "3"], ["/breaks/2", "2"], ["/breaks/1", "1"]]);
  });

  it("shows the stage, the spots, the price and when it opened", () => {
    const body = html.slice(html.indexOf("<tbody>"));
    const cells = [...body.matchAll(/<tr>(.*?)<\/tr>/g)].map((m) => text(m[1] as string));
    expect(cells).toEqual([
      "Break #3 On sale 4 of 10 2 $20.50 2027-01-15 08:00 UTC",
      "Break #2 Drawn 10 of 10 3 $20 2027-01-15 08:00 UTC",
      "Break #1 Cancelled 0 of 10 2 $20 2027-01-15 08:00 UTC",
    ]);
  });

  it("scrolls inside a labelled, keyboard-reachable box so a narrow screen does not get wider", () => {
    expect(html).toContain('<div class="scroll" role="region" aria-label="Breaks, newest first" tabindex="0"><table>');
  });

  it("colours each break's stage badge by where it is", () => {
    expect(html).toContain('<span class="badge live">On sale</span>');
    expect(html).toContain('<span class="badge done">Drawn</span>');
    expect(html).toContain('<span class="badge off">Cancelled</span>');
    const settling = renderToStaticMarkup(createElement(BreakRows, { rows: [row(4, { status: "Funded" }), row(5, { status: "Open" })], now: CLOSES + 60 }));
    expect(settling).toContain('<span class="badge waiting">Packs paid for</span>');
    expect(settling).toContain('<span class="badge waiting">Sale over, closing</span>');
  });

  it("has column headings and a caption for screen readers", () => {
    expect(html).toContain("<caption>Newest first</caption>");
    expect((html.match(/<th scope="col">/g) ?? []).length).toBe(6);
    expect((html.match(/<th scope="row">/g) ?? []).length).toBe(3);
  });
});

describe("the latest break on the home page", () => {
  const summary = (latest: BreakRow | undefined, total: number) => text(renderToStaticMarkup(createElement(LatestSummary, { latest, total, now: CLOSES - 60 })));

  it("says there is no break yet", () => {
    expect(summary(undefined, 0)).toBe("No break has been made yet. The first one opens by itself when the reserve can pay for it.");
  });

  it("describes the newest break and links to it", () => {
    const html = renderToStaticMarkup(createElement(LatestSummary, { latest: row(5, { status: "Open", spotsSold: 4 }), total: 5, now: CLOSES - 60 }));
    expect(html).toContain('<a href="/breaks/5"><strong>Break #5</strong></a><span class="badge live">On sale</span>');
    const paragraphs = [...html.matchAll(/<p>(.*?)<\/p>/g)].map((m) => sentence(m[1] as string));
    expect(paragraphs).toEqual(["Break #5On sale", "4 of 10 paid spots sold at $20, plus 2 free spots for holders. All 5 breaks"]);
    expect(html).toContain('<a href="/breaks">All 5 breaks</a>');
  });

  it("only offers the full list when there is more than one break, and reads one free spot in the singular", () => {
    const one = renderToStaticMarkup(createElement(LatestSummary, { latest: row(1, { freeSpots: 1 }), total: 1, now: CLOSES }));
    expect(one).not.toContain('href="/breaks"');
    expect(sentence(one)).toContain("plus 1 free spot for holders.");
  });
});
