import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Address, TOKEN_PROGRAM, associatedTokenAddress, configAddress } from "../lib/chain/address";
import { loadUsdcBalance } from "../lib/chain/balance";
import { LoadError } from "../lib/chain/load";
import { type ConfigFields, type Served, configFieldsFromVector, encodeConfig, encodeTokenAccount, fakeNode } from "./support/accounts";
import { fill } from "./support/wallet";

const vectors: { programs: { breaks: string }; cases: { name: string; outputs: Record<string, any> | null }[] } = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "programs", "breaks", "instruction-vectors.json"), "utf8"),
);
const PROGRAM = vectors.programs.breaks;
const CONFIG: ConfigFields = configFieldsFromVector(vectors.cases.find((c) => c.name === "breaks.account.BreaksConfig")?.outputs as Record<string, any>);
const WALLET = fill(5);
const ATA = associatedTokenAddress(WALLET, CONFIG.usdcMint);

interface World {
  config?: Served | null;
  token?: Served | null;
}

function node(over: World = {}) {
  const accounts = new Map<Address, Served>();
  const config = over.config === undefined ? { data: encodeConfig(CONFIG), owner: PROGRAM } : over.config;
  if (config) accounts.set(configAddress(PROGRAM), config);
  const token = over.token === undefined ? { data: encodeTokenAccount({ mint: CONFIG.usdcMint, owner: WALLET, amount: 25_000_000n }), owner: TOKEN_PROGRAM } : over.token;
  if (token) accounts.set(ATA, token);
  return fakeNode(accounts);
}

const load = (n: ReturnType<typeof node>, owner = WALLET) => loadUsdcBalance({ rpcUrl: "http://node.test", program: PROGRAM, owner, fetch: n.fetchFn });

describe("a wallet's USDC balance", () => {
  it("is what the wallet's USDC account holds, in the USDC the program uses", async () => {
    const n = node();
    expect(await load(n)).toEqual({ mint: CONFIG.usdcMint, account: ATA, balance: 25_000_000n });
    // The config is read first (it names the mint), then the wallet's account for that mint, at finalized.
    expect(n.requests.map((r) => r.addresses)).toEqual([[configAddress(PROGRAM)], [ATA]]);
    expect(n.requests.every((r) => r.config.commitment === "finalized")).toBe(true);
  });

  it("is zero for an account that holds nothing, and null for a wallet that has no USDC account yet", async () => {
    expect(await load(node({ token: { data: encodeTokenAccount({ mint: CONFIG.usdcMint, owner: WALLET, amount: 0n }), owner: TOKEN_PROGRAM } }))).toMatchObject({ balance: 0n });
    expect(await load(node({ token: null }))).toEqual({ mint: CONFIG.usdcMint, account: ATA, balance: null });
  });

  it("looks in the account of the wallet it was asked about", async () => {
    const other = fill(6);
    const n = node();
    expect((await load(n, other)).account).toBe(associatedTokenAddress(other, CONFIG.usdcMint));
    expect((await load(n, other)).balance).toBeNull();
  });

  it("refuses a program that is not set up, or a config it does not own or cannot read", async () => {
    await expect(load(node({ config: null }))).rejects.toThrow(/has not been set up on this network/);
    await expect(load(node({ config: { data: encodeConfig(CONFIG), owner: fill(9) } }))).rejects.toThrow("The config account is not owned by the breaks program.");
    await expect(load(node({ config: { data: new Uint8Array(50), owner: PROGRAM } }))).rejects.toThrow(/config account could not be read/);
  });

  it("refuses a wallet account that is not what a USDC account must be", async () => {
    const acct = (over: { owner?: Address; mint?: Address; authority?: Address; state?: 0 | 1 | 2; programOwner?: Address }): World => ({
      token: { data: encodeTokenAccount({ mint: over.mint ?? CONFIG.usdcMint, owner: over.authority ?? WALLET, amount: 1n, ...(over.state === undefined ? {} : { state: over.state }) }), owner: over.programOwner ?? TOKEN_PROGRAM },
    });
    await expect(load(node(acct({ programOwner: fill(9) })))).rejects.toThrow("is not a token account");
    await expect(load(node(acct({ mint: fill(9) })))).rejects.toThrow("holds another token");
    await expect(load(node(acct({ authority: fill(9) })))).rejects.toThrow("belongs to another wallet");
    await expect(load(node(acct({ state: 2 })))).rejects.toThrow("frozen");
    await expect(load(node(acct({ state: 0 })))).rejects.toThrow(/could not be read: the token account is not initialized/);
    await expect(load(node({ token: { data: new Uint8Array(10), owner: TOKEN_PROGRAM } }))).rejects.toThrow(/USDC account could not be read/);
  });

  it("says what went wrong when the node does", async () => {
    const down = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const err = await loadUsdcBalance({ rpcUrl: "http://node.test", program: PROGRAM, owner: WALLET, fetch: down }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoadError);
    expect((err as Error).message).toMatch(/could not reach the node: offline/);
  });
});
