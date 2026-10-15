import { ed25519 } from "@noble/curves/ed25519.js";
import { Message, Transaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcChainClient, connectFromConfig, describeTransactionError } from "../src/pipeline/rpc-chain.js";
import * as breaks from "../src/solana/breaks.js";
import { GENESIS_HASHES, WrongClusterError, assertCluster } from "../src/solana/cluster.js";
import type { Instruction } from "../src/solana/instruction.js";
import { signerFromSecretKey } from "../src/solana/keypair.js";
import { RpcClient } from "../src/solana/rpc.js";
import { MissingSignerError, TransactionTooLargeError } from "../src/solana/transaction.js";
import { addr } from "./support/chain.js";
import { FakeNode, signatureOf } from "./support/fake-node.js";

const keeper = signerFromSecretKey(new Uint8Array(32).fill(1));
const PROGRAMS = { breaks: "8tmJjCG3D4TF7oPiPWNoaCjZ4pN2U4H237BSGVw2B8KU", treasury: "Bvq3U9fz2MiHkLH8u4zyt6T1bimxnaEuHkZhezNDT5R9" };
const commit = (): Instruction => breaks.commitPool(PROGRAMS, { keeper: keeper.address, breakId: 7n, poolHash: new Uint8Array(32).fill(3), poolSize: 5 });
const LANDED = { afterLookups: 0, err: null, confirmationStatus: "confirmed" as const };

async function setup(configure: (node: FakeNode) => void = () => {}, opts: { commitment?: "confirmed" | "finalized"; maxWaitMs?: number } = {}) {
  const node = new FakeNode();
  configure(node);
  const rpc = new RpcClient({ url: "http://fake", fetch: node.fetch, sleep: node.sleep, retries: 2 });
  const client = await RpcChainClient.connect({
    rpc,
    signer: keeper,
    cluster: "devnet",
    now: node.now,
    sleep: node.sleep,
    pollMs: 1_000,
    rebroadcastMs: 4_000,
    ...opts,
  });
  return { node, client };
}

const methods = (node: FakeNode) => node.requests.map((r) => r.method);

describe("RpcChainClient: reading", () => {
  it("returns an account's data, or undefined when it does not exist", async () => {
    const { node, client } = await setup((n) => n.accounts.set("Acct", Uint8Array.of(1, 2, 3)));
    expect(await client.getAccountData("Acct")).toEqual(Uint8Array.of(1, 2, 3));
    expect(await client.getAccountData("Missing")).toBeUndefined();
    const call = node.requests.find((r) => r.method === "getAccountInfo");
    expect(call?.params[1]).toMatchObject({ encoding: "base64", commitment: "confirmed" });
  });

  it("tells whether the account is a program and how many lamports it holds, and can ask for only a part of its data", async () => {
    const node = new FakeNode();
    node.accounts.set("Prog", Uint8Array.of(1, 2, 3, 4, 5, 6));
    node.owners.set("Prog", "Loader");
    node.executables.add("Prog");
    node.lamports.set("Prog", 1_141_440n);
    node.accounts.set("Plain", Uint8Array.of(9));
    const rpc = new RpcClient({ url: "http://fake", fetch: node.fetch, sleep: node.sleep, retries: 0 });
    expect(await rpc.getAccountInfo("Prog", { commitment: "finalized" })).toEqual({ data: Uint8Array.of(1, 2, 3, 4, 5, 6), owner: "Loader", slot: 500, lamports: 1_141_440n, executable: true });
    expect(await rpc.getAccountInfo("Prog", { commitment: "confirmed", dataSlice: { offset: 1, length: 3 } })).toMatchObject({ data: Uint8Array.of(2, 3, 4) });
    expect(node.requests[1]?.params[1]).toEqual({ encoding: "base64", commitment: "confirmed", dataSlice: { offset: 1, length: 3 } });
    expect(node.requests[0]?.params[1]).not.toHaveProperty("dataSlice");
    expect(await rpc.getAccountInfo("Plain", { commitment: "confirmed" })).toMatchObject({ executable: false, lamports: 1n });
  });

  it("retries a read that was refused as too early, then gives up with the node's message", async () => {
    const ok = await setup((n) => {
      n.accounts.set("Acct", Uint8Array.of(9));
      n.staleReads = 3;
    });
    expect(await ok.client.getAccountData("Acct")).toEqual(Uint8Array.of(9));
    expect(ok.node.minContextSlots).toHaveLength(4);

    const stuck = await setup((n) => {
      n.staleReads = 100;
    });
    await expect(stuck.client.getAccountData("Acct")).rejects.toThrow(/Minimum context slot/);
  });

  it("retries a node that is briefly unavailable, and reports one that stays down", async () => {
    const brief = await setup((n) => {
      n.accounts.set("Acct", Uint8Array.of(5));
    });
    const original = brief.node.fetch;
    let failures = 2;
    const rpc = new RpcClient({
      url: "x",
      sleep: brief.node.sleep,
      retries: 3,
      fetch: async (url, init) => (failures-- > 0 ? { ok: false, status: 503, text: async () => "" } : original(url, init)),
    });
    expect((await rpc.getAccountInfo("Acct", { commitment: "confirmed" }))?.data).toEqual(Uint8Array.of(5));

    const down = new RpcClient({ url: "x", sleep: brief.node.sleep, retries: 2, fetch: async () => ({ ok: false, status: 503, text: async () => "" }) });
    await expect(down.getAccountInfo("Acct", { commitment: "confirmed" })).rejects.toThrow(/gave up after 3 tries/);
  });
});

