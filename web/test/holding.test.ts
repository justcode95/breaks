import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type BreakAccount, decodeBreak } from "../lib/chain/accounts";
import { type Address, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, addressFromBytes } from "../lib/chain/address";
import { decodeMint, loadHolding, reaches, saleFloor, tokenAccountAmount, tokenAmount } from "../lib/chain/holding";
import type { BreakRow } from "../lib/chain/list";
import { LoadError } from "../lib/chain/load";
import { RpcFailure, getBlockTime, getTokenAccountsByOwner } from "../lib/chain/rpc";
import { concat, fromHex, toHex } from "../lib/draw/bytes";
import { type BreakFields, type Served, breakFieldsFromVector, encodeBreak, encodeMint, encodeTokenAccount } from "./support/accounts";
import { rpcNode } from "./support/node";
import { fill } from "./support/wallet";

interface Vector {
  name: string;
  inputs: Record<string, string>;
  outputs: Record<string, any> | null;
}
const load = (program: string): { cases: Vector[] } =>
  JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "programs", program, "instruction-vectors.json"), "utf8"));
const treasury = load("treasury");
const named = (name: string) => treasury.cases.find((c) => c.name === name) as Vector;
const SAMPLE_BREAK = breakFieldsFromVector(load("breaks").cases.find((c) => c.name === "breaks.account.Break")?.outputs as Record<string, any>);

const MINT = fill(31);
const WALLET = fill(32);
const OTHER = fill(33);
const RPC = "https://node.example";

describe("a token mint, as the token program packs it", () => {
  it("reads the Rust sample mint (spl-token's own bytes): its supply and its decimals", () => {
    const v = named("spl.account.Mint");
    const data = fromHex(v.inputs.data as string);
    expect(data.length).toBe(82);
    const m = decodeMint(data, TOKEN_PROGRAM);
    expect({ supply: m.supply.toString(), decimals: m.decimals, initialized: true }).toEqual(v.outputs);
  });

  it("is written byte for byte by the test encoder, authorities and all", () => {
    const v = named("spl.account.Mint");
    const encoded = encodeMint({ supply: 987_654_321_000_000_000n, decimals: 9, authority: addressFromBytes(new Uint8Array(32).fill(2)), freeze: addressFromBytes(new Uint8Array(32).fill(6)) });
    expect(toHex(encoded)).toBe(v.inputs.data);
  });

  it("does not mix the authorities into the supply or the decimals", () => {
    const m = decodeMint(encodeMint({ supply: 5n, decimals: 0, authority: fill(250), freeze: fill(251) }), TOKEN_PROGRAM);
    expect(m).toEqual({ supply: 5n, decimals: 0 });
  });

  it("takes a Token-2022 mint without extensions (82 bytes) and with them (the account type 1 at byte 165)", () => {
    expect(decodeMint(encodeMint({ supply: 7n, decimals: 6 }), TOKEN_2022_PROGRAM)).toEqual({ supply: 7n, decimals: 6 });
    const extended = encodeMint({ supply: 8n, decimals: 9, extension: true });
    expect(extended.length).toBeGreaterThan(166);
    expect(decodeMint(extended, TOKEN_2022_PROGRAM)).toEqual({ supply: 8n, decimals: 9 });
  });

  it("refuses what is not an initialized mint of a token program, saying why", () => {
    const base = encodeMint({ supply: 1n, decimals: 6 });
    expect(() => decodeMint(base, SYSTEM_PROGRAM)).toThrow("it is not owned by a token program");
    // The classic program's mints are exactly 82 bytes.
    for (const len of [81, 83, 165, 166]) {
      const data = new Uint8Array(len);
      data.set(base.subarray(0, Math.min(82, len)));
      expect(() => decodeMint(data, TOKEN_PROGRAM), String(len)).toThrow(`a mint of the token program is 82 bytes, not ${len}`);
    }
    // Token-2022: longer only with the mint's account type right after the padding.
    const extended = encodeMint({ supply: 1n, decimals: 6, extension: true });
    const asAccount = extended.slice();
    asAccount[165] = 2;
    expect(() => decodeMint(asAccount, TOKEN_2022_PROGRAM)).toThrow("it is not laid out as a mint of the token program");
    expect(() => decodeMint(extended.slice(0, 165), TOKEN_2022_PROGRAM)).toThrow("it is not laid out as a mint of the token program");
    expect(() => decodeMint(extended.slice(0, 166), TOKEN_2022_PROGRAM)).not.toThrow();
    expect(() => decodeMint(extended, TOKEN_PROGRAM)).toThrow("82 bytes");
    for (const flag of [0, 2]) {
      expect(() => decodeMint(encodeMint({ supply: 1n, decimals: 6, initialized: flag }), TOKEN_PROGRAM), String(flag)).toThrow("it is not an initialized mint");
    }
  });
});

