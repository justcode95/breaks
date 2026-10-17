import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LedgerSection, type LedgerViewState } from "../app/breaks/[number]/ledger-view";
import { type BreakAccount, decodeBreak } from "../lib/chain/accounts";
import { addressFromBytes, addressToBytes, configAddress } from "../lib/chain/address";
import type { Loaded } from "../lib/chain/load";
import { fromHex } from "../lib/draw/bytes";
import { drawFreeWinners } from "../lib/draw/draw";
import { assignment } from "../lib/draw/draw";
import { sortedPool } from "../lib/draw/pool";
import { type Ledger, type LedgerChain, checkLedger, fetchLedger, loadLedger, parseLedger } from "../lib/ledger";
import { type BreakFields, type ConfigFields, breakFieldsFromVector, configFieldsFromVector, encodeBreak, encodeConfig, fakeNode } from "./support/accounts";
import { buttons } from "./support/tree";

// The keeper's golden ledger (keeper/test/publish.test.ts makes and pins it): break id 7, seed 0x5a × 32, the paid spots bought
// by the keeper test's holders 11, 12 and 13, two free winners drawn from the example list, the buyer wallet holder 90, and one
// of each null (a price, a proof, a delivery transaction).
const EXAMPLE = join(import.meta.dirname, "..", "..", "docs", "published-example");
const file = (folder: string) => {
  const [name] = readdirSync(join(EXAMPLE, folder));
  return { name: name as string, text: readFileSync(join(EXAMPLE, folder, name as string), "utf8") };
};
const LEDGER = file("ledger");
const POOL_HASH = LEDGER.name.replace(".json", "");
const ELIGIBILITY = JSON.parse(file("eligibility").text) as { entries: { wallet: string; weight: string }[] };
/** The keeper test's holders: real public keys of the bytes n, n, ... */
const holder = (n: number) => addressFromBytes(ed25519.getPublicKey(new Uint8Array(32).fill(n)));
const SEED = new Uint8Array(32).fill(0x5a);
const BUYERS = [11, 12, 13].map(holder);
const BUYER = holder(90);
// The free winners, worked out here with the page's own draw from the published list and the seed, not read from the ledger.
const LEAVES = ELIGIBILITY.entries.map((e) => ({ wallet: addressToBytes(e.wallet), weight: BigInt(e.weight) }));
const WINNERS = drawFreeWinners(SEED, LEAVES, 2).map((w) => ({ wallet: addressFromBytes((LEAVES[w.leafIndex] as { wallet: Uint8Array }).wallet), start: w.start, weight: w.weight }));

const vectors: { programs: { breaks: string }; cases: { name: string; outputs?: Record<string, any> | null }[] } = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "programs", "breaks", "instruction-vectors.json"), "utf8"),
);
const named = (n: string) => vectors.cases.find((c) => c.name === n)?.outputs as Record<string, any>;
const PROGRAM = vectors.programs.breaks;
const SAMPLE = breakFieldsFromVector(named("breaks.account.Break"));
const CONFIG: ConfigFields = { ...configFieldsFromVector(named("breaks.account.BreaksConfig")), buyer: BUYER };

/** The drawn break the golden ledger belongs to: packs of one machine at most $25 each, five bought. */
const brk = (over: Partial<BreakFields> = {}): BreakAccount =>
  decodeBreak(
    encodeBreak({
      ...SAMPLE,
      id: 7n,
      status: "Drawn",
      paidSpots: 10,
      freeSpots: 2,
      tiers: [{ machine: new Uint8Array(32).fill(1), maxPrice: 25_000_000n }],
      packs: Array<number>(12).fill(0),
      spotsSold: 3,
      poolSize: 5,
      packBudget: 125_000_000n,
      poolHash: fromHex(POOL_HASH),
      seed: SEED,
      freeWinnerCount: 2,
      freeWinners: WINNERS,
      ...over,
    }),
  );
const chain = (over: Partial<LedgerChain> = {}): LedgerChain => ({ break: brk(), paidOwners: BUYERS, buyer: BUYER, ...over });
const ledger = (text = LEDGER.text): Ledger => {
  const r = parseLedger(text);
  if (!r.ok) throw new Error(r.errors.join(" | "));
  return r.ledger;
};
const edited = (edit: (d: any) => void) => {
  const d = JSON.parse(LEDGER.text);
  edit(d);
  return JSON.stringify(d);
};
const refused = (text: string) => {
  const r = parseLedger(text);
  if (r.ok) throw new Error("expected the ledger to be refused");
  return r.errors;
};
const problems = (l: Ledger = ledger(), c: LedgerChain = chain()) => checkLedger(l, c).problems;

