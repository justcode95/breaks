import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TreasuryDetails } from "../app/treasury/details";
import { type Address, configAddress, vaultAddress } from "../lib/chain/address";
import { LoadError } from "../lib/chain/load";
import { TOKEN_PROGRAM, type Treasury, decodeTokenAccount, decodeTreasuryConfig, loadTreasury, noController } from "../lib/chain/treasury";
import { fromHex, toHex } from "../lib/draw/bytes";
import { type Served, type TreasuryConfigFields, encodeTokenAccount, encodeTreasuryConfig, fakeNode, treasuryConfigFieldsFromVector } from "./support/accounts";

interface Vector {
  name: string;
  inputs: Record<string, string>;
  outputs: Record<string, any> | null;
  accounts?: { pubkey: string }[];
}
// Made by the Rust treasury's tests: sample account bytes with their fields, and the addresses the program derives.
const vectors: { programs: { treasury: string }; cases: Vector[] } = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "programs", "treasury", "instruction-vectors.json"), "utf8"),
);
const TREASURY = vectors.programs.treasury;
const OTHER = "8tmJjCG3D4TF7oPiPWNoaCjZ4pN2U4H237BSGVw2B8KU";
const named = (name: string) => vectors.cases.find((c) => c.name === name) as Vector;
const SAMPLE_CONFIG = treasuryConfigFieldsFromVector(named("treasury.account.Config").outputs as Record<string, any>);
const CONFIG_KEY = configAddress(TREASURY);

describe("the treasury's addresses and accounts, as the Rust program writes them", () => {
  it("derives the config and the two vaults the program derives", () => {
    // `deposit_fees`: [depositor, depositor usdc, config, subsidy vault, holder vault, token program]
    const accounts = (named("treasury.deposit_fees").accounts as { pubkey: string }[]).map((a) => a.pubkey);
    expect(configAddress(TREASURY)).toBe(accounts[2]);
    expect(vaultAddress(TREASURY, "subsidy")).toBe(accounts[3]);
    expect(vaultAddress(TREASURY, "holder")).toBe(accounts[4]);
    expect(accounts[5]).toBe(TOKEN_PROGRAM);
    expect(vaultAddress(TREASURY, "subsidy")).not.toBe(vaultAddress(TREASURY, "holder"));
    expect(vaultAddress(OTHER, "subsidy")).not.toBe(vaultAddress(TREASURY, "subsidy"));
  });

  it("reads the config", () => {
    const v = named("treasury.account.Config");
    const c = decodeTreasuryConfig(fromHex(v.inputs.data as string));
    const o = v.outputs as Record<string, any>;
    expect({ ...c, lockedSubsidy: c.lockedSubsidy.toString(), lockedHolder: c.lockedHolder.toString() }).toEqual({
      admin: o.admin,
      usdcMint: o.usdcMint,
      controller: o.controller,
      subsidyBps: o.subsidyBps,
      holderBps: o.holderBps,
      lockedSubsidy: o.lockedSubsidy,
      lockedHolder: o.lockedHolder,
    });
  });

  it("reads the SPL token account", () => {
    const v = named("spl.account.TokenAccount");
    const t = decodeTokenAccount(fromHex(v.inputs.data as string));
    const o = v.outputs as Record<string, any>;
    expect({ mint: t.mint, owner: t.owner, amount: t.amount.toString(), frozen: t.frozen }).toEqual({ mint: o.mint, owner: o.owner, amount: o.amount, frozen: false });
  });

  it("writes test accounts that are byte for byte the Rust ones", () => {
    expect(toHex(encodeTreasuryConfig(SAMPLE_CONFIG))).toBe(named("treasury.account.Config").inputs.data);
    const o = named("spl.account.TokenAccount").outputs as Record<string, any>;
    expect(toHex(encodeTokenAccount({ mint: o.mint, owner: o.owner, amount: BigInt(o.amount) }))).toBe(named("spl.account.TokenAccount").inputs.data);
  });

  it("refuses data that is not the account asked for", () => {
    const config = fromHex(named("treasury.account.Config").inputs.data as string);
    expect(() => decodeTreasuryConfig(new Uint8Array(0))).toThrow(/not a Config account/);
    expect(() => decodeTreasuryConfig(config.slice(0, 100))).toThrow(/too short/);
    const wrong = new Uint8Array(config);
    wrong[0] ^= 1;
    expect(() => decodeTreasuryConfig(wrong)).toThrow(/not a Config account/);

    const token = fromHex(named("spl.account.TokenAccount").inputs.data as string);
    expect(() => decodeTokenAccount(token.slice(0, 164))).toThrow(/at least 165 bytes/);
    const uninitialized = new Uint8Array(token);
    uninitialized[108] = 0;
    expect(() => decodeTokenAccount(uninitialized)).toThrow(/not initialized/);
    const frozen = new Uint8Array(token);
    frozen[108] = 2;
    expect(decodeTokenAccount(frozen).frozen).toBe(true);
    const odd = new Uint8Array(token);
    odd[108] = 3;
    expect(() => decodeTokenAccount(odd)).toThrow(/unknown token account state 3/);
  });
});

