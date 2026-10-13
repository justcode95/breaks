import { describe, expect, it } from "vitest";
import { createRunner, type Job, type Logger } from "../src/job.js";

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
