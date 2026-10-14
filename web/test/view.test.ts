import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BreakDetails } from "../app/breaks/[number]/details";
import { type BreakAccount, type BreakStatus, type FreeWinner, decodeBreak } from "../lib/chain/accounts";
import { breakAddress } from "../lib/chain/address";
import type { Loaded } from "../lib/chain/load";
import { duration, expectedWinners, headline, machineLabel, money, share, steps, utcTime } from "../lib/chain/view";
import { toHex } from "../lib/draw/bytes";
import { type BreakFields, breakFieldsFromVector, encodeBreak } from "./support/accounts";

const vectors: { programs: { breaks: string }; cases: { name: string; outputs: Record<string, any> | null }[] } = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "programs", "breaks", "instruction-vectors.json"), "utf8"),
);
const PROGRAM = vectors.programs.breaks;
const SAMPLE = breakFieldsFromVector(vectors.cases.find((c) => c.name === "breaks.account.Break")?.outputs as Record<string, any>);
// 2027-01-15 08:00 UTC to 14:00 UTC; the sample's seed was recorded at 16:21 (seededAt 1800030100).
const OPENS = 1_800_000_000;
const CLOSES = 1_800_021_600;

const account = (over: Partial<BreakFields> = {}): BreakAccount => decodeBreak(encodeBreak({ ...SAMPLE, ...over }));

describe("the figures on a break page", () => {
  it("writes USDC amounts as dollars", () => {
    expect(money(20_000_000n)).toBe("$20");
    expect(money(20_500_000n)).toBe("$20.50");
    expect(money(25_250_000n)).toBe("$25.25");
    expect(money(20_050_000n)).toBe("$20.05");
    expect(money(20_005_000n)).toBe("$20.005");
    expect(money(1n)).toBe("$0.000001");
    expect(money(0n)).toBe("$0");
    expect(money(1_234_567_000_000n)).toBe("$1,234,567");
  });

  it("writes times in UTC and does not throw on a time that makes no sense", () => {
    expect(utcTime(BigInt(OPENS))).toBe("2027-01-15 08:00 UTC");
    expect(utcTime(BigInt(CLOSES))).toBe("2027-01-15 14:00 UTC");
    expect(utcTime(0n)).toBe("an unknown time");
    expect(utcTime(-5n)).toBe("an unknown time");
    expect(utcTime(2n ** 62n)).toBe("an unknown time");
  });

  it("writes how long is left", () => {
    expect(duration(30)).toBe("under a minute");
    expect(duration(-100)).toBe("under a minute");
    expect(duration(60)).toBe("1m");
    expect(duration(3 * 3_600 + 12 * 60 + 59)).toBe("3h 12m");
    expect(duration(90_000)).toBe("1d 1h");
  });

  it("shows a machine label as text and anything else shortened", () => {
    const padded = new Uint8Array(32);
    padded.set(new TextEncoder().encode("Pokemon $25"));
    expect(machineLabel(padded)).toBe("Pokemon $25");
    expect(machineLabel(new Uint8Array(32).fill(0x77))).toBe("w".repeat(32));
    const raw = new Uint8Array(32).fill(0xab);
    expect(machineLabel(raw)).toBe("0xababab…abab");
    expect(machineLabel(new Uint8Array(32))).toBe("0x000000…0000");
    // A control character or a zero in the middle is not a label somebody typed.
    const control = new Uint8Array(32);
    control.set([0x41, 0x07, 0x42]);
    expect(machineLabel(control)).toBe(`0x${toHex(control).slice(0, 6)}…${toHex(control).slice(-4)}`);
    const hole = new Uint8Array(32);
    hole.set([0x41, 0x00, 0x42]);
    expect(machineLabel(hole)).toBe(`0x${toHex(hole).slice(0, 6)}…${toHex(hole).slice(-4)}`);
  });

  it("writes a wallet's share of the list", () => {
    expect(share(600n, 1200n)).toBe("50%");
    expect(share(20n, 1200n)).toBe("1.66%");
    expect(share(1n, 8n)).toBe("12.5%");
    expect(share(1n, 200n)).toBe("0.5%");
    expect(share(1n, 400n)).toBe("0.25%");
    expect(share(1n, 10_000n)).toBe("0.01%");
    expect(share(1n, 1_000_000_000n)).toBe("<0.01%");
    expect(share(0n, 100n)).toBe("0%");
    expect(share(5n, 0n)).toBe("0%");
    expect(share(100n, 100n)).toBe("100%");
    expect(share(101n, 100n)).toBe("—");
  });
});

