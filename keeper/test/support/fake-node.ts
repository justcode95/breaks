// A scripted Solana JSON-RPC node for tests: it answers the few methods the keeper uses, records every
// request, and lets a test decide when a transaction "lands" and what the node says about it. Time is fake:
// `sleep` moves the clock, so nothing here waits.

import { base58, base64 } from "@scure/base";
import { GENESIS_HASHES } from "../../src/solana/cluster.js";
import type { Fetch, SignatureStatus } from "../../src/solana/rpc.js";

interface Landing {
  /** The node starts reporting this after this many status lookups of the transaction. */
  afterLookups: number;
  err: unknown;
  confirmationStatus: SignatureStatus["confirmationStatus"];
  logs?: string[];
}

export class FakeNode {
  public clock = 1_000_000;
  public slot = 500;
  public blockHeight = 10_000;
  /** How far the block height moves each time it is asked for. */
  public heightStep = 0;
  public lastValidOffset = 150;
  public genesis: string = GENESIS_HASHES.devnet;
  public readonly accounts = new Map<string, Uint8Array>();
  /** Every request, in order. */
  public readonly requests: { method: string; params: unknown[] }[] = [];
  /** Raw transactions the node received. */
  public readonly sent: Uint8Array[] = [];
  /** What `sendTransaction` answers with, one entry per call; after the list is used up it accepts. */
  public sendScript: ({ error: { code: number; message: string; data?: unknown } } | "ok" | "http-503")[] = [];
  /** How the transaction lands. Undefined: it never does. */
  public landing: Landing | undefined;
  /** Status lookups by `searchTransactionHistory`, when the transaction is found only there. */
  public historyOnly: Landing | undefined;
  /** Errors for status lookups, one per call, to simulate an outage. */
  public statusFailures = 0;
  /** `getAccountInfo` answers -32016 this many times before answering. */
  public staleReads = 0;
  /** The minContextSlot of every getAccountInfo call. */
  public readonly minContextSlots: (number | undefined)[] = [];
  /**
   * Makes the node execute what it is sent: called with each new transaction (once per signature), it answers
   * whether the node accepts it. A refusal is reported as a preflight failure; an acceptance lands the transaction.
   */
  public execute: ((tx: Uint8Array) => Promise<{ ok: true } | { ok: false; err: unknown; logs?: string[] }>) | undefined;
  /** Where account data comes from, instead of `accounts`. */
  public readAccount: ((address: string) => Promise<Uint8Array | undefined>) | undefined;
  private readonly executed = new Set<string>();
  private lookups = 0;

  readonly now = () => this.clock;
  readonly sleep = async (ms: number) => {
    this.clock += ms;
  };

  readonly fetch: Fetch = async (_url, init) => {
    const { method, params } = JSON.parse(init.body) as { method: string; params: unknown[] };
    this.requests.push({ method, params });
    const reply = (result: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result }) });
    const fail = (code: number, message: string, data?: unknown) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code, message, ...(data !== undefined ? { data } : {}) } }),
    });

    switch (method) {
      case "getGenesisHash":
        return reply(this.genesis);
      case "getLatestBlockhash":
        return reply({ context: { slot: this.slot }, value: { blockhash: "11111111111111111111111111111112", lastValidBlockHeight: this.blockHeight + this.lastValidOffset } });
      case "getBlockHeight":
        this.blockHeight += this.heightStep;
        return reply(this.blockHeight);
      case "getAccountInfo": {
        const opts = params[1] as { minContextSlot?: number };
        this.minContextSlots.push(opts.minContextSlot);
        if (this.staleReads > 0) {
          this.staleReads--;
          return fail(-32016, "Minimum context slot has not been reached");
        }
        const data = this.readAccount ? await this.readAccount(params[0] as string) : this.accounts.get(params[0] as string);
        return reply({ context: { slot: this.slot }, value: data ? { data: [base64.encode(data), "base64"], owner: "11111111111111111111111111111111", lamports: 1, executable: false } : null });
      }
      case "sendTransaction": {
        const step = this.sendScript.shift() ?? "ok";
        if (step === "http-503") return { ok: false, status: 503, text: async () => "unavailable" };
        if (step !== "ok") return fail(step.error.code, step.error.message, step.error.data);
        const bytes = base64.decode(params[0] as string);
        const signature = signatureOf(bytes);
        if (this.execute && !this.executed.has(signature)) {
          const verdict = await this.execute(bytes);
          if (!verdict.ok) return fail(-32002, "Transaction simulation failed", { err: verdict.err, logs: verdict.logs ?? null });
          this.executed.add(signature);
          this.landing = { afterLookups: 0, err: null, confirmationStatus: "confirmed" };
          this.lookups = 0;
        }
        this.sent.push(bytes);
        return reply(signature);
      }
      case "getSignatureStatuses": {
        if (this.statusFailures > 0) {
          this.statusFailures--;
          return fail(-32005, "Node is unhealthy");
        }
        const history = (params[1] as { searchTransactionHistory: boolean }).searchTransactionHistory;
        this.lookups++;
        const source = history ? (this.historyOnly ?? this.landing) : this.landing;
        // A transaction can only land after the node accepted a send of it.
        const landed = source && this.sent.length > 0 && (history || this.lookups > source.afterLookups) ? source : undefined;
        return reply({ context: { slot: this.slot }, value: [landed ? { slot: this.slot, confirmations: null, err: landed.err, confirmationStatus: landed.confirmationStatus } : null] });
      }
      case "getTransaction":
        return reply({ meta: { logMessages: this.landing?.logs ?? null } });
      default:
        return fail(-32601, `Method not found: ${method}`);
    }
  };
}

/** The id of a transaction: its first signature, after the length prefix. */
export function signatureOf(tx: Uint8Array): string {
  return base58.encode(tx.slice(1, 65));
}
