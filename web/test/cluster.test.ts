import { readFileSync } from "node:fs";
import { join } from "node:path";
import { base58 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { GENESIS_HASHES, checkDevnet } from "../lib/chain/cluster";
import { RpcFailure, rpc } from "../lib/chain/rpc";
import { rpcNode } from "./support/node";

const check = (genesis?: string, failing?: string[]) => {
  const node = rpcNode({ accounts: new Map(), ...(genesis ? { genesis } : {}), ...(failing ? { failing } : {}) });
  return checkDevnet({ url: "http://node.test", fetch: node.fetchFn }).then((r) => ({ r, node }));
};

describe("which network the node is", () => {
  it("accepts devnet and only devnet", async () => {
    expect((await check()).r).toEqual({ ok: true });
    expect((await check(GENESIS_HASHES.devnet)).r).toEqual({ ok: true });
  });

  it("refuses mainnet and testnet by name, and anything it does not know", async () => {
    expect((await check(GENESIS_HASHES["mainnet-beta"])).r).toEqual({ ok: false, reason: "This site's node is Solana mainnet. The site only works on devnet, so nothing was sent." });
    expect((await check(GENESIS_HASHES.testnet)).r).toEqual({ ok: false, reason: "This site's node is Solana testnet. The site only works on devnet, so nothing was sent." });
    const unknown = (await check("SomeOtherNetworkGenesisHash1111111111111111111")).r;
    expect(unknown).toEqual({ ok: false, reason: "This site's node is not Solana devnet (its first block is SomeOtherNetworkGenesisHash1111111111111111111), so nothing was sent." });
  });

  it("refuses when the node says something that is not a hash, or cannot be asked", async () => {
    const node = (genesis: unknown) => checkDevnet({ url: "http://node.test", fetch: (async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: genesis }))) as unknown as typeof fetch });
    expect(await node(42)).toEqual({ ok: false, reason: "This site's node is not Solana devnet, so nothing was sent." });
    expect(await node(null)).toMatchObject({ ok: false });
    expect(await node("x".repeat(100))).toMatchObject({ ok: false, reason: `This site's node is not Solana devnet (its first block is ${"x".repeat(60)}), so nothing was sent.` });
    const down = (await check(undefined, ["getGenesisHash"])).r;
    expect(down).toMatchObject({ ok: false });
    expect((down as { reason: string }).reason).toBe("Could not check which network the node is on (the node refused the request: getGenesisHash is failing), so nothing was sent.");
    const offline = await checkDevnet({ url: "http://node.test", fetch: (async () => Promise.reject(new Error("offline"))) as unknown as typeof fetch });
    expect(offline).toMatchObject({ ok: false });
    expect((offline as { reason: string }).reason).toContain("could not reach the node: offline");
  });

  it("knows each network by a first-block hash that is a real 32-byte address, the same as the keeper's", () => {
    for (const hash of Object.values(GENESIS_HASHES)) expect(base58.decode(hash)).toHaveLength(32);
    const keeper = readFileSync(join(import.meta.dirname, "..", "..", "keeper", "src", "solana", "cluster.ts"), "utf8");
    for (const [name, hash] of Object.entries(GENESIS_HASHES)) expect(keeper, name).toContain(`"${hash}"`);
    expect(new Set(Object.values(GENESIS_HASHES)).size).toBe(3);
  });
});

describe("one call to a node", () => {
  const answer = (body: unknown, init: ResponseInit = {}) => (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), init)) as unknown as typeof fetch;
  const call = (fetchFn: typeof fetch) => rpc<unknown>({ url: "http://node.test", fetch: fetchFn }, "getBalance", ["abc", { commitment: "confirmed" }]);

  it("sends a JSON-RPC request with the method and its parameters, and returns the result", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: 5 } }));
    }) as unknown as typeof fetch;
    expect(await call(fetchFn)).toEqual({ value: 5 });
    expect(seen[0]?.url).toBe("http://node.test");
    expect(seen[0]?.init.method).toBe("POST");
    expect(JSON.parse(seen[0]?.init.body as string)).toEqual({ jsonrpc: "2.0", id: 1, method: "getBalance", params: ["abc", { commitment: "confirmed" }] });
  });

  it("says in words when the node cannot be reached, answers badly, or refuses", async () => {
    await expect(call((async () => Promise.reject(new Error("offline"))) as unknown as typeof fetch)).rejects.toThrow(new RpcFailure("could not reach the node: offline"));
    await expect(call(answer("busy", { status: 503 }))).rejects.toThrow("the node answered 503");
    await expect(call(answer("not json"))).rejects.toThrow("the node's answer was not JSON");
    await expect(call(answer({ error: { message: "slow down" } }))).rejects.toThrow("the node refused the request: slow down");
    await expect(call(answer({ error: {} }))).rejects.toThrow("the node refused the request: no reason given");
    await expect(call(answer({ error: { message: "x".repeat(300) } }))).rejects.toMatchObject({ message: `the node refused the request: ${"x".repeat(200)}` });
  });
});
