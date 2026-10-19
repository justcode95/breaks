import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { StandingsView, chanceText, freeSpotText, standingText } from "../app/me/standing-view";
import { type BreakAccount, decodeBreak } from "../lib/chain/accounts";
import type { BreakRow } from "../lib/chain/list";
import { fromHex } from "../lib/draw/bytes";
import { type BreakStanding, STANDING_BREAKS, freeSpotOf, lastMinimum, loadStandings, standingOf, standingsKey } from "../lib/standing";
import { type EligibilityRecord, listProblem, parseRecord } from "../lib/twab/record";
import { type BreakFields, breakFieldsFromVector, encodeBreak } from "./support/accounts";
import { buttons } from "./support/tree";
import { fill } from "./support/wallet";

// The keeper's golden record (keeper/test/publish.test.ts makes and pins it): six wallets on the list (total weight 130), and one
// wallet for each reason a wallet is out.
const EXAMPLE = join(import.meta.dirname, "..", "..", "docs", "published-example");
const file = (folder: string) => {
  const [name] = readdirSync(join(EXAMPLE, folder));
  return { name: name as string, text: readFileSync(join(EXAMPLE, folder, name as string), "utf8") };
};
const RECORD = file("records");
const LEDGER = JSON.parse(file("ledger").text) as { spots: { kind: string; index: number; wallet: string }[] };
const ROOT = file("eligibility").name.replace(".json", "");
const INPUTS_HASH = RECORD.name.replace(".json", "");
const WINDOW = { start: 1_800_000_000n, end: 1_800_043_200n };

const doc = JSON.parse(RECORD.text) as { wallets: { wallet: string; twab: string; weight: string; reason: string | null }[] };
const walletWith = (reason: string | null, twab?: string) => doc.wallets.find((w) => w.reason === reason && (twab === undefined || w.twab === twab))?.wallet as string;
const TOP = walletWith(null, "50");
const SMALL = walletWith("below_min_twab");
const EXCHANGE = walletWith("excluded:exchange");
const VAULT = walletWith("off_curve");
const STRANGER = fill(9);
/** The wallets on the golden list and their weights, in the tree's order: 20, 30, 15, 10, 50 (TOP) and 5. */
const LISTED = doc.wallets.filter((w) => w.reason === null).map((w) => ({ wallet: w.wallet, weight: BigInt(w.weight) }));
/** The keeper's own draw with seed 0x5a × 32 from this list (its golden ledger): TOP first, then the wallet of weight 30. */
const SEED = new Uint8Array(32).fill(0x5a);
const [FIRST, SECOND] = LEDGER.spots.filter((s) => s.kind === "free").map((s) => s.wallet) as [string, string];
const OTHER = LISTED.find((l) => l.weight === 15n)?.wallet as string;

/** The chance by going through every order in which the free spots can be drawn. */
function exactChance(weights: readonly number[], i: number, k: number): number {
  const walk = (left: readonly number[], drawn: number): number => {
    if (drawn === k) return 0;
    const total = left.reduce((a, j) => a + (weights[j] as number), 0);
    return left.reduce((p, j) => p + ((weights[j] as number) / total) * (j === i ? 1 : walk(left.filter((x) => x !== j), drawn + 1)), 0);
  };
  return walk(
    weights.map((_, j) => j),
    0,
  );
}
const GOLDEN_WEIGHTS = LISTED.map((l) => Number(l.weight));
const chanceOf = (wallet: string, k = 2) => exactChance(GOLDEN_WEIGHTS, LISTED.findIndex((l) => l.wallet === wallet), k);

const edited = (edit: (d: any) => void) => {
  const d = JSON.parse(RECORD.text);
  edit(d);
  return JSON.stringify(d);
};
const record = (text = RECORD.text): EligibilityRecord => {
  const r = parseRecord(text);
  if (!r.ok) throw new Error(r.errors.join(" | "));
  return r.record;
};
const rowOf = (d: any, wallet: string) => d.wallets.find((w: { wallet: string }) => w.wallet === wallet);

const vectors: { cases: { name: string; outputs?: Record<string, any> | null }[] } = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "programs", "breaks", "instruction-vectors.json"), "utf8"),
);
const SAMPLE = breakFieldsFromVector(vectors.cases.find((c) => c.name === "breaks.account.Break")?.outputs as Record<string, any>);

/** A break whose committed list is the golden record's. */
const brk = (id: number, over: Partial<BreakFields> = {}): BreakAccount =>
  decodeBreak(
    encodeBreak({
      ...SAMPLE,
      id: BigInt(id),
      status: "Funded",
      freeSpots: 2,
      eligibilityRoot: fromHex(ROOT),
      eligibilityTotalWeight: 130n,
      eligibilityCount: 6,
      eligibilityInputsHash: fromHex(INPUTS_HASH),
      opensAt: WINDOW.start,
      closesAt: WINDOW.end,
      freeWinnerCount: 0,
      freeWinners: [],
      ...over,
      ...(over.freeWinners ? { freeWinnerCount: over.freeWinners.length } : {}),
    }),
  );