describe("reading a ledger", () => {
  it("reads the keeper's golden ledger as it is, with every null", () => {
    const l = ledger();
    expect(l.poolHash).toBe(POOL_HASH);
    expect(l.buyer).toBe(BUYER);
    expect(l.packs).toHaveLength(5);
    expect(l.spots).toHaveLength(5);
    expect(l.packs.map((p) => p.price)).toEqual([20_000_000n, 21_000_000n, undefined, 23_000_000n, 24_000_000n]);
    expect(l.packs[4]?.proof).toBeUndefined();
    expect(l.packs[0]?.proof).toBe("example-proof-1");
    expect(l.spots.map((s) => [s.kind, s.index])).toEqual([["paid", 0], ["paid", 1], ["paid", 2], ["free", 0], ["free", 1]]);
    expect(l.spots[1]?.deliveryTx).toBeUndefined();
    expect(l.spots[0]?.deliveryTx).toBe("example-send-paid-1");
  });

  it("refuses what is not a ledger", () => {
    expect(refused("nope")).toEqual(["it is not JSON"]);
    expect(refused("[]")).toEqual(["it is not a JSON object"]);
    expect(refused(edited((d) => (d.version = 2)))).toEqual(["it is not a ledger of a version this page reads"]);
    expect(refused(edited((d) => (d.kind = "pool")))).toEqual(["it is not a ledger of a version this page reads"]);
  });

  it("refuses every field that is not in the format, saying which", () => {
    expect(refused(edited((d) => (d.poolHash = POOL_HASH.toUpperCase())))).toEqual(["the pool hash is not 64 lowercase hex digits"]);
    expect(refused(edited((d) => (d.buyer = "not-an-address")))).toEqual(["the buyer wallet is not an address"]);
    expect(refused(edited((d) => (d.packs = {})))).toEqual(["packs is not a list"]);
    expect(refused(edited((d) => (d.spots = "x")))).toEqual(["spots is not a list"]);
    expect(refused(edited((d) => (d.packs[1] = 5)))[0]).toBe("pack 2 is not an object");
    expect(refused(edited((d) => (d.spots[0] = null)))[0]).toBe("spot 1 is not an object");
    expect(refused(edited((d) => (d.packs[2].index = 3)))).toEqual(["pack 3 has index 3, not 2: the packs are in the order of the pack list"]);
    for (const price of ["-1", "01", "1.5", "18446744073709551616", 5, ""]) {
      expect(refused(edited((d) => (d.packs[0].price = price))), String(price)).toEqual(["pack 1: the price is not null or a whole number of micro-USDC"]);
    }
    expect(parseLedger(edited((d) => (d.packs[0].price = "18446744073709551615"))).ok).toBe(true);
    for (const tx of [null, "", "has space", "x".repeat(201), "line\nbreak", 7]) {
      expect(refused(edited((d) => (d.packs[0].purchaseTx = tx))), String(tx)).toEqual(["pack 1: the purchase transaction is not a transaction or reference of 1 to 200 printable characters"]);
    }
    expect(parseLedger(edited((d) => (d.packs[0].purchaseTx = "x".repeat(200)))).ok).toBe(true);
    expect(refused(edited((d) => (d.packs[0].card = "x")))).toEqual(["pack 1: the card is not an address"]);
    expect(refused(edited((d) => (d.packs[0].proof = "")))).toEqual(["pack 1: the proof is not null or a transaction or reference of 1 to 200 printable characters"]);
    expect(refused(edited((d) => (d.spots[0].kind = "house")))).toEqual(['spot 1: the kind is not "paid" or "free"']);
    for (const index of [-1, 1.5, "0", null]) expect(refused(edited((d) => (d.spots[0].index = index))), String(index)).toEqual(["spot 1: the index is not a whole number from 0"]);
    expect(refused(edited((d) => (d.spots[0].wallet = 1)))).toEqual(["spot 1: the wallet is not an address"]);
    expect(refused(edited((d) => (d.spots[0].card = "")))).toEqual(["spot 1: the card is not an address"]);
    expect(refused(edited((d) => (d.spots[0].deliveryTx = "a b")))).toEqual(["spot 1: the delivery transaction is not null or a transaction or reference of 1 to 200 printable characters"]);
  });

  it("refuses more entries than a break can have, and says at most twenty things", () => {
    const many = (n: number) => Array.from({ length: n }, () => ({}));
    expect(refused(edited((d) => (d.packs = many(65))))).toEqual(["packs has 65 entries; a break has at most 64"]);
    expect(refused(edited((d) => (d.spots = many(65))))).toEqual(["spots has 65 entries; a break has at most 64"]);
    const errors = refused(edited((d) => (d.spots = Array.from({ length: 30 }, () => ({ kind: "x", index: 0, wallet: holder(1), card: holder(2), deliveryTx: null })))));
    expect(errors).toHaveLength(21);
    expect(errors[20]).toBe("... and 10 more");
  });
});

