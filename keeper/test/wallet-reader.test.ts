import { Connection, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { type Fetch, RpcClient } from "../src/solana/rpc.js";
import { RpcWalletReader } from "../src/sweep/wallet.js";
import { addr } from "./support/chain.js";

function node(lamports: number) {
  const requests: { method: string; params: unknown[] }[] = [];
  const fetch: Fetch = async (_url, init) => {
    const { id, method, params } = JSON.parse(init.body) as { id: number; method: string; params: unknown[] };
    requests.push({ method, params });
    const text = JSON.stringify({ jsonrpc: "2.0", id, result: { context: { slot: 7 }, value: lamports } });
    return { ok: true, status: 200, statusText: "OK", text: async () => text } as never;
  };
  return { fetch, requests };
}

describe("RpcWalletReader", () => {
  it("reads a wallet's lamports exactly, above 2^53 included", async () => {
    const n = node(5_000_000_000);
    const reader = new RpcWalletReader(new RpcClient({ url: "http://node", fetch: n.fetch }), "finalized");
    expect(await reader.lamports(addr(9))).toBe(5_000_000_000n);
  });

  it("asks the way web3.js asks, and web3.js reads the same answer", async () => {
    const mine = node(123_456_789);
    await new RpcWalletReader(new RpcClient({ url: "http://node", fetch: mine.fetch }), "finalized").lamports(addr(9));

    const theirs = node(123_456_789);
    const connection = new Connection("http://node", { fetch: theirs.fetch as unknown as typeof fetch });
    expect(await connection.getBalance(new PublicKey(addr(9)), "finalized")).toBe(123_456_789);
    expect(mine.requests).toEqual(theirs.requests);
  });
});
