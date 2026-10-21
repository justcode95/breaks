import { describe, expect, it } from "vitest";
import { MAX_RANDOMNESS_ATTEMPTS } from "../src/solana/breaks.js";
import { type BreakFacts, SELLBACK_HOURS, breakAlert, duration, jobAlerts, keeperAlert, pausedAlert, unreadAlert } from "../src/watch/rules.js";
import { addr } from "./support/chain.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const limits = { afterMs: 15 * MIN, settleSecs: 120 };
const T0 = 1_800_000_000_000;
const at = (ms: number) => new Date(T0 + ms);

describe("duration", () => {
  it("says minutes, then hours and minutes, then days and hours, rounded down and never under a minute", () => {
    expect(duration(0)).toBe("1 min");
    expect(duration(119_999)).toBe("1 min");
    expect(duration(2 * MIN)).toBe("2 min");
    expect(duration(59 * MIN + 59_999)).toBe("59 min");
    expect(duration(HOUR)).toBe("1 h");
    expect(duration(HOUR + MIN)).toBe("1 h 1 min");
    expect(duration(47 * HOUR + 59 * MIN)).toBe("47 h 59 min");
    expect(duration(48 * HOUR)).toBe("2 days");
    expect(duration(49 * HOUR + 59 * MIN)).toBe("2 days 1 h");
    expect(duration(30 * 24 * HOUR)).toBe("30 days");
  });

  it("rounds up, when asked, for a time that is at most that long", () => {
    expect(duration(1, "up")).toBe("1 min");
    expect(duration(MIN + 1, "up")).toBe("2 min");
    expect(duration(59 * MIN + 1, "up")).toBe("1 h");
    expect(duration(47 * HOUR + 59 * MIN + 1, "up")).toBe("2 days");
    expect(duration(48 * HOUR + 1, "up")).toBe("2 days 1 h");
    expect(duration(71 * HOUR + 45 * MIN, "up")).toBe("3 days");
  });
});

describe("jobAlerts", () => {
  const failing = (over: Partial<Parameters<typeof jobAlerts>[0][number]> = {}) => ({ name: "pipeline", failures: 3, failingSince: at(0), lastError: "the node said 503", ...over });

  it("reports a job that has failed every run for the limit, from the second failure on", () => {
    expect(jobAlerts([failing()], at(15 * MIN - 1), limits)).toEqual([]);
    expect(jobAlerts([failing()], at(15 * MIN), limits)).toEqual([
      { key: "job:pipeline", text: "The pipeline job has failed every run for 15 min (3 runs in a row). Last error: the node said 503" },
    ]);
    // One failed run, however long ago, is not "every run": the job may run rarely.
    expect(jobAlerts([failing({ failures: 1 })], at(10 * HOUR), limits)).toEqual([]);
    expect(jobAlerts([failing({ failures: 2 })], at(HOUR), limits)[0]?.text).toContain("(2 runs in a row)");
    expect(jobAlerts([failing({ lastError: undefined })], at(HOUR), limits)[0]?.text).toContain("Last error: (none given)");
    expect(jobAlerts([{ name: "pipeline", failures: 0 }], at(HOUR), limits)).toEqual([]);
  });

  it("reports a run that has not ended for the limit", () => {
    const running = { name: "indexer", failures: 0, runningSince: at(0) };
    expect(jobAlerts([running], at(15 * MIN - 1), limits)).toEqual([]);
    expect(jobAlerts([running], at(20 * MIN), limits)).toEqual([
      { key: "job:indexer:hung", text: "A run of the indexer job started 20 min ago and has not finished: something it waits on (the node, the database) does not answer, and until it ends the keeper starts no other job." },
    ]);
  });

  it("says both for a failing job whose next run hangs, and never reports the watchdog itself", () => {
    const both = { ...failing(), runningSince: at(0) };
    expect(jobAlerts([both], at(HOUR), limits).map((a) => a.key)).toEqual(["job:pipeline", "job:pipeline:hung"]);
    expect(jobAlerts([{ ...both, name: "watchdog" }], at(HOUR), limits)).toEqual([]);
  });
});

