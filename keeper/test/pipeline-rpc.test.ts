import { Transaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { RpcChainClient } from "../src/pipeline/rpc-chain.js";
import { ORAO_PROGRAM, requestAddress } from "../src/solana/breaks.js";
import type { Instruction } from "../src/solana/instruction.js";
import { signerFromSecretKey } from "../src/solana/keypair.js";
import { RpcClient } from "../src/solana/rpc.js";
import { FakeNode } from "./support/fake-node.js";
import { ANSWER, KEEPER, world } from "./support/world.js";

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
