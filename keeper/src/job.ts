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

interface JobState {
  job: Job;
  nextRunAt: number;
  running: boolean;
}

/** Runs each job on its own interval. One failing job never stops the others and a job never overlaps itself. */
export function createRunner(jobs: Job[], ctx: JobContext) {
  const start = ctx.now().getTime();
  const states: JobState[] = jobs.map((job) => ({ job, nextRunAt: start, running: false }));

  async function runJob(state: JobState): Promise<void> {
    state.running = true;
    try {
      await state.job.run(ctx);
    } catch (err) {
      ctx.log.error(`job ${state.job.name} failed`, { error: err instanceof Error ? err.message : String(err) });
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