describe("checking a ledger against the chain and the draw", () => {
  it("finds nothing wrong with the golden ledger, and joins each spot to the pack its card came out of", () => {
    const c = checkLedger(ledger(), chain());
    expect(c.problems).toEqual([]);
    const l = ledger();
    expect(c.rows.map((r) => r.spot)).toEqual(l.spots);
    for (const r of c.rows) expect(r.pack?.card).toBe(r.spot.card);
    expect(c.cost).toEqual({ known: 88_000_000n, unknown: 1 });
    // The cards really are the draw's, worked out here and not taken from the ledger.
    const pool = sortedPool(l.packs.map((p) => addressToBytes(p.card)));
    const perm = assignment(SEED, 5);
    expect(l.spots.map((s) => s.card)).toEqual(perm.map((j) => addressFromBytes(pool[j] as Uint8Array)));
    expect(l.spots.map((s) => s.wallet)).toEqual([...BUYERS, ...WINNERS.map((w) => w.wallet)]);
  });

  it("says when the break is not drawn, or the ledger is for another pool or names another buyer wallet", () => {
    expect(problems(ledger(), chain({ break: brk({ status: "Settled" }) }))).toEqual(["the break is Settled on chain, not drawn, so no card can have gone to its spot yet"]);
    expect(problems(ledger(edited((d) => (d.poolHash = "ab".repeat(32)))))).toEqual([`it is for pool hash ${"ab".repeat(32)}, not the ${POOL_HASH} committed on chain`]);
    expect(problems(ledger(), chain({ buyer: holder(91) }))).toEqual([`it names ${BUYER} as the buyer wallet, but the program's config names ${holder(91)}`]);
  });

  it("says when the packs are not the pool or cost more than their own cap, and not when one costs exactly its cap", () => {
    expect(problems(ledger(edited((d) => d.packs.pop())))).toContain("it lists 4 packs, but 5 were bought for this break");
    expect(problems(ledger(edited((d) => (d.packs[0].card = holder(77)))))).toContain("its cards are not the pool committed on chain");
    expect(problems(ledger(edited((d) => (d.packs[1].card = d.packs[0].card))))).toContain("a card appears in two packs");
    expect(problems(ledger(edited((d) => (d.packs[3].price = "25000001"))))).toEqual(["pack 4 cost 25000001 micro-USDC, above its cap of 25000000"]);
    expect(problems(ledger(edited((d) => (d.packs[3].price = "25000000"))))).toEqual([]);
    // Each pack has its own cap: a mixed list where the first two packs may cost at most $20.
    const mixed = brk({ tiers: [{ machine: new Uint8Array(32).fill(1), maxPrice: 20_000_000n }, { machine: new Uint8Array(32).fill(2), maxPrice: 25_000_000n }], packs: [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1] });
    expect(problems(ledger(), chain({ break: mixed }))).toEqual(["pack 2 cost 21000000 micro-USDC, above its cap of 20000000"]);
    // A pack the break's list does not have.
    const short = brk({ paidSpots: 2, freeSpots: 2, packs: [0, 0, 0, 0] });
    expect(problems(ledger(), chain({ break: short }))).toContain("pack 5 is not in the break's pack list");
  });

  it("says when a spot is not the chain's: the order, the wallet, the card the draw gives it", () => {
    expect(problems(ledger(edited((d) => d.spots.pop())))).toEqual(["it lists 4 spots, but the break has 5: 3 paid and 2 free"]);
    expect(problems(ledger(edited((d) => ([d.spots[3], d.spots[4]] = [d.spots[4], d.spots[3]]))))).toEqual(["spot 4 should be free spot 1, but it says free spot 2", "spot 5 should be free spot 2, but it says free spot 1"]);
    expect(problems(ledger(edited((d) => (d.spots[2].kind = "free"))))).toEqual(["spot 3 should be paid spot 3, but it says free spot 3"]);
    expect(problems(ledger(edited((d) => (d.spots[1].wallet = holder(77)))))).toEqual([`paid spot 2 names ${holder(77)}, but the chain's is ${BUYERS[1]}`]);
    const l = ledger();
    const swapped = edited((d) => ([d.spots[0].card, d.spots[1].card] = [d.spots[1].card, d.spots[0].card]));
    expect(problems(ledger(swapped))).toEqual([`paid spot 1 got card ${l.spots[1]?.card}, but the draw gives it ${l.spots[0]?.card}`, `paid spot 2 got card ${l.spots[0]?.card}, but the draw gives it ${l.spots[1]?.card}`]);
    // The paid spots' owners come from the chain: another buyer of spot 1 makes the ledger's wallet wrong.
    expect(problems(ledger(), chain({ paidOwners: [holder(77), BUYERS[1] as string, BUYERS[2] as string] }))).toEqual([`paid spot 1 names ${BUYERS[0]}, but the chain's is ${holder(77)}`]);
    // Only the draw's own seed gives these cards.
    expect(problems(ledger(), chain({ break: brk({ seed: new Uint8Array(32).fill(0x5b) }) })).length).toBeGreaterThan(0);
  });

  it("says at most twenty things", () => {
    const c = brk({ paidSpots: 30, freeSpots: 0, packs: Array<number>(30).fill(0), spotsSold: 30, freeWinnerCount: 0, freeWinners: [] });
    // Thirty spots, each naming a wallet that is not the chain's.
    const thirty = ledger(edited((d) => (d.spots = Array.from({ length: 30 }, (_, i) => ({ kind: "paid", index: i, wallet: holder(200 + i), card: d.packs[0].card, deliveryTx: null })))));
    const p = problems(thirty, chain({ break: c, paidOwners: Array.from({ length: 30 }, (_, i) => holder(100 + i)) }));
    expect(p).toHaveLength(21);
    expect(p[20]).toMatch(/^\.\.\. and \d+ more$/);
  });
});