const tokenAccount = (over: { mint?: Address; owner?: Address; amount?: bigint; state?: 0 | 1 | 2 } = {}) =>
  encodeTokenAccount({ mint: over.mint ?? MINT, owner: over.owner ?? WALLET, amount: over.amount ?? 10n, ...(over.state === undefined ? {} : { state: over.state }) });
/** A Token-2022 token account with an extension: the base, the account type 2 at byte 165, then the extension. */
const extendedAccount = (base: Uint8Array, type = 2) => concat(base, Uint8Array.of(type), new Uint8Array(4));
const classicMint = { address: MINT, program: TOKEN_PROGRAM, decimals: 6, supply: 10n ** 15n };
const newMint = { ...classicMint, program: TOKEN_2022_PROGRAM };
const entry = (data: Uint8Array, owner: Address = TOKEN_PROGRAM, address: Address = fill(40)) => ({ address, account: { data, owner } });

describe("one of the wallet's token accounts", () => {
  it("reads the Rust sample token account (spl-token's own bytes)", () => {
    const v = named("spl.account.TokenAccount");
    const o = v.outputs as Record<string, string>;
    const mint = { ...classicMint, address: o.mint as Address };
    expect(tokenAccountAmount(entry(fromHex(v.inputs.data as string)), mint, o.owner as Address)).toBe(BigInt(o.amount as string));
  });

  it("counts a frozen account's tokens: they are still held", () => {
    expect(tokenAccountAmount(entry(tokenAccount({ amount: 77n, state: 2 })), classicMint, WALLET)).toBe(77n);
  });

  it("takes a Token-2022 account, with or without extensions", () => {
    expect(tokenAccountAmount(entry(tokenAccount({ amount: 5n }), TOKEN_2022_PROGRAM), newMint, WALLET)).toBe(5n);
    expect(tokenAccountAmount(entry(extendedAccount(tokenAccount({ amount: 6n })), TOKEN_2022_PROGRAM), newMint, WALLET)).toBe(6n);
  });

  it("refuses an account that is not this wallet's account of this mint, saying why", () => {
    expect(() => tokenAccountAmount(entry(tokenAccount(), TOKEN_2022_PROGRAM), classicMint, WALLET)).toThrow("it does not belong to the token's program");
    expect(() => tokenAccountAmount(entry(tokenAccount()), newMint, WALLET)).toThrow("it does not belong to the token's program");
    expect(() => tokenAccountAmount(entry(extendedAccount(tokenAccount())), classicMint, WALLET)).toThrow("it is not laid out as a token account");
    expect(() => tokenAccountAmount(entry(extendedAccount(tokenAccount(), 1), TOKEN_2022_PROGRAM), newMint, WALLET)).toThrow("it is not laid out as a token account");
    expect(() => tokenAccountAmount(entry(tokenAccount().slice(0, 164)), classicMint, WALLET)).toThrow("it is not laid out as a token account");
    expect(() => tokenAccountAmount(entry(tokenAccount({ state: 0 })), classicMint, WALLET)).toThrow("not initialized");
    expect(() => tokenAccountAmount(entry(tokenAccount({ mint: OTHER })), classicMint, WALLET)).toThrow("it holds another token");
    expect(() => tokenAccountAmount(entry(tokenAccount({ owner: OTHER })), classicMint, WALLET)).toThrow("it belongs to another wallet");
  });
});

