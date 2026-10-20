// A pretend Solana node for the purchase: it answers the handful of calls a purchase makes, remembers every call in order, and
// can be scripted (a network that is not devnet, a balance, what the network says about a transaction poll after poll).

import { base58, base64 } from "@scure/base";
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "../../lib/chain/address";
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
  /** The rent of an account of 60 bytes (a spot), of 0 bytes and of 165 bytes (a token account). */
  rent?: { spot?: number; bare?: number; tokenAccount?: number };
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
  /** The slot answers are from (default 1). */
  slot?: number;
  /** What `getBlockTime` answers for that slot (default 1_700_000_000); `null` when the node does not know. */
  blockTime?: number | null;
  /**
   * What `getTokenAccountsByOwner` answers instead of searching `accounts` (to make the node list accounts it should not). By
   * default it searches like a real node: the mint's program, and the mint and owner fields of its token accounts.
   */
  tokenAccounts?: { pubkey: Address; served: Served }[];
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
      case "getProgramAccounts": {
        // The filters are really applied: the size, and the bytes at an offset, so a wrong offset or size finds nothing.
        const [program, config] = params as [string, { filters: ({ dataSize: number } | { memcmp: { offset: number; bytes: string } })[] }];
        const found = [...script.accounts.entries()].filter(([, s]) => {
          if (s.owner !== program) return false;
          return config.filters.every((f) => {
            if ("dataSize" in f) return s.data.length === f.dataSize;
            const want = base58.decode(f.memcmp.bytes);
            return want.every((b, i) => s.data[f.memcmp.offset + i] === b);
          });
        });
        return reply(found.map(([pubkey, s]) => ({ pubkey, account: { data: [base64.encode(s.data), "base64"], owner: s.owner, lamports: 1, executable: false } })));
      }
      case "getTokenAccountsByOwner": {
        const [owner, filter] = params as [string, { mint: string }];
        const program = script.accounts.get(filter.mint)?.owner;
        if (!script.tokenAccounts && program !== TOKEN_PROGRAM && program !== TOKEN_2022_PROGRAM) {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "Invalid param: not a Token mint" } }));
        }
        const want = (s: Served) => s.owner === program && s.data.length >= 165 && equal(s.data.subarray(0, 32), base58.decode(filter.mint)) && equal(s.data.subarray(32, 64), base58.decode(owner));
        const found = script.tokenAccounts ?? [...script.accounts.entries()].filter(([, s]) => want(s)).map(([pubkey, served]) => ({ pubkey, served }));
        const value = found.map(({ pubkey, served }) => ({ pubkey, account: { data: [base64.encode(served.data), "base64"], owner: served.owner, lamports: 1, executable: false } }));
        return reply({ context: { slot: script.slot ?? 1 }, value });
      }
      case "getBlockTime":
        return reply(script.blockTime === undefined ? 1_700_000_000 : script.blockTime);
      case "getBalance":
        return reply({ context: { slot: 1 }, value: script.lamports ?? 5_000_000 });
      case "getMinimumBalanceForRentExemption":
        return reply(params[0] === 0 ? (script.rent?.bare ?? 890_880) : params[0] === 165 ? (script.rent?.tokenAccount ?? 2_039_280) : (script.rent?.spot ?? 1_308_480));
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

const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
