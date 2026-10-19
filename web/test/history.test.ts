import { describe, expect, it } from "vitest";
import { MAX_SIGNATURES, MAX_TRANSACTIONS, SIGNATURE_PAGE, balanceChanges, loadSaleHistory, saleAverages, standingEvents } from "../lib/chain/history";
import { getSignaturesForAddress, getTransaction } from "../lib/chain/rpc";
import { TwabError } from "../lib/twab/twab";
import { TokenChain } from "./support/token-chain";
import { fill } from "./support/wallet";

const MINT = fill(70);
const OTHER_MINT = fill(71);
const WALLET = fill(1);
const OTHER = fill(2);
const THIRD = fill(3);
const [A, B, C, D, X, Y, Z] = [10, 11, 12, 13, 20, 21, 22].map(fill) as [string, string, string, string, string, string, string];
const OPENS = 1_800_000_000;
const CLOSES = OPENS + 21_600;
const SALE = { opensAt: OPENS, closesAt: CLOSES };
const NOW = OPENS + 10_800;
const RPC = "http://node.test";

/** A wallet with a history before the sale and in it: accounts filled, emptied, closed, given away and received. */
function busyChain() {
  const c = new TokenChain(MINT, OPENS - 9_000);
  c.open(A, WALLET);
  c.mintTo(A, 1_000_000n);
  c.at(OPENS - 4_000).open(B, WALLET);
  c.mintTo(B, 500_000n);
  c.open(X, OTHER);
  c.mintTo(X, 9_000_000n);
  c.open(D, OTHER);
  c.mintTo(D, 70_000n);
  c.at(OPENS + 600).transfer(A, X, 300_000n, WALLET);
  c.open(Y, OTHER);
  // Another wallet's account moves without this wallet: its history as read here has gaps, which are none of this wallet's.
  c.at(OPENS + 1_800).transfer(X, Y, 1_000n, OTHER);
  // Coming in, signed by others only: found through the account's own history.
  c.at(OPENS + 1_200).mintTo(B, 200_000n);
  c.at(OPENS + 2_400).transfer(X, A, 50_000n, OTHER);
  // A new account takes everything from B, and B is closed: B is found through the wallet's own transactions.
  c.at(OPENS + 3_600).open(C, WALLET);
  c.transfer(B, C, 700_000n, WALLET);
  c.close(B);
  // A is given away, D is received.
  c.at(OPENS + 5_000).setOwner(A, OTHER);
  c.at(OPENS + 6_000).setOwner(D, WALLET);
  c.at(OPENS + 7_000).other(WALLET);
  c.at(NOW);
  return c;
}

const load = (c: TokenChain, node = c.node(), over: Partial<Parameters<typeof loadSaleHistory>[0]> = {}) =>
  loadSaleHistory({ rpcUrl: RPC, fetch: node.fetch, owner: WALLET, mint: MINT, sale: SALE, ...c.snapshot(WALLET), ...over });

