// How each job's runs are going, as the runner sees them: the watchdog's only view of the jobs. It lives in the keeper's
// memory, like the runner itself, so a restart starts it again from nothing (a job that keeps failing is reported again a
// little later, never wrongly).

import type { RunObserver } from "../job.js";

export interface JobStatus {
  name: string;
  /** When the run in progress started; absent when the job is not running. */
  runningSince?: Date;
  /** Runs in a row that threw, counted up to the last finished run. */
  failures: number;
  /** When the first of those failed runs ended; absent when the last run did not throw. */
  failingSince?: Date;
  /** What the last failed run threw, while the job is failing. */
  lastError?: string;
}

export class JobHealth implements RunObserver {
  private readonly jobs = new Map<string, JobStatus>();

  private of(name: string): JobStatus {
    let s = this.jobs.get(name);
    if (!s) {
      s = { name, failures: 0 };
      this.jobs.set(name, s);
    }
    return s;
  }

  started(name: string, at: Date): void {
    this.of(name).runningSince = at;
  }

  finished(name: string, at: Date, error?: string): void {
    const s = this.of(name);
    delete s.runningSince;
    if (error === undefined) {
      s.failures = 0;
      delete s.failingSince;
      delete s.lastError;
      return;
    }
    if (s.failures === 0) s.failingSince = at;
    s.failures += 1;
    s.lastError = error;
  }

  /** A copy of every job's status, in the order the jobs first ran. */
  snapshot(): JobStatus[] {
    return [...this.jobs.values()].map((s) => ({ ...s }));
  }
}
