import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TreasuryDetails } from "../app/treasury/details";
import { HistoryCard, type HistoryState, MAX_PROBLEMS, actionText, movementText, pair, signed } from "../app/treasury/history-view";
import { SYSTEM_PROGRAM } from "../lib/chain/address";
import { RpcFailure, getAccountsAt } from "../lib/chain/rpc";
import { type Call, type HistoryPage, type Movement, loadTreasuryHistory } from "../lib/chain/treasury-history";
import { loadTreasury } from "../lib/chain/treasury";
import { buttons } from "./support/tree";
import { BREAKS, BUYER, ROUTER, TREASURY, TreasuryChain, wallet } from "./support/treasury-chain";

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const html = (view: HistoryState, more: Partial<{ showOlder: () => void; retry: () => void }> = {}) =>
  renderToStaticMarkup(createElement(HistoryCard, { view, showOlder: more.showOlder ?? (() => {}), retry: more.retry ?? (() => {}) }));
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

function busy() {
  const chain = new TreasuryChain();
  chain.setUp();
  chain.setController(chain.authority);
  chain.deposit(wallet(1), 100_000_000n);
  chain.deposit(wallet(2), 50_000_000n, { via: ROUTER });
  chain.noise();
  chain.createBreak(0n, 22_500_000n, 30_000_000n);
  chain.straight("holder", 5_000_000n);
  chain.fund(0n, 20_000_000n, 25_000_000n);
  chain.setSplit(6000, 4000);
  chain.deposit(wallet(3), 10_000_001n);
  chain.createBreak(1n, 10_000_000n, 5_000_000n);
  chain.cancel(1n, { unfundable: true });
  return chain;
}
const loadAll = (chain: TreasuryChain) => loadTreasuryHistory({ rpcUrl: "http://node", fetch: chain.node().fetch, treasuryProgram: TREASURY, breaksProgram: BREAKS });