describe("the wallet's average over the sale, from its history", () => {
  it("is the chain's own books, so far and to the close, through accounts filled, emptied, closed, given away and received", async () => {
    const c = busyChain();
    const got = await load(c);
    expect(got).toEqual({ kind: "read", soFar: c.average(WALLET, OPENS, NOW), toClose: c.average(WALLET, OPENS, CLOSES), transactions: expect.any(Number), accounts: 4 });
    // The books themselves, worked out by hand: 1,000,000 in A and 500,000 in B at the opening, then
    // A −300,000 at 600 s, B +200,000 at 1,200 s, A +50,000 at 2,400 s, B's 700,000 moved to C at 3,600 s (no change), A (750,000)
    // given away at 5,000 s, D (70,000) received at 6,000 s.
    const area =
      1_500_000n * 600n + 1_200_000n * 600n + 1_400_000n * 1_200n + 1_450_000n * 1_200n + 1_450_000n * 1_400n + 700_000n * 1_000n + 770_000n * 4_800n;
    expect(c.average(WALLET, OPENS, NOW)).toBe(area / 10_800n);
    expect(c.average(WALLET, OPENS, CLOSES)).toBe((area + 770_000n * 10_800n) / 21_600n);
  });

  it("reads transactions at finalized, as the node parses them, and pages back only to the opening", async () => {
    const c = busyChain();
    const node = c.node();
    await load(c, node);
    const pages = node.calls.filter((x) => x.method === "getSignaturesForAddress");
    expect(pages[0]?.params).toEqual([WALLET, { limit: SIGNATURE_PAGE, commitment: "finalized" }]);
    const reads = node.calls.filter((x) => x.method === "getTransaction");
    expect(reads[0]?.params).toEqual([expect.any(String), { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 }]);
    // The transactions since the opening, each once, and for each account that existed then, the newest one before the opening.
    const read = reads.map((x) => x.params[0] as string);
    expect(new Set(read).size).toBe(read.length);
    const inSale = new Set(c.txs.filter((t) => t.blockTime >= OPENS).map((t) => t.signature));
    const openings = [A, B, D].map((x) => c.txs.filter((t) => t.blockTime < OPENS && t.keys.includes(x)).at(-1)?.signature);
    expect(read.filter((s) => !inSale.has(s)).sort()).toEqual([...new Set(openings)].sort());
    // Every account the wallet had in the sale is asked about once (each history fits in a page): the four it held and the one it
    // closed, and the wallet itself.
    expect(pages.map((x) => x.params[0]).sort()).toEqual([WALLET, A, B, C, D].sort());
  });

  it("pages through a long history and stops at the opening", async () => {
    const c = new TokenChain(MINT, OPENS - 10_000);
    c.open(A, WALLET);
    for (let i = 0; i < 150; i++) c.at(OPENS - 9_000 + i).mintTo(A, 1n);
    for (let i = 0; i < 150; i++) c.at(OPENS + 10 * i).mintTo(A, 1_000n);
    c.at(NOW);
    const node = c.node();
    // The 150 in the sale and the newest one before it.
    expect(await load(c, node)).toMatchObject({ kind: "read", soFar: c.average(WALLET, OPENS, NOW), toClose: c.average(WALLET, OPENS, CLOSES), transactions: 151 });
    const pages = node.calls.filter((x) => x.method === "getSignaturesForAddress" && x.params[0] === A);
    // 150 in the sale, then the first one before it: two pages of 100, the second continuing from the last of the first.
    expect(pages).toHaveLength(2);
    expect((pages[1]?.params[1] as { before: string }).before).toBe(c.txs[c.txs.length - 100]?.signature);
  });

  it("leaves out what happened after the balances were read, and failed transactions", async () => {
    const c = busyChain();
    // A failed transaction in the sale, before the balances: it changed nothing and is not even read.
    const failed = c.at(NOW - 1).transfer(C, X, 1n, WALLET, { failed: true });
    c.at(NOW);
    const before = c.snapshot(WALLET);
    const first = c.node();
    const expected = await load(c, first, before);
    expect(expected).toMatchObject({ kind: "read", soFar: c.average(WALLET, OPENS, NOW) });
    expect(first.calls.filter((x) => x.method === "getTransaction").map((x) => x.params[0])).not.toContain(failed);
    // A transfer after the balances were read is left for the next read, not read now.
    const later = c.at(NOW + 5).transfer(C, X, 100_000n, WALLET);
    const node = c.node();
    expect(await load(c, node, before)).toEqual(expected);
    expect(node.calls.filter((x) => x.method === "getTransaction").map((x) => x.params[0])).not.toContain(later);
  });

  it("keeps reading past a transaction the node lists without a time", async () => {
    const c = busyChain();
    const expected = await load(c);
    const untimed = new Set(c.txs.filter((t) => t.blockTime >= OPENS).map((t) => t.signature));
    expect(await load(c, c.node({ untimed }))).toEqual(expected);
  });

  it("puts transactions of one slot in the order that adds up, and ignores other tokens", async () => {
    const c = new TokenChain(MINT, OPENS - 100);
    c.open(A, WALLET);
    c.mintTo(A, 100n);
    c.open(Z, OTHER, OTHER, OTHER_MINT);
    c.mintTo(Z, 5n);
    c.open(Y, OTHER);
    c.mintTo(Y, 1_000n);
    c.at(OPENS + 100).transfer(Y, A, 10n, OTHER);
    c.transfer(Y, A, 20n, OTHER, { sameSlot: true });
    c.transfer(A, Y, 25n, WALLET, { sameSlot: true, extra: [Z] });
    c.at(NOW);
    expect(await load(c)).toMatchObject({ kind: "read", soFar: c.average(WALLET, OPENS, NOW), toClose: c.average(WALLET, OPENS, CLOSES) });
  });

  it("takes the balance at the opening from the newest transaction before it, a failed one too", async () => {
    const c = new TokenChain(MINT, OPENS - 500);
    c.open(A, WALLET);
    c.mintTo(A, 80n);
    c.open(Y, OTHER);
    const failed = c.at(OPENS - 10).transfer(A, Y, 1n, WALLET, { failed: true });
    c.at(OPENS + 50).mintTo(A, 20n);
    c.at(NOW);
    const node = c.node();
    expect(await load(c, node)).toMatchObject({ kind: "read", soFar: c.average(WALLET, OPENS, NOW), transactions: 2 });
    expect(node.calls.filter((x) => x.method === "getTransaction").map((x) => x.params[0])).toContain(failed);
  });

  it("uses no change from before the opening, even one an account's opening transaction made to another account", async () => {
    // X's newest transaction before the opening also paid Y, whose own newest one before the opening is later, with a change of
    // Y's in between that is not read: only the openings decide what each held then.
    const c = new TokenChain(MINT, OPENS - 900);
    c.open(A, WALLET);
    c.mintTo(A, 100n);
    c.open(B, WALLET);
    c.at(OPENS - 800).transfer(A, B, 40n, WALLET);
    c.at(OPENS - 700).mintTo(B, 5n);
    c.at(OPENS - 600).mintTo(B, 6n);
    c.at(OPENS + 300).mintTo(A, 1n);
    c.at(OPENS + 400).mintTo(B, 2n);
    c.at(NOW);
    expect(await load(c)).toMatchObject({ kind: "read", soFar: c.average(WALLET, OPENS, NOW), toClose: c.average(WALLET, OPENS, CLOSES) });
  });

  it("is nothing for a wallet that never held the token, and has no average so far at the very opening", async () => {
    const c = new TokenChain(MINT, OPENS - 100);
    c.other(WALLET);
    c.at(OPENS);
    expect(await load(c)).toEqual({ kind: "read", soFar: undefined, toClose: 0n, transactions: 0, accounts: 0 });
    // A wallet that holds tokens, with balances read at the very opening: there is no "so far" yet.
    const held = new TokenChain(MINT, OPENS - 100);
    held.open(A, WALLET);
    held.mintTo(A, 40n);
    held.at(OPENS);
    expect(await load(held)).toEqual({ kind: "read", soFar: undefined, toClose: 40n, transactions: 1, accounts: 1 });
  });

  it("refuses a history with a transaction missing, wherever it is missing", async () => {
    // A payment before the first change the node lists: without the balance at the opening it would pass for what A held then.
    const early = new TokenChain(MINT, OPENS - 50);
    early.open(A, WALLET);
    early.mintTo(A, 5n);
    const hidden = early.at(OPENS + 900).mintTo(A, 3n);
    early.at(OPENS + 1_900).mintTo(A, 2n);
    early.at(NOW);
    expect(await load(early, early.node({ hide: new Set([hidden]) }))).toMatchObject({ kind: "does-not-add-up", message: expect.stringMatching(/a transaction is missing/) });
    expect(await load(early)).toMatchObject({ kind: "read", soFar: early.average(WALLET, OPENS, NOW) });
    // An account opened in the sale whose opening the node leaves out.
    const opened = new TokenChain(MINT, OPENS + 10);
    const creation = opened.open(A, WALLET, OTHER);
    opened.at(OPENS + 20).mintTo(A, 9n);
    opened.at(NOW);
    expect(await load(opened, opened.node({ hide: new Set([creation]) }))).toEqual({
      kind: "does-not-add-up",
      message: `the history of ${A} as the node gave it does not start where the account was opened, so a transaction is missing`,
    });
    expect(await load(opened)).toMatchObject({ kind: "read", soFar: opened.average(WALLET, OPENS, NOW) });
    // An account the node lists for the wallet but has no history for at all.
    const none = new TokenChain(MINT, OPENS - 10);
    none.at(NOW);
    expect(await load(none, none.node(), { held: new Map([[A, 5n]]) })).toMatchObject({ kind: "does-not-add-up" });
    const c = busyChain();
    // An incoming payment the node leaves out of A's list (no wallet signed it): the next change does not follow from the last.
    const missing = c.txs.find((t) => t.blockTime === OPENS + 2_400)?.signature as string;
    expect(await load(c, c.node({ hide: new Set([missing]) }))).toMatchObject({ kind: "does-not-add-up", message: expect.stringMatching(/a transaction is missing/) });
    // The last change of an account missing: its history does not reach what it holds now.
    const last = c.at(NOW).mintTo(D, 5n);
    expect(await load(c, c.node({ hide: new Set([last]) }))).toMatchObject({ kind: "does-not-add-up" });
  });

  it("says when there is more history than it reads", async () => {
    const many = new TokenChain(MINT, OPENS - 100);
    many.open(A, WALLET);
    for (let i = 0; i <= MAX_TRANSACTIONS; i++) many.at(OPENS + i).mintTo(A, 1n);
    many.at(NOW);
    expect(MAX_TRANSACTIONS).toBe(200);
    expect(await load(many)).toEqual({ kind: "too-much", message: "it has more than 200 transactions to read since the sale opened" });
    const failing = new TokenChain(MINT, OPENS - 100);
    failing.open(A, WALLET);
    failing.mintTo(A, 1n);
    for (let i = 0; i < MAX_SIGNATURES; i++) failing.at(OPENS + i).mintTo(A, 1n, { failed: true });
    failing.at(NOW);
    expect(MAX_SIGNATURES).toBe(1000);
    expect(await load(failing)).toEqual({ kind: "too-much", message: `more than 1000 transactions name ${A.slice(0, 4)}…${A.slice(-4)} since the sale opened` });
    // Exactly the limit is still read: 199 in the sale and the one before it.
    const edge = new TokenChain(MINT, OPENS - 100);
    edge.open(A, WALLET);
    for (let i = 0; i < MAX_TRANSACTIONS - 1; i++) edge.at(OPENS + i).mintTo(A, 1n);
    edge.at(NOW);
    expect(await load(edge)).toMatchObject({ kind: "read", transactions: 200 });
  });

  it("says when the node cannot give it", async () => {
    const c = busyChain();
    expect(await load(c, c.node({ failing: "getSignaturesForAddress" }))).toEqual({ kind: "unreadable", message: "the node refused the request: getSignaturesForAddress is failing" });
    expect(await load(c, c.node({ failing: "getTransaction" }))).toEqual({ kind: "unreadable", message: "the node refused the request: getTransaction is failing" });
    const one = c.txs.find((t) => t.blockTime === OPENS + 600)?.signature as string;
    expect(await load(c, c.node({ drop: new Set([one]) }))).toEqual({ kind: "unreadable", message: `the node does not have transaction ${one}` });
  });
});

