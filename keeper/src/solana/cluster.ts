// The project runs on devnet only until the owner says otherwise after an audit (CLAUDE.md, guardrails). The
// RPC url comes from config, so a typo or a copied production url must not be able to make the keeper send
// anything to the wrong network: before the first send the node is asked for its genesis hash, and the keeper
// refuses to run against mainnet-beta or testnet, whatever the config says.

import type { RpcClient } from "./rpc.js";

export const GENESIS_HASHES = {
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
} as const;

export class WrongClusterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WrongClusterError";
  }
}

/** Throws unless the node is the cluster the config names: devnet, or a local validator (anything but a public network). */
export async function assertCluster(rpc: Pick<RpcClient, "getGenesisHash">, cluster: "devnet" | "localnet"): Promise<void> {
  const genesis = await rpc.getGenesisHash();
  if (genesis === GENESIS_HASHES["mainnet-beta"]) throw new WrongClusterError("the RPC node is mainnet-beta; this project runs on devnet only");
  if (genesis === GENESIS_HASHES.testnet) throw new WrongClusterError("the RPC node is testnet; this project runs on devnet only");
  if (cluster === "devnet" && genesis !== GENESIS_HASHES.devnet) {
    throw new WrongClusterError(`the RPC node is not devnet (genesis ${genesis}), but SOLANA_CLUSTER is devnet`);
  }
}
