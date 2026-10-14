// Where the site reads the chain from. Set when the site is built (the `NEXT_PUBLIC_` values are put into the page):
//   NEXT_PUBLIC_BREAKS_PROGRAM_ID     the deployed breaks program (no default: it belongs to one deployment)
//   NEXT_PUBLIC_TREASURY_PROGRAM_ID   the deployed treasury program (the treasury page is hidden without it)
//   NEXT_PUBLIC_PUBLISHED_URL         where the keeper's published lists are served (the verify page loads them from there)
//   NEXT_PUBLIC_SOLANA_RPC_URL        a node that answers browsers (default: the public devnet node)

import { type Address, isAddress } from "./chain/address";

export const DEFAULT_RPC_URL = "https://api.devnet.solana.com";

export interface ChainConfig {
  rpcUrl: string;
  breaksProgram: Address;
}

export interface TreasuryConfigSetting {
  rpcUrl: string;
  treasuryProgram: Address;
}

export type Setup<T> = { kind: "off" } | { kind: "problem"; problem: string } | { kind: "on"; config: T };
export type ChainSetup = Setup<ChainConfig>;

/** The program's address and the node's, checked. `variable` names the setting in a problem report. */
function programAndNode(env: { rpcUrl?: string | undefined; program?: string | undefined }, variable: string): { kind: "off" } | { kind: "problem"; problem: string } | { kind: "ok"; program: Address; rpcUrl: string } {
  const program = env.program?.trim();
  if (!program) return { kind: "off" };
  if (!isAddress(program)) return { kind: "problem", problem: `${variable} is not a Solana address.` };
  const rpcUrl = env.rpcUrl?.trim() || DEFAULT_RPC_URL;
  let url: URL;
  try {
    url = new URL(rpcUrl);
  } catch {
    return { kind: "problem", problem: "NEXT_PUBLIC_SOLANA_RPC_URL is not a web address." };
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    return { kind: "problem", problem: "NEXT_PUBLIC_SOLANA_RPC_URL must be an https:// address." };
  }
  return { kind: "ok", program, rpcUrl };
}

export function chainSetup(env: { rpcUrl?: string | undefined; program?: string | undefined }): ChainSetup {
  const s = programAndNode(env, "NEXT_PUBLIC_BREAKS_PROGRAM_ID");
  return s.kind === "ok" ? { kind: "on", config: { rpcUrl: s.rpcUrl, breaksProgram: s.program } } : s;
}

export function treasurySetup(env: { rpcUrl?: string | undefined; program?: string | undefined }): Setup<TreasuryConfigSetting> {
  const s = programAndNode(env, "NEXT_PUBLIC_TREASURY_PROGRAM_ID");
  return s.kind === "ok" ? { kind: "on", config: { rpcUrl: s.rpcUrl, treasuryProgram: s.program } } : s;
}

export interface PublishedSetting {
  /** Where `eligibility/<root>.json` and `pool/<pool hash>.json` are served from: no trailing slash. */
  baseUrl: string;
}

/** The address the published lists are served from. Files are fetched from it by name, so it is only a folder. */
export function publishedSetup(raw: string | undefined): Setup<PublishedSetting> {
  const text = raw?.trim();
  if (!text) return { kind: "off" };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { kind: "problem", problem: "NEXT_PUBLIC_PUBLISHED_URL is not a web address." };
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    return { kind: "problem", problem: "NEXT_PUBLIC_PUBLISHED_URL must be an https:// address." };
  }
  if (url.username || url.password || url.search || url.hash) {
    return { kind: "problem", problem: "NEXT_PUBLIC_PUBLISHED_URL must be a plain folder address, without a login, a query or a fragment." };
  }
  return { kind: "on", config: { baseUrl: `${url.origin}${url.pathname.replace(/\/+$/, "")}` } };
}
