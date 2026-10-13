import { loadConfig } from "./config.js";
import { createRunner, type Job, type Logger } from "./job.js";

const log: Logger = {
  info: (msg, extra) => console.log(JSON.stringify({ level: "info", msg, ...extra })),
  error: (msg, extra) => console.error(JSON.stringify({ level: "error", msg, ...extra })),
};

// Jobs are added phase by phase (see CLAUDE.md, "Keeper"): fee sweep, scheduler, indexer, eligibility,
// pack buyer, delivery, X bot. The scaffold registers none.
const jobs: Job[] = [];

const config = loadConfig();
const runner = createRunner(jobs, { now: () => new Date(), log });

log.info("keeper started", { cluster: config.cluster, jobs: jobs.map((j) => j.name) });
const timer = setInterval(() => void runner.tick(), config.jobTickMs);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    clearInterval(timer);
    log.info("keeper stopped", { signal: sig });
    process.exit(0);
  });
}