describe("RpcChainClient: sending", () => {
  it("sends a valid signed transaction and answers confirmed with its signature", async () => {
    const { node, client } = await setup((n) => {
      n.landing = { ...LANDED, afterLookups: 2 };
    });
    const result = await client.sendAndConfirm([commit()]);
    expect(result.outcome).toBe("confirmed");
    expect(node.sent).toHaveLength(1);
    expect(result).toMatchObject({ signature: signatureOf(node.sent[0] as Uint8Array) });

    // What reached the node is a real transaction: web3.js reads it, and the signature verifies.
    const tx = Transaction.from(node.sent[0] as Uint8Array);
    expect(tx.verifySignatures()).toBe(true);
    expect(tx.feePayer?.toBase58()).toBe(keeper.address);
    const message = Message.from(tx.serializeMessage());
    const keys = message.accountKeys.map((k) => k.toBase58());
    expect(keys[message.instructions[0]?.programIdIndex as number]).toBe(PROGRAMS.breaks);
    expect(ed25519.verify(tx.signatures[0]?.signature as Uint8Array, tx.serializeMessage(), ed25519.getPublicKey(new Uint8Array(32).fill(1)))).toBe(true);
  });

  it("sends the same signed transaction again while it has not landed", async () => {
    const { node, client } = await setup((n) => {
      n.landing = { ...LANDED, afterLookups: 8 };
    });
    expect((await client.sendAndConfirm([commit()])).outcome).toBe("confirmed");
    expect(node.sent.length).toBeGreaterThan(1);
    expect(new Set(node.sent.map((b) => Buffer.from(b).toString("hex"))).size).toBe(1);
  });

  it("asks for a fresh blockhash for every transaction and nothing else changes it", async () => {
    const { node, client } = await setup((n) => {
      n.landing = LANDED;
    });
    await client.sendAndConfirm([commit()]);
    await client.sendAndConfirm([commit()]);
    expect(methods(node).filter((m) => m === "getLatestBlockhash")).toHaveLength(2);
  });

  it("waits for finalized when told to", async () => {
    const { client } = await setup(
      (n) => {
        n.landing = { ...LANDED, confirmationStatus: "confirmed" };
        n.heightStep = 10;
      },
      { commitment: "finalized", maxWaitMs: 5_000 },
    );
    expect((await client.sendAndConfirm([commit()])).outcome).toBe("unknown");
    const fin = await setup((n) => {
      n.landing = { ...LANDED, confirmationStatus: "finalized" };
    }, { commitment: "finalized" });
    expect((await fin.client.sendAndConfirm([commit()])).outcome).toBe("confirmed");
  });

  it("reads at least as new as its own transaction afterwards", async () => {
    const { node, client } = await setup((n) => {
      n.landing = LANDED;
      n.accounts.set("Acct", Uint8Array.of(1));
    });
    await client.getAccountData("Acct");
    expect(node.minContextSlots.at(-1)).toBeUndefined();
    node.slot = 777;
    await client.sendAndConfirm([commit()]);
    await client.getAccountData("Acct");
    expect(node.minContextSlots.at(-1)).toBe(777);
  });
});

