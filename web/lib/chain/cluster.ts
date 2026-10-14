// The project runs on devnet only until the owner says otherwise after an audit (CLAUDE.md, guardrails). The node the site reads
// comes from its settings, so before anything is sent the site asks the node which network it is: a copied production address, or
// a typo, must not be able to make it send a purchase to the wrong one. The keeper does the same (keeper/src/solana/cluster.ts).

import { type RpcOptions, rpc } from "./rpc";

/** The first block's hash of each public network: how a node says which network it is. */
export const GENESIS_HASHES = {
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
} as const;

export type DevnetCheck = { ok: true } | { ok: false; reason: string };

/** Whether the node is Solana devnet. Anything else, and a node that cannot be asked, is a no: the check fails closed. */
export async function checkDevnet(opts: RpcOptions): Promise<DevnetCheck> {
  let genesis: unknown;
  try {
    genesis = await rpc<unknown>(opts, "getGenesisHash", []);
  } catch (err) {
    return { ok: false, reason: `Could not check which network the node is on (${err instanceof Error ? err.message : String(err)}), so nothing was sent.` };
  }
  if (genesis === GENESIS_HASHES.devnet) return { ok: true };
  if (genesis === GENESIS_HASHES["mainnet-beta"]) return { ok: false, reason: "This site's node is Solana mainnet. The site only works on devnet, so nothing was sent." };
  if (genesis === GENESIS_HASHES.testnet) return { ok: false, reason: "This site's node is Solana testnet. The site only works on devnet, so nothing was sent." };
  const shown = typeof genesis === "string" ? ` (its first block is ${genesis.slice(0, 60)})` : "";
  return { ok: false, reason: `This site's node is not Solana devnet${shown}, so nothing was sent.` };
}
