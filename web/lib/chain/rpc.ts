// Reads from a Solana node (JSON-RPC) from the browser: the accounts the pages show, and the few other facts a purchase needs.

import { base64 } from "@scure/base";
import type { Address } from "./address";

export interface RpcAccount {
  data: Uint8Array;
  owner: Address;
}

export class RpcFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcFailure";
  }
}

export interface RpcOptions {
  url: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** One JSON-RPC call. Says in words what went wrong: the node is unreachable, answers badly, or refuses the request. */
export async function rpc<T>(opts: RpcOptions, method: string, params: readonly unknown[]): Promise<T> {
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(opts.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
  } catch (err) {
    throw new RpcFailure(`could not reach the node: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new RpcFailure(`the node answered ${res.status}`);

  let body: { error?: { message?: unknown }; result?: unknown };
  try {
    body = await res.json();
  } catch {
    throw new RpcFailure("the node's answer was not JSON");
  }
  if (body.error) throw new RpcFailure(`the node refused the request: ${String(body.error.message ?? "no reason given").slice(0, 200)}`);
  return body.result as T;
}

/** The most addresses the node takes in one `getMultipleAccounts`. */
const BATCH = 100;

/**
 * The accounts at `addresses`, in order; `null` for one that does not exist. Read at `finalized` unless told otherwise, so
 * what comes back cannot roll back.
 */
export async function getAccounts(opts: RpcOptions & { addresses: readonly Address[]; commitment?: "finalized" | "confirmed" }): Promise<(RpcAccount | null)[]> {
  const out: (RpcAccount | null)[] = [];
  for (let i = 0; i < opts.addresses.length; i += BATCH) {
    out.push(...(await batch(opts, opts.addresses.slice(i, i + BATCH))));
  }
  return out;
}

async function batch(opts: RpcOptions & { commitment?: "finalized" | "confirmed" }, addresses: readonly Address[]): Promise<(RpcAccount | null)[]> {
  const result = await rpc<{ value?: ({ data?: unknown; owner?: unknown } | null)[] }>(opts, "getMultipleAccounts", [addresses, { encoding: "base64", commitment: opts.commitment ?? "finalized" }]);
  const value = result?.value;
  if (!Array.isArray(value) || value.length !== addresses.length) throw new RpcFailure("the node's answer did not have one entry per account");
  return value.map((v) => {
    if (v === null) return null;
    const data = Array.isArray(v.data) ? v.data[0] : undefined;
    if (typeof data !== "string" || typeof v.owner !== "string") throw new RpcFailure("the node's answer for an account was malformed");
    return { data: base64.decode(data), owner: v.owner };
  });
}

export interface ProgramAccount {
  address: Address;
  account: RpcAccount;
}

/**
 * The accounts of `program` that are exactly `dataSize` bytes long and hold `bytes` (an address) at `offset`: the node does the
 * searching, so what comes back still has to be checked by whoever asked (an account is only the program's if its owner says so
 * and its address is the one it should have).
 */
export async function getProgramAccounts(
  opts: RpcOptions & { program: Address; dataSize: number; memcmp: { offset: number; bytes: Address }; commitment?: "finalized" | "confirmed" },
): Promise<ProgramAccount[]> {
  const result = await rpc<unknown>(opts, "getProgramAccounts", [
    opts.program,
    { encoding: "base64", commitment: opts.commitment ?? "finalized", filters: [{ dataSize: opts.dataSize }, { memcmp: { offset: opts.memcmp.offset, bytes: opts.memcmp.bytes } }] },
  ]);
  if (!Array.isArray(result)) throw new RpcFailure("the node's answer was not a list of accounts");
  return result.map((entry: { pubkey?: unknown; account?: { data?: unknown; owner?: unknown } } | null) => {
    const data = Array.isArray(entry?.account?.data) ? entry?.account?.data[0] : undefined;
    if (typeof entry?.pubkey !== "string" || typeof data !== "string" || typeof entry.account?.owner !== "string") {
      throw new RpcFailure("the node's answer for an account was malformed");
    }
    return { address: entry.pubkey, account: { data: base64.decode(data), owner: entry.account.owner } };
  });
}

/**
 * `owner`'s token accounts for `mint` (of either token program: the node finds the program from the mint), and the slot the
 * answer is from. As with `getProgramAccounts`, the node does the searching, so each account still has to be checked.
 */
export async function getTokenAccountsByOwner(
  opts: RpcOptions & { owner: Address; mint: Address; commitment?: "finalized" | "confirmed" },
): Promise<{ slot: number; accounts: ProgramAccount[] }> {
  const result = await rpc<{ context?: { slot?: unknown }; value?: unknown } | null>(opts, "getTokenAccountsByOwner", [
    opts.owner,
    { mint: opts.mint },
    { encoding: "base64", commitment: opts.commitment ?? "finalized" },
  ]);
  const slot = result?.context?.slot;
  if (typeof slot !== "number" || !Number.isSafeInteger(slot) || slot < 0) throw new RpcFailure("the node's answer did not say which slot it is from");
  if (!Array.isArray(result?.value)) throw new RpcFailure("the node's answer was not a list of accounts");
  const accounts = result.value.map((entry: { pubkey?: unknown; account?: { data?: unknown; owner?: unknown } } | null) => {
    const data = Array.isArray(entry?.account?.data) ? entry?.account?.data[0] : undefined;
    if (typeof entry?.pubkey !== "string" || typeof data !== "string" || typeof entry.account?.owner !== "string") {
      throw new RpcFailure("the node's answer for an account was malformed");
    }
    return { address: entry.pubkey, account: { data: base64.decode(data), owner: entry.account.owner } };
  });
  return { slot, accounts };
}

/** When the block of `slot` was made, in seconds since 1970, as the chain records it; `null` when the node does not know. */
export async function getBlockTime(opts: RpcOptions, slot: number): Promise<number | null> {
  const result = await rpc<unknown>(opts, "getBlockTime", [slot]);
  if (result === null) return null;
  if (typeof result !== "number" || !Number.isSafeInteger(result)) throw new RpcFailure("the node's answer for a block's time was not a whole number");
  return result;
}

export interface SignatureInfo {
  signature: string;
  slot: number;
  /** When its block was made (seconds since 1970); `null` when the node does not say. */
  blockTime: number | null;
  /** The transaction failed: it changed nothing but the fee. */
  failed: boolean;
}

/**
 * Up to `limit` of the transactions that name `address`, newest first, at `finalized`; `before` continues from an older one. The
 * node does the searching, so a transaction's effects still have to be read from the transaction itself.
 */
export async function getSignaturesForAddress(opts: RpcOptions & { address: Address; limit: number; before?: string }): Promise<SignatureInfo[]> {
  const result = await rpc<unknown>(opts, "getSignaturesForAddress", [
    opts.address,
    { limit: opts.limit, commitment: "finalized", ...(opts.before !== undefined ? { before: opts.before } : {}) },
  ]);
  if (!Array.isArray(result)) throw new RpcFailure("the node's answer was not a list of transactions");
  return result.map((entry: { signature?: unknown; slot?: unknown; blockTime?: unknown; err?: unknown } | null) => {
    const { signature, slot, blockTime, err } = entry ?? {};
    if (typeof signature !== "string" || typeof slot !== "number" || !Number.isSafeInteger(slot) || slot < 0) {
      throw new RpcFailure("the node's answer for a transaction was malformed");
    }
    if (blockTime !== null && blockTime !== undefined && (typeof blockTime !== "number" || !Number.isSafeInteger(blockTime))) {
      throw new RpcFailure("the node's answer for a transaction's time was not a whole number");
    }
    return { signature, slot, blockTime: blockTime ?? null, failed: err !== null && err !== undefined };
  });
}

/** The transaction with `signature` as the node reads it (`jsonParsed`, `finalized`), still to be checked; `null` when it has none. */
export async function getTransaction(opts: RpcOptions & { signature: string }): Promise<unknown> {
  return rpc<unknown>(opts, "getTransaction", [opts.signature, { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 }]);
}