const row = (number: number, over: Partial<BreakFields> = {}): BreakRow => ({ number, break: brk(number - 1, over) });
const winner = (wallet: string, weight: bigint) => ({ wallet, start: 0n, weight });

const BASE = "https://files.example/published";
/** A host serving `files` (published path → body); records it is asked for. */
function host(files: Record<string, string | { status: number } | Error> = {}) {
  const asked: string[] = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    asked.push(url);
    expect(init).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer" });
    const path = url.slice(BASE.length + 1);
    const served = files[path];
    if (served instanceof Error) throw served;
    if (served === undefined) return new Response("not found", { status: 404 });
    if (typeof served === "object") return new Response("no", { status: served.status });
    return new Response(served, { status: 200 });
  });
  return { asked, fetch: fetchFn as unknown as typeof fetch };
}
const GOLDEN = { [`records/${INPUTS_HASH}.json`]: RECORD.text };
const load = (rows: BreakRow[], owner: string, h = host(GOLDEN), cache?: Map<string, EligibilityRecord>) =>
  loadStandings({ baseUrl: BASE, fetch: h.fetch, owner, rows, ...(cache ? { cache } : {}) });
const only = async (owner: string, over: Partial<BreakFields> = {}, h = host(GOLDEN)) => {
  const [s] = await load([row(4, over)], owner, h);
  return s as BreakStanding;
};

describe("where a wallet stands in a checked record", () => {
  it("is on the list with the average balance and weight the record gives it, and its chance of a free spot", () => {
    expect(standingOf(record(), TOP, brk(3))).toEqual({
      ok: true,
      standing: { kind: "listed", twab: 50n, weight: 50n },
      free: { kind: "chance", chance: expect.closeTo(chanceOf(TOP), 9), draws: 2 },
    });
  });

  it("is out for the reason the record gives, with its average balance", () => {
    expect(standingOf(record(), SMALL, brk(3))).toEqual({ ok: true, standing: { kind: "out", twab: 2n, reason: { kind: "below-min" } } });
    expect(standingOf(record(), EXCHANGE, brk(3))).toEqual({ ok: true, standing: { kind: "out", twab: 1000n, reason: { kind: "excluded", code: "exchange" } } });
    expect(standingOf(record(), VAULT, brk(3))).toEqual({ ok: true, standing: { kind: "out", twab: 7n, reason: { kind: "off-curve" } } });
  });

  it("is absent when the record does not have the wallet at all", () => {
    expect(standingOf(record(), STRANGER, brk(3))).toEqual({ ok: true, standing: { kind: "absent" } });
  });

  it("is refused when the wallet's own line does not follow from the record's rules", () => {
    const listedBelow = record(edited((d) => (rowOf(d, SMALL).reason = null)));
    expect(standingOf(listedBelow, SMALL, brk(3))).toEqual({ ok: false, problem: `${SMALL} is on the list with an average balance of 2, below the minimum of 3` });
    const wrongWeight = record(edited((d) => (rowOf(d, TOP).weight = "49")));
    expect(standingOf(wrongWeight, TOP, brk(3))).toEqual({ ok: false, problem: `${TOP} is on the list with weight 49, but the rules give 50 for an average balance of 50` });
    const vaultListed = record(edited((d) => (rowOf(d, VAULT).reason = null)));
    expect(standingOf(vaultListed, VAULT, brk(3))).toMatchObject({ ok: false, problem: `${VAULT} is on the list, but it is a program's account (off the curve), which can never be a holder` });
    const outWithWeight = record(edited((d) => (rowOf(d, EXCHANGE).weight = "1")));
    expect(standingOf(outWithWeight, EXCHANGE, brk(3))).toEqual({ ok: false, problem: `${EXCHANGE} is not on the list but has weight 1` });
    // Another wallet's line is not this wallet's business here (the verify page checks the whole record).
    expect(standingOf(wrongWeight, SMALL, brk(3))).toMatchObject({ ok: true });
  });

  it("works out the chance over the wallets the list puts on it, whatever other lines say", () => {
    // Another wallet's line does not follow the rules (an excluded wallet with a weight, a wallet below the minimum on the list
    // with no weight): the list still builds the committed root, and the chance is over the same six wallets.
    const loose = record(
      edited((d) => {
        rowOf(d, EXCHANGE).weight = "1";
        rowOf(d, SMALL).reason = null;
      }),
    );
    expect(listProblem(loose)).toBeUndefined();
    expect(standingOf(loose, TOP, brk(3))).toEqual(standingOf(record(), TOP, brk(3)));
    expect(standingOf(loose, TOP, brk(3))).toMatchObject({ ok: true, free: { kind: "chance", chance: expect.closeTo(chanceOf(TOP), 9) } });
  });

  it("must agree with the winners the chain recorded", () => {
    expect(standingOf(record(), TOP, brk(3, { status: "Drawn", freeWinners: [winner(fill(8), 20n), winner(TOP, 50n)] }))).toEqual({
      ok: true,
      standing: { kind: "listed", twab: 50n, weight: 50n },
      free: { kind: "won", position: 2 },
    });
    expect(standingOf(record(), SMALL, brk(3, { status: "Drawn", freeWinners: [winner(SMALL, 2n)] }))).toEqual({
      ok: false,
      problem: "the chain recorded this wallet as a free-spot winner, but the record does not put it on the list",
    });
    expect(standingOf(record(), STRANGER, brk(3, { status: "Drawn", freeWinners: [winner(STRANGER, 5n)] }))).toEqual({
      ok: false,
      problem: "the chain recorded this wallet as a free-spot winner, but the record does not have it",
    });
    expect(standingOf(record(), TOP, brk(3, { status: "Drawn", freeWinners: [winner(TOP, 49n)] }))).toEqual({
      ok: false,
      problem: "the chain recorded this wallet as a winner with weight 49, but the record gives it 50",
    });
  });
});