describe("breakAlert", () => {
  const facts = (over: Partial<BreakFacts> = {}): BreakFacts => ({
    id: 6n,
    status: "Funded",
    seenSince: at(0),
    closesAt: BigInt(T0 / 1000),
    randomnessAttempt: 0,
    randomnessRequestedAt: 0n,
    seededAt: 0n,
    poolSize: 5,
    ...over,
  });
  const edge = (f: BreakFacts, since: number) => {
    expect(breakAlert(f, at(since + 15 * MIN - 1), limits), "just before the limit").toBeUndefined();
    return breakAlert(f, at(since + 15 * MIN), limits);
  };

  it("names the break as people see it (id + 1) and keys it by id and stage", () => {
    expect(edge(facts(), 0)).toEqual({
      key: "break:6:Funded",
      text: "Break #7 has been funded for at least 15 min and its pool is not committed: the packs are not all bought and pulled, or commit_pool has not landed (see the keeper's log).",
    });
  });

  it("measures an open break from the end of its sale", () => {
    expect(edge(facts({ status: "Open", seenSince: at(-HOUR) }), 0)?.text).toBe(
      "Break #7's sale ended 15 min ago and it is still open on chain: close_break has not landed (see the keeper's log).",
    );
  });

  it("gives a closed break the indexer's settle time on top", () => {
    expect(edge(facts({ status: "Closed" }), 120_000)?.text).toBe(
      "Break #7's sale ended 17 min ago and its eligibility list is not committed: the balance indexer may be behind, or the list cannot be made (see the keeper's log).",
    );
  });

  it("measures the stages the chain keeps no time for from when the watchdog first saw them", () => {
    expect(edge(facts({ status: "EligibilityCommitted", seenSince: at(HOUR) }), HOUR)?.text).toBe(
      "Break #7 has had its eligibility list committed for at least 15 min and is neither funded nor cancelled: is the program paused, or the buyer wallet's USDC account missing? (see the keeper's log)",
    );
    expect(edge(facts({ status: "PoolCommitted", seenSince: at(HOUR) }), HOUR)?.text).toBe(
      "Break #7's pool has been committed for at least 15 min and no randomness has been asked for (see the keeper's log).",
    );
  });

  it("measures a randomness request from the earlier of the request and the first sighting, so a repeat does not reset it", () => {
    const requested = BigInt(T0 / 1000) + 3600n; // repeated an hour in, after the watchdog first saw it waiting
    expect(edge(facts({ status: "RandomnessRequested", seenSince: at(0), randomnessRequestedAt: requested, randomnessAttempt: 1 }), 0)?.text).toBe(
      "Break #7 has waited at least 15 min for ORAO's randomness, on request 2 of 5 (see the keeper's log).",
    );
    // After a restart the sighting is new, and the request time is the better one.
    expect(edge(facts({ status: "RandomnessRequested", seenSince: at(2 * HOUR), randomnessRequestedAt: requested }), HOUR)?.text).toContain("request 1 of 5");
  });

  it("says when the last request the program allows has gone unanswered", () => {
    const last = breakAlert(facts({ status: "RandomnessRequested", randomnessAttempt: MAX_RANDOMNESS_ATTEMPTS - 1, randomnessRequestedAt: BigInt(T0 / 1000) }), at(HOUR), limits);
    expect(last?.text).toBe(
      "Break #7 has waited at least 1 h for ORAO's randomness, on request 5 of 5: that was the last request the program allows, so only the admin can go on, by switching the randomness program (set_randomness) (see the keeper's log).",
    );
    const before = breakAlert(facts({ status: "RandomnessRequested", randomnessAttempt: MAX_RANDOMNESS_ATTEMPTS - 2, randomnessRequestedAt: BigInt(T0 / 1000) }), at(HOUR), limits);
    expect(before?.text).not.toContain("last request");
  });

  it("measures a settled and a drawn break from the seed", () => {
    const seeded = BigInt(T0 / 1000);
    expect(edge(facts({ status: "Settled", seededAt: seeded, seenSince: at(HOUR) }), 0)?.text).toBe(
      "Break #7's seed has been final for 15 min and its free-spot winners are not all recorded (see the keeper's log).",
    );
    expect(edge(facts({ status: "Drawn", seededAt: seeded, seenSince: at(HOUR), delivered: 2 }), 0)).toEqual({
      key: "break:6:Drawn",
      text: "Break #7 was drawn 15 min ago and 2 of its 5 cards are delivered (see the keeper's log). Every card was pulled before the draw, so Collector Crypt's sellback window, about 72 hours from the pull (not confirmed yet), ends within 3 days.",
    });
  });

  it("says how much of the sellback window may be left, and when it has probably closed", () => {
    const drawn = facts({ status: "Drawn", seededAt: BigInt(T0 / 1000), poolSize: 1 });
    expect(breakAlert(drawn, at(3 * HOUR), limits)?.text).toContain("its cards are not all delivered (see the keeper's log)");
    expect(breakAlert({ ...drawn, delivered: 0 }, at(3 * HOUR), limits)?.text).toContain("0 of its 1 card is delivered");
    expect(breakAlert(drawn, at(SELLBACK_HOURS * HOUR - MIN), limits)?.text).toContain("ends within 1 min.");
    expect(breakAlert(drawn, at(30 * HOUR), limits)?.text).toContain("ends within 42 h.");
    expect(breakAlert(drawn, at(SELLBACK_HOURS * HOUR), limits)?.text).toContain("has probably closed.");
  });

  it("reports a break the database has and the chain does not, and leaves cancelled breaks to the refund job", () => {
    expect(edge(facts({ status: "missing" }), 0)).toEqual({
      key: "break:6:missing",
      text: "Break #7 is in the keeper's database but has no account on chain: is BREAKS_PROGRAM_ID the program it was made with? (see the keeper's log)",
    });
    expect(breakAlert(facts({ status: "Cancelled" }), at(100 * HOUR), limits)).toBeUndefined();
  });
});