describe("what one transaction did to the coin", () => {
  const tx = (over: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) => ({
    slot: 9,
    blockTime: OPENS + 1,
    transaction: { signatures: ["s1"], message: { accountKeys: [{ pubkey: WALLET }, A, { pubkey: B }] } },
    meta: { err: null, preTokenBalances: [], postTokenBalances: [], ...meta },
    ...over,
  });
  const bal = (accountIndex: number, owner: string, amount: string, mint = MINT) => ({ accountIndex, mint, owner, uiTokenAmount: { amount, decimals: 6, uiAmount: null } });
  const ev = (tokenAccount: string, owner: string, delta: bigint, balanceAfter: bigint) => ({ signature: "s1", slot: 9n, time: OPENS + 1, owner, tokenAccount, delta, balanceAfter });

  it("is one event per balance that changed, a new account starting and a closed one ending at nothing", () => {
    const got = balanceChanges(tx({}, { preTokenBalances: [bal(1, WALLET, "100"), bal(2, OTHER, "7")], postTokenBalances: [bal(1, WALLET, "60"), bal(2, OTHER, "7")] }), "s1", MINT);
    expect(got.events).toEqual([ev(A, WALLET, -40n, 60n)]);
    expect(got.holders).toEqual([
      { tokenAccount: A, owner: WALLET },
      { tokenAccount: B, owner: OTHER },
    ]);
    expect(got.slot).toBe(9n);
    expect(got.time).toBe(OPENS + 1);
    expect(got.before).toEqual(new Map([[A, { owner: WALLET, amount: 100n }], [B, { owner: OTHER, amount: 7n }]]));
    expect(got.after).toEqual(new Map([[A, { owner: WALLET, amount: 60n }], [B, { owner: OTHER, amount: 7n }]]));
    expect(balanceChanges(tx({}, { postTokenBalances: [bal(1, WALLET, "5")] }), "s1", MINT).events).toEqual([ev(A, WALLET, 5n, 5n)]);
    expect(balanceChanges(tx({}, { preTokenBalances: [bal(1, WALLET, "5")] }), "s1", MINT).events).toEqual([ev(A, WALLET, -5n, 0n)]);
    // A closed account that was empty changes nothing, but is still named with its owner, and is gone afterwards.
    const closed = balanceChanges(tx({}, { preTokenBalances: [bal(1, WALLET, "0")] }), "s1", MINT);
    expect(closed.events).toEqual([]);
    expect(closed.holders).toEqual([{ tokenAccount: A, owner: WALLET }]);
    expect(closed.after.size).toBe(0);
  });

  it("is two events when the account's owner changed inside it, and none for an empty account", () => {
    const changed = balanceChanges(tx({}, { preTokenBalances: [bal(1, WALLET, "30")], postTokenBalances: [bal(1, OTHER, "30")] }), "s1", MINT);
    expect(changed.events).toEqual([ev(A, WALLET, -30n, 0n), ev(A, OTHER, 30n, 30n)]);
    expect(changed.holders).toEqual([
      { tokenAccount: A, owner: WALLET },
      { tokenAccount: A, owner: OTHER },
    ]);
    expect(balanceChanges(tx({}, { preTokenBalances: [bal(1, WALLET, "0")], postTokenBalances: [bal(1, OTHER, "0")] }), "s1", MINT).events).toEqual([]);
  });

  it("leaves other tokens out, reads the accounts a v0 transaction loaded, and nothing from a failed one", () => {
    expect(balanceChanges(tx({}, { postTokenBalances: [bal(1, WALLET, "5", OTHER_MINT)] }), "s1", MINT)).toMatchObject({ events: [], holders: [], after: new Map() });
    const v0 = tx({}, { loadedAddresses: { writable: [C], readonly: [D] }, postTokenBalances: [bal(3, WALLET, "8"), bal(4, THIRD, "1")] });
    expect(balanceChanges(v0, "s1", MINT).events).toEqual([ev(C, WALLET, 8n, 8n), ev(D, THIRD, 1n, 1n)]);
    // A failed transaction changes nothing, but still says what the accounts held.
    const failed = balanceChanges(tx({}, { err: { InstructionError: [0, "Custom"] }, preTokenBalances: [bal(1, WALLET, "5")], postTokenBalances: [bal(1, WALLET, "5")] }), "s1", MINT);
    expect(failed.events).toEqual([]);
    expect(failed.holders).toEqual([{ tokenAccount: A, owner: WALLET }]);
    expect(failed.after).toEqual(new Map([[A, { owner: WALLET, amount: 5n }]]));
    // Even if a node reported a change on a failed transaction, it is not taken for one.
    expect(balanceChanges(tx({}, { err: { InstructionError: [1, "Custom"] }, preTokenBalances: [bal(1, WALLET, "5")], postTokenBalances: [bal(1, WALLET, "9")] }), "s1", MINT).events).toEqual([]);
  });

  it("refuses what it cannot read exactly", () => {
    const refuse = (t: unknown, message: string, signature = "s1") => expect(() => balanceChanges(t, signature, MINT)).toThrow(message);
    refuse(tx(), "the node answered with another transaction than s2", "s2");
    refuse(null, "the node answered with another transaction than s1");
    refuse(tx({ meta: null }), "transaction s1 has no metadata");
    refuse(tx({ blockTime: null }), "transaction s1 has no block time");
    refuse(tx({ blockTime: 1.5 }), "transaction s1 has no block time");
    refuse(tx({ slot: -1 }), "transaction s1 has no slot");
    refuse(tx({ transaction: { signatures: ["s1"], message: {} } }), "transaction s1 has no list of accounts");
    refuse(tx({ transaction: { signatures: ["s1"], message: { accountKeys: "keys" } } }), "transaction s1 has no list of accounts");
    refuse(tx({ transaction: { signatures: ["s1"], message: { accountKeys: [{}] } } }), "transaction s1 has a malformed list of accounts");
    refuse(tx({}, { loadedAddresses: { writable: [1] } }), "transaction s1 has a malformed list of accounts");
    refuse(tx({}, { postTokenBalances: {} }), "transaction s1 has a malformed list of token balances");
    refuse(tx({}, { postTokenBalances: [{ accountIndex: 1, owner: WALLET, uiTokenAmount: { amount: "1" } }] }), "transaction s1 has a token balance without a mint");
    refuse(tx({}, { postTokenBalances: [bal(3, WALLET, "1")] }), "transaction s1 has a token balance of an account it does not name");
    refuse(tx({}, { postTokenBalances: [bal(1.5, WALLET, "1")] }), "transaction s1 has a token balance of an account it does not name");
    refuse(tx({}, { postTokenBalances: [bal(1, WALLET, "1"), bal(1, WALLET, "2")] }), "transaction s1 gives one token account two balances");
    refuse(tx({}, { postTokenBalances: [{ accountIndex: 1, mint: MINT, uiTokenAmount: { amount: "1" } }] }), `transaction s1 does not say who owns token account ${A}`);
    for (const amount of ["-1", "1.5", "01", "18446744073709551616", "", "1e3"]) {
      refuse(tx({}, { postTokenBalances: [bal(1, WALLET, amount)] }), "transaction s1 has a balance that is not a whole number of base units");
    }
    expect(balanceChanges(tx({}, { postTokenBalances: [bal(1, WALLET, "18446744073709551615")] }), "s1", MINT).events[0]?.balanceAfter).toBe(2n ** 64n - 1n);
  });
});