describe("what the draw did or will do for a wallet on the list", () => {
  const free = (wallet: string, over: Partial<BreakFields> = {}) => freeSpotOf(brk(3, over), wallet, LISTED);

  it("is a win at its place in the draw once it is recorded, whatever the stage", () => {
    expect(free(TOP, { status: "Settled", seed: SEED, freeWinners: [{ wallet: TOP, start: 75n, weight: 50n }] })).toEqual({ ok: true, free: { kind: "won", position: 1 } });
    expect(free(TOP, { status: "Drawn", freeWinners: [winner(fill(8), 20n), winner(TOP, 50n)] })).toEqual({ ok: true, free: { kind: "won", position: 2 } });
  });

  it("is not drawn once the break is drawn without it", () => {
    expect(free(TOP, { status: "Drawn" })).toEqual({ ok: true, free: { kind: "not-drawn", recorded: true } });
    expect(free(TOP, { status: "Drawn", eligibilityCount: 2, freeSpots: 2 })).toEqual({ ok: true, free: { kind: "not-drawn", recorded: true } });
  });

  it("is nothing to win in a break without free spots, at any stage", () => {
    for (const status of ["EligibilityCommitted", "Funded", "Settled", "Drawn"] as const) {
      expect(free(TOP, { status, freeSpots: 0 }), status).toEqual({ ok: true, free: { kind: "none" } });
    }
  });

  it("is one for everyone when the list has no more wallets than free spots, until the break is drawn", () => {
    for (const status of ["EligibilityCommitted", "Funded", "PoolCommitted", "RandomnessRequested", "Settled"] as const) {
      expect(free(TOP, { status, seed: SEED, freeSpots: 6 }), status).toEqual({ ok: true, free: { kind: "everyone" } });
      expect(free(TOP, { status, seed: SEED, freeSpots: 7 }), status).toEqual({ ok: true, free: { kind: "everyone" } });
    }
    // Once the seed is final, the winners are recorded in the draw's order, the first of them already a win.
    const first = { wallet: FIRST, start: 75n, weight: 50n };
    expect(free(FIRST, { status: "Settled", seed: SEED, freeSpots: 6, freeWinners: [first] })).toEqual({ ok: true, free: { kind: "won", position: 1 } });
    expect(free(SECOND, { status: "Settled", seed: SEED, freeSpots: 6, freeWinners: [first] })).toEqual({ ok: true, free: { kind: "everyone" } });
  });

  it("is the chance worked out from the list's weights until the randomness has come", () => {
    for (const status of ["EligibilityCommitted", "Funded", "PoolCommitted", "RandomnessRequested"] as const) {
      for (const [wallet, k] of [
        [TOP, 2],
        [OTHER, 2],
        [OTHER, 3],
        [TOP, 5],
      ] as const) {
        expect(free(wallet, { status, freeSpots: k }), `${status} ${wallet} ${k}`).toEqual({
          ok: true,
          free: { kind: "chance", chance: expect.closeTo(chanceOf(wallet, k), 9), draws: k },
        });
      }
    }
    // The heaviest wallet's chance of one of two free spots is well above its share of the weight (50 of 130).
    expect(chanceOf(TOP)).toBeGreaterThan(0.6);
    expect(free(fill(8))).toEqual({ ok: false, problem: "this wallet is not among the wallets of the list" });
  });

  it("is the keeper's own draw once the seed is final, before the winners are recorded", () => {
    const settled = { status: "Settled" as const, seed: SEED };
    expect(FIRST).toBe(TOP);
    expect(free(FIRST, settled)).toEqual({ ok: true, free: { kind: "wins", position: 1 } });
    expect(free(SECOND, settled)).toEqual({ ok: true, free: { kind: "wins", position: 2 } });
    expect(free(OTHER, settled)).toEqual({ ok: true, free: { kind: "not-drawn", recorded: false } });
    // With the first winner recorded (at its range in the tree: weights 20, 30, 15 and 10 come before it), the second still wins.
    const first = { wallet: FIRST, start: 75n, weight: 50n };
    expect(free(SECOND, { ...settled, freeWinners: [first] })).toEqual({ ok: true, free: { kind: "wins", position: 2 } });
    expect(free(OTHER, { ...settled, freeWinners: [first] })).toEqual({ ok: true, free: { kind: "not-drawn", recorded: false } });
    // The seed decides: over other seeds the heaviest wallet is not always drawn first.
    const firsts = Array.from({ length: 8 }, (_, i) => free(FIRST, { status: "Settled", seed: new Uint8Array(32).fill(i) }));
    expect(firsts.filter((r) => r.ok && r.free.kind === "wins" && r.free.position === 1).length).toBeLessThan(8);
    expect(firsts.some((r) => r.ok && r.free.kind === "not-drawn")).toBe(true);
  });

  it("refuses to say when the winners recorded on the break are not the draw's, even to a recorded winner, even when all win", () => {
    const settled = { status: "Settled" as const, seed: SEED };
    const wrong = [{ wallet: SECOND, start: 20n, weight: 30n }];
    const problem = `the chain recorded free-spot winner #1 as ${SECOND}, but this page's draw from the seed and the list gives ${FIRST}`;
    expect(free(SECOND, { ...settled, freeWinners: wrong })).toEqual({ ok: false, problem });
    expect(free(SECOND, { ...settled, freeSpots: 6, freeWinners: wrong })).toEqual({ ok: false, problem });
    expect(free(OTHER, { ...settled, freeWinners: [{ wallet: SECOND, start: 20n, weight: 30n }] })).toEqual({
      ok: false,
      problem: `the chain recorded free-spot winner #1 as ${SECOND}, but this page's draw from the seed and the list gives ${FIRST}`,
    });
    // Another wallet at the right place with the right weight, the right wallet at the wrong place, or with the wrong weight.
    expect(free(OTHER, { ...settled, freeWinners: [{ wallet: SECOND, start: 75n, weight: 50n }] })).toEqual({
      ok: false,
      problem: `the chain recorded free-spot winner #1 as ${SECOND}, but this page's draw from the seed and the list gives ${FIRST}`,
    });
    expect(free(OTHER, { ...settled, freeWinners: [{ wallet: FIRST, start: 74n, weight: 50n }] })).toMatchObject({ ok: false });
    expect(free(OTHER, { ...settled, freeWinners: [{ wallet: FIRST, start: 75n, weight: 51n }] })).toMatchObject({ ok: false });
    // More winners recorded than there are free spots.
    const both = [
      { wallet: FIRST, start: 75n, weight: 50n },
      { wallet: SECOND, start: 20n, weight: 30n },
    ];
    expect(free(OTHER, { ...settled, freeSpots: 1, freeWinners: both })).toEqual({
      ok: false,
      problem: `the chain recorded free-spot winner #2 as ${SECOND}, but this page's draw from the seed and the list gives nobody`,
    });
  });
});

