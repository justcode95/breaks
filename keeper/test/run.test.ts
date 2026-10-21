import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "../src/job.js";
import { startKeeper, startLoop } from "../src/run.js";
import { JobHealth } from "../src/watch/health.js";
import { logger } from "./support/world.js";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("startLoop", () => {
  it("ticks at once and then every interval", async () => {
    let ticks = 0;
    const loop = startLoop({ tick: async () => void ticks++ }, 1000, logger().log);
    await vi.advanceTimersByTimeAsync(0);
    expect(ticks).toBe(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(ticks).toBe(4);
    await loop.stop();
  });

  it("never overlaps ticks: the next one is timed from the end of the last", async () => {
    let running = 0;
    let maxRunning = 0;
    let ticks = 0;
    const loop = startLoop(
      {
        tick: async () => {
          ticks++;
          running++;
          maxRunning = Math.max(maxRunning, running);
          await new Promise((r) => setTimeout(r, 2500)); // longer than the interval
          running--;
        },
      },
      1000,
      logger().log,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(maxRunning).toBe(1);
    expect(ticks).toBe(3); // 0-2.5, 3.5-6, 7-9.5
    await loop.stop();
  });

  it("stop waits for the tick in progress and then nothing more runs", async () => {
    let finished = false;
    let ticks = 0;
    const loop = startLoop(
      {
        tick: async () => {
          ticks++;
          await new Promise((r) => setTimeout(r, 500));
          finished = true;
        },
      },
      1000,
      logger().log,
    );
    await vi.advanceTimersByTimeAsync(100);
    let stopResolved = false;
    const stopped = loop.stop().then(() => {
      stopResolved = true;
    });
    // The tick needs 500 ms; 200 ms in, stop must still be waiting.
    await vi.advanceTimersByTimeAsync(100);
    expect(finished).toBe(false);
    expect(stopResolved).toBe(false);
    await vi.advanceTimersByTimeAsync(400);
    await stopped;
    expect(finished).toBe(true);
    expect(stopResolved).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ticks).toBe(1);
  });

  it("stop is safe to call while waiting for the next tick", async () => {
    let ticks = 0;
    const loop = startLoop({ tick: async () => void ticks++ }, 1000, logger().log);
    await vi.advanceTimersByTimeAsync(10);
    await loop.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ticks).toBe(1);
  });

  it("logs a tick that throws and keeps going", async () => {
    const { log, errors } = logger();
    let ticks = 0;
    const loop = startLoop(
      {
        tick: async () => {
          if (++ticks === 1) throw new Error("boom");
        },
      },
      1000,
      log,
    );
    await vi.advanceTimersByTimeAsync(2500);
    expect(errors).toEqual(["tick failed"]);
    expect(ticks).toBeGreaterThanOrEqual(3);
    await loop.stop();
  });
});

describe("startKeeper", () => {
  it("runs the watchdog on a loop of its own, so a job that never finishes, which holds up the runner, is still reported", async () => {
    const health = new JobHealth();
    let clock = 1_800_000_000_000;
    const ctx = { now: () => new Date(clock), log: logger().log };
    let quick = 0;
    const jobs: Job[] = [
      { name: "pipeline", intervalMs: 1000, run: () => new Promise<void>(() => {}) }, // waits for a node that never answers
      { name: "indexer", intervalMs: 1000, run: async () => void quick++ },
    ];
    const seen: string[][] = [];
    const watchdog: Job = {
      name: "watchdog",
      intervalMs: 60_000,
      run: async () => {
        clock += 60_000;
        seen.push(health.snapshot().filter((j) => j.runningSince).map((j) => `${j.name} since ${(clock - j.runningSince!.getTime()) / 60_000} min`));
      },
    };
    const keeper = startKeeper({ jobs, watchdog, observer: health, ctx, tickMs: 1000 });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    // The runner is stuck in its first tick: the indexer ran once, never again.
    expect(quick).toBe(1);
    // The watchdog kept running and saw the run that does not end grow older.
    expect(seen.length).toBe(11);
    expect(seen.at(-1)).toEqual(["pipeline since 11 min"]);
    void keeper.stop(); // would wait for the stuck run forever
  });

  it("stops both loops", async () => {
    let jobRuns = 0;
    let watchRuns = 0;
    const ctx = { now: () => new Date(), log: logger().log }; // the fake timers move the clock
    const keeper = startKeeper({
      jobs: [{ name: "a", intervalMs: 1000, run: async () => void jobRuns++ }],
      watchdog: { name: "watchdog", intervalMs: 1000, run: async () => void watchRuns++ },
      observer: new JobHealth(),
      ctx,
      tickMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(2500);
    await keeper.stop();
    const [j, w] = [jobRuns, watchRuns];
    expect(j).toBeGreaterThan(1);
    expect(w).toBe(3);
    await vi.advanceTimersByTimeAsync(10_000);
    expect([jobRuns, watchRuns]).toEqual([j, w]);
  });
});