describe("what a transaction did, in words", () => {
  const ctx = { buyer: BUYER, authority: "AUTH" };
  const call = (over: Partial<Call> = {}): Call => ({ actions: [], ...over });

  it("says each action of the treasury in a sentence", () => {
    expect(actionText({ kind: "set-up", admin: wallet(1), subsidyBps: 7000, holderBps: 3000 }, call(), ctx)).toBe("The treasury was set up, with new deposits split 70% / 30%.");
    expect(actionText({ kind: "deposit", amount: 100_000_000n, depositor: wallet(1) }, call(), ctx)).toBe(`Deposit of $100 from ${short(wallet(1))}.`);
    expect(actionText({ kind: "deposit", amount: 1n, depositor: wallet(1) }, call({ caller: ROUTER }), ctx)).toBe(`Deposit of $0.000001 from ${short(wallet(1))}, through the program ${short(ROUTER)}.`);
    expect(actionText({ kind: "split", subsidyBps: 6550, holderBps: 3450 }, call(), ctx)).toBe("The split of new deposits was changed to 65.5% / 34.5%.");
    expect(actionText({ kind: "controller", controller: "AUTH" }, call(), ctx)).toBe("The breaks program was made the controller: only it can reserve, release and pay out money.");
    expect(actionText({ kind: "controller", controller: wallet(9) }, call(), ctx)).toBe(`${short(wallet(9))} was made the controller: only it can reserve, release and pay out money.`);
    expect(actionText({ kind: "controller", controller: SYSTEM_PROGRAM }, call(), ctx)).toBe("The controller was removed: nobody can reserve or pay out money until a new one is set.");
  });

  it("says which break a reservation, a release or a pay-out was for, and why", () => {
    const created = call({ step: "create_break", breakKey: "K", breakNumber: 3 });
    expect(actionText({ kind: "reserve", subsidy: 22_500_000n, holder: 30_000_000n }, created, ctx)).toBe("Reserved $22.50 of the subsidy bucket and $30 of the holder bucket for break #3, when it was created.");
    expect(actionText({ kind: "reserve", subsidy: 0n, holder: 30_000_000n }, call({ step: "create_break", breakKey: "K" }), ctx)).toBe("Reserved $30 of the holder bucket for a break, when it was created.");
    expect(actionText({ kind: "reserve", subsidy: 1n, holder: 0n }, call(), ctx)).toBe("Reserved $0.000001 of the subsidy bucket.");
    const funded = call({ step: "fund_purchases", breakKey: "K", breakNumber: 3 });
    expect(actionText({ kind: "release", subsidy: 2_500_000n, holder: 5_000_000n }, funded, ctx)).toBe("Released $2.50 of the subsidy bucket and $5 of the holder bucket that break #3 did not need.");
    expect(actionText({ kind: "release", subsidy: 0n, holder: 0n }, call({ step: "fund_purchases" }), ctx)).toBe("Released nothing that the break did not need.");
    expect(actionText({ kind: "release", subsidy: 1n, holder: 2n }, call({ step: "cancel_break", breakKey: "K", breakNumber: 4 }), ctx)).toBe(
      "Released $0.000001 of the subsidy bucket and $0.000002 of the holder bucket: break #4 was cancelled.",
    );
    expect(actionText({ kind: "release", subsidy: 1n, holder: 0n }, call({ step: "cancel_unfundable", breakKey: "K", breakNumber: 4 }), ctx)).toBe(
      "Released $0.000001 of the subsidy bucket: break #4 was cancelled, as it could not be funded.",
    );
    expect(actionText({ kind: "release", subsidy: 1n, holder: 0n }, call({ breakKey: "K", breakNumber: 4 }), ctx)).toBe("Released $0.000001 of the subsidy bucket of break #4.");
    expect(actionText({ kind: "release", subsidy: 1n, holder: 0n }, call(), ctx)).toBe("Released $0.000001 of the subsidy bucket.");
    expect(actionText({ kind: "pay", bucket: "subsidy", amount: 20_000_000n, destination: wallet(5), recipient: BUYER }, funded, ctx)).toBe("Paid $20 from the subsidy bucket to the buyer wallet, for the packs of break #3.");
    expect(actionText({ kind: "pay", bucket: "holder", amount: 1n, destination: wallet(5), recipient: wallet(6) }, call(), ctx)).toBe(`Paid $0.000001 from the holder bucket to ${short(wallet(6))}.`);
    expect(actionText({ kind: "pay", bucket: "holder", amount: 1n, destination: wallet(5) }, call(), ctx)).toBe(`Paid $0.000001 from the holder bucket to the account ${short(wallet(5))}.`);
    // Without the buyer wallet known, its address is named.
    expect(actionText({ kind: "pay", bucket: "holder", amount: 1n, destination: wallet(5), recipient: BUYER }, call(), {})).toBe(`Paid $0.000001 from the holder bucket to ${short(BUYER)}.`);
  });

  it("adds money sent straight to a vault, and says something for a transaction that only has problems", () => {
    const m = (over: Partial<Movement>): Movement => ({ signature: "S", slot: 1, time: 0, calls: [], change: { subsidy: 0n, holder: 0n }, straight: [], problems: [], ...over });
    expect(movementText(m({ straight: [{ bucket: "holder", amount: 5_000_000n }] }), {})).toEqual(["$5 sent straight to the holder vault, outside a deposit (so it was not split)."]);
    expect(movementText(m({ straight: [{ amount: 5_000_000n }] }), {})).toEqual(["$5 sent straight to the vaults, outside a deposit."]);
    expect(movementText(m({ problems: ["x"] }), {})).toEqual(["Named the treasury."]);
    expect(movementText(m({ calls: [{ actions: [{ kind: "deposit", amount: 1n, depositor: wallet(1) }] }], straight: [{ bucket: "subsidy", amount: 2n }] }), {})).toEqual([
      `Deposit of $0.000001 from ${short(wallet(1))}.`,
      "$0.000002 sent straight to the subsidy vault, outside a deposit (so it was not split).",
    ]);
  });

  it("writes amounts with their sign, and pairs of buckets", () => {
    expect(signed(70_000_000n)).toBe("+$70");
    expect(signed(-22_500_000n)).toBe("−$22.50");
    expect(signed(0n)).toBe("—");
    expect(pair(1n, 0n)).toBe("$0.000001 of the subsidy bucket");
    expect(pair(0n, 1n)).toBe("$0.000001 of the holder bucket");
    expect(pair(0n, 0n)).toBe("nothing");
  });
});

