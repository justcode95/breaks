import { type Job, type JobContext, type Logger, type RunObserver, createRunner } from "./job.js";

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

/**
 * The keeper's two loops: the jobs, run by the runner, and the watchdog on a loop of its own. A tick waits for every job it
 * started, so a run that never ends holds up every job; on its own loop the watchdog still runs and says so.
 */
export function startKeeper(o: { jobs: Job[]; watchdog: Job; observer: RunObserver; ctx: JobContext; tickMs: number }): { stop(): Promise<void> } {
  const jobs = startLoop(createRunner(o.jobs, o.ctx, o.observer), o.tickMs, o.ctx.log);
  const watch = startLoop({ tick: () => o.watchdog.run(o.ctx) }, o.watchdog.intervalMs, o.ctx.log);
  return {
    async stop() {
      await Promise.all([jobs.stop(), watch.stop()]);
    },
  };
}