const BASE = "https://files.example/published";
const RPC = "http://node.test";
/** One fetch for both: the published files at BASE, the node at RPC. */
function world(o: { file?: string | null; config?: { data: Uint8Array; owner: string } | null; nodeFails?: boolean } = {}) {
  const accounts = new Map<string, { data: Uint8Array; owner: string }>();
  if (o.config !== null) accounts.set(configAddress(PROGRAM), o.config ?? { data: encodeConfig(CONFIG), owner: PROGRAM });
  const node = fakeNode(accounts);
  const asked: string[] = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith(BASE)) {
      asked.push(url);
      expect(init).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer" });
      const body = o.file === undefined ? LEDGER.text : o.file;
      return url === `${BASE}/ledger/${POOL_HASH}.json` && body !== null ? new Response(body, { status: 200 }) : new Response("not found", { status: 404 });
    }
    if (o.nodeFails) throw new TypeError("network down");
    return node.fetchFn(url, init as RequestInit);
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, asked, node };
}
const loaded = (b = brk()): Loaded => ({ number: 8, break: b, paidOwners: BUYERS, notes: [] });
const load = (w = world(), b = brk()) => loadLedger({ rpcUrl: RPC, breaksProgram: PROGRAM, baseUrl: BASE, fetch: w.fetch, loaded: loaded(b) });