describe("how far a break has got", () => {
  const ORDER: BreakStatus[] = ["Open", "Closed", "EligibilityCommitted", "Funded", "PoolCommitted", "RandomnessRequested", "Settled", "Drawn"];

  it("marks every step before the break's status done, that one current and the rest not yet", () => {
    ORDER.forEach((status, at) => {
      const list = steps(account({ status }), OPENS + 100);
      expect(list.map((s) => s.state), status).toEqual(ORDER.map((_, i) => (i < at ? "done" : i === at ? (status === "Drawn" ? "done" : "current") : "todo")));
      expect(list.filter((s) => s.detail !== undefined).map((s) => s.label), status).toEqual([list[at]?.label]);
    });
  });

  it("has eight steps with different words", () => {
    const labels = steps(account({ status: "Open" }), OPENS).map((s) => s.label);
    expect(labels).toHaveLength(8);
    expect(new Set(labels).size).toBe(8);
  });

  it("says when the sale closes, and that the closing time has passed", () => {
    const open = steps(account({ status: "Open" }), CLOSES - (3 * 3_600 + 12 * 60));
    expect(open[0]?.detail).toBe("Closes 2027-01-15 14:00 UTC (3h 12m left by your clock).");
    // At the closing time itself the sale is over.
    expect(steps(account({ status: "Open" }), CLOSES)[0]?.detail).toMatch(/has passed; the sale is waiting to be closed/);
    expect(steps(account({ status: "Open" }), CLOSES + 1)[0]?.detail).toMatch(/has passed/);
  });

  it("says what each later stage is waiting for", () => {
    const detail = (over: Partial<BreakFields>) => steps(account(over), CLOSES + 10).find((s) => s.detail !== undefined)?.detail;
    expect(detail({ status: "Closed" })).toBe("Waiting for the list of eligible holders to be committed.");
    expect(detail({ status: "EligibilityCommitted", eligibilityCount: 5 })).toBe("5 eligible wallets committed. Next: the packs are paid for.");
    expect(detail({ status: "EligibilityCommitted", eligibilityCount: 1 })).toBe("1 eligible wallet committed. Next: the packs are paid for.");
    expect(detail({ status: "Funded", poolSize: 10 })).toBe("10 packs are being bought and pulled.");
    expect(detail({ status: "Funded", poolSize: 1 })).toBe("1 pack is being bought and pulled.");
    expect(detail({ status: "PoolCommitted", poolSize: 10 })).toBe("10 cards are committed as the pool. Next: randomness is requested.");
    expect(detail({ status: "PoolCommitted", poolSize: 1 })).toBe("1 card is committed as the pool. Next: randomness is requested.");
    expect(detail({ status: "RandomnessRequested" })).toBe("Waiting for ORAO's answer.");
  });

  it("counts the free winners recorded so far against the ones the draw will give", () => {
    // 2 free spots but only 1 eligible wallet: one winner is all the draw can give.
    expect(expectedWinners(account({ freeSpots: 2, eligibilityCount: 1 }))).toBe(1);
    expect(expectedWinners(account({ freeSpots: 2, eligibilityCount: 5 }))).toBe(2);
    expect(expectedWinners(account({ freeSpots: 0, eligibilityCount: 5 }))).toBe(0);
    const winner = SAMPLE.freeWinners[0] as NonNullable<BreakFields["freeWinners"][0]>;
    const settled = steps(account({ status: "Settled", freeSpots: 2, eligibilityCount: 5, freeWinnerCount: 1, freeWinners: [winner] }), CLOSES);
    expect(settled[6]?.detail).toBe("Seed recorded 2027-01-15 16:21 UTC. Free winners recorded: 1 of 2.");
    expect(steps(account({ status: "Drawn" }), CLOSES)[7]?.detail).toBe("2 free winners recorded. Delivery of the cards is not shown on this page yet.");
  });

  it("shows no steps for a cancelled break, since the chain does not say how far it got", () => {
    expect(steps(account({ status: "Cancelled" }), CLOSES)).toEqual([]);
  });

  it("has a headline for each kind of break", () => {
    expect(headline(account({ status: "Open" }), CLOSES - 1)).toBe("On sale");
    expect(headline(account({ status: "Open" }), CLOSES)).toBe("Sale over, closing");
    expect(headline(account({ status: "Funded" }), CLOSES)).toBe("Being settled");
    expect(headline(account({ status: "Drawn" }), CLOSES)).toBe("Drawn");
    expect(headline(account({ status: "Cancelled" }), CLOSES)).toBe("Cancelled");
  });
});

