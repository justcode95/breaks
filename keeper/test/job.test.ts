import { describe, expect, it } from "vitest";
import { createRunner, type Job, type Logger } from "../src/job.js";
import { JobHealth } from "../src/watch/health.js";

function harness() {
  let t = 0;
  const errors: string[] = [];
  const log: Logger = { info: () => {}, error: (m) => errors.push(m) };
  return { advance: (ms: number) => (t += ms), errors, ctx: { now: () => new Date(t), log } };
}

describe("createRunner", () => {
  it("runs a job immediately, then only once its interval has passed", async () => {
    const h = harness();
    let runs = 0;
    const runner = createRunner([{ name: "a", intervalMs: 1000, run: async () => void runs++ }], h.ctx);
    await runner.tick();
    await runner.tick();
    expect(runs).toBe(1);
    h.advance(999);
    await runner.tick();
    expect(runs).toBe(1);
    h.advance(1);
    await runner.tick();
    expect(runs).toBe(2);
  });

  it("isolates failures: a throwing job is logged, retried later and does not stop other jobs", async () => {
    const h = harness();
    let good = 0;
    let bad = 0;
    const jobs: Job[] = [
      { name: "bad", intervalMs: 10, run: async () => { bad++; throw new Error("boom"); } },
      { name: "good", intervalMs: 10, run: async () => void good++ },
    ];
    const runner = createRunner(jobs, h.ctx);
    await runner.tick();
    h.advance(10);
    await runner.tick();
    expect(good).toBe(2);
    expect(bad).toBe(2);
    expect(h.errors).toEqual(["job bad failed", "job bad failed"]);
  });

  it("never overlaps a job with itself", async () => {
    const h = harness();
    let release!: () => void;
    let started = 0;
    const slow: Job = {
      name: "slow",
      intervalMs: 1,
      run: () => new Promise<void>((r) => { started++; release = r; }),
    };
    const runner = createRunner([slow], h.ctx);
    const first = runner.tick();
    h.advance(100);
    await runner.tick(); // slow is still running, so this tick must skip it
    expect(started).toBe(1);
    release();
    await first;
  });
});

describe("createRunner with a JobHealth", () => {
  it("tells it when each run starts and how it ends, so it knows which jobs keep failing", async () => {
    const h = harness();
    const health = new JobHealth();
    let fail = true;
    let release!: () => void;
    const jobs: Job[] = [
      { name: "flaky", intervalMs: 10, run: async () => { if (fail) throw new Error("the node said 503"); } },
      { name: "slow", intervalMs: 10, run: () => new Promise<void>((r) => (release = r)) },
    ];
    const runner = createRunner(jobs, h.ctx, health);
    const firstTick = runner.tick();
    await Promise.resolve();
    // The slow job is running, the flaky one has failed once.
    expect(health.snapshot()).toEqual([
      { name: "flaky", failures: 1, failingSince: new Date(0), lastError: "the node said 503" },
      { name: "slow", failures: 0, runningSince: new Date(0) },
    ]);
    h.advance(10);
    await runner.tick();
    expect(health.snapshot()[0]).toEqual({ name: "flaky", failures: 2, failingSince: new Date(0), lastError: "the node said 503" });
    fail = false;
    h.advance(10);
    await runner.tick();
    expect(health.snapshot()[0]).toEqual({ name: "flaky", failures: 0 });
    release();
    await firstTick;
    expect(health.snapshot()[1]).toEqual({ name: "slow", failures: 0 });
  });
});

describe("JobHealth", () => {
  it("counts failures in a row from the end of the first, and forgets them after a run that ends well", () => {
    const health = new JobHealth();
    health.started("a", new Date(1));
    health.finished("a", new Date(2), "boom");
    health.started("a", new Date(3));
    health.finished("a", new Date(4), "bang");
    expect(health.snapshot()).toEqual([{ name: "a", failures: 2, failingSince: new Date(2), lastError: "bang" }]);
    health.started("a", new Date(5));
    expect(health.snapshot()).toEqual([{ name: "a", failures: 2, failingSince: new Date(2), lastError: "bang", runningSince: new Date(5) }]);
    health.finished("a", new Date(6));
    expect(health.snapshot()).toEqual([{ name: "a", failures: 0 }]);
    health.finished("a", new Date(7), "again");
    expect(health.snapshot()).toEqual([{ name: "a", failures: 1, failingSince: new Date(7), lastError: "again" }]);
  });

  it("hands out copies, so a reader cannot change what it knows", () => {
    const health = new JobHealth();
    health.finished("a", new Date(1), "boom");
    const copy = health.snapshot();
    (copy[0] as { failures: number }).failures = 99;
    expect(health.snapshot()[0]?.failures).toBe(1);
  });
});
