// What the indexer asks a node: the signatures that touched an address, and the transactions behind them.
// Only finalized data is read, so a fork can never change what was stored.

import type { RpcClient } from "../solana/rpc.js";
import type { Address } from "../solana/pubkey.js";
import type { TransactionJson } from "./parse.js";

export interface SignatureInfo {
  signature: string;
  slot: number;
  /** True if the transaction failed (it changed no balance). */
  failed: boolean;
}

export interface SignaturesQuery {
  /** Continue before this signature (older than it). */
  before?: string;
  /** Stop at this signature (it is not returned). */
  until?: string;
  limit: number;
}

export interface TokenReader {
  /** The finalized transactions that touched `address`, newest first. */
  signatures(address: Address, query: SignaturesQuery): Promise<SignatureInfo[]>;
  /** The transactions with these signatures, in this order. Throws if the node cannot return one of them. */
  transactions(signatures: readonly string[]): Promise<TransactionJson[]>;
}

interface RawSignature {
  signature: string;
  slot: number;
  err: unknown;
}

export interface RpcReaderOptions {
  /** Transactions fetched at the same time. Default 4. */
  concurrency?: number;
}

/** A `TokenReader` over standard JSON-RPC, so it works with any node (a provider's URL included). */
export class RpcTokenReader implements TokenReader {
  private readonly concurrency: number;

  constructor(
    private readonly rpc: RpcClient,
    opts: RpcReaderOptions = {},
  ) {
    this.concurrency = Math.max(1, opts.concurrency ?? 4);
  }

  async signatures(address: Address, query: SignaturesQuery): Promise<SignatureInfo[]> {
    const raw = await this.rpc.call<RawSignature[]>("getSignaturesForAddress", [
      address,
      {
        commitment: "finalized",
        limit: query.limit,
        ...(query.before !== undefined ? { before: query.before } : {}),
        ...(query.until !== undefined ? { until: query.until } : {}),
      },
    ]);
    return raw.map((r) => ({ signature: r.signature, slot: r.slot, failed: r.err !== null && r.err !== undefined }));
  }

  async transactions(signatures: readonly string[]): Promise<TransactionJson[]> {
    const out = new Array<TransactionJson>(signatures.length);
    let next = 0;
    const worker = async () => {
      for (let i = next++; i < signatures.length; i = next++) {
        const signature = signatures[i] as string;
        const tx = await this.rpc.call<TransactionJson | null>("getTransaction", [
          signature,
          { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 },
        ]);
        if (tx === null) throw new Error(`the node has no finalized transaction ${signature}`);
        out[i] = tx;
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, signatures.length) }, worker));
    return out;
  }
}