/** A treasury holding `subsidy` and `holder` micro-dollars, with the given amounts reserved. */
function world(over: { subsidy?: bigint; holder?: bigint; config?: Partial<TreasuryConfigFields>; skip?: ("config" | "subsidy" | "holder")[]; vault?: { mint?: Address; owner?: Address; programOwner?: Address; state?: 0 | 1 | 2 } } = {}) {
  const config: TreasuryConfigFields = { ...SAMPLE_CONFIG, lockedSubsidy: 1_000_000n, lockedHolder: 500_000n, ...over.config };
  const vault = (amount: bigint): Served => ({
    data: encodeTokenAccount({ mint: over.vault?.mint ?? config.usdcMint, owner: over.vault?.owner ?? CONFIG_KEY, amount, ...(over.vault?.state !== undefined ? { state: over.vault.state } : {}) }),
    owner: over.vault?.programOwner ?? TOKEN_PROGRAM,
  });
  const accounts = new Map<Address, Served>();
  if (!over.skip?.includes("config")) accounts.set(CONFIG_KEY, { data: encodeTreasuryConfig(config), owner: TREASURY });
  if (!over.skip?.includes("subsidy")) accounts.set(vaultAddress(TREASURY, "subsidy"), vault(over.subsidy ?? 7_000_000n));
  if (!over.skip?.includes("holder")) accounts.set(vaultAddress(TREASURY, "holder"), vault(over.holder ?? 3_000_000n));
  return accounts;
}

const load = (accounts: Map<Address, Served>, program = TREASURY) => {
  const node = fakeNode(accounts);
  return { node, promise: loadTreasury({ rpcUrl: "https://node.example", treasuryProgram: program, fetch: node.fetchFn }) };
};

describe("loading the treasury", () => {
  it("reads the config and both vaults in one request at finalized, and works out what is available", async () => {
    const { node, promise } = load(world());
    const t = await promise;
    expect(node.requests).toHaveLength(1);
    expect(node.requests[0]?.addresses).toEqual([CONFIG_KEY, vaultAddress(TREASURY, "subsidy"), vaultAddress(TREASURY, "holder")]);
    expect(node.requests[0]?.config.commitment).toBe("finalized");
    expect(t.subsidy).toEqual({ balance: 7_000_000n, locked: 1_000_000n, available: 6_000_000n, vault: vaultAddress(TREASURY, "subsidy") });
    expect(t.holder).toEqual({ balance: 3_000_000n, locked: 500_000n, available: 2_500_000n, vault: vaultAddress(TREASURY, "holder") });
    expect(t.config.subsidyBps + t.config.holderBps).toBe(10_000);
    expect(t.configAddress).toBe(CONFIG_KEY);
    expect(t.notes).toEqual([]);
  });

  it("has nothing available, and says so, when exactly everything is reserved", async () => {
    const t = await load(world({ subsidy: 1_000_000n })).promise;
    expect(t.subsidy.available).toBe(0n);
    expect(t.notes).toEqual([]);
  });

  it("shows, rather than hides, a bucket that has more reserved than it holds", async () => {
    const t = await load(world({ subsidy: 999_999n })).promise;
    expect(t.subsidy).toMatchObject({ balance: 999_999n, locked: 1_000_000n, available: 0n });
    expect(t.notes).toEqual(["More is reserved in the subsidy bucket than its vault holds. This should not happen."]);
    const holder = await load(world({ holder: 100n })).promise;
    expect(holder.notes).toEqual(["More is reserved in the holder bucket than its vault holds. This should not happen."]);
  });

  it("notes a frozen vault and a split that does not add up", async () => {
    expect((await load(world({ vault: { state: 2 } })).promise).notes).toEqual(["The subsidy vault is frozen: no money can move in or out of it.", "The holder vault is frozen: no money can move in or out of it."]);
    expect((await load(world({ config: { subsidyBps: 7000, holderBps: 2999 } })).promise).notes).toEqual(["The two shares of the split do not add up to 100%."]);
  });

  it("knows whether a controller has been appointed", () => {
    expect(noController("11111111111111111111111111111111")).toBe(true);
    expect(noController(SAMPLE_CONFIG.controller)).toBe(false);
  });
});

