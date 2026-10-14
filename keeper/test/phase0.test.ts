import { Connection } from "@solana/web3.js";
import { base58 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { analyze, base58Head, MAINNET_USDC, render, type TransactionJson } from "../src/phase0/analyze.js";
import { main, parseArgs } from "../src/phase0/main.js";
import type { Fetch } from "../src/solana/rpc.js";
import { addr } from "./support/chain.js";

// SYNTHETIC transactions: they have the shape of what a node returns, but say nothing about how Collector Crypt's
// purchase really looks. That is what the tool is for.

const SIG = "5".repeat(87);
const BUYER = addr(11);
const BUYER_USDC = addr(12);
const VAULT_USDC = addr(13);
const CARD_ACCOUNT = addr(14);
const CARD_TOKEN_ACCOUNT = addr(15);
const MACHINE = addr(16); // some program nobody here has heard of
const COSIGNER = addr(17);
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SYSTEM = "11111111111111111111111111111111";
const MEMO = "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo";
const COMPUTE = "ComputeBudget111111111111111111111111111111";
const CORE = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";

/** A token amount as a node writes it. */
const ui = (amount: string, decimals: number) => ({ amount, decimals, uiAmount: Number(amount) / 10 ** decimals, uiAmountString: String(Number(amount) / 10 ** decimals) });

const key = (pubkey: string, signer = false, writable = true) => ({ pubkey, signer, writable, source: "transaction" });
const data = (...bytes: number[]) => base58.encode(Uint8Array.from(bytes));

function purchase(over: { cosigner?: boolean; memo?: boolean; failed?: boolean; lookups?: boolean } = {}): TransactionJson {
  const keys = [key(BUYER, true), ...(over.cosigner ? [key(COSIGNER, true)] : []), key(BUYER_USDC), key(VAULT_USDC), key(CARD_ACCOUNT), key(CARD_TOKEN_ACCOUNT), key(MACHINE, false, false), key(TOKEN, false, false), key(SYSTEM, false, false), key(CORE, false, false), key(COMPUTE, false, false), key(MEMO, false, false)];
  const at = (a: string) => keys.findIndex((k) => k.pubkey === a);
  const n = keys.length;
  const pre = Array.from({ length: n }, () => 1_000_000);
  const post = [...pre];
  post[0] = 1_000_000 - 5_000 - 3_000_000;
  post[at(CARD_ACCOUNT)] = 3_000_000;
  pre[at(CARD_ACCOUNT)] = 0;
  return {
    slot: 300_000_000,
    blockTime: 1_800_000_000,
    version: over.lookups ? 0 : "legacy",
    transaction: {
      signatures: [SIG],
      message: {
        accountKeys: keys,
        recentBlockhash: "11111111111111111111111111111111",
        instructions: [
          { programId: COMPUTE, accounts: [], data: data(2, 0x40, 0x0d, 0x03, 0) },
          { programId: MACHINE, accounts: [BUYER, BUYER_USDC, VAULT_USDC, CARD_ACCOUNT], data: data(0xde, 0xad, 0xbe, 0xef, 1, 2, 3, 4, 5, 6) },
          ...(over.memo === false ? [] : [{ program: "spl-memo", programId: MEMO, parsed: "breaks:pack:7:0" }]),
        ],
        ...(over.lookups ? { addressTableLookups: [{ accountKey: addr(30), writableIndexes: [0], readonlyIndexes: [1] }] } : {}),
      },
    },
    meta: {
      err: over.failed ? { InstructionError: [1, "Custom"] } : null,
      fee: 5_000,
      preBalances: pre,
      postBalances: post,
      computeUnitsConsumed: 120_000,
      preTokenBalances: [
        { accountIndex: at(BUYER_USDC), mint: MAINNET_USDC, owner: BUYER, uiTokenAmount: ui("100000000", 6) },
        { accountIndex: at(VAULT_USDC), mint: MAINNET_USDC, owner: addr(40), uiTokenAmount: ui("5000000", 6) },
      ],
      postTokenBalances: [
        { accountIndex: at(BUYER_USDC), mint: MAINNET_USDC, owner: BUYER, uiTokenAmount: ui("75000000", 6) },
        { accountIndex: at(VAULT_USDC), mint: MAINNET_USDC, owner: addr(40), uiTokenAmount: ui("30000000", 6) },
        { accountIndex: at(CARD_TOKEN_ACCOUNT), mint: addr(50), owner: BUYER, uiTokenAmount: ui("1", 0) },
      ],
      innerInstructions: [
        {
          index: 1,
          instructions: [
            { program: "spl-token", programId: TOKEN, parsed: { type: "transferChecked", info: { amount: "25000000" } } },
            { program: "system", programId: SYSTEM, parsed: { type: "createAccount", info: { newAccount: CARD_ACCOUNT, owner: CORE, lamports: 3_000_000 } } },
          ],
        },
      ],
      logMessages: ["Program 111 invoke [1]", "Program log: Instruction: Open", "Program 111 success"],
    },
  };
}

describe("analyze", () => {
  it("states the facts of a purchase: who signs, where the USDC goes, what arrives, what is created", () => {
    const r = analyze(purchase());
    expect(r).toMatchObject({ signature: SIG, ok: true, slot: 300_000_000, version: "legacy", feePayer: BUYER, signers: [BUYER], feeLamports: 5_000, computeUnits: 120_000, usesLookupTables: false, memos: ["breaks:pack:7:0"] });
    expect(r.time).toBe("2027-01-15T08:00:00.000Z");
    expect(r.programs.map((p) => p.name)).toEqual(["Compute Budget", MACHINE, "spl-memo", "SPL Token", "System"]);
    expect(r.tokenChanges.map((t) => [t.mint === MAINNET_USDC ? "usdc" : "card", t.owner, t.after - t.before])).toEqual([
      ["usdc", BUYER, -25_000_000n],
      ["usdc", addr(40), 25_000_000n],
      ["card", BUYER, 1n],
    ]);
    expect(r.createdAccounts).toEqual([{ address: CARD_ACCOUNT, owner: CORE }]);
    // the 8 bytes an Anchor program starts its data with, and the inner instructions in place
    expect(r.instructions.map((i) => [i.at, i.program, i.type ?? i.dataHead ?? i.memo])).toEqual([
      ["0", "Compute Budget", "02400d0300"],
      ["1", MACHINE, "deadbeef01020304"],
      ["1.0", "SPL Token", "transferChecked"],
      ["1.1", "System", "createAccount"],
      ["2", "spl-memo", "breaks:pack:7:0"],
    ]);
  });

  it("calls out the things the open questions depend on", () => {
    const text = analyze(purchase()).notes.join("\n");
    expect(text).toContain("Only the fee payer");
    expect(text).toContain("can be built and signed by our own code");
    expect(text).toContain('A memo is present: "breaks:pack:7:0"');
    expect(text).toContain("USDC left token account");
    expect(text).toContain("25.000000");
    expect(text).toContain("A 1-of-1 token");
    expect(text).toContain("probably a Core asset");
    expect(text).toContain(`Programs beyond the basic ones`);
    expect(text).toContain(MACHINE);
  });

  it("flags a co-signer, because only that party's service can then complete the transaction", () => {
    const text = analyze(purchase({ cosigner: true })).notes.join("\n");
    expect(text).toContain(`Signers besides the fee payer: ${COSIGNER}`);
    expect(text).toContain("a memo cannot be added");
  });

  it("says when there is no memo, when lookup tables are used and when the transaction failed", () => {
    expect(analyze(purchase({ memo: false })).notes.join("\n")).toContain("There is no memo");
    expect(analyze(purchase({ lookups: true })).usesLookupTables).toBe(true);
    expect(analyze(purchase({ lookups: true })).notes.join("\n")).toContain("address lookup tables");
    const failed = analyze(purchase({ failed: true }));
    expect(failed.ok).toBe(false);
    expect(failed.notes.join("\n")).toContain("FAILED");
  });

  it("refuses a transaction without metadata", () => {
    expect(() => analyze({ ...purchase(), meta: null })).toThrow(/no metadata/);
  });

  it("reads the head of base58 data exactly, leading zero bytes included", () => {
    expect(base58Head(base58.encode(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])), 8)).toBe("0102030405060708");
    expect(base58Head(base58.encode(Uint8Array.from([0, 0, 7, 8, 9])), 8)).toBe("000007080 9".replace(" ", ""));
    expect(base58Head("", 8)).toBe("");
    expect(base58Head("0OIl", 8)).toBe(""); // not base58
  });

  it("has the shape a node answers with, as web3.js reads it", async () => {
    const fetch: Fetch = async (_url, init) => {
      const { id } = JSON.parse(init.body) as { id: number };
      const text = JSON.stringify({ jsonrpc: "2.0", id, result: purchase({ cosigner: true }) });
      return { ok: true, status: 200, statusText: "OK", text: async () => text } as never;
    };
    const connection = new Connection("http://node", { fetch: fetch as unknown as typeof globalThis.fetch });
    const parsed = await connection.getParsedTransaction(SIG, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
    expect(parsed?.transaction.message.accountKeys.filter((k) => k.signer)).toHaveLength(2);
    expect(parsed?.meta?.innerInstructions?.[0]?.instructions).toHaveLength(2);
  });
});

