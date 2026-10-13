import { Connection, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { readTransaction } from "../src/indexer/parse.js";
import { RpcTokenReader } from "../src/indexer/reader.js";
import { RpcClient } from "../src/solana/rpc.js";
import { TokenLedger } from "./support/token-ledger.js";

const T0 = 1_800_000_000;

function world() {
  const ledger = new TokenLedger(T0);
  const alice = ledger.holder("alice");
  const bob = ledger.holder("bob");
  const first = ledger.mintTo(alice, 100n);
  const second = ledger.transfer(alice, bob, 40n, { v0: true });
  const failed = ledger.fail(alice, bob);
  return { ledger, alice, bob, first, second, failed };
}

describe("RpcTokenReader", () => {
  it("lists signatures newest first and tells failed transactions apart", async () => {
    const { ledger, alice, first, second, failed } = world();
    const reader = new RpcTokenReader(new RpcClient({ url: "http://node", fetch: ledger.node() }));
    const list = await reader.signatures(alice.account, { limit: 10 });
    expect(list.map((s) => [s.signature, s.failed])).toEqual([
      [failed, true],
      [second, false],
      [first, false],
    ]);
  });

  it("pages with before and until", async () => {
    const { ledger, alice, first, second, failed } = world();
    const reader = new RpcTokenReader(new RpcClient({ url: "http://node", fetch: ledger.node() }));
    expect((await reader.signatures(alice.account, { limit: 1 })).map((s) => s.signature)).toEqual([failed]);
    expect((await reader.signatures(alice.account, { limit: 1, before: failed })).map((s) => s.signature)).toEqual([second]);
    expect((await reader.signatures(alice.account, { limit: 10, until: first })).map((s) => s.signature)).toEqual([failed, second]);
  });

  it("fetches transactions in the order asked and the parser can read them", async () => {
    const { ledger, first, second } = world();
    const reader = new RpcTokenReader(new RpcClient({ url: "http://node", fetch: ledger.node() }), { concurrency: 2 });
    const txs = await reader.transactions([second, first]);
    expect(txs.map((t) => t.transaction.signatures[0])).toEqual([second, first]);
    expect(readTransaction(txs[1]!, ledger.mint, first).events).toEqual(ledger.truth.filter((e) => e.signature === first));
  });

  it("never has more than `concurrency` transactions in flight", async () => {
    const ledger = new TokenLedger(T0);
    const alice = ledger.holder("alice");
    const sigs = Array.from({ length: 9 }, () => ledger.mintTo(alice, 1n));
    let inFlight = 0;
    let peak = 0;
    const inner = ledger.node();
    const slow: typeof inner = async (url, init) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      try {
        return await inner(url, init);
      } finally {
        inFlight -= 1;
      }
    };
    const reader = new RpcTokenReader(new RpcClient({ url: "http://node", fetch: slow }), { concurrency: 3 });
    expect(await reader.transactions(sigs)).toHaveLength(9);
    expect(peak).toBe(3);
  });

  it("throws when the node does not have a transaction, instead of skipping it", async () => {
    const { ledger } = world();
    const reader = new RpcTokenReader(new RpcClient({ url: "http://node", fetch: ledger.node() }));
    await expect(reader.transactions(["no-such-signature"])).rejects.toThrow(/no finalized transaction no-such-signature/);
  });

  describe("against web3.js as an independent oracle", () => {
    it("asks the same questions web3.js asks for the same data, and the answers pass web3.js's schema", async () => {
      const { ledger, alice, first, second } = world();
      const mine = new RpcTokenReader(new RpcClient({ url: "http://node", fetch: ledger.node() }));
      await mine.signatures(alice.account, { limit: 5, before: second, until: first });
      await mine.transactions([second]);
      const myRequests = ledger.requests.splice(0);

      const connection = new Connection("http://node", { fetch: ledger.node() as unknown as typeof fetch });
      await connection.getSignaturesForAddress(new PublicKey(alice.account), { limit: 5, before: second, until: first }, "finalized");
      // Throws if the answer does not match web3.js's schema for a parsed transaction (field names, types, annotated keys).
      const parsed = await connection.getParsedTransaction(second, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
      const theirRequests = ledger.requests.splice(0);

      expect(parsed?.transaction.signatures).toEqual([second]);
      expect(parsed?.transaction.message.accountKeys.some((k) => k.source === "lookupTable")).toBe(true);
      expect(myRequests).toEqual(theirRequests);
    });
  });
});