/** A chain with the mint and some token accounts, every one at its own address. */
function chain(opts: { mint?: Served | null; accounts?: { address: Address; served: Served }[] } = {}) {
  const accounts = new Map<Address, Served>();
  const mint = opts.mint === undefined ? { data: encodeMint({ supply: 10n ** 15n, decimals: 6 }), owner: TOKEN_PROGRAM } : opts.mint;
  if (mint) accounts.set(MINT, mint);
  for (const a of opts.accounts ?? []) accounts.set(a.address, a.served);
  return accounts;
}
const held = (n: number, amount: bigint, over: { owner?: Address; mint?: Address; program?: Address } = {}) => ({
  address: fill(60 + n),
  served: { data: tokenAccount({ amount, owner: over.owner ?? WALLET, mint: over.mint ?? MINT }), owner: over.program ?? TOKEN_PROGRAM },
});

describe("loading the wallet's tokens", () => {
  it("adds up the wallet's token accounts of the mint, says how many hold any, and when the chain says those balances are from", async () => {
    const node = rpcNode({
      accounts: chain({ accounts: [held(1, 1_500_000n), held(2, 0n), held(3, 250_000n), held(4, 999n, { owner: OTHER }), held(5, 999n, { mint: OTHER })] }),
      slot: 4242,
      blockTime: 1_800_000_123,
    });
    const h = await loadHolding({ rpcUrl: RPC, mint: MINT, owner: WALLET, fetch: node.fetchFn });
    expect(h).toEqual({ mint: { address: MINT, program: TOKEN_PROGRAM, decimals: 6, supply: 10n ** 15n }, total: 1_750_000n, accounts: 2, slot: 4242, time: 1_800_000_123 });
    expect(node.methods()).toEqual(["getMultipleAccounts", "getTokenAccountsByOwner", "getBlockTime"]);
    expect(node.calls[0]?.params).toEqual([[MINT], { encoding: "base64", commitment: "finalized" }]);
    expect(node.calls[1]?.params).toEqual([WALLET, { mint: MINT }, { encoding: "base64", commitment: "finalized" }]);
    // The time is asked for the slot the balances are from, not some other one.
    expect(node.calls[2]?.params).toEqual([4242]);
  });

  it("reads a Token-2022 coin the same way", async () => {
    const node = rpcNode({
      accounts: chain({
        mint: { data: encodeMint({ supply: 1n, decimals: 9, extension: true }), owner: TOKEN_2022_PROGRAM },
        accounts: [{ address: fill(70), served: { data: extendedAccount(tokenAccount({ amount: 3n })), owner: TOKEN_2022_PROGRAM } }],
      }),
    });
    const h = await loadHolding({ rpcUrl: RPC, mint: MINT, owner: WALLET, fetch: node.fetchFn });
    expect([h.mint.program, h.mint.decimals, h.total, h.accounts]).toEqual([TOKEN_2022_PROGRAM, 9, 3n, 1]);
  });

  it("says a wallet with no token account holds nothing", async () => {
    const node = rpcNode({ accounts: chain() });
    const h = await loadHolding({ rpcUrl: RPC, mint: MINT, owner: WALLET, fetch: node.fetchFn });
    expect([h.total, h.accounts]).toEqual([0n, 0]);
  });

  it("goes on without the time when the node cannot give it", async () => {
    const unknown = rpcNode({ accounts: chain({ accounts: [held(1, 5n)] }), blockTime: null });
    expect((await loadHolding({ rpcUrl: RPC, mint: MINT, owner: WALLET, fetch: unknown.fetchFn })).time).toBeNull();
    const failing = rpcNode({ accounts: chain({ accounts: [held(1, 5n)] }), failing: ["getBlockTime"] });
    const h = await loadHolding({ rpcUrl: RPC, mint: MINT, owner: WALLET, fetch: failing.fetchFn });
    expect([h.total, h.time]).toEqual([5n, null]);
  });

  const refused = async (node: ReturnType<typeof rpcNode>, message: string) => {
    const err = await loadHolding({ rpcUrl: RPC, mint: MINT, owner: WALLET, fetch: node.fetchFn }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoadError);
    expect((err as Error).message).toBe(message);
  };

  it("says when the setting names no mint, or something that is not one", async () => {
    await refused(rpcNode({ accounts: chain({ mint: null }) }), "The token this site is set up for (NEXT_PUBLIC_TOKEN_MINT) does not exist on this network.");
    await refused(
      rpcNode({ accounts: chain({ mint: { data: encodeMint({ supply: 1n, decimals: 6 }), owner: SYSTEM_PROGRAM } }) }),
      "The token this site is set up for (NEXT_PUBLIC_TOKEN_MINT) is not a token mint: it is not owned by a token program.",
    );
    await refused(
      rpcNode({ accounts: chain({ mint: { data: encodeMint({ supply: 1n, decimals: 6, initialized: 0 }), owner: TOKEN_PROGRAM } }) }),
      "The token this site is set up for (NEXT_PUBLIC_TOKEN_MINT) is not a token mint: it is not an initialized mint.",
    );
  });

  it("does not believe a node that lists an account that is not this wallet's account of the coin", async () => {
    const lying = (served: Served) => rpcNode({ accounts: chain(), tokenAccounts: [{ pubkey: fill(80), served }] });
    const name = `${fill(80).slice(0, 4)}…${fill(80).slice(-4)}`;
    await refused(lying({ data: tokenAccount({ owner: OTHER }), owner: TOKEN_PROGRAM }), `The node listed ${name} as one of this wallet's token accounts, but it belongs to another wallet.`);
    await refused(lying({ data: tokenAccount({ mint: OTHER }), owner: TOKEN_PROGRAM }), `The node listed ${name} as one of this wallet's token accounts, but it holds another token.`);
    await refused(lying({ data: tokenAccount(), owner: SYSTEM_PROGRAM }), `The node listed ${name} as one of this wallet's token accounts, but it does not belong to the token's program.`);
    const twice = { pubkey: fill(81), served: { data: tokenAccount({ amount: 5n }), owner: TOKEN_PROGRAM } };
    await refused(rpcNode({ accounts: chain(), tokenAccounts: [twice, twice] }), `The node listed the token account ${fill(81).slice(0, 4)}…${fill(81).slice(-4)} twice.`);
  });

  it("says in words when the node cannot be read", async () => {
    await refused(rpcNode({ accounts: chain(), failing: ["getMultipleAccounts"] }), "The wallet's tokens could not be read: the node refused the request: getMultipleAccounts is failing.");
    await refused(rpcNode({ accounts: chain(), failing: ["getTokenAccountsByOwner"], failMessage: "too busy" }), "The wallet's tokens could not be read: the node refused the request: too busy.");
  });
});