describe("the averages and the standing balances", () => {
  it("adds what each account holds at the balances' slot, nothing for one the wallet no longer holds", () => {
    expect(standingEvents(WALLET, [A, B], new Map([[A, 5n]]), 42, NOW)).toEqual([
      { signature: "(balance at slot 42)", slot: 42n, time: NOW, owner: WALLET, tokenAccount: A, delta: 0n, balanceAfter: 5n },
      { signature: "(balance at slot 42)", slot: 42n, time: NOW, owner: WALLET, tokenAccount: B, delta: 0n, balanceAfter: 0n },
    ]);
  });

  it("counts an account that did not change in the sale for the whole sale", () => {
    const events = standingEvents(WALLET, [A], new Map([[A, 600n]]), 42, NOW);
    expect(saleAverages(events, WALLET, SALE, NOW)).toEqual({ soFar: 600n, toClose: 600n });
  });

  it("refuses a history that does not reach the standing balance", () => {
    const events = [{ signature: "s", slot: 5n, time: OPENS + 10, owner: WALLET, tokenAccount: A, delta: 5n, balanceAfter: 5n }, ...standingEvents(WALLET, [A], new Map([[A, 6n]]), 42, NOW)];
    expect(() => saleAverages(events, WALLET, SALE, NOW)).toThrow(TwabError);
  });

  it("works the average so far out to the balances' time, and never past the close", () => {
    const B9 = 1_000_000_000n;
    const events = [{ signature: "s", slot: 5n, time: OPENS + 100, owner: WALLET, tokenAccount: A, delta: B9, balanceAfter: B9 }, ...standingEvents(WALLET, [A], new Map([[A, B9]]), 42, OPENS + 200)];
    expect(saleAverages(events, WALLET, SALE, OPENS + 200)).toEqual({ soFar: B9 / 2n, toClose: (B9 * 21_500n) / 21_600n });
    expect(saleAverages(events, WALLET, SALE, CLOSES + 99).soFar).toBe((B9 * 21_500n) / 21_600n);
  });
});