describe("what can go wrong with the treasury", () => {
  const fails = async (p: Promise<unknown>, message: RegExp) => {
    const err = await p.then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(LoadError);
    expect((err as Error).message).toMatch(message);
  };

  it("says when the treasury is not set up, or its config is not the program's or cannot be read", async () => {
    await fails(load(world({ skip: ["config"] })).promise, /has not been set up on this network/);
    const foreign = world();
    foreign.set(CONFIG_KEY, { data: encodeTreasuryConfig(SAMPLE_CONFIG), owner: OTHER });
    await fails(load(foreign).promise, /config account is not owned by the treasury program/);
    const garbage = world();
    garbage.set(CONFIG_KEY, { data: new Uint8Array(125), owner: TREASURY });
    await fails(load(garbage).promise, /config account could not be read: not a Config account/);
  });

  it("refuses a vault that is missing, is not a token account, is not the treasury's or holds other money", async () => {
    await fails(load(world({ skip: ["subsidy"] })).promise, /The subsidy vault should exist but its account is missing/);
    await fails(load(world({ skip: ["holder"] })).promise, /The holder vault should exist but its account is missing/);
    await fails(load(world({ vault: { programOwner: OTHER } })).promise, /subsidy vault is not a token account/);
    await fails(load(world({ vault: { owner: OTHER } })).promise, /subsidy vault is not controlled by the treasury/);
    await fails(load(world({ vault: { mint: OTHER } })).promise, /subsidy vault does not hold the treasury's USDC/);
    await fails(load(world({ vault: { state: 0 } })).promise, /subsidy vault could not be read: the token account is not initialized/);
    // Only the holder vault is wrong: the error names it and not the other one.
    const holderOnly = world();
    holderOnly.set(vaultAddress(TREASURY, "holder"), { data: encodeTokenAccount({ mint: SAMPLE_CONFIG.usdcMint, owner: OTHER, amount: 1n }), owner: TOKEN_PROGRAM });
    await fails(load(holderOnly).promise, /holder vault is not controlled by the treasury/);
  });

  it("reports a node that cannot be reached or refuses", async () => {
    const down = loadTreasury({ rpcUrl: "https://node.example", treasuryProgram: TREASURY, fetch: (async () => { throw new Error("offline"); }) as unknown as typeof fetch });
    await fails(down, /could not reach the node: offline/);
    const refused = loadTreasury({ rpcUrl: "https://node.example", treasuryProgram: TREASURY, fetch: (async () => new Response("", { status: 429 })) as unknown as typeof fetch });
    await fails(refused, /the node answered 429/);
  });
});

describe("the treasury page", () => {
  const NOW = 1_800_000_000;
  const page = async (over: Parameters<typeof world>[0] = {}, readAgo = 90) => {
    const treasury: Treasury = await load(world(over)).promise;
    return renderToStaticMarkup(createElement(TreasuryDetails, { treasury, program: TREASURY, now: NOW, readAt: NOW - readAgo, refresh: () => {} }));
  };
  const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

  it("says what is available, reserved and held, in total and per bucket", async () => {
    const t = text(await page());
    expect(t).toContain("$8.50 is available to fund new breaks. $1.50 more is reserved for breaks that already exist, out of $10 in the treasury.");
    const body = await page();
    const rows = [...body.matchAll(/<tr>(.*?)<\/tr>/g)].map((m) => text(m[1] as string).trim());
    expect(rows).toEqual([
      "Bucket Share of new deposits In the vault Reserved for breaks Available for new breaks",
      "Subsidy tops up the price of a paid spot when a spot costs less than a pack 70% $7 $1 $6",
      "Holder pays for the packs of the free holder spots 30% $3 $0.50 $2.50",
      "Total 100% $10 $1.50 $8.50",
    ]);
  });

  it("shows who controls it, and says when nobody does yet", async () => {
    const set = text(await page());
    expect(set).toContain(SAMPLE_CONFIG.admin);
    expect(set).toContain(SAMPLE_CONFIG.controller);
    expect(set).toContain(SAMPLE_CONFIG.usdcMint);
    expect(set).not.toContain("Not set yet");
    const none = text(await page({ config: { controller: "11111111111111111111111111111111" } }));
    expect(none).toContain("Not set yet. Until the admin appoints one, nobody can reserve or pay out money.");
    expect(none).not.toContain("11111111111111111111111111111111 The only signer");
  });

  it("lists the addresses to check, and any note about something that looks wrong", async () => {
    const html = await page({ subsidy: 10n });
    for (const a of [TREASURY, CONFIG_KEY, vaultAddress(TREASURY, "subsidy"), vaultAddress(TREASURY, "holder")]) expect(html).toContain(a);
    expect(html).toContain('<li class="problem">More is reserved in the subsidy bucket than its vault holds. This should not happen.</li>');
    expect(text(await page())).not.toContain("This should not happen");
  });

  it("says how old the reading is, and offers Refresh", async () => {
    expect(text(await page({}, 5))).toContain("Read from the chain (finalized) under a minute ago. Nothing here");
    const old = text(await page({}, 125));
    expect(old).toContain("Read from the chain (finalized) 2m ago; use Refresh to read it again.");
    expect((await page()).includes(">Refresh</button>")).toBe(true);
  });

  it("starts suggesting a refresh at exactly one minute", async () => {
    expect(text(await page({}, 59))).not.toContain("use Refresh");
    expect(text(await page({}, 60))).toContain("1m ago; use Refresh to read it again.");
  });

  it("scrolls inside a labelled, keyboard-reachable box on a narrow screen", async () => {
    expect(await page()).toContain('<div class="scroll" role="region" aria-label="Treasury buckets" tabindex="0">');
  });
});
