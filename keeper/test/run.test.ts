import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startLoop } from "../src/run.js";
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