describe("RpcChainClient: when it does not work out", () => {
  const anchorLogs = ["Program log: AnchorError thrown in programs/breaks/src/lifecycle.rs:276. Error Code: WrongStatus. Error Number: 6004. Error Message: Wrong status."];

  it("a transaction the node refuses in preflight is failed, with the program's error name", async () => {
    const { node, client } = await setup((n) => {
      n.sendScript = [{ error: { code: -32002, message: "Transaction simulation failed", data: { err: { InstructionError: [0, { Custom: 6004 }] }, logs: anchorLogs } } }];
    });
    const result = await client.sendAndConfirm([commit()]);
    expect(result).toMatchObject({ outcome: "failed" });
    expect((result as { reason: string }).reason).toMatch(/WrongStatus \(6004\)/);
    expect(node.sent).toHaveLength(0);
  });

  it("a blockhash the node has not seen yet is not a failure", async () => {
    const { node, client } = await setup((n) => {
      n.sendScript = [{ error: { code: -32002, message: "Blockhash not found", data: { err: "BlockhashNotFound" } } }];
      n.landing = LANDED;
    });
    expect((await client.sendAndConfirm([commit()])).outcome).toBe("confirmed");
    expect(node.sent.length).toBeGreaterThanOrEqual(1);
  });

  it("a transaction that landed and reverted is failed, with the reason from its log", async () => {
    const { client } = await setup((n) => {
      n.landing = { afterLookups: 0, err: { InstructionError: [0, { Custom: 6004 }] }, confirmationStatus: "confirmed", logs: anchorLogs };
    });
    const result = await client.sendAndConfirm([commit()]);
    expect(result.outcome).toBe("failed");
    expect((result as { reason: string }).reason).toContain("WrongStatus (6004)");
  });

  it("a revert is still reported when the node cannot give the log", async () => {
    const { node } = await setup((n) => {
      n.landing = { afterLookups: 0, err: { InstructionError: [0, { Custom: 6004 }] }, confirmationStatus: "confirmed" };
    });
    const original = node.fetch;
    const rpc = new RpcClient({ url: "x", sleep: node.sleep, retries: 0, fetch: async (u, i) => (JSON.parse(i.body).method === "getTransaction" ? { ok: false, status: 500, text: async () => "" } : original(u, i)) });
    const other = await RpcChainClient.connect({ rpc, signer: keeper, cluster: "devnet", now: node.now, sleep: node.sleep });
    const result = await other.sendAndConfirm([commit()]);
    expect(result).toMatchObject({ outcome: "failed" });
    expect((result as { reason: string }).reason).toContain("Custom");
  });

  it("a transaction whose blockhash expired is failed, once a last look through history finds nothing", async () => {
    const { node, client } = await setup((n) => {
      n.heightStep = 100;
    });
    const result = await client.sendAndConfirm([commit()]);
    expect(result).toMatchObject({ outcome: "failed" });
    expect((result as { reason: string }).reason).toMatch(/expired/);
    expect(node.requests.filter((r) => r.method === "getSignatureStatuses").some((r) => (r.params[1] as { searchTransactionHistory: boolean }).searchTransactionHistory)).toBe(true);
  });

  it("a transaction found only by that last look is not called failed", async () => {
    const { client } = await setup((n) => {
      n.heightStep = 100;
      n.historyOnly = LANDED;
    });
    expect((await client.sendAndConfirm([commit()])).outcome).toBe("confirmed");
  });

  it("answers unknown, not failed, when the node keeps failing and time runs out", async () => {
    const { client } = await setup(
      (n) => {
        n.statusFailures = 1000;
      },
      { maxWaitMs: 10_000 },
    );
    const result = await client.sendAndConfirm([commit()]);
    expect(result).toMatchObject({ outcome: "unknown" });
    expect((result as { reason: string }).reason).toMatch(/not confirmed within 10000 ms .*unhealthy/);
  });

  it("does not guess when it is only processed", async () => {
    const { client } = await setup(
      (n) => {
        n.landing = { ...LANDED, confirmationStatus: "processed" };
      },
      { maxWaitMs: 5_000 },
    );
    expect((await client.sendAndConfirm([commit()])).outcome).toBe("unknown");
  });

  it("throws, without sending, for something it can never send", async () => {
    const { node, client } = await setup();
    const foreign: Instruction = { programId: PROGRAMS.breaks, accounts: [{ pubkey: addr(80), isSigner: true, isWritable: false }], data: new Uint8Array(1) };
    await expect(client.sendAndConfirm([foreign])).rejects.toBeInstanceOf(MissingSignerError);
    const huge: Instruction = { programId: PROGRAMS.breaks, accounts: [], data: new Uint8Array(1400) };
    await expect(client.sendAndConfirm([huge])).rejects.toBeInstanceOf(TransactionTooLargeError);
    expect(node.sent).toHaveLength(0);
  });

  it("throws, rather than answering unknown, when the node is down before anything was sent", async () => {
    const node = new FakeNode();
    const rpc = new RpcClient({
      url: "x",
      sleep: node.sleep,
      retries: 1,
      fetch: async (url, init) => (JSON.parse(init.body).method === "getGenesisHash" ? node.fetch(url, init) : { ok: false, status: 503, text: async () => "" }),
    });
    const client = await RpcChainClient.connect({ rpc, signer: keeper, cluster: "devnet", now: node.now, sleep: node.sleep });
    await expect(client.sendAndConfirm([commit()])).rejects.toThrow(/gave up/);
    expect(node.sent).toHaveLength(0);
  });
});

