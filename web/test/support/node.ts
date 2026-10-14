// A pretend Solana node for the purchase: it answers the handful of calls a purchase makes, remembers every call in order, and
// can be scripted (a network that is not devnet, a balance, what the network says about a transaction poll after poll).

import { base64 } from "@scure/base";
import { GENESIS_HASHES } from "../../lib/chain/cluster";
import type { Address } from "../../lib/chain/address";
import type { Served } from "./accounts";

export interface Status {
  err: unknown;
  confirmationStatus?: string | null;
}

export interface NodeScript {
  accounts: Map<Address, Served>;
  genesis?: string;
  lamports?: number;
  /** The rent of an account of 60 bytes and of 0 bytes. */
  rent?: { spot: number; bare: number };
  blockhash?: string;
  lastValidBlockHeight?: number;
  /** What `getSignatureStatuses` answers, one entry per call; the last one repeats. `"fail"` makes that call fail. */
  statuses?: (Status | null | "fail")[];
  /** What `getBlockHeight` answers, one per call; the last one repeats. */
  heights?: number[];
  /** Methods that always fail with an error from the node. */
  failing?: string[];
  /** What the node says when it fails (default: "<method> is failing"). */
  failMessage?: string;
}

export interface Call {
  method: string;
  params: unknown[];
}

export function rpcNode(script: NodeScript) {
  const calls: Call[] = [];
  let statusCalls = 0;
  let heightCalls = 0;
  const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const { method, params } = JSON.parse(init.body as string) as { method: string; params: unknown[] };
    calls.push({ method, params });
    if (script.failing?.includes(method)) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: script.failMessage ?? `${method} is failing` } }));
    switch (method) {
      case "getGenesisHash":
        return reply(script.genesis ?? GENESIS_HASHES.devnet);
      case "getMultipleAccounts": {
        const value = (params[0] as string[]).map((a) => {
          const s = script.accounts.get(a);
          return s ? { data: [base64.encode(s.data), "base64"], owner: s.owner, lamports: 1, executable: false } : null;
        });
        return reply({ context: { slot: 1 }, value });
      }
      case "getBalance":
        return reply({ context: { slot: 1 }, value: script.lamports ?? 5_000_000 });
      case "getMinimumBalanceForRentExemption":
        return reply(params[0] === 0 ? (script.rent?.bare ?? 890_880) : (script.rent?.spot ?? 1_308_480));
      case "getLatestBlockhash":
        return reply({ context: { slot: 1 }, value: { blockhash: script.blockhash, lastValidBlockHeight: script.lastValidBlockHeight ?? 1000 } });
      case "getSignatureStatuses": {
        const list = script.statuses ?? [null];
        const entry = list[Math.min(statusCalls++, list.length - 1)];
        if (entry === "fail") return new Response("busy", { status: 503 });
        return reply({ context: { slot: 1 }, value: [entry ?? null] });
      }
      case "getBlockHeight": {
        const list = script.heights ?? [0];
        return reply(list[Math.min(heightCalls++, list.length - 1)]);
      }
      default:
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: `no ${method} here` } }));
    }
  }) as unknown as typeof fetch;
  return { fetchFn, calls, methods: () => calls.map((c) => c.method) };
}
