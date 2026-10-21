export interface Logger {
  info(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
}

export interface JobContext {
  now(): Date;
  log: Logger;
}

/**
 * A keeper job. `run` MUST be idempotent and retry-safe: the runner calls it again after any
 * failure, including a crash halfway through a previous run (CLAUDE.md guardrails).
 */
export interface Job {
  name: string;
  intervalMs: number;
  run(ctx: JobContext): Promise<void>;
}

/** Hears when each run starts and ends (the watchdog's view of the jobs). A run that throws ends with its error. */
export interface RunObserver {
  started(name: string, at: Date): void;
  finished(name: string, at: Date, error?: string): void;
}

interface JobState {
  job: Job;
  nextRunAt: number;
  running: boolean;
}

/** Runs each job on its own interval. One failing job never stops the others and a job never overlaps itself. */
export function createRunner(jobs: Job[], ctx: JobContext, observer?: RunObserver) {
  const start = ctx.now().getTime();
  const states: JobState[] = jobs.map((job) => ({ job, nextRunAt: start, running: false }));

  async function runJob(state: JobState): Promise<void> {
    state.running = true;
    observer?.started(state.job.name, ctx.now());
    try {
      await state.job.run(ctx);
      observer?.finished(state.job.name, ctx.now());
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      ctx.log.error(`job ${state.job.name} failed`, { error });
      observer?.finished(state.job.name, ctx.now(), error);
    } finally {
      state.running = false;
      state.nextRunAt = ctx.now().getTime() + state.job.intervalMs;
    }
  }

  return {
    /** Starts every job that is due and waits for those runs to finish. */
    async tick(): Promise<void> {
      const t = ctx.now().getTime();
      const due = states.filter((s) => !s.running && s.nextRunAt <= t);
      await Promise.all(due.map(runJob));
    },
  };
}