describe("reading the ledger from the published files", () => {
  it("reads it under the committed pool hash, and refuses a file that names another", async () => {
    expect(await fetchLedger({ baseUrl: BASE, fetch: world().fetch, poolHash: POOL_HASH })).toEqual({ ok: true, value: ledger() });
    const other = "cd".repeat(32);
    const w = world({ file: edited((d) => (d.poolHash = other)) });
    expect(await fetchLedger({ baseUrl: BASE, fetch: w.fetch, poolHash: POOL_HASH })).toEqual({ ok: false, kind: "invalid", message: "the pool hash inside the file is not the one it is named after" });
    expect(await fetchLedger({ baseUrl: BASE, fetch: world({ file: "{" }).fetch, poolHash: POOL_HASH })).toEqual({ ok: false, kind: "invalid", message: "it is not JSON" });
    expect(await fetchLedger({ baseUrl: BASE, fetch: world({ file: null }).fetch, poolHash: POOL_HASH })).toMatchObject({ ok: false, kind: "missing" });
  });

  it("checks a drawn break's ledger with the buyer wallet the program's config names, read at finalized", async () => {
    const w = world();
    const state = await load(w);
    expect(state).toMatchObject({ kind: "checked", ledger: ledger(), check: { problems: [], cost: { known: 88_000_000n, unknown: 1 } } });
    expect(w.asked).toEqual([`${BASE}/ledger/${POOL_HASH}.json`]);
    expect(w.node.requests).toEqual([{ addresses: [configAddress(PROGRAM)], config: { encoding: "base64", commitment: "finalized" } }]);
  });

  it("reads nothing before the break is drawn", async () => {
    for (const status of ["Funded", "Settled", "Cancelled"] as const) {
      const w = world();
      expect(await load(w, brk({ status })), status).toEqual({ kind: "not-drawn" });
      expect(w.asked).toEqual([]);
      expect(w.node.requests).toEqual([]);
    }
  });

  it("does not show a ledger that does not agree with the chain, and says why", async () => {
    expect(await load(world({ config: { data: encodeConfig({ ...CONFIG, buyer: holder(91) }), owner: PROGRAM } }))).toEqual({
      kind: "wrong",
      problems: [`it names ${BUYER} as the buyer wallet, but the program's config names ${holder(91)}`],
    });
  });

  it("says when the file is missing or wrong, or the config cannot be read", async () => {
    expect(await load(world({ file: null }))).toEqual({ kind: "unavailable", why: "missing", message: "there is no such file" });
    expect(await load(world({ file: "[]" }))).toEqual({ kind: "unavailable", why: "invalid", message: "it is not a JSON object" });
    expect(await load(world({ config: null }))).toEqual({ kind: "unavailable", why: "unreachable", message: "the program's config account, which names the buyer wallet, is missing" });
    expect(await load(world({ config: { data: encodeConfig(CONFIG), owner: holder(5) } }))).toEqual({ kind: "unavailable", why: "unreachable", message: "the program's config account is not owned by the breaks program" });
    expect(await load(world({ nodeFails: true }))).toMatchObject({ kind: "unavailable", why: "unreachable", message: expect.stringMatching(/^the program's config could not be read: /) });
  });
});

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const render = (state: LedgerViewState, over: { fileUrl?: string; onRetry?: () => void } = {}) =>
  renderToStaticMarkup(createElement(LedgerSection, { state, host: "files.example", budget: 125_000_000n, ...over }));
const checked = (l = ledger()): LedgerViewState => ({ kind: "checked", ledger: l, check: checkLedger(l, chain()) });

describe("the ledger on the break page", () => {
  it("is not there before the break is drawn", () => {
    expect(render({ kind: "not-drawn" })).toBe("");
  });

  it("shows every spot with its wallet, card, pack, price and the two transactions", () => {
    const html = render(checked(), { fileUrl: `${BASE}/ledger/${POOL_HASH}.json` });
    const t = text(html);
    expect(t).toContain("Per-spot ledger");
    expect(t).toContain("Every spot's wallet and card agree with the chain and the draw, the cards are the committed pool, and no pack cost more than its cap.");
    const l = ledger();
    const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
    const packOf = (card: string) => l.packs.find((p) => p.card === card) as Ledger["packs"][number];
    const first = l.spots[0] as Ledger["spots"][number];
    expect(t).toContain(`Paid #1 ${short(first.wallet)} ${short(first.card)} #${packOf(first.card).index + 1}`);
    // A transaction that is not a real signature (the example's) is shown as text, not as a link.
    expect(html).not.toContain("explorer.solana.com");
    expect(t).toContain(`transfer ${short(first.deliveryTx as string)}`);
    expect(t).toContain(`purchase ${short(packOf(first.card).purchaseTx)}`);
    // The card found at its wallet has no transfer.
    expect(t).toContain("found at the wallet");
    // The pack whose price is not known says so.
    expect(t).toContain("price not known");
    expect(t).toContain(`Buyer wallet ${BUYER}`);
    // (The text helper leaves a space where a tag was, so before the comma.)
    // Four packs whose prices are known come to $88; the fifth's is not known.
    expect(t).toContain("4 packs for $88 , plus 1 pack whose price is not known. The program paid $125 to the buyer wallet for them, the most each pack could cost.");
    expect(t).not.toContain("was not spent");
    expect(html).toContain(`href="${BASE}/ledger/${POOL_HASH}.json"`);
    expect(t).toContain("The transactions are the keeper's word");
  });

  it("links a transaction that looks like a signature to the devnet explorer, and says what was not spent when every price is known", () => {
    const sig = "5".repeat(87);
    const l = ledger(edited((d) => ((d.packs[2].price = "22000000"), (d.packs[0].purchaseTx = sig), (d.spots[0].deliveryTx = sig))));
    const html = render(checked(l));
    expect(html).toContain(`href="https://explorer.solana.com/tx/${sig}?cluster=devnet"`);
    expect(html).toContain('rel="noopener noreferrer"');
    expect(text(html)).toContain("5 packs for $110 . The program paid $125 to the buyer wallet for them, the most each pack could cost. $15 of it was not spent on packs.");
  });

  it("says when no price is known, in the singular too", () => {
    const none = ledger(edited((d) => d.packs.forEach((p: { price: string | null }) => (p.price = null))));
    expect(text(render(checked(none)))).toContain("5 packs, whose prices are not known. The program paid $125");
    expect(text(render(checked(none)))).not.toContain("was not spent");
    const two = ledger(edited((d) => d.packs.forEach((p: { price: string | null }, i: number) => (p.price = i === 0 ? "20000000" : null))));
    expect(text(render(checked(two)))).toContain("1 pack for $20 , plus 4 packs whose price is not known.");
    const single: Ledger = { ...none, packs: none.packs.slice(0, 1) };
    expect(text(render({ kind: "checked", ledger: single, check: { problems: [], rows: [], cost: { known: 0n, unknown: 1 } } }))).toContain("1 pack, whose price is not known.");
  });

  it("says why there is no ledger, and offers to read again only when it may turn up", () => {
    const retry = vi.fn();
    const missing = createElement(LedgerSection, { state: { kind: "unavailable", why: "missing", message: "there is no such file" }, host: "files.example", budget: 0n, onRetry: retry });
    expect(text(renderToStaticMarkup(missing))).toContain("It is not published at files.example yet. The keeper publishes it once every card of the break is delivered, which happens right after the draw.");
    const [button] = buttons(missing);
    expect(button?.text).toBe("Read the ledger again");
    button?.onClick?.();
    expect(retry).toHaveBeenCalledOnce();
    expect(text(render({ kind: "unavailable", why: "unreachable", message: "network down" }, { onRetry: retry }))).toContain("It could not be read or checked (network down).");
    expect(buttons(createElement(LedgerSection, { state: { kind: "unavailable", why: "unreachable", message: "x" }, host: "h", budget: 0n, onRetry: retry }))).toHaveLength(1);
    const invalid = createElement(LedgerSection, { state: { kind: "unavailable", why: "invalid", message: "it is not JSON" }, host: "files.example", budget: 0n, onRetry: retry });
    expect(text(renderToStaticMarkup(invalid))).toContain("The file at files.example is not a ledger this page can use (it is not JSON), so it is not shown.");
    expect(buttons(invalid)).toHaveLength(0);
    expect(text(render({ kind: "off" }))).toContain("This site is not set up to read the published lists, so the ledger cannot be shown here.");
    expect(text(render({ kind: "loading" }))).toContain("Reading the ledger…");
  });

  it("does not show a ledger that does not agree with the chain, says why, and never reads a reason as markup", () => {
    const html = render({ kind: "wrong", problems: ["its cards are not the pool committed on chain", "<img src=x onerror=alert(1)>"] }, { fileUrl: "https://f/ledger/x.json" });
    expect(text(html)).toContain("The ledger at files.example does not agree with the chain, so it is not shown. its cards are not the pool committed on chain");
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<table");
    expect(html).toContain('href="https://f/ledger/x.json"');
  });
});
