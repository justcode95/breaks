import pg from "pg";
import { buildJobs, sqlFromPool } from "./app.js";
import { loadConfig } from "./config.js";
import { createRunner, type Logger } from "./job.js";
import { connectFromConfig } from "./pipeline/rpc-chain.js";
import { startLoop } from "./run.js";

const log: Logger = {
  info: (msg, extra) => console.log(JSON.stringify({ level: "info", msg, ...extra })),
  error: (msg, extra) => console.error(JSON.stringify({ level: "error", msg, ...extra })),
};

async function main() {
  const config = loadConfig();

  // The network and the key are checked before anything else: devnet only, and the key the program expects.
  const chain = await connectFromConfig(config, { log });
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  pool.on("error", (err) => log.error("database connection error", { error: err.message }));
  try {
    await pool.query("select 1");
  } catch (err) {
    // Say what failed, but never print the connection string: it holds the password.
    throw new Error(`cannot reach the database: ${err instanceof Error ? err.message : String(err)}`);
  }

  const jobs = await buildJobs(config, { sql: sqlFromPool(pool), chain, keeper: chain.keeper, log });
  const runner = createRunner(jobs, { now: () => new Date(), log });
  log.info("keeper started", { cluster: config.cluster, keeper: chain.keeper, jobs: jobs.map((j) => j.name) });
  const loop = startLoop(runner, config.jobTickMs, log);

  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      if (stopping) return;
      stopping = true;
      log.info("keeper stopping", { signal: sig });
      void loop
        .stop()
        .then(() => pool.end())
        .then(() => {
          log.info("keeper stopped");
          process.exit(0);
        });
    });
  }
}

main().catch((err) => {
  log.error("keeper failed to start", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
