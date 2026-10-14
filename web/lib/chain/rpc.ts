// Reads accounts from a Solana node (JSON-RPC `getMultipleAccounts`) from the browser.

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

/** The most addresses the node takes in one `getMultipleAccounts`. */
const BATCH = 100;

/**
 * The accounts at `addresses`, in order; `null` for one that does not exist. Read at `finalized`, so what comes back
 * cannot roll back.
 */
export async function getAccounts(opts: { url: string; addresses: readonly Address[]; fetch?: typeof fetch; timeoutMs?: number }): Promise<(RpcAccount | null)[]> {
  const out: (RpcAccount | null)[] = [];
  for (let i = 0; i < opts.addresses.length; i += BATCH) {
    out.push(...(await batch(opts, opts.addresses.slice(i, i + BATCH))));
  }
  return out;
}

async function batch(opts: { url: string; fetch?: typeof fetch; timeoutMs?: number }, addresses: readonly Address[]): Promise<(RpcAccount | null)[]> {
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(opts.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [addresses, { encoding: "base64", commitment: "finalized" }] }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
  } catch (err) {
    throw new RpcFailure(`could not reach the node: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new RpcFailure(`the node answered ${res.status}`);

  let body: { error?: { message?: unknown }; result?: { value?: ({ data?: unknown; owner?: unknown } | null)[] } };
  try {
    body = await res.json();
  } catch {
    throw new RpcFailure("the node's answer was not JSON");
  }
  if (body.error) throw new RpcFailure(`the node refused the request: ${String(body.error.message ?? "no reason given").slice(0, 200)}`);
  const value = body.result?.value;
  if (!Array.isArray(value) || value.length !== addresses.length) throw new RpcFailure("the node's answer did not have one entry per account");
  return value.map((v) => {
    if (v === null) return null;
    const data = Array.isArray(v.data) ? v.data[0] : undefined;
    if (typeof data !== "string" || typeof v.owner !== "string") throw new RpcFailure("the node's answer for an account was malformed");
    return { data: base64.decode(data), owner: v.owner };
  });
}