describe("keeperAlert", () => {
  const need = { create: 13_695_320n, cycle: 20_139_240n };
  const keeper = addr(3);

  it("is quiet with what one whole break needs, and says how short the wallet is below it", () => {
    expect(keeperAlert(keeper, need.cycle, need)).toBeUndefined();
    expect(keeperAlert(keeper, need.cycle - 1n, need)).toEqual({
      key: "keeper:sol",
      text: `The keeper wallet ${keeper} holds 0.020139239 SOL: enough to create a break, not to see one through, which needs about 0.02013924 SOL. Top it up with devnet SOL.`,
    });
    expect(keeperAlert(keeper, need.create, need)?.text).toContain("enough to create a break");
    expect(keeperAlert(keeper, need.create - 1n, need)).toEqual({
      key: "keeper:sol",
      text: `The keeper wallet ${keeper} holds 0.013695319 SOL: creating a break needs 0.01369532 SOL and seeing one through about 0.02013924 SOL. Top it up with devnet SOL.`,
    });
  });
});

describe("pausedAlert and unreadAlert", () => {
  it("reports a pause at once", () => {
    expect(pausedAlert(false)).toBeUndefined();
    expect(pausedAlert(true)?.key).toBe("program:paused");
  });

  it("reports what cannot be read once it has lasted the limit", () => {
    expect(unreadAlert("chain", at(0), "fetch failed", at(15 * MIN - 1), limits)).toBeUndefined();
    expect(unreadAlert("chain", at(0), "fetch failed", at(15 * MIN), limits)).toEqual({ key: "watch:chain", text: "The watchdog has not been able to read the node for 15 min: fetch failed" });
    expect(unreadAlert("database", at(0), "connection refused", at(HOUR), limits)).toEqual({
      key: "watch:database",
      text: "The watchdog has not been able to read the database for 1 h: connection refused",
    });
  });
});