describe("the node's answers for token accounts and block times", () => {
  const answering = (result: unknown) => (async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }))) as unknown as typeof fetch;
  const ask = (result: unknown) => getTokenAccountsByOwner({ url: RPC, fetch: answering(result), owner: WALLET, mint: MINT });

  it("reads the slot and the accounts", async () => {
    const got = await ask({ context: { slot: 9 }, value: [{ pubkey: fill(90), account: { data: ["AQID", "base64"], owner: TOKEN_PROGRAM } }] });
    expect(got).toEqual({ slot: 9, accounts: [{ address: fill(90), account: { data: Uint8Array.of(1, 2, 3), owner: TOKEN_PROGRAM } }] });
  });

  it("refuses an answer without a slot, without a list or with a malformed account", async () => {
    for (const slot of [undefined, -1, 1.5, "9"]) await expect(ask({ context: { slot }, value: [] }), String(slot)).rejects.toThrow("did not say which slot");
    await expect(ask(null)).rejects.toThrow("did not say which slot");
    await expect(ask({ context: { slot: 1 }, value: {} })).rejects.toThrow("not a list of accounts");
    await expect(ask({ context: { slot: 1 }, value: [{ pubkey: fill(90), account: { data: "AQID", owner: TOKEN_PROGRAM } }] })).rejects.toThrow("malformed");
    await expect(ask({ context: { slot: 1 }, value: [null] })).rejects.toBeInstanceOf(RpcFailure);
  });

  it("reads a block's time, null when the node does not know it, and refuses anything else", async () => {
    expect(await getBlockTime({ url: RPC, fetch: answering(1_800_000_000) }, 5)).toBe(1_800_000_000);
    expect(await getBlockTime({ url: RPC, fetch: answering(null) }, 5)).toBeNull();
    for (const bad of ["1800000000", 1.5, {}]) await expect(getBlockTime({ url: RPC, fetch: answering(bad) }, 5), JSON.stringify(bad)).rejects.toThrow("not a whole number");
  });
});