describe("the standings of the newest breaks", () => {
  it("looks at the newest ten breaks that are not cancelled, newest first", async () => {
    expect(STANDING_BREAKS).toBe(10);
    const rows = Array.from({ length: 14 }, (_, i) => row(14 - i, i === 1 || i === 3 ? { status: "Cancelled" } : {}));
    const got = await load(rows, TOP);
    expect(got.map((s) => s.number)).toEqual([14, 12, 10, 9, 8, 7, 6, 5, 4, 3]);
    expect(got.every((s) => s.kind === "standing")).toBe(true);
  });

  it("does not ask for a record while the sale is on or the list is being made", async () => {
    const h = host(GOLDEN);
    const got = await load([row(6, { status: "Open" }), row(5, { status: "Closed" }), row(4, { status: "Drawn" })], TOP, h);
    expect(got.map((s) => [s.number, s.kind])).toEqual([
      [6, "not-yet"],
      [5, "not-yet"],
      [4, "standing"],
    ]);
    expect(h.asked).toEqual([`${BASE}/records/${INPUTS_HASH}.json`]);
  });

  it("gives every kind of standing from the golden record", async () => {
    expect(await only(TOP)).toMatchObject({ kind: "standing", standing: { kind: "listed", twab: 50n, weight: 50n }, free: { kind: "chance", draws: 2 }, minTwab: 3n });
    expect(await only(SECOND, { status: "Settled", seed: SEED })).toMatchObject({ kind: "standing", free: { kind: "wins", position: 2 } });
    expect(await only(SMALL)).toMatchObject({ kind: "standing", standing: { kind: "out", reason: { kind: "below-min" } }, minTwab: 3n });
    expect(await only(STRANGER)).toMatchObject({ kind: "standing", standing: { kind: "absent" } });
    expect(await only(SMALL)).not.toHaveProperty("free");
    expect(await only(TOP, { status: "Drawn", freeWinners: [winner(TOP, 50n)] })).toMatchObject({ free: { kind: "won", position: 1 } });
  });

  it("says why when the record is missing, cannot be reached or is not what the chain committed", async () => {
    expect(await only(TOP, {}, host())).toMatchObject({ kind: "unavailable", why: "missing", message: "there is no such file" });
    expect(await only(TOP, {}, host({ [`records/${INPUTS_HASH}.json`]: { status: 500 } }))).toMatchObject({ kind: "unavailable", why: "unreachable", message: "the host answered 500" });
    expect(await only(TOP, {}, host({ [`records/${INPUTS_HASH}.json`]: new Error("offline") }))).toMatchObject({ kind: "unavailable", why: "unreachable", message: "could not reach the host: offline" });
    expect(await only(TOP, {}, host({ [`records/${INPUTS_HASH}.json`]: "nope" }))).toMatchObject({ kind: "unavailable", why: "invalid", message: "it is not JSON" });
    // The chain committed another total than the record states.
    expect(await only(TOP, { eligibilityTotalWeight: 131n })).toMatchObject({ kind: "unavailable", why: "invalid", message: expect.stringMatching(/not what was committed on chain$/) });
    // Measured over another window.
    expect(await only(TOP, { closesAt: WINDOW.end + 60n })).toMatchObject({ kind: "unavailable", why: "invalid", message: "it was measured over another window than the break's" });
  });

  it("does not use a record whose listed wallets do not build the committed root, whoever is asking", async () => {
    // Each line still follows the rules (an average of 49 gives a weight of 49), but the list is no longer the committed one.
    const text = edited((d) => {
      rowOf(d, TOP).twab = "49";
      rowOf(d, TOP).weight = "49";
    });
    const h = host({ [`records/${INPUTS_HASH}.json`]: text });
    for (const owner of [TOP, SMALL, STRANGER]) {
      expect(await only(owner, {}, h)).toMatchObject({ kind: "unavailable", why: "invalid", message: expect.stringMatching(/^the wallets it calls eligible build root [0-9a-f]{64} with 6 wallets and total 129, not the root /) });
    }
  });

  it("does not use a record whose listed weights add up to more than a 64-bit number", async () => {
    const big = "9223372036854775808"; // 2^63: each line is a valid u64 and follows the rules, their sum is not.
    const text = edited((d) => {
      for (const w of d.wallets.filter((w: { reason: string | null }) => w.reason === null).slice(0, 2)) (w.twab = big), (w.weight = big);
    });
    expect(listProblem(record(text))).toBe("the wallets it calls eligible cannot be built into a tree (their weights add up to more than a 64-bit number)");
    expect(await only(TOP, {}, host({ [`records/${INPUTS_HASH}.json`]: text }))).toMatchObject({ kind: "unavailable", why: "invalid", message: expect.stringMatching(/^the wallets it calls eligible cannot be built into a tree/) });
    expect(listProblem(record())).toBeUndefined();
  });

  it("says when the wallet's own line or the recorded winners do not add up", async () => {
    // Only the excluded wallet's line is wrong: the list itself still builds the committed root.
    const h = host({ [`records/${INPUTS_HASH}.json`]: edited((d) => (rowOf(d, EXCHANGE).weight = "1")) });
    expect(await only(EXCHANGE, {}, h)).toMatchObject({ kind: "unavailable", why: "problem", message: `${EXCHANGE} is not on the list but has weight 1` });
    expect(await only(SMALL, { status: "Drawn", freeWinners: [winner(SMALL, 2n)] })).toMatchObject({
      kind: "unavailable",
      why: "problem",
      message: "the chain recorded this wallet as a free-spot winner, but the record does not put it on the list",
    });
    // Once the seed is final, a recorded winner that is not the draw's is said for every wallet on the list.
    expect(await only(OTHER, { status: "Settled", seed: SEED, freeWinners: [{ wallet: SECOND, start: 20n, weight: 30n }] })).toMatchObject({
      kind: "unavailable",
      why: "problem",
      message: `the chain recorded free-spot winner #1 as ${SECOND}, but this page's draw from the seed and the list gives ${FIRST}`,
    });
  });

  it("says so when a break past its sale committed no balance-event hash, without asking the host", async () => {
    const h = host(GOLDEN);
    expect(await only(TOP, { eligibilityInputsHash: new Uint8Array(32) }, h)).toEqual(
      expect.objectContaining({ kind: "unavailable", why: "problem", message: "no balance-event hash was committed for this break, so it has no record" }),
    );
    expect(h.asked).toEqual([]);
  });

  it("keeps the records that passed every check, and asks again for the others", async () => {
    const cache = new Map<string, EligibilityRecord>();
    const good = host(GOLDEN);
    await load([row(4)], TOP, good, cache);
    await load([row(4)], SMALL, good, cache);
    expect(good.asked).toHaveLength(1);
    expect(cache.size).toBe(1);

    const missing = host();
    const empty = new Map<string, EligibilityRecord>();
    await load([row(4)], TOP, missing, empty);
    await load([row(4)], TOP, missing, empty);
    expect(missing.asked).toHaveLength(2);
    expect(empty.size).toBe(0);

    const wrong = host({ [`records/${INPUTS_HASH}.json`]: edited((d) => ((rowOf(d, TOP).twab = "49"), (rowOf(d, TOP).weight = "49"))) });
    const none = new Map<string, EligibilityRecord>();
    await load([row(4)], TOP, wrong, none);
    expect(none.size).toBe(0);
  });

  it("does not serve a kept record to a break that commits something else under the same inputs hash", async () => {
    const cache = new Map<string, EligibilityRecord>();
    const h = host(GOLDEN);
    await load([row(4)], TOP, h, cache);
    for (const over of [{ eligibilityTotalWeight: 131n }, { eligibilityCount: 7 }, { eligibilityRoot: fromHex("ee".repeat(32)) }, { opensAt: WINDOW.start + 1n }, { closesAt: WINDOW.end + 1n }]) {
      const [s] = await load([row(5, over)], TOP, h, cache);
      expect(s, Object.keys(over)[0]).toMatchObject({ kind: "unavailable", why: "invalid" });
    }
    expect(h.asked).toHaveLength(6);
  });

  it("asks for every record at once and still gives the breaks newest first", async () => {
    // Each answer waits until all three records have been asked for, so reading them one after another would never finish.
    const asked: string[] = [];
    const waiting: (() => void)[] = [];
    const barrier = (async (url: string) => {
      asked.push(url);
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
        if (waiting.length === 3) waiting.reverse().forEach((r) => r());
      });
      return new Response(RECORD.text, { status: 200 });
    }) as unknown as typeof fetch;
    const got = await loadStandings({ baseUrl: BASE, fetch: barrier, owner: TOP, rows: [row(7), row(6), row(5)] });
    expect(asked).toHaveLength(3);
    expect(got.map((s) => [s.number, s.kind])).toEqual([
      [7, "standing"],
      [6, "standing"],
      [5, "standing"],
    ]);
  });

  it("never throws, whatever the host does", async () => {
    const throwing = (async () => {
      throw new TypeError("boom");
    }) as unknown as typeof fetch;
    await expect(loadStandings({ baseUrl: BASE, fetch: throwing, owner: TOP, rows: [row(4)] })).resolves.toMatchObject([{ kind: "unavailable", why: "unreachable" }]);
  });
});

