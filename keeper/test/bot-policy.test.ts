import { describe, expect, it } from "vitest";
import { type BotSettings, type World, desiredPosts } from "../src/bot/policy.js";
import type { BreakAccount } from "../src/solana/breaks.js";
import { HOUR, T0, brk } from "./support/bot.js";
import { addr } from "./support/chain.js";

const SETTINGS: BotSettings = { milestones: [25, 50, 75], reminderHours: [3, 1], finalityMarginSecs: 120 };

/** `secs` after the break opened. */
const at = (secs: bigint): Date => new Date(Number(T0 + secs) * 1000);

function world(over: Partial<World> = {}): World {
  return { now: at(0n), breaks: [], handles: new Map(), delivered: [], keys: new Set(), ...over };
}

const kinds = (w: World, s: BotSettings = SETTINGS) => desiredPosts(w, s).map((d) => d.dedupeKey);

describe("the sale", () => {
  it("announces a break that is live, once, until the sale ends", () => {
    const [d] = desiredPosts(world({ breaks: [brk()] }), SETTINGS);
    expect(d).toMatchObject({ kind: "open", breakId: 4n, dedupeKey: "open:4" });
    expect(d?.body).toBe("Break #5 is LIVE — 10 paid spots @ $20 + 2 FREE holder spots. Packs: pokemon-25. Closes Jan 15, 20:00 UTC.");
    expect(d?.validUntil).toEqual(at(12n * HOUR));
  });

  it("announces nothing for a sale that is over, closed, cancelled, or a break that is further along", () => {
    for (const status of ["Closed", "EligibilityCommitted", "Funded", "PoolCommitted", "RandomnessRequested", "Settled", "Cancelled"] as const) {
      expect(kinds(world({ breaks: [brk({ status })] })), status).toEqual([]);
    }
    // Still "Open" on chain after the deadline until someone closes it: the sale is over all the same.
    expect(kinds(world({ breaks: [brk()], now: at(12n * HOUR) }))).toEqual([]);
    expect(kinds(world({ breaks: [brk()], now: at(13n * HOUR) }))).toEqual([]);
  });

  it("does not ask twice: the dedupe key is the same on every look", () => {
    expect(kinds(world({ breaks: [brk()], now: at(HOUR) }))).toEqual(kinds(world({ breaks: [brk()], now: at(2n * HOUR) })));
  });
});

describe("spots left", () => {
  const remind = (secsLeft: bigint, over: Partial<BreakAccount> = {}, settings = SETTINGS) =>
    desiredPosts(world({ breaks: [brk(over)], now: at(12n * HOUR - secsLeft) }), settings).filter((d) => d.kind === "reminder");

  it("reminds at the first threshold passed, with the spots left and the time left", () => {
    expect(remind(4n * HOUR + 1n)).toEqual([]);
    const [r] = remind(3n * HOUR);
    expect(r).toMatchObject({ dedupeKey: "reminder:4:3", validUntil: at(12n * HOUR) });
    expect(r?.body).toBe("7 spots left in Break #5. Closes in 3h.");
    expect(remind(2n * HOUR + 1800n)[0]?.dedupeKey).toBe("reminder:4:3");
  });

  it("moves to the next threshold when it is passed, and only the nearest one when the bot was off", () => {
    expect(remind(HOUR)[0]?.dedupeKey).toBe("reminder:4:1");
    expect(remind(1800n)[0]).toMatchObject({ dedupeKey: "reminder:4:1" });
    expect(remind(1800n)[0]?.body).toBe("7 spots left in Break #5. Closes in 30 min.");
    // Between the two: still the 3 hour one.
    expect(remind(HOUR + 1n)[0]?.dedupeKey).toBe("reminder:4:3");
  });

  it("says nothing when the sale is sold out", () => {
    expect(remind(HOUR, { spotsSold: 10 })).toEqual([]);
    expect(remind(HOUR, { spotsSold: 9 })[0]?.body).toBe("1 spot left in Break #5. Closes in 60 min.");
  });

  it("only uses thresholds that fall in the second half of the sale", () => {
    // A 4 hour sale: the 3 hour mark would come right after it opened.
    const short = { closesAt: T0 + 4n * HOUR };
    const remindShort = (secsLeft: bigint) =>
      desiredPosts(world({ breaks: [brk(short)], now: at(4n * HOUR - secsLeft) }), SETTINGS).filter((d) => d.kind === "reminder");
    expect(remindShort(3n * HOUR)).toEqual([]);
    expect(remindShort(2n * HOUR)).toEqual([]);
    expect(remindShort(HOUR)[0]?.dedupeKey).toBe("reminder:4:1");
  });

  it("has no reminders when none are configured", () => {
    expect(remind(HOUR, {}, { ...SETTINGS, reminderHours: [] })).toEqual([]);
  });
});

