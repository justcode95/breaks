// A small JSON-RPC client for the Solana methods the keeper needs. `fetch` is injectable so the tests can
// script a node's answers; nothing here talks to the network on its own.

import { base64 } from "@scure/base";
import { type Address } from "./pubkey.js";

export type Commitment = "confirmed" | "finalized";

/** An error the node answered with (JSON-RPC `error`), or a transport failure after the retries ran out. */
export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export interface FetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}
export type Fetch = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<FetchResponse>;

export interface RpcOptions {
  url: string;
  fetch?: Fetch;
  /** Per request. Default 15 s. */
  timeoutMs?: number;
  /** Extra tries after a transport failure, a 429 or a 5xx. Default 3. */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SignatureStatus {
  slot: number;
  /** Null while the transaction has not failed. Otherwise the node's description of the error. */
  err: unknown;
  confirmationStatus: "processed" | "confirmed" | "finalized" | null;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class RpcClient {
  private readonly fetchImpl: Fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private nextId = 1;

  constructor(private readonly opts: RpcOptions) {
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as Fetch);
    this.sleep = opts.sleep ?? realSleep;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.retries = opts.retries ?? 3;
  }

  /** One JSON-RPC call. Transport failures, 429 and 5xx are retried with a growing pause; a node's `error` is not. */
  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const body = JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params });
    let lastError = "no attempt made";
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) await this.sleep(250 * 2 ** (attempt - 1));
      let text: string;
      try {
        const response = await this.fetchImpl(this.opts.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (response.status === 429 || response.status >= 500) {
          lastError = `${method}: HTTP ${response.status}`;
          continue;
        }
        if (!response.ok) throw new RpcError(`${method}: HTTP ${response.status}`);
        text = await response.text();
      } catch (err) {
        if (err instanceof RpcError) throw err;
        lastError = `${method}: ${err instanceof Error ? err.message : String(err)}`;
        continue;
      }
      let json: { result?: T; error?: { code: number; message: string; data?: unknown } };
      try {
        json = JSON.parse(text);
      } catch {
        throw new RpcError(`${method}: the node did not answer with JSON`);
      }
      if (json.error) throw new RpcError(`${method}: ${json.error.message}`, json.error.code, json.error.data);
      return json.result as T;
    }
    throw new RpcError(`${lastError} (gave up after ${this.retries + 1} tries)`);
  }

  async getGenesisHash(): Promise<string> {
    return this.call<string>("getGenesisHash");
  }

  async getAccountInfo(
    address: Address,
    opts: { commitment: Commitment; minContextSlot?: number },
  ): Promise<{ data: Uint8Array; owner: Address; slot: number } | undefined> {
    const result = await this.call<{ context: { slot: number }; value: { data: [string, string]; owner: string } | null }>("getAccountInfo", [
      address,
      { encoding: "base64", commitment: opts.commitment, ...(opts.minContextSlot !== undefined ? { minContextSlot: opts.minContextSlot } : {}) },
    ]);
    if (!result.value) return undefined;
    return { data: base64.decode(result.value.data[0]), owner: result.value.owner, slot: result.context.slot };
  }

  async getLatestBlockhash(commitment: Commitment): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    const result = await this.call<{ value: { blockhash: string; lastValidBlockHeight: number } }>("getLatestBlockhash", [{ commitment }]);
    return result.value;
  }

  async getBlockHeight(commitment: Commitment): Promise<number> {
    return this.call<number>("getBlockHeight", [{ commitment }]);
  }

  /** Sends a signed transaction. The node simulates it first (preflight) and refuses it if the simulation fails. */
  async sendTransaction(transaction: Uint8Array, preflightCommitment: Commitment): Promise<string> {
    return this.call<string>("sendTransaction", [
      base64.encode(transaction),
      { encoding: "base64", skipPreflight: false, preflightCommitment, maxRetries: 0 },
    ]);
  }

  /** The state of a transaction, or null if the node does not know it. `history` also searches old blocks. */
  async getSignatureStatus(signature: string, history: boolean): Promise<SignatureStatus | null> {
    const result = await this.call<{ value: (SignatureStatus | null)[] }>("getSignatureStatuses", [[signature], { searchTransactionHistory: history }]);
    return result.value[0] ?? null;
  }

  /** The program log of a landed transaction, for explaining why it failed. Null if the node cannot give it. */
  async getTransactionLogs(signature: string, commitment: Commitment): Promise<string[] | null> {
    const result = await this.call<{ meta: { logMessages: string[] | null } | null } | null>("getTransaction", [
      signature,
      { encoding: "json", commitment, maxSupportedTransactionVersion: 0 },
    ]);
    return result?.meta?.logMessages ?? null;
  }
}
