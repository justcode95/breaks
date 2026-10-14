// Phase 0 inspector: `pnpm --filter keeper phase0 -- --rpc <url> [--das] [label=]<signature> ...`
//
// Run it on your own machine against the transactions of a pack purchase, a card transfer and a sellback that you made
// by hand (CLAUDE.md, "Build phases", Phase 0), and paste what it prints. It only READS: it sends nothing, holds no
// key, and never prints the RPC url (which may contain an API key).

import { pathToFileURL } from "node:url";
import { type Fetch, RpcClient } from "../solana/rpc.js";
import { analyze, render, type TransactionJson } from "./analyze.js";

const USAGE = `usage: phase0 --rpc <rpc url> [--das] [label=]<signature> [[label=]<signature> ...]

  --rpc <url>   a Solana RPC url for the cluster the transactions are on (or set PHASE0_RPC_URL)
  --das         also ask the node for the asset record (getAsset) of every 1-of-1 token that moves; needs a DAS-capable RPC
  label=sig     a name for the transaction, for example purchase=5Kx... transfer=3Ab... sellback=2Cd...
`;

export interface Phase0Deps {
  fetch?: Fetch;
  env?: Record<string, string | undefined>;
}

const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;

/** Parses the arguments. Returns what to inspect, or the reason it cannot. */
export function parseArgs(argv: string[], env: Record<string, string | undefined>): { rpc: string; das: boolean; targets: { label: string; signature: string }[] } | { error: string } {
  let rpc = env.PHASE0_RPC_URL;
  let das = false;
  const targets: { label: string; signature: string }[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    // `pnpm phase0 -- --rpc ...` hands the script a bare `--`; it only marks the end of pnpm's own options.
    if (a === "--") continue;
    if (a === "--rpc") rpc = argv[++i];
    else if (a === "--das") das = true;
    else if (a === "--help" || a === "-h") return { error: "" };
    else if (a.startsWith("--")) return { error: `unknown option ${a}` };
    else {
      const eq = a.indexOf("=");
      const label = eq > 0 ? a.slice(0, eq) : `transaction ${targets.length + 1}`;
      const signature = eq > 0 ? a.slice(eq + 1) : a;
      if (!SIGNATURE.test(signature)) return { error: `"${signature}" is not a transaction signature (base58, about 88 characters)` };
      targets.push({ label, signature });
    }
  }
  if (!rpc) return { error: "no RPC url: pass --rpc <url> or set PHASE0_RPC_URL" };
  if (!/^https?:\/\//.test(rpc)) return { error: "the RPC url must start with http:// or https://" };
  if (targets.length === 0) return { error: "no transaction signature given" };
  return { rpc, das, targets };
}

/** 1-of-1 tokens that move in the transaction: the cards. */
function cardMints(tx: TransactionJson): string[] {
  const all = [...(tx.meta?.preTokenBalances ?? []), ...(tx.meta?.postTokenBalances ?? [])];
  return [...new Set(all.filter((b) => b.uiTokenAmount.decimals === 0 && ["0", "1"].includes(b.uiTokenAmount.amount)).map((b) => b.mint))];
}

export async function main(argv: string[], deps: Phase0Deps = {}): Promise<{ code: number; out: string }> {
  const env = deps.env ?? process.env;
  const parsed = parseArgs(argv, env);
  if ("error" in parsed) return { code: parsed.error ? 2 : 0, out: `${parsed.error ? `${parsed.error}\n\n` : ""}${USAGE}` };

  const rpc = new RpcClient({ url: parsed.rpc, retries: 2, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  const out: string[] = ["# Phase 0 report", "", "Read-only: this tool sent nothing to the chain.", ""];
  let code = 0;
  for (const { label, signature } of parsed.targets) {
    try {
      const tx = await rpc.call<TransactionJson | null>("getTransaction", [signature, { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 }]);
      if (!tx) {
        out.push(`## ${label}`, "", `Not found: \`${signature}\`. Check that it is finalized and that this RPC is on the right cluster and keeps old transactions.`, "");
        code = 1;
        continue;
      }
      out.push(render(label, analyze(tx)));
      if (parsed.das) {
        for (const mint of cardMints(tx)) {
          try {
            const asset = await rpc.call<unknown>("getAsset", [{ id: mint }]);
            out.push(`### Asset record of \`${mint}\` (getAsset)`, "", "```json", JSON.stringify(asset, null, 1).slice(0, 2500), "```", "");
          } catch (err) {
            out.push(`### Asset record of \`${mint}\``, "", `getAsset failed: ${err instanceof Error ? err.message : String(err)}`, "");
          }
        }
      }
    } catch (err) {
      out.push(`## ${label}`, "", `Could not read \`${signature}\`: ${err instanceof Error ? err.message : String(err)}`, "");
      code = 1;
    }
  }
  return { code, out: out.join("\n") };
}

// Run when started from the command line.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await main(process.argv.slice(2));
  process.stdout.write(`${result.out}\n`);
  process.exit(result.code);
}
