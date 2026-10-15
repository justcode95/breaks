// Keeper doctor: `pnpm --filter keeper check-setup` (not `doctor`: pnpm has a command of that name of its own)
//
// Looks at everything the keeper depends on, before it runs: the settings, the key, the node, the deployed programs and how
// they are set up, the keeper's SOL, the token, the database. It only READS: it sends no transaction, writes no row, and
// never prints a url, a password or a key. It reports every problem at once, with what to do about each.
//
// Exit code: 0 when nothing failed (warnings do not stop the keeper), 1 when something did, 2 for a bad command line.

import { pathToFileURL } from "node:url";
import pg from "pg";
import { sqlFromPool } from "../app.js";
import { RpcTokenReader } from "../indexer/reader.js";
import { RpcClient } from "../solana/rpc.js";
import { type DoctorPorts, runChecks } from "./checks.js";
import { type Check, render, scrubber, summarize, urlSecrets } from "./report.js";

const USAGE = `usage: pnpm --filter keeper check-setup [-- --help]

Checks the keeper's setup against the settings in the environment (the same ones the keeper reads, from keeper/.env) and
the cluster they point at. Read-only. Run it before the first start, and after changing a setting or a deployment.
`;

/** The ports the real doctor uses: a node with short timeouts (a dead node should not hold it up for minutes) and a read-only database session. */
export const realPorts: DoctorPorts = {
  rpc: (config) => new RpcClient({ url: config.rpcUrl, timeoutMs: 8_000, retries: 1 }),
  reader: (rpc) => new RpcTokenReader(rpc, { concurrency: 1 }),
  async connectDb(config) {
    const client = new pg.Client({ connectionString: config.databaseUrl, connectionTimeoutMillis: 5_000 });
    // A connection that drops while the doctor runs would otherwise throw from the event loop; the query that was waiting rejects instead.
    client.on("error", () => {});
    await client.connect();
    // Belt and braces: the doctor only issues SELECTs, and this makes the session refuse anything else.
    await client.query("set default_transaction_read_only = on");
    return { sql: sqlFromPool(client), close: () => client.end() };
  },
  now: () => new Date(),
};

/** Every value in the environment that the doctor must never print. */
function secretsOf(env: Record<string, string | undefined>): string[] {
  const keys = ["X_CONSUMER_KEY", "X_CONSUMER_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"];
  return [...urlSecrets(env.SOLANA_RPC_URL, "rpc"), ...urlSecrets(env.DATABASE_URL, "db"), ...keys.map((k) => env[k] ?? "")];
}

export interface DoctorDeps {
  env?: Record<string, string | undefined>;
  ports?: DoctorPorts;
}

export async function main(argv: string[], deps: DoctorDeps = {}): Promise<{ code: number; out: string }> {
  const args = argv.filter((a) => a !== "--");
  if (args.includes("--help") || args.includes("-h")) return { code: 0, out: USAGE };
  if (args.length > 0) return { code: 2, out: `unknown argument ${args[0]}\n\n${USAGE}` };

  const env = deps.env ?? process.env;
  const hide = scrubber(secretsOf(env));
  const checks: Check[] = (await runChecks(env, deps.ports ?? realPorts)).map((c) => ({
    ...c,
    detail: hide(c.detail),
    ...(c.fix !== undefined ? { fix: hide(c.fix) } : {}),
  }));
  const report = summarize(checks);
  return { code: report.ready ? 0 : 1, out: render(report) };
}

// Run when started from the command line.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await main(process.argv.slice(2));
  process.stdout.write(`${result.out}\n`);
  process.exit(result.code);
}