describe("the reserve", () => {
  const reserve = (percent: number, over: Partial<NonNullable<World["reserve"]>> = {}) => ({ nextBreakId: 5n, percent, enough: false, target: 100_000_000n, ...over });
  const reserveDrafts = (w: World, s = SETTINGS) => desiredPosts(w, s).filter((d) => d.kind === "reserve");

  it("announces the highest milestone reached", () => {
    expect(reserveDrafts(world({ reserve: reserve(24) }))).toEqual([]);
    const [d] = reserveDrafts(world({ reserve: reserve(60) }));
    expect(d).toMatchObject({ breakId: 5n, dedupeKey: "reserve:5:50" });
    expect(d?.body).toBe("Break #6 is 50% funded 🔥 Unlocks at $100.");
    expect(reserveDrafts(world({ reserve: reserve(99) }))[0]?.dedupeKey).toBe("reserve:5:75");
    expect(reserveDrafts(world({ reserve: reserve(25) }))[0]?.dedupeKey).toBe("reserve:5:25");
  });

  it("is news for a few hours", () => {
    expect(reserveDrafts(world({ reserve: reserve(60) }))[0]?.validUntil).toEqual(new Date(at(0n).getTime() + 3 * 3_600_000));
  });

  it("does not announce a milestone below one that was already announced", () => {
    const keys = new Set(["reserve:5:75"]);
    expect(reserveDrafts(world({ reserve: reserve(60), keys }))[0]?.dedupeKey).toBeUndefined();
    // Another break's milestones do not count.
    expect(reserveDrafts(world({ reserve: reserve(60), keys: new Set(["reserve:4:75"]) }))[0]?.dedupeKey).toBe("reserve:5:50");
  });

  it("says nothing once the reserve is enough: the break itself is announced when it opens", () => {
    expect(reserveDrafts(world({ reserve: reserve(100, { enough: true }) }))).toEqual([]);
    expect(reserveDrafts(world())).toEqual([]);
  });
});

describe("the free-spot winners", () => {
  const drawn = (over: Partial<BreakAccount> = {}) =>
    brk({
      status: "Drawn",
      seededAt: T0 + 13n * HOUR,
      freeWinnerCount: 2,
      freeWinners: [
        { wallet: addr(21), start: 0n, weight: 5n },
        { wallet: addr(22), start: 5n, weight: 5n },
        ...Array.from({ length: 14 }, () => ({ wallet: addr(0), start: 0n, weight: 0n })),
      ],
      ...over,
    });

  it("names the winners: a handle for those who agreed to be tagged, a short wallet for the rest", () => {
    const handles = new Map([[addr(21), "alice"]]);
    const [d] = desiredPosts(world({ breaks: [drawn()], handles, now: at(14n * HOUR) }), SETTINGS);
    expect(d).toMatchObject({ kind: "winners", dedupeKey: "winners:4" });
    expect(d?.body).toBe(`Free holder spots in Break #5 go to @alice, ${addr(22).slice(0, 4)}…${addr(22).slice(-4)} 🎉`);
  });

  it("does not tag anyone without their consent", () => {
    const [d] = desiredPosts(world({ breaks: [drawn()], now: at(14n * HOUR) }), SETTINGS);
    expect(d?.body).not.toContain("@");
  });

  it("only counts the winners that were recorded", () => {
    const [d] = desiredPosts(world({ breaks: [drawn({ freeWinnerCount: 1 })], now: at(14n * HOUR) }), SETTINGS);
    expect(d?.body).toContain(addr(21).slice(0, 4));
    expect(d?.body).not.toContain(addr(22).slice(0, 4) + "…");
  });

  it("has nothing to say when nobody won, before the draw is complete, or about an old draw", () => {
    expect(kinds(world({ breaks: [drawn({ freeWinnerCount: 0 })], now: at(14n * HOUR) }))).toEqual([]);
    expect(kinds(world({ breaks: [drawn({ status: "Settled" })], now: at(14n * HOUR) }))).toEqual([]);
    expect(kinds(world({ breaks: [drawn()], now: at(13n * HOUR + 47n * HOUR) }))).toEqual(["winners:4"]);
    expect(kinds(world({ breaks: [drawn()], now: at(13n * HOUR + 48n * HOUR) }))).toEqual([]);
  });
});