describe("the node's lists of transactions and its transactions", () => {
  const answering = (result: unknown) => {
    const calls: unknown[] = [];
    const fetchFn = (async (_u: string, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)).params);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
    }) as unknown as typeof fetch;
    return { fetch: fetchFn, calls };
  };
  const list = (result: unknown, before?: string) => {
    const n = answering(result);
    return { got: getSignaturesForAddress({ url: RPC, fetch: n.fetch, address: A, limit: 7, ...(before ? { before } : {}) }), calls: n.calls };
  };

  it("lists signatures with their slot, time and whether they failed, continuing from an older one when asked", async () => {
    const { got, calls } = list([
      { signature: "s2", slot: 9, blockTime: OPENS, err: null, memo: null },
      { signature: "s1", slot: 8, blockTime: null, err: { InstructionError: [0, "Custom"] } },
      { signature: "s0", slot: 7, err: null },
    ]);
    expect(await got).toEqual([
      { signature: "s2", slot: 9, blockTime: OPENS, failed: false },
      { signature: "s1", slot: 8, blockTime: null, failed: true },
      { signature: "s0", slot: 7, blockTime: null, failed: false },
    ]);
    expect(calls).toEqual([[A, { limit: 7, commitment: "finalized" }]]);
    const later = list([], "s0");
    expect(await later.got).toEqual([]);
    expect(later.calls).toEqual([[A, { limit: 7, commitment: "finalized", before: "s0" }]]);
  });

  it("refuses an answer it cannot read", async () => {
    await expect(list({}).got).rejects.toThrow("the node's answer was not a list of transactions");
    for (const bad of [null, { slot: 1 }, { signature: "s", slot: -1 }, { signature: "s", slot: 1.5 }, { signature: 3, slot: 1 }]) {
      await expect(list([bad]).got, JSON.stringify(bad)).rejects.toThrow("the node's answer for a transaction was malformed");
    }
    for (const blockTime of [1.5, "1"]) {
      await expect(list([{ signature: "s", slot: 1, blockTime }]).got).rejects.toThrow("the node's answer for a transaction's time was not a whole number");
    }
  });

  it("asks for a transaction as the node parses it, at finalized, and passes on what it says", async () => {
    const n = answering({ slot: 1 });
    expect(await getTransaction({ url: RPC, fetch: n.fetch, signature: "s9" })).toEqual({ slot: 1 });
    expect(n.calls).toEqual([["s9", { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 }]]);
    expect(await getTransaction({ url: RPC, fetch: answering(null).fetch, signature: "s9" })).toBeNull();
  });
});