describe("render", () => {
  it("prints the facts as markdown", () => {
    const md = render("purchase", analyze(purchase()));
    expect(md).toContain("## purchase");
    expect(md).toContain(`- signature: \`${SIG}\``);
    expect(md).toContain("### Notes");
    expect(md).toContain("| 1 |");
    expect(md).toContain("data deadbeef01020304…");
    expect(md).toContain(`memo "breaks:pack:7:0"`);
    expect(md).toContain("(USDC)");
    expect(md).toContain("100.000000 -> 75.000000");
    expect(md).toContain(`owner program \`${CORE}\``);
    expect(md).toContain("Program log: Instruction: Open");
  });

  it("prints a transaction with nothing in it", () => {
    const tx = purchase();
    tx.meta!.preTokenBalances = [];
    tx.meta!.postTokenBalances = [];
    tx.meta!.innerInstructions = [];
    tx.meta!.logMessages = null;
    tx.meta!.preBalances = tx.meta!.postBalances;
    const md = render("x", analyze(tx));
    expect(md.match(/\(none\)/g)).toHaveLength(3);
  });
});

describe("parseArgs", () => {
  const sig = "4".repeat(88);
  it("reads the url, the flag and labelled or unlabelled signatures", () => {
    expect(parseArgs(["--rpc", "https://rpc.example", "--das", `purchase=${sig}`, sig], {})).toEqual({
      rpc: "https://rpc.example",
      das: true,
      targets: [
        { label: "purchase", signature: sig },
        { label: "transaction 2", signature: sig },
      ],
    });
    expect(parseArgs([sig], { PHASE0_RPC_URL: "https://env.example" })).toMatchObject({ rpc: "https://env.example", das: false });
  });

  it("ignores the bare -- that pnpm passes on", () => {
    expect(parseArgs(["--", "--rpc", "https://rpc.example", sig], {})).toMatchObject({ rpc: "https://rpc.example", targets: [{ signature: sig }] });
  });

  it("says what is wrong", () => {
    expect(parseArgs([sig], {})).toEqual({ error: "no RPC url: pass --rpc <url> or set PHASE0_RPC_URL" });
    expect(parseArgs(["--rpc", "ftp://x", sig], {})).toEqual({ error: "the RPC url must start with http:// or https://" });
    expect(parseArgs(["--rpc", "https://x"], {})).toEqual({ error: "no transaction signature given" });
    expect(parseArgs(["--rpc", "https://x", "nope"], {})).toMatchObject({ error: expect.stringContaining("not a transaction signature") });
    expect(parseArgs(["--rpc", "https://x", "--wat", sig], {})).toEqual({ error: "unknown option --wat" });
    expect(parseArgs(["--help"], {})).toEqual({ error: "" });
  });
});