describe("the break page", () => {
  const owners = ["E3M3d7sy8ZKivUGxBexL9wxE7ebqzGWFqkdeFMedCJFS", "E7GLmRLyircx4ZXTcxHFSpizMop3fLC5QAJJJjhDwda9", "E3M3d7sy8ZKivUGxBexL9wxE7ebqzGWFqkdeFMedCJFS"];
  const page = (over: Partial<BreakFields>, now = CLOSES + 600, notes: string[] = [], paidOwners = owners) => {
    const loaded: Loaded = { number: 8, break: account(over), paidOwners, notes };
    return renderToStaticMarkup(createElement(BreakDetails, { loaded, now, readAt: now - 90, program: PROGRAM, refresh: () => {} }));
  };
  const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

  it("shows a drawn break with everything the chain holds", () => {
    const html = page({ status: "Drawn", freeWinners: [SAMPLE.freeWinners[0] as FreeWinner, { ...(SAMPLE.freeWinners[1] as FreeWinner), weight: 600n }], eligibilityTotalWeight: 1200n });
    const t = text(html);
    expect(t).toContain("Drawn. 8 of 10 paid spots sold at $20, plus 2 free spots for holders.");
    expect(t).toContain("at most $25 each");
    expect(t).toContain("2027-01-15 08:00 UTC to 2027-01-15 14:00 UTC");
    for (const hex of [SAMPLE.eligibilityRoot, SAMPLE.poolHash, SAMPLE.seed]) expect(html).toContain(toHex(hex));
    expect(t).toContain("5 · total weight 1200");
    // Both recorded winners, with their weight and share of the list (20 of 1200 is 1.66%).
    for (const w of SAMPLE.freeWinners) expect(html).toContain(w.wallet);
    expect(t).toContain("1.66%");
    expect(t).toContain("50%");
    expect(t).toContain("Winners recorded on chain, in draw order");
    expect(html).toContain(breakAddress(PROGRAM, SAMPLE.id));
    expect(html).toContain('href="/verify?break=8"');
  });

  it("lists the paid spots in order, once each even when a wallet bought two", () => {
    const html = page({});
    const rows = [...html.matchAll(/<tr><td>(\d+)<\/td><td><code[^>]*>([1-9A-HJ-NP-Za-km-z]{32,44})<\/code><\/td><\/tr>/g)].map((m) => [m[1], m[2]]);
    expect(rows).toEqual(owners.map((o, i) => [String(i + 1), o]));
  });

  it("shows an open break as on sale, with the spots left and nothing committed yet", () => {
    const html = page({ status: "Open", spotsSold: 3, eligibilityRoot: new Uint8Array(32), eligibilityTotalWeight: 0n, eligibilityCount: 0, poolHash: new Uint8Array(32), seed: new Uint8Array(32), freeWinnerCount: 0, freeWinners: [] }, CLOSES - 7_320, [], owners);
    const t = text(html);
    expect(t).toContain("On sale. 3 of 10 paid spots sold at $20, plus 2 free spots for holders. 7 paid spots left.");
    expect(t).toContain("Closes 2027-01-15 14:00 UTC (2h 2m left by your clock).");
    expect(t).not.toContain("Committed before the draw");
    expect(t).not.toContain("Draw seed");
    expect(t).not.toContain("Pool hash");
    // There is no pool until the packs are paid for.
    expect(t).not.toContain("An unsold paid spot is not bought");
    expect(t).toContain("No winners are recorded yet.");
  });

  it("does not say 0 spots are left when the sale is full, and marks only the current step for screen readers", () => {
    const open = { status: "Open" as const, spotsSold: 10, eligibilityRoot: new Uint8Array(32), eligibilityTotalWeight: 0n, eligibilityCount: 0, poolHash: new Uint8Array(32), seed: new Uint8Array(32), freeWinnerCount: 0, freeWinners: [] };
    const full = page(open, CLOSES - 600, [], owners);
    expect(text(full)).toContain("10 of 10 paid spots sold at $20");
    expect(text(full)).not.toMatch(/paid spots? left/);
    expect(full.match(/aria-current="step"/g)).toHaveLength(1);
    expect(text(full)).toContain("Spots on sale (now)");
    expect(text(full)).toContain("Sale closed (not yet)");
    const drawn = page({ status: "Drawn" });
    expect(drawn).not.toContain("aria-current");
    expect(text(drawn)).toContain("Spots on sale (done)");
    // One spot left reads in the singular.
    expect(text(page({ ...open, spotsSold: 9 }, CLOSES - 600, [], owners))).toContain("1 paid spot left.");
  });

  it("has no paid spots table when nobody has bought a spot", () => {
    const t = text(page({ status: "Open", spotsSold: 0, freeWinnerCount: 0, freeWinners: [] }, CLOSES - 600, [], []));
    expect(t).toContain("0 of 10 paid spots sold");
    expect(t).not.toContain("Paid spots In purchase order");
  });

  it("shows the root but not a pool hash or a seed before they exist", () => {
    const t = text(page({ status: "EligibilityCommitted", poolHash: new Uint8Array(32), seed: new Uint8Array(32), freeWinnerCount: 0, freeWinners: [] }));
    expect(t).toContain("Committed before the draw");
    expect(t).toContain("Eligibility root");
    expect(t).not.toContain("Pool hash");
    expect(t).not.toContain("Draw seed");
    expect(t).not.toContain("An unsold paid spot is not bought");
    // From the moment the packs are paid for, the pool is part of the break.
    expect(text(page({ status: "Funded", poolHash: new Uint8Array(32), seed: new Uint8Array(32), freeWinnerCount: 0, freeWinners: [] }))).toContain("Pool 10 packs: the paid spots sold plus the free spots that have an eligible holder. An unsold paid spot is not bought.");
  });

  it("says the winners are being recorded only while some are still missing", () => {
    const first = SAMPLE.freeWinners.slice(0, 1);
    const partial = text(page({ status: "Settled", freeSpots: 2, eligibilityCount: 5, freeWinnerCount: 1, freeWinners: first }));
    expect(partial).toContain("The winners are being recorded one at a time.");
    expect(partial).toContain("Free winners recorded: 1 of 2.");
    // All of them recorded, or as many as there are eligible wallets: nothing is missing.
    expect(text(page({ status: "Settled", freeSpots: 2, eligibilityCount: 5 }))).not.toContain("being recorded");
    expect(text(page({ status: "Settled", freeSpots: 2, eligibilityCount: 1, freeWinnerCount: 1, freeWinners: first }))).not.toContain("being recorded");
    expect(text(page({ status: "Drawn" }))).not.toContain("being recorded");
    // Before the seed there is nothing to record yet, so the hint stays quiet.
    expect(text(page({ status: "PoolCommitted", freeSpots: 2, eligibilityCount: 5, freeWinnerCount: 0, freeWinners: [], seed: new Uint8Array(32) }))).not.toContain("being recorded");
  });

  it("shows a cancelled break as cancelled, with no progress", () => {
    const t = text(page({ status: "Cancelled", freeWinnerCount: 0, freeWinners: [] }));
    expect(t).toContain("Cancelled.");
    expect(t).toContain("This break was cancelled: nothing was drawn, and the paid spots can be refunded.");
    expect(t).not.toContain("Progress");
    expect(t).not.toContain("Free spots go to");
  });

  it("passes on the notes the loader made, and says how old the reading is", () => {
    const t = text(page({}, CLOSES + 600, ["Paid spot 2 was refunded."]));
    expect(t).toContain("Paid spot 2 was refunded.");
    expect(t).toContain("Read from the chain (finalized) 1m ago");
    expect(text(page({}, CLOSES + 600)).includes("use Refresh")).toBe(true);
  });

  it("escapes a machine label instead of reading it as markup", () => {
    const label = new Uint8Array(32);
    label.set(new TextEncoder().encode("<b>x</b>&"));
    const html = page({ packMachine: label });
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;&amp;");
    expect(html).not.toContain("<b>x</b>");
  });
});
