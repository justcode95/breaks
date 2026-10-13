import type { Logger } from "./job.js";

/**
 * Runs `runner.tick()` now and then every `tickMs` after the previous tick finished, so ticks never overlap.
 * `stop` ends the loop and waits for the tick in progress, so shutting down never cuts a job in half.
 */
export function startLoop(runner: { tick(): Promise<void> }, tickMs: number, log: Logger): { stop(): Promise<void> } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> = Promise.resolve();

  const loop = async () => {
    try {
      await runner.tick();
    } catch (err) {
      // The runner catches job failures itself; this is for anything unexpected around it.
      log.error("tick failed", { error: err instanceof Error ? err.message : String(err) });
    }
    if (!stopped) timer = setTimeout(() => void (running = loop()), tickMs);
  };
  running = loop();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
    },
  };
}