describe("the results", () => {
  const delivered = (over: Record<string, unknown> = {}) => ({ breakId: 4n, cards: 12, wallets: 11, lastDeliveredAt: at(20n * HOUR), ...over });

  it("posts them once the last delivery has had time to be final, with a link to the results page", () => {
    const settings = { ...SETTINGS, siteUrl: "https://example.org/" };
    expect(desiredPosts(world({ delivered: [delivered()], now: at(20n * HOUR + 119n) }), settings)).toEqual([]);
    const [d] = desiredPosts(world({ delivered: [delivered()], now: at(20n * HOUR + 120n) }), settings);
    expect(d).toMatchObject({ kind: "results", dedupeKey: "results:4" });
    expect(d?.body).toBe("Break #5 results are in: 12 cards sent to 11 wallets. Full results + proof: https://example.org/breaks/5");
  });

  it("posts without a link when the site is not configured", () => {
    const [d] = desiredPosts(world({ delivered: [delivered()], now: at(21n * HOUR) }), SETTINGS);
    expect(d?.body).toBe("Break #5 results are in: 12 cards sent to 11 wallets.");
  });

  it("names the best card and its owner when a catalogue says which it is, tagging only with consent", () => {
    const topHit = { name: "PSA 10 Charizard", winner: addr(30) };
    const [plain] = desiredPosts(world({ delivered: [delivered({ topHit })], now: at(21n * HOUR) }), SETTINGS);
    expect(plain?.body).toBe(`Break #5 results: PSA 10 Charizard → ${addr(30).slice(0, 4)}…${addr(30).slice(-4)}.`);
    const [tagged] = desiredPosts(world({ delivered: [delivered({ topHit })], handles: new Map([[addr(30), "carol"]]), now: at(21n * HOUR) }), SETTINGS);
    expect(tagged?.body).toBe("Break #5 results: PSA 10 Charizard → @carol.");
  });

  it("does not announce results long after the fact", () => {
    expect(desiredPosts(world({ delivered: [delivered()], now: at(20n * HOUR + 48n * HOUR) }), SETTINGS)).toEqual([]);
    expect(desiredPosts(world({ delivered: [delivered()], now: at(20n * HOUR + 47n * HOUR) }), SETTINGS)).toHaveLength(1);
  });
});

describe("several things at once", () => {
  it("lists them in a fixed order, each with its own key", () => {
    const w = world({
      reserve: { nextBreakId: 5n, percent: 30, enough: false, target: 100_000_000n },
      breaks: [brk({ id: 4n }), brk({ id: 3n, status: "Drawn", seededAt: T0 - HOUR, freeWinnerCount: 1, freeWinners: [{ wallet: addr(21), start: 0n, weight: 1n }, ...Array.from({ length: 15 }, () => ({ wallet: addr(0), start: 0n, weight: 0n }))] })],
      now: at(9n * HOUR + 1800n),
    });
    expect(kinds(w)).toEqual(["reserve:5:25", "open:4", "reminder:4:3", "winners:3"]);
    const keys = kinds(w);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