const OPENS = 1_800_000_000n;
const CLOSES = OPENS + 21_600n;
const brk = (id: number, over: Partial<BreakFields> = {}): BreakAccount => decodeBreak(encodeBreak({ ...SAMPLE_BREAK, id: BigInt(id), status: "Open", opensAt: OPENS, closesAt: CLOSES, ...over }));
const row = (id: number, over: Partial<BreakFields> = {}): BreakRow => ({ number: id + 1, break: brk(id, over) });
const T = (offset: bigint) => Number(OPENS + offset);

describe("what the tokens held now give over the sale that is on", () => {
  it("is nothing to say when no break is on sale", () => {
    expect(saleFloor([], 100n, T(0n))).toEqual({ kind: "none" });
    expect(saleFloor([row(3, { status: "Closed" }), row(2, { status: "Drawn" })], 100n, T(0n))).toEqual({ kind: "none" });
  });

  it("takes the newest break that says it is on sale", () => {
    const s = saleFloor([row(5, { status: "Closed" }), row(4), row(3, { opensAt: OPENS - 100n })], 100n, T(0n));
    expect(s).toMatchObject({ kind: "on", number: 5 });
  });

  it("counts the tokens for the part of the sale still to come, rounded down like the list", () => {
    // Half the sale left: half the balance.
    expect(saleFloor([row(0)], 1_000_001n, T(10_800n))).toEqual({ kind: "on", number: 1, closesAt: CLOSES, left: 10_800n, length: 21_600n, floor: 500_000n });
    // At the opening: all of it. One second before the close: one second's worth.
    expect(saleFloor([row(0)], 21_600n * 7n, T(0n))).toMatchObject({ kind: "on", left: 21_600n, floor: 151_200n });
    expect(saleFloor([row(0)], 21_600n * 7n, T(21_599n))).toMatchObject({ kind: "on", left: 1n, floor: 7n });
    expect(saleFloor([row(0)], 21_599n, T(21_599n))).toMatchObject({ kind: "on", floor: 0n });
    expect(saleFloor([row(0)], 0n, T(100n))).toMatchObject({ kind: "on", floor: 0n });
  });

  it("is closed from the closing second on, by the chain's clock", () => {
    expect(saleFloor([row(0)], 100n, T(21_600n))).toEqual({ kind: "closed", number: 1, closesAt: CLOSES });
    expect(saleFloor([row(0)], 100n, T(99_999n))).toMatchObject({ kind: "closed" });
  });

  it("counts every token in full before the sale opens", () => {
    expect(saleFloor([row(0)], 123n, T(-1n))).toEqual({ kind: "before", number: 1, opensAt: OPENS, closesAt: CLOSES, floor: 123n });
  });

  it("says nothing about the floor without the time of the balances", () => {
    expect(saleFloor([row(0)], 100n, null)).toEqual({ kind: "no-time", number: 1 });
  });

  it("whether an average reaches a minimum: at least it, and never zero", () => {
    expect(reaches(10n, 10n)).toBe(true);
    expect(reaches(9n, 10n)).toBe(false);
    expect(reaches(11n, 10n)).toBe(true);
    expect(reaches(0n, 0n)).toBe(false);
    expect(reaches(1n, 0n)).toBe(true);
  });
});

describe("token amounts", () => {
  it("are shown in whole tokens with the fraction that matters", () => {
    expect(tokenAmount(0n, 6)).toBe("0");
    expect(tokenAmount(1_000_000n, 6)).toBe("1");
    expect(tokenAmount(1_234_500_000n, 6)).toBe("1,234.5");
    expect(tokenAmount(1n, 6)).toBe("0.000001");
    expect(tokenAmount(2_000_000_000_000_000_000n, 9)).toBe("2,000,000,000");
    expect(tokenAmount(1_234_567n, 0)).toBe("1,234,567");
    expect(tokenAmount(999n, 3)).toBe("0.999");
  });
});