describe("the key that decides when to read again", () => {
  it("changes with the wallet, the breaks, their stage, their list and their winners, and only then", () => {
    const rows = [row(5, { status: "Settled" }), row(4)];
    const key = standingsKey(TOP, rows);
    expect(standingsKey(TOP, [row(5, { status: "Settled" }), row(4)])).toBe(key);
    expect(standingsKey(SMALL, rows)).not.toBe(key);
    expect(standingsKey(TOP, [row(6), ...rows])).not.toBe(key);
    expect(standingsKey(TOP, [row(5, { status: "Drawn" }), row(4)])).not.toBe(key);
    expect(standingsKey(TOP, [row(5, { status: "Settled", eligibilityInputsHash: fromHex("ee".repeat(32)) }), row(4)])).not.toBe(key);
    expect(standingsKey(TOP, [row(5, { status: "Settled", freeWinners: [winner(TOP, 50n)] }), row(4)])).not.toBe(key);
    // The same stages and lists for other breaks: the numbers shown would be the wrong ones.
    const zero = new Uint8Array(32);
    expect(standingsKey(TOP, [row(5, { status: "Open", eligibilityInputsHash: zero })])).not.toBe(standingsKey(TOP, [row(6, { status: "Open", eligibilityInputsHash: zero })]));
    // Something that does not decide the standings: the spots sold.
    expect(standingsKey(TOP, [row(5, { status: "Settled", spotsSold: 1 }), row(4)])).toBe(key);
  });
});

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const HOST = "files.example";
const at = (number: number, over: Partial<BreakFields>, rest: Record<string, unknown>) => ({ number, break: brk(number - 1, over), ...rest }) as BreakStanding;
const render = (standings: BreakStanding[], onRetry?: () => void) => renderToStaticMarkup(createElement(StandingsView, { standings, host: HOST, ...(onRetry ? { onRetry } : {}) }));

