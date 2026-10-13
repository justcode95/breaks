import { describe, expect, it } from "vitest";
import { readTransaction, type TransactionJson } from "../src/indexer/parse.js";
import { TokenLedger } from "./support/token-ledger.js";

const T0 = 1_800_000_000;

/** The wire form of a recorded transaction, by signature. */
async function wireOf(ledger: TokenLedger, signature: string): Promise<TransactionJson> {
  const [tx] = await ledger.transactions([signature]);
  return tx as TransactionJson;
}

describe("readTransaction", () => {
  it("reads a transfer as one loss and one gain, in exact base units", async () => {
    const ledger = new TokenLedger(T0);
    const alice = ledger.holder("alice");
    const bob = ledger.holder("bob");
    ledger.mintTo(alice, 90_071_992_547_409_930n); // above 2^53: a float would round it
    const sig = ledger.transfer(alice, bob, 90_071_992_547_409_925n);

    const { events, accounts } = readTransaction(await wireOf(ledger, sig), ledger.mint, sig);
    expect(events).toEqual(ledger.truth.filter((e) => e.signature === sig));
    expect(events.map((e) => [e.owner, e.delta, e.balanceAfter])).toEqual([
      [alice.wallet, -90_071_992_547_409_925n, 5n],
      [bob.wallet, 90_071_992_547_409_925n, 90_071_992_547_409_925n],
    ]);
    expect(accounts.sort()).toEqual([alice.account, bob.account].sort());
  });

  it("treats a new account as starting empty and a closed account as ending empty", async () => {
    const ledger = new TokenLedger(T0);
    const alice = ledger.holder("alice");
    const bob = ledger.holder("bob");
    const mint = ledger.mintTo(alice, 100n);
    const close = ledger.close(alice, bob);

    const created = readTransaction(await wireOf(ledger, mint), ledger.mint, mint);
    expect(created.events).toEqual([expect.objectContaining({ tokenAccount: alice.account, delta: 100n, balanceAfter: 100n })]);

    const closed = readTransaction(await wireOf(ledger, close), ledger.mint, close);
    expect(closed.events).toEqual(ledger.truth.filter((e) => e.signature === close));
    expect(closed.events.find((e) => e.tokenAccount === alice.account)).toMatchObject({ delta: -100n, balanceAfter: 0n });
    // the closed account holds nothing any more, the receiving one does
    expect(closed.accounts).toContain(bob.account);
  });

  it("ignores another token's balances in the same transaction", async () => {
    const ledger = new TokenLedger(T0);
    const alice = ledger.holder("alice");
    const sig = ledger.mintTo(alice, 5n, { noise: true });
    const tx = await wireOf(ledger, sig);
    // The other token's balance did change in this transaction (1000 -> 123456789).
    expect(tx.meta?.postTokenBalances?.map((b) => b.uiTokenAmount.amount)).toContain("123456789");
    const { events, accounts } = readTransaction(tx, ledger.mint, sig);
    expect(events).toEqual([expect.objectContaining({ tokenAccount: alice.account, delta: 5n })]);
    expect(accounts).toEqual([alice.account]);
  });

  it("reads nothing from a failed transaction", async () => {
    const ledger = new TokenLedger(T0);
    const alice = ledger.holder("alice");
    const bob = ledger.holder("bob");
    ledger.mintTo(alice, 5n);
    const sig = ledger.fail(alice, bob);
    expect(readTransaction(await wireOf(ledger, sig), ledger.mint, sig)).toEqual({ events: [], accounts: [] });
  });

  it("makes no event, and does not ask for the account, when the balance did not change and is empty", async () => {
    const ledger = new TokenLedger(T0);
    const alice = ledger.holder("alice");
    const sig = ledger.touch(alice);
    expect(readTransaction(await wireOf(ledger, sig), ledger.mint, sig)).toEqual({ events: [], accounts: [] });
  });

  it("asks for an account that holds tokens even when this transaction did not change it", async () => {
    const ledger = new TokenLedger(T0);
    const alice = ledger.holder("alice");
    ledger.mintTo(alice, 5n);
    const sig = ledger.touch(alice);
    const { events, accounts } = readTransaction(await wireOf(ledger, sig), ledger.mint, sig);
    expect(events).toEqual([]);
    expect(accounts).toEqual([alice.account]);
  });

  it("splits a change of owner into a loss for the old owner and a gain for the new one", async () => {
    const ledger = new TokenLedger(T0);
    const alice = ledger.holder("alice");
    const bob = ledger.holder("bob");
    ledger.mintTo(alice, 40n);
    const sig = ledger.setOwner(alice, bob.wallet);
    const { events } = readTransaction(await wireOf(ledger, sig), ledger.mint, sig);
    expect(events).toEqual(ledger.truth.filter((e) => e.signature === sig));
    expect(events.map((e) => [e.owner, e.delta, e.balanceAfter])).toEqual([
      [alice.wallet, -40n, 0n],
      [bob.wallet, 40n, 40n],
    ]);
  });

  it("finds token accounts that came from an address lookup table", async () => {
    const ledger = new TokenLedger(T0);
    const alice = ledger.holder("alice");
    const bob = ledger.holder("bob");
    ledger.mintTo(alice, 10n);
    const sig = ledger.transfer(alice, bob, 4n, { v0: true });
    const tx = await wireOf(ledger, sig);
    expect(tx.meta?.loadedAddresses?.writable).toEqual([alice.account, bob.account]);
    expect(readTransaction(tx, ledger.mint, sig).events).toEqual(ledger.truth.filter((e) => e.signature === sig));
  });

  it("falls back to the loaded addresses when the keys list only the static accounts", async () => {
    const ledger = new TokenLedger(T0);
    const alice = ledger.holder("alice");
    const bob = ledger.holder("bob");
    ledger.mintTo(alice, 10n);
    const sig = ledger.transfer(alice, bob, 4n, { v0: true });
    const tx = await wireOf(ledger, sig);
    // The plain `json` encoding: static keys as strings, the looked-up ones only under loadedAddresses.
    const staticKeys = tx.transaction.message.accountKeys.filter((k) => typeof k !== "string" && (k as { source?: string }).source !== "lookupTable");
    const plain: TransactionJson = {
      ...tx,
      transaction: { ...tx.transaction, message: { accountKeys: staticKeys.map((k) => (k as { pubkey: string }).pubkey) } },
    };
    expect(readTransaction(plain, ledger.mint, sig).events).toEqual(ledger.truth.filter((e) => e.signature === sig));
  });

  it("refuses what it cannot read exactly", async () => {
    const ledger = new TokenLedger(T0);
    const alice = ledger.holder("alice");
    const sig = ledger.mintTo(alice, 10n);
    const tx = await wireOf(ledger, sig);

    expect(() => readTransaction(tx, ledger.mint, "another-signature")).toThrow(/answered with transaction/);
    expect(() => readTransaction({ ...tx, blockTime: null }, ledger.mint, sig)).toThrow(/no block time/);
    expect(() => readTransaction({ ...tx, meta: null }, ledger.mint, sig)).toThrow(/no metadata/);

    const ownerless = structuredClone(tx);
    delete (ownerless.meta!.postTokenBalances![0] as { owner?: string }).owner;
    expect(() => readTransaction(ownerless, ledger.mint, sig)).toThrow(/has no owner/);

    const outOfRange = structuredClone(tx);
    outOfRange.meta!.postTokenBalances![0]!.accountIndex = 99;
    expect(() => readTransaction(outOfRange, ledger.mint, sig)).toThrow(/out of range/);
  });
});
