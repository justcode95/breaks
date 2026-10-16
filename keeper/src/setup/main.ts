// `pnpm --filter keeper setup-devnet`: takes freshly deployed devnet programs to a usable state. See `USAGE` for the steps.
//
// It never prints a key, the node's url or anything that holds a provider's API key (all text goes through `scrubber`), refuses
// any network but devnet before it sends anything (the node's genesis hash is checked), and only prints unless --send is given.

import { statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { gitRoot } from "../doctor/checks.js";
import { scrubber, urlSecrets } from "../doctor/report.js";
import { RpcChainClient } from "../pipeline/rpc-chain.js";
import { type Signer, loadSignerFromFile } from "../solana/keypair.js";
import { RpcClient } from "../solana/rpc.js";
import { USAGE, parseArgs, type SetupRequest } from "./args.js";
import { type SetupChain, runSetup } from "./run.js";

export interface SetupDeps {
  env?: Record<string, string | undefined>;
  /** How to reach the chain: the real one by default (a node over JSON-RPC, devnet only). */
  connect?: (req: SetupRequest, authority: Signer) => Promise<SetupChain>;
}

const realConnect: NonNullable<SetupDeps["connect"]> = (req, authority) =>
  RpcChainClient.connect({ rpc: new RpcClient({ url: req.rpcUrl, timeoutMs: 15_000 }), signer: authority, cluster: req.cluster });

/** Warnings about a key file: readable by others, or inside a git work tree where it can be committed by accident. */
function keyWarnings(label: string, path: string): string[] {
  const out: string[] = [];
  if (process.platform !== "win32") {
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o077) !== 0) out.push(`the ${label} key file's mode is ${mode.toString(8)}: other users on this machine can read it (chmod 600)`);
  }
  const root = gitRoot(path);
  if (root !== undefined) out.push(`the ${label} key file is inside the git work tree ${root}: move it outside, a key can be committed by accident`);
  return out;
}

export async function main(argv: string[], deps: SetupDeps = {}): Promise<{ code: number; out: string }> {
  const env = deps.env ?? process.env;
  const parsed = parseArgs(argv, env);
  if (parsed.kind === "help") return { code: 0, out: USAGE };
  if (parsed.kind === "error") return { code: 2, out: `${parsed.problems.map((p) => `error: ${p}`).join("\n")}\n\n${USAGE}` };
  const req = parsed.request;
  const hide = scrubber(urlSecrets(req.rpcUrl, "rpc"));

  let authority: Signer;
  let admin: Signer | undefined;
  const warnings: string[] = [];
  try {
    authority = loadSignerFromFile(req.authorityKeypair);
    warnings.push(...keyWarnings("authority", req.authorityKeypair));
    if (req.adminKeypair) {
      admin = loadSignerFromFile(req.adminKeypair);
      warnings.push(...keyWarnings("admin", req.adminKeypair));
    }
  } catch (err) {
    return { code: 2, out: `error: ${hide(err instanceof Error ? err.message : String(err))}` };
  }

  try {
    const chain = await (deps.connect ?? realConnect)(req, authority);
    const result = await runSetup(req, { chain, keys: { authority, ...(admin ? { admin } : {}) }, hide, warnings });
    return { code: result.code, out: result.out };
  } catch (err) {
    // The node could not be reached, or it is the wrong network. Nothing was sent unless a step above says so.
    return { code: 1, out: hide(`error: ${err instanceof Error ? err.message : String(err)}`) };
  }
}

// Run when started from the command line.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await main(process.argv.slice(2));
  process.stdout.write(`${result.out}\n`);
  process.exit(result.code);
}
