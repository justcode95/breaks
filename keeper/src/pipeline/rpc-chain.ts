// The real ChainClient: JSON-RPC against a Solana node, signing with the keeper key.
//
// What matters here, in order:
//  1. Never send to the wrong network: `connect` checks the node's genesis hash first.
//  2. Never claim more than is known. `confirmed` only when the node says the transaction landed and
//     succeeded; `failed` only when the chain did not change (the node refused it in preflight, it landed and
//     reverted, or its blockhash expired and it is certainly not coming); anything else is `unknown`, and the
//     pipeline then waits and reads the chain instead of guessing.
//  3. Read what we wrote: after a confirmed send, reads ask the node for data at least as new as that slot
//     (`minContextSlot`), so a lagging node cannot hand back the state from before our own transaction.

import type { Config } from "../config.js";
import type { Logger } from "../job.js";
import { type Commitment, type Fetch, RpcClient, RpcError } from "../solana/rpc.js";
import { assertCluster } from "../solana/cluster.js";
import type { Instruction } from "../solana/instruction.js";
import { type Signer, loadSignerFromFile } from "../solana/keypair.js";
import type { Address } from "../solana/pubkey.js";
import { compileMessage, signTransaction, signatureToString } from "../solana/transaction.js";
import type { ChainClient, SendResult } from "./chain.js";

export interface RpcChainOptions {
  rpc: RpcClient;
  /** The keeper key: fee payer and the signer the programs expect. */
  signer: Signer;
  cluster: "devnet" | "localnet";
  /** What "landed" means, for sends and for reads. Default `confirmed`. */
  commitment?: Commitment;
  /** Pause between looks at a transaction's status. Default 1 s. */
  pollMs?: number;
  /** Send the same signed transaction again when it has not landed after this long. Default 4 s. */
  rebroadcastMs?: number;
  /** Stop waiting after this long and answer `unknown`. Default 90 s (a blockhash lives about 60-90 s). */
  maxWaitMs?: number;
  log?: Logger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const RANK: Record<string, number> = { processed: 0, confirmed: 1, finalized: 2 };

/** Anchor writes "Error Code: Name. Error Number: 6004." in the program log of a failed instruction. */
function anchorError(logs: readonly string[] | null | undefined): string | undefined {
  for (const line of logs ?? []) {
    const m = /Error Code: (\w+)\. Error Number: (\d+)/.exec(line);
    if (m) return `${m[1]} (${m[2]})`;
  }
  return undefined;
}

/** A short, readable reason for the operator: the program's own error name when the log has it. */
export function describeTransactionError(err: unknown, logs?: readonly string[] | null): string {
  const anchor = anchorError(logs);
  const raw = typeof err === "string" ? err : JSON.stringify(err);
  return anchor ? `${anchor}: ${raw}` : raw;
}

type Preflight = "wait" | { reason: string } | undefined;

/** What a refused `sendTransaction` means. `undefined` means it was not a preflight verdict (node trouble). */
function preflightVerdict(err: RpcError): Preflight {
  if (err.code !== -32002) return undefined;
  const data = err.data as { err?: unknown; logs?: string[] | null } | undefined;
  const e = data?.err;
  // The node has not seen the blockhash yet, or already has the transaction: neither says the chain won't change.
  if (e === "BlockhashNotFound" || e === "AlreadyProcessed") return "wait";
  return { reason: describeTransactionError(e ?? err.message, data?.logs) };
}

export class RpcChainClient implements ChainClient {
  private readonly rpc: RpcClient;
  private readonly signer: Signer;
  private readonly commitment: Commitment;
  private readonly pollMs: number;
  private readonly rebroadcastMs: number;
  private readonly maxWaitMs: number;
  private readonly log?: Logger;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** The newest slot at which one of our own transactions landed. */
  private minSlot: number | undefined;

