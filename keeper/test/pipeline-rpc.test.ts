import { Transaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { RpcChainClient } from "../src/pipeline/rpc-chain.js";
import { OraoVrf } from "../src/pipeline/vrf.js";
import { ORAO_PROGRAM, oraoNetworkState, requestAddress } from "../src/solana/breaks.js";
import type { Instruction } from "../src/solana/instruction.js";
import { signerFromSecretKey } from "../src/solana/keypair.js";
import { RpcClient } from "../src/solana/rpc.js";
import { oneMachine } from "./support/packs.js";
import { BreakScheduler } from "../src/scheduler/scheduler.js";
import type { SchedulerStore } from "../src/scheduler/store.js";
import type { BreakAccount } from "../src/solana/breaks.js";
import { FeeSweeper } from "../src/sweep/sweeper.js";
import type { SweepStore } from "../src/sweep/store.js";
import { encodeNetworkState } from "./support/accounts.js";
import { addr } from "./support/chain.js";
import { FakeNode } from "./support/fake-node.js";
import { ANSWER, KEEPER, PROGRAMS, world } from "./support/world.js";

// The keeper's whole path through the real client: the pipeline builds instructions, the client compiles,
// signs and sends them over JSON-RPC, and a fake node decodes each transaction with web3.js (an independent
// parser), runs it on the model of the program, and serves the resulting accounts back. If a byte, a flag
// or a signature were wrong anywhere on the way, the model would refuse the transaction.

/** The keeper key whose address world() calls KEEPER. */
function keeperKey() {
  // world() uses addr(3) = 32 bytes of 3 as an address; a signer needs a seed, so use a seed and take its address.
  return signerFromSecretKey(new Uint8Array(32).fill(1));
}

async function connected() {
  const signer = keeperKey();
  const w = world();
  // The program model must expect the key we actually sign with.
  w.chain.config = { ...w.chain.config, keeper: signer.address };
  w.chain.solBalances.set(signer.address, 5_000_000_000n); // the keeper pays the rent of what `create_break` makes
  const node = new FakeNode();
  const seen: string[] = [];
  node.readAccount = (address) => w.chain.getAccountData(address);
  node.execute = async (bytes) => {
    const tx = Transaction.from(bytes);
    if (!tx.verifySignatures()) return { ok: false, err: "SignatureFailure" };
    const instructions: Instruction[] = tx.instructions.map((ix) => ({
      programId: ix.programId.toBase58(),
      accounts: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
      data: new Uint8Array(ix.data),
    }));
    const result = await w.chain.sendAndConfirm(instructions);
    seen.push(w.chain.applied.at(-1) ?? "?");
    return result.outcome === "confirmed" ? { ok: true } : { ok: false, err: result.outcome === "failed" ? result.reason : "unknown" };
  };
  const rpc = new RpcClient({ url: "http://fake", fetch: node.fetch, sleep: node.sleep });
  const client = await RpcChainClient.connect({ rpc, signer, cluster: "devnet", now: node.now, sleep: node.sleep });
  return { w, node, client, signer, seen };
}

describe("the pipeline through the real RPC client", () => {
  it("takes a funded break all the way to a recorded draw with real transactions", async () => {
    const { w, client, signer, node } = await connected();
    await w.pullPacks();
    const pipe = w.pipeline({ chain: client, keeper: signer.address });

    const first = await pipe.advance(w.active);
    expect(first.sent.map((s) => s.step)).toEqual(["commit_pool", "request_randomness"]);
    expect(first.sent.every((s) => s.result.outcome === "confirmed")).toBe(true);
    expect(first.chainStatus).toBe("RandomnessRequested");

    const request = requestAddress(ORAO_PROGRAM, w.chain.breaks.get(7n)!.randomnessRequestId);
    w.chain.fulfill(request, ANSWER);
    const second = await pipe.advance(w.active);
    expect(second.sent.map((s) => s.step)).toEqual(["settle_randomness", "claim_free_spot#0", "claim_free_spot#1"]);
    expect(second.chainStatus).toBe("Drawn");
    expect(second.problem).toBeUndefined();

    // Each of those was a distinct transaction the node accepted, and none was executed twice.
    expect(w.chain.applied).toEqual(["commit_pool", "request_randomness", "settle_randomness", "claim_free_spot", "claim_free_spot"]);
    expect(node.sent.length).toBeGreaterThanOrEqual(5);
  });

  it("reads ORAO's treasury from its network state through the client and sends the request to it", async () => {
    const { w, client, signer } = await connected();
    await w.pullPacks();
    // ORAO's authority moves the treasury: the request still goes to the right one.
    w.chain.accounts.set(
      oraoNetworkState(ORAO_PROGRAM),
      encodeNetworkState({ authority: addr(0xa0), treasury: addr(0x99), requestFee: 1_500_000n, fulfillmentAuthorities: [], numReceived: 1n }),
    );
    const pipe = w.pipeline({ chain: client, keeper: signer.address, vrf: new OraoVrf(client, ORAO_PROGRAM) });
    const r = await pipe.advance(w.active);
    expect(r.sent.map((x) => x.step)).toEqual(["commit_pool", "request_randomness"]);
    expect(r.problem).toBeUndefined();
    expect(w.chain.applied).toEqual(["commit_pool", "request_randomness"]);
  });

  it("reports a step the program refuses as failed, with the node's reason", async () => {
    const { w, client, signer } = await connected();
    await w.pullPacks();
    // The model refuses commit_pool unless the signer is its configured keeper.
    w.chain.config = { ...w.chain.config, keeper: KEEPER };
    const pipe = w.pipeline({ chain: client, keeper: signer.address });
    const r = await pipe.advance(w.active);
    expect(r.problem).toMatch(/commit_pool failed: Unauthorized/);
    expect(w.chain.applied).toEqual([]);
  });
});

describe("the scheduler through the real RPC client", () => {
  it("creates a break with a real signed transaction that the program model accepts", async () => {
    const { w, client, signer, node } = await connected();
    // The treasury can pay for the worst case of the break below: 3 * (25 - 20) = $15 and 2 * 25 = $50.
    w.chain.treasury.subsidyVault = 15_000_000n;
    w.chain.treasury.holderVault = 50_000_000n;

    const recorded: BreakAccount[] = [];
    const store: SchedulerStore = {
      highestOnchainId: async () => 7n, // the fixture's funded break, already known
      recordBreak: async (b) => void recorded.push(b),
      openOnchainIds: async () => recorded.map((b) => b.id),
    };
    const now = () => new Date(Number(w.chain.unixTime) * 1000);
    const scheduler = new BreakScheduler({
      chain: client,
      programs: PROGRAMS,
      keeper: signer.address,
      store,
      template: { paidSpots: 3, freeSpots: 2, spotPrice: 20_000_000n, packs: oneMachine("pokemon-25", 25_000_000n, 5), windowSecs: 21_600n },
      enabled: true,
      now,
    });

    const first = await scheduler.run();
    expect(first).toMatchObject({ kind: "created", breakId: 8n });
    expect(w.chain.applied).toEqual(["create_break"]);
    expect(node.sent).toHaveLength(1);
    expect(w.chain.breaks.get(8n)).toMatchObject({ status: "Open", paidSpots: 3, freeSpots: 2, lockedSubsidy: 15_000_000n, lockedHolder: 50_000_000n });
    expect(w.chain.treasury.config).toMatchObject({ lockedSubsidy: 15_000_000n, lockedHolder: 50_000_000n });

    // The next run copies it from the chain and sees it is still selling: no second transaction.
    const second = await scheduler.run();
    expect(second).toMatchObject({ kind: "selling", breakId: 8n, recorded: [8n] });
    expect(node.sent).toHaveLength(1);
  });

  it("reports the program's refusal when the treasury cannot pay, as the node explains it", async () => {
    const { w, client, signer } = await connected();
    // Enough for the pre-check but the program model is told otherwise: its vault is emptied after the scheduler looks.
    w.chain.treasury.subsidyVault = 15_000_000n;
    w.chain.treasury.holderVault = 50_000_000n;
    const store: SchedulerStore = { highestOnchainId: async () => 7n, recordBreak: async () => {}, openOnchainIds: async () => [] };
    const racing = { ...client, getAccountData: client.getAccountData.bind(client), sendAndConfirm: async (ix: Parameters<typeof client.sendAndConfirm>[0]) => {
      w.chain.treasury.holderVault = 0n; // another break took the money in between
      return client.sendAndConfirm(ix);
    } };
    const scheduler = new BreakScheduler({
      chain: racing,
      programs: PROGRAMS,
      keeper: signer.address,
      store,
      template: { paidSpots: 3, freeSpots: 2, spotPrice: 20_000_000n, packs: oneMachine("pokemon-25", 25_000_000n, 5), windowSecs: 21_600n },
      enabled: true,
      now: () => new Date(Number(w.chain.unixTime) * 1000),
    });
    const r = await scheduler.run();
    expect(r).toMatchObject({ kind: "failed", breakId: 8n });
    expect((r as { reason: string }).reason).toMatch(/InsufficientAvailable/);
    expect(w.chain.breaks.has(8n)).toBe(false);
  });
});

describe("the fee sweep through the real RPC client", () => {
  it("deposits USDC into the treasury with a real signed transaction that the program model accepts", async () => {
    const { w, client, signer, node } = await connected();
    w.chain.giveUsdc(signer.address, 1_000_001n);
    const events: unknown[] = [];
    const store = { recordEvent: async (e: unknown) => void events.push(e) } as unknown as SweepStore;
    const sweeper = new FeeSweeper({
      chain: client,
      treasuryProgram: PROGRAMS.treasury,
      wallet: signer.address,
      wallets: w.chain,
      store,
      policy: { keepLamports: 0n, minLamports: 1n, maxLamports: 1n, slippageBps: 0, minDeposit: 1n },
    });

    const r = await sweeper.run();
    expect(r.deposit).toMatchObject({ kind: "deposited", amount: 1_000_001n });
    expect(w.chain.applied).toEqual(["deposit_fees"]);
    expect(node.sent).toHaveLength(1);
    expect(w.chain.treasury.subsidyVault).toBe(700_000n);
    expect(w.chain.treasury.holderVault).toBe(300_001n);
    expect(events).toHaveLength(1);

    // Nothing left: a second run sends nothing.
    expect((await sweeper.run()).deposit.kind).toBe("none");
    expect(node.sent).toHaveLength(1);
  });
});