describe("main", () => {
  const sig = SIG;
  function node(answers: Record<string, unknown>) {
    const requests: { method: string; params: unknown[] }[] = [];
    const fetch: Fetch = async (_url, init) => {
      const { id, method, params } = JSON.parse(init.body) as { id: number; method: string; params: unknown[] };
      requests.push({ method, params });
      const answer = answers[method];
      const text = JSON.stringify(answer instanceof Error ? { jsonrpc: "2.0", id, error: { code: -32000, message: answer.message } } : { jsonrpc: "2.0", id, result: answer });
      return { ok: true, status: 200, text: async () => text };
    };
    return { fetch, requests };
  }

  it("reads each transaction at the strongest commitment and prints one report", async () => {
    const n = node({ getTransaction: purchase() });
    const r = await main(["--rpc", "https://rpc.example", `purchase=${sig}`], { fetch: n.fetch, env: {} });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Read-only: this tool sent nothing");
    expect(r.out).toContain("## purchase");
    expect(n.requests).toEqual([{ method: "getTransaction", params: [sig, { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 }] }]);
    // it asked for nothing else
    expect(n.requests.every((q) => q.method === "getTransaction")).toBe(true);
  });

  it("asks for the asset record of the card when told to, and survives a node that cannot", async () => {
    const withDas = node({ getTransaction: purchase(), getAsset: { interface: "MplCoreAsset", ownership: { owner: BUYER, frozen: false } } });
    const a = await main(["--rpc", "https://rpc.example", "--das", sig], { fetch: withDas.fetch, env: {} });
    expect(a.out).toContain("Asset record of");
    expect(a.out).toContain("MplCoreAsset");
    expect(withDas.requests.filter((q) => q.method === "getAsset")).toEqual([{ method: "getAsset", params: [{ id: addr(50) }] }]);

    const without = node({ getTransaction: purchase(), getAsset: new Error("method not found") });
    const b = await main(["--rpc", "https://rpc.example", "--das", sig], { fetch: without.fetch, env: {} });
    expect(b.out).toContain("getAsset failed: getAsset: method not found");
    expect(b.code).toBe(0);
  });

  it("says when a transaction is not found and when the node fails, and never prints the url", async () => {
    const secret = "https://rpc.example/?api-key=SECRET123";
    const missing = await main(["--rpc", secret, sig], { fetch: node({ getTransaction: null }).fetch, env: {} });
    expect(missing.code).toBe(1);
    expect(missing.out).toContain("Not found");

    const broken = await main(["--rpc", secret, sig], { fetch: node({ getTransaction: new Error("boom") }).fetch, env: {} });
    expect(broken.code).toBe(1);
    expect(broken.out).toContain("boom");

    for (const out of [missing.out, broken.out]) expect(out).not.toContain("SECRET123");
  });

  it("prints the usage for wrong arguments, and exits cleanly for --help", async () => {
    const bad = await main([], { env: {} });
    expect(bad.code).toBe(2);
    expect(bad.out).toContain("usage: phase0");
    expect((await main(["--help"], { env: {} })).code).toBe(0);
  });
});