describe("how a standing is said", () => {
  it("in words for every kind", () => {
    const st = (standing: unknown, over: Partial<BreakFields> = {}) => standingText(at(4, over, { kind: "standing", standing, minTwab: 3n }), HOST);
    expect(st({ kind: "listed", twab: 50n, weight: 50n })).toEqual({ badge: "On the list", tone: "done", line: "Average balance 50, weight 50 (38.46% of the list)." });
    // With a cap, the weight is below the average balance, and the share is the weight's.
    expect(st({ kind: "listed", twab: 80n, weight: 50n }).line).toBe("Average balance 80, weight 50 (38.46% of the list).");
    expect(st({ kind: "out", twab: 2n, reason: { kind: "below-min" } })).toEqual({ badge: "Not on the list", tone: "off", line: "Its average balance over the sale, 2, is below the minimum of 3." });
    expect(st({ kind: "out", twab: 1000n, reason: { kind: "excluded", code: "exchange" } })).toEqual({ badge: "Not on the list", tone: "off", line: "Left out on purpose (exchange); its average balance was 1000." });
    expect(st({ kind: "out", twab: 7n, reason: { kind: "off-curve" } })).toEqual({ badge: "Not on the list", tone: "off", line: "It is a program's account (off the curve), which is never a holder." });
    expect(st({ kind: "absent" })).toEqual({ badge: "Not on the list", tone: "off", line: "This wallet held none of the token before the sale ended." });
    expect(standingText(at(4, { status: "Open" }, { kind: "not-yet" }), HOST)).toEqual({ badge: "Sale on", tone: "live", line: "The list is made from the balances over the sale, after it ends." });
    expect(standingText(at(4, { status: "Closed" }, { kind: "not-yet" }), HOST)).toEqual({ badge: "List not made yet", tone: "waiting", line: "The sale is over; the list is made from the balances over it." });
    const un = (why: string) => standingText(at(4, {}, { kind: "unavailable", why, message: "the reason" }), HOST);
    expect(un("missing")).toEqual({ badge: "Not known", tone: "waiting", line: "The record of this break's list is not published at files.example yet." });
    expect(un("unreachable").line).toBe("The record of this break's list could not be read from files.example (the reason).");
    expect(un("invalid").line).toBe("The record at files.example is not what the chain committed (the reason), so it was not used.");
    expect(un("problem").line).toBe("The record at files.example does not add up (the reason), so it was not used.");
  });

  it("for the free spot, singular and plural", () => {
    expect(freeSpotText({ kind: "won", position: 2 }, 3)).toBe("Won: #2 in the draw");
    expect(freeSpotText({ kind: "wins", position: 2 }, 3)).toBe("Wins #2 in the draw: the seed is final");
    expect(freeSpotText({ kind: "not-drawn", recorded: true }, 3)).toBe("Not drawn");
    expect(freeSpotText({ kind: "not-drawn", recorded: false }, 3)).toBe("Not drawn: the seed is final");
    expect(freeSpotText({ kind: "none" }, 0)).toBe("No free spots in this break");
    expect(freeSpotText({ kind: "everyone" }, 3)).toBe("One for each wallet on the list (3 free spots)");
    expect(freeSpotText({ kind: "everyone" }, 1)).toBe("One for each wallet on the list (1 free spot)");
    expect(freeSpotText({ kind: "chance", chance: 0.123, draws: 3 }, 3)).toBe("About 12% chance of one of the 3 free spots");
    expect(freeSpotText({ kind: "chance", chance: 0.5, draws: 1 }, 1)).toBe("About 50% chance of the free spot");
  });

  it("for a chance, to the whole percent, and never 0% or 100% for something that is neither", () => {
    expect(chanceText(0)).toBe("Less than 1%");
    expect(chanceText(0.0049999)).toBe("Less than 1%");
    expect(chanceText(0.005)).toBe("About 1%");
    expect(chanceText(0.125)).toBe("About 13%");
    expect(chanceText(0.4449)).toBe("About 44%");
    expect(chanceText(0.9949999)).toBe("About 99%");
    expect(chanceText(0.995)).toBe("More than 99%");
    expect(chanceText(1)).toBe("More than 99%");
  });
});