describe("the card", () => {
  it("lists a whole history that adds up, newest first, with each row's amounts and a link to its transaction", async () => {
    const chain = busy();
    const page = await loadAll(chain);
    const markup = html({ state: "loaded", pages: [page] });
    const t = text(markup);
    expect(t).toContain("Money in and out");
    expect(markup).toContain('class="verdict ok" role="status"');
    expect(t).toContain("Every transaction since the treasury was set up is listed, and together they lead to what the vaults hold and what is reserved now.");
    const order = [
      "Released $10 of the subsidy bucket and $5 of the holder bucket: break #2 was cancelled, as it could not be funded.",
      "Reserved $10 of the subsidy bucket and $5 of the holder bucket for break #2, when it was created.",
      `Deposit of $10.000001 from ${short(wallet(3))}.`,
      "The split of new deposits was changed to 60% / 40%.",
      "Paid $20 from the subsidy bucket to the buyer wallet, for the packs of break #1.",
      "Paid $25 from the holder bucket to the buyer wallet, for the packs of break #1.",
      "Released $2.50 of the subsidy bucket and $5 of the holder bucket that break #1 did not need.",
      "$5 sent straight to the holder vault, outside a deposit (so it was not split).",
      "Reserved $22.50 of the subsidy bucket and $30 of the holder bucket for break #1, when it was created.",
      `Deposit of $50 from ${short(wallet(2))}, through the program ${short(ROUTER)}.`,
      `Deposit of $100 from ${short(wallet(1))}.`,
      "The breaks program was made the controller: only it can reserve, release and pay out money.",
      "The treasury was set up, with new deposits split 70% / 30%.",
    ];
    let at = -1;
    for (const line of order) {
      const i = t.indexOf(line);
      expect(i, line).toBeGreaterThan(at);
      at = i;
    }
    for (const amount of ["+$70", "+$30", "−$20", "−$25", "+$6", "+$4.000001"]) expect(t).toContain(amount);
    expect(t).toContain("1 more transaction named the treasury and changed nothing in it; it is not listed.");
    const first = page.rows[0] as Movement;
    expect(markup).toContain(`href="https://explorer.solana.com/tx/${first.signature}?cluster=devnet"`);
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).toContain('role="region" aria-label="The treasury&#x27;s transactions" tabindex="0"');
    expect(buttons(createElement(HistoryCard, { view: { state: "loaded", pages: [page] }, showOlder: () => {}, retry: () => {} }))).toEqual([]);
  });

  it("offers older transactions while there are some, and says how far it has read", async () => {
    const chain = new TreasuryChain();
    chain.setUp();
    for (let i = 0; i < 25; i++) chain.deposit(wallet(10), 1_000_000n);
    const page = await loadAll(chain);
    let calls = 0;
    const view: HistoryState = { state: "loaded", pages: [page] };
    expect(text(html(view))).toContain("The 20 transactions read so far lead, without a gap, to what the vaults hold now.");
    // Those that changed nothing count as read too.
    expect(text(html({ state: "loaded", pages: [{ ...page, quiet: 3 }] }))).toContain("The 23 transactions read so far lead");
    const found = buttons(createElement(HistoryCard, { view, showOlder: () => calls++, retry: () => {} }));
    expect(found.map((b) => b.text)).toEqual(["Show older"]);
    found[0]?.onClick?.();
    expect(calls).toBe(1);
    expect(html({ ...view, more: "loading" })).toMatch(/<button type="button" class="secondary" disabled="">Reading older transactions…<\/button>/);
    const failed = html({ ...view, more: { error: "Could not read the treasury's history: the node is down" } });
    expect(text(failed)).toContain("Could not read the treasury's history: the node is down");
    expect(buttons(createElement(HistoryCard, { view: { ...view, more: { error: "x" } }, showOlder: () => {}, retry: () => {} })).map((b) => b.text)).toEqual(["Try again"]);
    // One transaction read so far reads in the singular.
    const one: HistoryPage = { ...page, rows: page.rows.slice(0, 1), quiet: 0 };
    expect(text(html({ state: "loaded", pages: [one] }))).toContain("The 1 transaction read so far leads, without a gap");
  });

  it("puts what does not add up first, as an alert, and in the row it belongs to", async () => {
    const chain = busy();
    const page = await loadAll(chain);
    const bad: HistoryPage = { ...page, problems: ["A page problem."], rows: page.rows.map((r, i) => (i === 2 ? { ...r, problems: ["A row problem."] } : r)) };
    const markup = html({ state: "loaded", pages: [bad] });
    expect(markup).toContain('class="verdict bad" role="alert"');
    expect(text(markup)).toContain("Not everything adds up: A row problem. A page problem.");
    expect(markup).toContain('<span class="block problem">A row problem.</span>');
    expect(text(markup)).not.toContain("Every transaction since the treasury was set up is listed");
    const many: HistoryPage = { ...page, problems: Array.from({ length: MAX_PROBLEMS + 3 }, (_, i) => `Problem ${i}.`) };
    const t = text(html({ state: "loaded", pages: [many] }));
    expect(t).toContain(`Problem ${MAX_PROBLEMS - 1}.`);
    expect(t).not.toContain(`Problem ${MAX_PROBLEMS}.`);
    expect(t).toContain("and 3 more problems, shown in the rows below.");
    const oneMore: HistoryPage = { ...page, problems: Array.from({ length: MAX_PROBLEMS + 1 }, (_, i) => `Problem ${i}.`) };
    expect(text(html({ state: "loaded", pages: [oneMore] }))).toContain("and 1 more problem, shown");
  });

  it("says when the node's history stops before the set-up", async () => {
    const chain = busy();
    const page = await loadAll(chain);
    const ended: HistoryPage = { ...page, complete: false, ended: true };
    const t = text(html({ state: "loaded", pages: [ended] }));
    expect(t).toContain("The node has no older transactions of the treasury, and the set-up is not among them");
    expect(t).not.toContain("Every transaction since the treasury was set up");
    expect(text(html({ state: "loaded", pages: [page] }))).not.toContain("The node has no older transactions");
  });

  it("counts the quiet transactions of every page, in the plural too", async () => {
    const chain = busy();
    const page = await loadAll(chain);
    expect(text(html({ state: "loaded", pages: [page, { ...page, rows: [], quiet: 2 }] }))).toContain("3 more transactions named the treasury and changed nothing in it; they are not listed.");
    expect(text(html({ state: "loaded", pages: [{ ...page, quiet: 0 }] }))).not.toContain("changed nothing in it");
  });

  it("reads, fails and tries again", () => {
    expect(text(html({ state: "loading" }))).toContain("Reading the treasury's transactions…");
    let retried = 0;
    const view: HistoryState = { state: "error", message: "Could not read the treasury's history: down" };
    expect(text(html(view))).toContain("Could not read the treasury's history: down");
    const found = buttons(createElement(HistoryCard, { view, showOlder: () => {}, retry: () => retried++ }));
    expect(found.map((b) => b.text)).toEqual(["Try again"]);
    found[0]?.onClick?.();
    expect(retried).toBe(1);
  });

  it("never reads what the node gave as markup, and links only what looks like a signature", async () => {
    const chain = busy();
    const page = await loadAll(chain);
    const row = page.rows[0] as Movement;
    const hostile: HistoryPage = {
      ...page,
      rows: [{ ...row, signature: "<b>not-a-signature</b>", calls: [{ actions: [{ kind: "pay", bucket: "holder", amount: 1n, destination: "<i>x</i>", recipient: "<script>alert(1)</script>" }] }] }],
    };
    const markup = html({ state: "loaded", pages: [hostile] });
    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain("<b>not");
    expect(markup).not.toContain("explorer.solana.com");
    expect(markup).toContain('<code class="mono" title="&lt;b&gt;not-a-signature&lt;/b&gt;">&lt;b&gt;n…&lt;/b&gt;</code>');
  });
});

