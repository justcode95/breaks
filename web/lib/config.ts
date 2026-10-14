// Where the site reads the chain from. Set when the site is built (the `NEXT_PUBLIC_` values are put into the page):
//   NEXT_PUBLIC_BREAKS_PROGRAM_ID   the deployed breaks program (no default: it belongs to one deployment)
//   NEXT_PUBLIC_SOLANA_RPC_URL      a node that answers browsers (default: the public devnet node)

import { type Address, isAddress } from "./chain/address";

export const DEFAULT_RPC_URL = "https://api.devnet.solana.com";

export interface ChainConfig {
  rpcUrl: string;
  breaksProgram: Address;
}

export type ChainSetup = { kind: "off" } | { kind: "problem"; problem: string } | { kind: "on"; config: ChainConfig };

export function chainSetup(env: { rpcUrl?: string | undefined; program?: string | undefined }): ChainSetup {
  const program = env.program?.trim();
  if (!program) return { kind: "off" };
  if (!isAddress(program)) return { kind: "problem", problem: "NEXT_PUBLIC_BREAKS_PROGRAM_ID is not a Solana address." };
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
  return { kind: "on", config: { rpcUrl, breaksProgram: program } };
}