describe("describeTransactionError", () => {
  it("names the program error when the log has it, and falls back to the raw error", () => {
    expect(describeTransactionError({ InstructionError: [0, { Custom: 1 }] }, ["Program log: Error Code: Unauthorized. Error Number: 6000."])).toBe(
      'Unauthorized (6000): {"InstructionError":[0,{"Custom":1}]}',
    );
    expect(describeTransactionError("BlockhashNotFound", null)).toBe("BlockhashNotFound");
    expect(describeTransactionError({ InstructionError: [1, "InvalidAccountData"] })).toBe('{"InstructionError":[1,"InvalidAccountData"]}');
  });
});

describe("the cluster guard (devnet only)", () => {
  const rpcWith = (genesis: string) => ({ getGenesisHash: async () => genesis });

  it("accepts devnet for devnet, and any private chain for localnet", async () => {
    await expect(assertCluster(rpcWith(GENESIS_HASHES.devnet), "devnet")).resolves.toBeUndefined();
    await expect(assertCluster(rpcWith("SomeLocalValidatorGenesisHash111111111111111111"), "localnet")).resolves.toBeUndefined();
    await expect(assertCluster(rpcWith(GENESIS_HASHES.devnet), "localnet")).resolves.toBeUndefined();
  });

  it("refuses mainnet and testnet whatever the config says", async () => {
    for (const cluster of ["devnet", "localnet"] as const) {
      await expect(assertCluster(rpcWith(GENESIS_HASHES["mainnet-beta"]), cluster)).rejects.toThrow(/mainnet-beta/);
      await expect(assertCluster(rpcWith(GENESIS_HASHES.testnet), cluster)).rejects.toThrow(/testnet/);
    }
  });

  it("refuses an unknown network when the config says devnet", async () => {
    await expect(assertCluster(rpcWith("SomeOtherNetwork1111111111111111111111111111"), "devnet")).rejects.toBeInstanceOf(WrongClusterError);
  });

  it("connect() hands out no client for the wrong network, and sends nothing", async () => {
    const node = new FakeNode();
    node.genesis = GENESIS_HASHES["mainnet-beta"];
    const rpc = new RpcClient({ url: "x", fetch: node.fetch, sleep: node.sleep });
    await expect(RpcChainClient.connect({ rpc, signer: keeper, cluster: "devnet" })).rejects.toBeInstanceOf(WrongClusterError);
    expect(node.requests.map((r) => r.method)).toEqual(["getGenesisHash"]);
  });
});

describe("connectFromConfig", () => {
  const keyFile = () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-cfg-"));
    const file = join(dir, "key.json");
    const seed = new Uint8Array(32).fill(1);
    writeFileSync(file, JSON.stringify([...seed, ...ed25519.getPublicKey(seed)]));
    return file;
  };
  const base = { rpcUrl: "http://fake", cluster: "devnet" as const, commitment: "confirmed" as const };

  it("needs a key file", async () => {
    await expect(connectFromConfig({ ...base })).rejects.toThrow(/KEEPER_KEYPAIR_PATH is not set/);
  });

  it("connects with the key from the file, and signs with it", async () => {
    const node = new FakeNode();
    node.landing = LANDED;
    const client = await connectFromConfig({ ...base, keeperKeypairPath: keyFile() }, { fetch: node.fetch });
    expect((await client.sendAndConfirm([breaks.commitPool(PROGRAMS, { keeper: keeper.address, breakId: 7n, poolHash: new Uint8Array(32), poolSize: 1 })])).outcome).toBe("confirmed");
    expect(Transaction.from(node.sent[0] as Uint8Array).feePayer?.toBase58()).toBe(keeper.address);
  });

  it("does not connect to the wrong network, and sends nothing", async () => {
    const node = new FakeNode();
    node.genesis = GENESIS_HASHES["mainnet-beta"];
    await expect(connectFromConfig({ ...base, keeperKeypairPath: keyFile() }, { fetch: node.fetch })).rejects.toBeInstanceOf(WrongClusterError);
    expect(node.sent).toHaveLength(0);
  });

  it("reports an unreadable key file without printing it", async () => {
    await expect(connectFromConfig({ ...base, keeperKeypairPath: "/nonexistent/key.json" })).rejects.toThrow(/could not read a keypair from \/nonexistent\/key.json/);
  });
});