describe("on the treasury page", () => {
  it("comes after who controls the treasury and before the Refresh button", async () => {
    const chain = busy();
    const treasury = await loadTreasury({ rpcUrl: "http://node", fetch: chain.node().fetch, treasuryProgram: TREASURY });
    const markup = renderToStaticMarkup(createElement(TreasuryDetails, { treasury, program: TREASURY, now: 10, readAt: 10, refresh: () => {}, history: createElement("p", null, "THE HISTORY") }));
    const at = markup.indexOf("THE HISTORY");
    expect(at).toBeGreaterThan(markup.indexOf("Who controls it"));
    expect(at).toBeLessThan(markup.indexOf("Refresh"));
    expect(renderToStaticMarkup(createElement(TreasuryDetails, { treasury, program: TREASURY, now: 10, readAt: 10, refresh: () => {} }))).not.toContain("THE HISTORY");
  });
});

describe("reading accounts with the slot they are from", () => {
  const answering = (result: unknown) => {
    const asked: unknown[] = [];
    const fetchFn = (async (_url: string, init: RequestInit) => {
      asked.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    }) as unknown as typeof fetch;
    return { fetchFn, asked };
  };

  it("asks for them all in one request at finalized, and gives the slot and the accounts", async () => {
    const node = answering({ context: { slot: 77 }, value: [{ data: ["AQID", "base64"], owner: TREASURY }, null] });
    expect(await getAccountsAt({ url: "http://node", fetch: node.fetchFn, addresses: [wallet(1), wallet(2)] })).toEqual({ slot: 77, accounts: [{ data: Uint8Array.of(1, 2, 3), owner: TREASURY }, null] });
    expect(node.asked).toEqual([{ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [[wallet(1), wallet(2)], { encoding: "base64", commitment: "finalized" }] }]);
  });

  it("refuses an answer without a slot or with the wrong number of accounts, and more than one request's worth", async () => {
    const ask = (result: unknown) => getAccountsAt({ url: "http://node", fetch: answering(result).fetchFn, addresses: [wallet(1)] });
    for (const slot of [undefined, -1, 1.5, "7"]) await expect(ask({ context: { slot }, value: [null] }), String(slot)).rejects.toThrow("did not say which slot");
    await expect(ask(null)).rejects.toThrow("did not say which slot");
    await expect(ask({ context: { slot: 1 }, value: [] })).rejects.toThrow("did not have one entry per account");
    await expect(ask({ context: { slot: 1 }, value: [{ data: "AQID", owner: TREASURY }] })).rejects.toBeInstanceOf(RpcFailure);
    await expect(getAccountsAt({ url: "http://node", fetch: answering(null).fetchFn, addresses: Array(101).fill(wallet(1)) })).rejects.toThrow("at most 100 accounts in one request");
  });
});