describe("the section on the My spots page", () => {
  const listed = at(5, { status: "Drawn", freeWinners: [winner(TOP, 50n)] }, { kind: "standing", standing: { kind: "listed", twab: 50n, weight: 50n }, free: { kind: "won", position: 1 }, minTwab: 3n });
  const out = at(4, {}, { kind: "standing", standing: { kind: "out", twab: 2n, reason: { kind: "below-min" } }, minTwab: 3n });
  const missing = at(3, {}, { kind: "unavailable", why: "missing", message: "there is no such file" });

  it("lists the breaks with where the wallet stands and its free spot", () => {
    const t = text(render([listed, out]));
    expect(t).toContain("On the free-spot lists");
    expect(t).toContain("This is where this wallet stands on the lists of the newest 2 breaks. A cancelled break gives no free spots, so it is left out.");
    expect(t).toContain("Break #5 On the list Average balance 50, weight 50 (38.46% of the list). Won: #1 in the draw");
    expect(t).toContain("Break #4 Not on the list Its average balance over the sale, 2, is below the minimum of 3. —");
    expect(render([listed])).toContain('href="/breaks/5"');
    expect(t).toContain("is the chain's word. Its average balance, and why a wallet is out, are the keeper's");
  });

  it("says it in the singular and when there is nothing to show", () => {
    expect(text(render([listed]))).toContain("This is where this wallet stands on the list of the newest break.");
    const none = text(render([]));
    expect(none).toContain("There is no break to show yet.");
    expect(none).not.toContain("This is where");
    expect(none).not.toContain("the chain's word");
  });

  it("links to the verify page and offers to read again only when a record may turn up", () => {
    const retry = vi.fn();
    const html = render([listed, missing], retry);
    expect(html).toContain('href="/verify?break=3"');
    expect(html).not.toContain('href="/verify?break=5"');
    const [button] = buttons(createElement(StandingsView, { standings: [listed, missing], host: HOST, onRetry: retry }));
    expect(button?.text).toBe("Read the lists again");
    button?.onClick?.();
    expect(retry).toHaveBeenCalledOnce();
    const unreachable = at(3, {}, { kind: "unavailable", why: "unreachable", message: "offline" });
    expect(buttons(createElement(StandingsView, { standings: [unreachable], host: HOST, onRetry: retry }))).toHaveLength(1);
    for (const why of ["invalid", "problem"]) {
      const s = at(3, {}, { kind: "unavailable", why, message: "x" });
      expect(buttons(createElement(StandingsView, { standings: [s], host: HOST, onRetry: retry })), why).toHaveLength(0);
    }
    expect(buttons(createElement(StandingsView, { standings: [listed], host: HOST, onRetry: retry }))).toHaveLength(0);
    // Only a record that says nothing about the chain's word leaves out the hint about it.
    expect(text(render([missing]))).not.toContain("the chain's word");
  });

  it("warns that a break can still be cancelled only while a listed wallet's break is not funded yet", () => {
    const chance = { kind: "chance", chance: 0.4, draws: 2 };
    const committed = (standing: unknown) => at(4, { status: "EligibilityCommitted" }, { kind: "standing", standing, free: chance, minTwab: 3n });
    const hint = "A break can still be cancelled before its packs are paid for, and then nobody gets a free spot in it.";
    expect(text(render([committed({ kind: "listed", twab: 50n, weight: 50n })]))).toContain(hint);
    expect(text(render([committed({ kind: "absent" })]))).not.toContain(hint);
    expect(text(render([at(4, { status: "Funded" }, { kind: "standing", standing: { kind: "listed", twab: 50n, weight: 50n }, free: chance, minTwab: 3n })]))).not.toContain(hint);
  });

  it("says how a chance is worked out only when one is shown, and that the seed decides only once a result comes from it", () => {
    const listedWith = (free: unknown, over: Partial<BreakFields> = {}) => at(4, { status: "Funded", ...over }, { kind: "standing", standing: { kind: "listed", twab: 50n, weight: 50n }, free, minTwab: 3n });
    const chanceHint =
      "The free spots are drawn after the cards are pulled, one at a time, each by weight among the wallets on the list not drawn yet, so a wallet gets at most one. A chance is worked out on this page from the weights on the checked list; nobody knows who wins before the randomness comes.";
    const seedHint = "Once the seed is final the winners are already decided: this page draws them itself from the seed and the checked list, while they are still being recorded on the break.";
    const html = render([listedWith({ kind: "chance", chance: 0.4, draws: 2 })]);
    const chance = text(html);
    expect(chance).toContain("About 40% chance of one of the 2 free spots");
    // The column of words keeps its words whole on a phone.
    expect(html).toContain('<td class="words">About 40% chance of one of the 2 free spots</td>');
    expect(chance).toContain(chanceHint);
    expect(chance).not.toContain(seedHint);
    for (const free of [{ kind: "wins", position: 1 }, { kind: "not-drawn", recorded: false }]) {
      const t = text(render([listedWith(free, { status: "Settled" })]));
      expect(t, free.kind).toContain(seedHint);
      expect(t, free.kind).not.toContain(chanceHint);
    }
    for (const free of [{ kind: "won", position: 1 }, { kind: "not-drawn", recorded: true }, { kind: "everyone" }, { kind: "none" }]) {
      const t = text(render([listedWith(free, { status: "Drawn" })]));
      expect(t, free.kind).not.toContain(seedHint);
      expect(t, free.kind).not.toContain(chanceHint);
    }
  });

  it("never reads a message as markup", () => {
    const html = render([at(3, {}, { kind: "unavailable", why: "problem", message: "<img src=x onerror=alert(1)>" })]);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});

describe("the last list's minimum, for the card about the wallet's tokens", () => {
  it("is the newest break whose record was read and checked, skipping the ones on sale and the ones not known", () => {
    const onSale = at(9, { status: "Open" }, { kind: "not-yet" });
    const unknown = at(8, {}, { kind: "unavailable", why: "missing", message: "there is no such file" });
    const newer = at(7, {}, { kind: "standing", standing: { kind: "absent" }, minTwab: 40n });
    const older = at(6, {}, { kind: "standing", standing: { kind: "listed", twab: 50n, weight: 50n }, minTwab: 3n });
    expect(lastMinimum([onSale, unknown, newer, older])).toEqual({ number: 7, minTwab: 40n });
    expect(lastMinimum([older, newer])).toEqual({ number: 6, minTwab: 3n });
  });

  it("is not known when no record was", () => {
    expect(lastMinimum([])).toBeUndefined();
    expect(lastMinimum([at(9, { status: "Open" }, { kind: "not-yet" }), at(8, {}, { kind: "unavailable", why: "invalid", message: "no" })])).toBeUndefined();
  });
});