  private constructor(opts: RpcChainOptions) {
    this.rpc = opts.rpc;
    this.signer = opts.signer;
    this.commitment = opts.commitment ?? "confirmed";
    this.pollMs = opts.pollMs ?? 1_000;
    this.rebroadcastMs = opts.rebroadcastMs ?? 4_000;
    this.maxWaitMs = opts.maxWaitMs ?? 90_000;
    if (opts.log) this.log = opts.log;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  /** The keeper's address: the fee payer and the signer of every transaction. */
  get keeper(): Address {
    return this.signer.address;
  }

  /** Checks which network the node is on (devnet only; see `assertCluster`) before handing out a client. */
  static async connect(opts: RpcChainOptions): Promise<RpcChainClient> {
    await assertCluster(opts.rpc, opts.cluster);
    return new RpcChainClient(opts);
  }

  async getAccountData(address: Address): Promise<Uint8Array | undefined> {
    for (let attempt = 0; ; attempt++) {
      try {
        const info = await this.rpc.getAccountInfo(address, {
          commitment: this.commitment,
          ...(this.minSlot !== undefined ? { minContextSlot: this.minSlot } : {}),
        });
        return info?.data;
      } catch (err) {
        // -32016: the node has not reached the slot of our last transaction yet. Give it a moment.
        if (err instanceof RpcError && err.code === -32016 && attempt < 10) {
          await this.sleep(300);
          continue;
        }
        throw err;
      }
    }
  }

  async sendAndConfirm(instructions: Instruction[]): Promise<SendResult> {
    // Nothing is sent before this succeeds, so an RPC outage here is an error, not an unknown result.
    const { blockhash, lastValidBlockHeight } = await this.rpc.getLatestBlockhash(this.commitment);
    const tx = signTransaction(compileMessage(this.signer.address, instructions, blockhash), [this.signer]);
    const signature = signatureToString(tx.signatures[0] as Uint8Array);

    const start = this.now();
    let lastSent = Number.NEGATIVE_INFINITY;
    let trouble: string | undefined;

    for (;;) {
      if (this.now() - lastSent >= this.rebroadcastMs) {
        lastSent = this.now();
        try {
          await this.rpc.sendTransaction(tx.bytes, this.commitment);
        } catch (err) {
          if (!(err instanceof RpcError)) throw err;
          const verdict = preflightVerdict(err);
          if (verdict && verdict !== "wait") return { outcome: "failed", reason: verdict.reason, signature };
          if (!verdict) trouble = err.message;
        }
      }

      try {
        const status = await this.rpc.getSignatureStatus(signature, false);
        const done = await this.settle(signature, status);
        if (done) return done;
        if (!status) {
          const height = await this.rpc.getBlockHeight(this.commitment);
          if (height > lastValidBlockHeight) return this.afterExpiry(signature);
        }
      } catch (err) {
        if (!(err instanceof RpcError)) throw err;
        trouble = err.message;
      }

      if (this.now() - start >= this.maxWaitMs) {
        return { outcome: "unknown", reason: `not confirmed within ${this.maxWaitMs} ms${trouble ? ` (${trouble})` : ""}`, signature };
      }
      await this.sleep(this.pollMs);
    }
  }

  /** A final answer from a status, or undefined if the transaction is still on its way. */
  private async settle(
    signature: string,
    status: { slot: number; err: unknown; confirmationStatus: string | null } | null,
  ): Promise<SendResult | undefined> {
    if (!status) return undefined;
    if (status.err) {
      // Landed and reverted. The log, if the node gives it, names the program error.
      let logs: string[] | null = null;
      try {
        logs = await this.rpc.getTransactionLogs(signature, this.commitment);
      } catch {
        // The reason is a courtesy; the failure stands without it.
      }
      this.log?.error("transaction reverted", { signature });
      return { outcome: "failed", reason: describeTransactionError(status.err, logs), signature };
    }
    const reached = RANK[status.confirmationStatus ?? ""] ?? -1;
    if (reached >= (RANK[this.commitment] as number)) {
      this.minSlot = Math.max(this.minSlot ?? 0, status.slot);
      this.log?.info("transaction confirmed", { signature, slot: status.slot });
      return { outcome: "confirmed", signature };
    }
    return undefined;
  }

  /** The blockhash is too old for the transaction to land any more; one last look in case it landed at the very end. */
  private async afterExpiry(signature: string): Promise<SendResult> {
    const last = await this.rpc.getSignatureStatus(signature, true);
    const done = await this.settle(signature, last);
    if (done) return done;
    if (last) return { outcome: "unknown", reason: "expired while only processed", signature };
    return { outcome: "failed", reason: "expired: the blockhash expired before the transaction landed", signature };
  }
}

/**
 * The client the keeper runs with: the node from `SOLANA_RPC_URL`, the key from `KEEPER_KEYPAIR_PATH`, devnet
 * only. Throws before anything is sent if the key is missing or the node is on the wrong network.
 */
export async function connectFromConfig(
  config: Pick<Config, "rpcUrl" | "cluster" | "commitment" | "keeperKeypairPath">,
  deps: { log?: Logger; fetch?: Fetch } = {},
): Promise<RpcChainClient> {
  if (!config.keeperKeypairPath) throw new Error("KEEPER_KEYPAIR_PATH is not set: the keeper has no key to sign with");
  const signer = loadSignerFromFile(config.keeperKeypairPath);
  const rpc = new RpcClient({ url: config.rpcUrl, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  return RpcChainClient.connect({
    rpc,
    signer,
    cluster: config.cluster,
    commitment: config.commitment,
    ...(deps.log ? { log: deps.log } : {}),
  });
}
