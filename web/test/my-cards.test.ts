import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MyCardsView, notShownText } from "../app/me/cards-view";
import { type BreakAccount, decodeBreak } from "../lib/chain/accounts";
import { addressFromBytes, addressToBytes, breakAddress, configAddress, spotAddress } from "../lib/chain/address";
import type { Mine } from "../lib/chain/mine";
import { fromHex } from "../lib/draw/bytes";
import { drawFreeWinners } from "../lib/draw/draw";
import { type Ledger, parseLedger } from "../lib/ledger";
import { type BreakCards, CARD_BREAKS, type MyCards, breakCards, cardBreaks, cardsOf, loadMyCards } from "../lib/my-cards";
import { type BreakFields, breakFieldsFromVector, configFieldsFromVector, encodeBreak, encodeConfig, encodeSpot, fakeNode } from "./support/accounts";
import { buttons } from "./support/tree";

// The keeper's golden ledger (keeper/test/publish.test.ts makes and pins it): break id 7 (break #8), seed 0x5a × 32, paid spots
// bought by the keeper test's holders 11, 12 and 13, two free winners drawn from the example list, the buyer wallet holder 90.
const EXAMPLE = join(import.meta.dirname, "..", "..", "docs", "published-example");
const file = (folder: string) => {
  const [name] = readdirSync(join(EXAMPLE, folder));
  return { name: name as string, text: readFileSync(join(EXAMPLE, folder, name as string), "utf8") };
};
const LEDGER = file("ledger");
const POOL_HASH = LEDGER.name.replace(".json", "");
const ELIGIBILITY = JSON.parse(file("eligibility").text) as { entries: { wallet: string; weight: string }[] };
const holder = (n: number) => addressFromBytes(ed25519.getPublicKey(new Uint8Array(32).fill(n)));
const SEED = new Uint8Array(32).fill(0x5a);
const BUYERS = [11, 12, 13].map(holder);
const LEAVES = ELIGIBILITY.entries.map((e) => ({ wallet: addressToBytes(e.wallet), weight: BigInt(e.weight) }));
const WINNERS = drawFreeWinners(SEED, LEAVES, 2).map((w) => ({ wallet: addressFromBytes((LEAVES[w.leafIndex] as { wallet: Uint8Array }).wallet), start: w.start, weight: w.weight }));
const STRANGER = holder(77);

const vectors: { programs: { breaks: string }; cases: { name: string; outputs?: Record<string, any> | null }[] } = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "programs", "breaks", "instruction-vectors.json"), "utf8"),
);
const named = (n: string) => vectors.cases.find((c) => c.name === n)?.outputs as Record<string, any>;
const PROGRAM = vectors.programs.breaks;
const SAMPLE = breakFieldsFromVector(named("breaks.account.Break"));
const CONFIG = { ...configFieldsFromVector(named("breaks.account.BreaksConfig")), buyer: holder(90) };

/** Break `number`; by default the drawn break of the golden ledger. */
const brk = (number = 8, over: Partial<BreakFields> = {}): BreakAccount => decodeBreak(encodeBreak({ ...breakFieldsOf(), id: BigInt(number - 1), ...over }));
const ledger = (): Ledger => {
  const r = parseLedger(LEDGER.text);
  if (!r.ok) throw new Error(r.errors.join(" | "));
  return r.ledger;
};
const golden = ledger();

/** What My spots read for a wallet: its paid spots and free wins, newest first. */
const mine = (o: { spots?: { number: number; index: number; refunded?: boolean; b?: BreakAccount }[]; wins?: { number: number; position: number; b?: BreakAccount }[] } = {}): Mine => ({
  spots: (o.spots ?? []).map((s) => ({ breakNumber: s.number, index: s.index, paid: 20_000_000n, refunded: s.refunded ?? false, break: s.b ?? brk(s.number) })),
  truncated: false,
  freeWins: (o.wins ?? []).map((w) => ({ breakNumber: w.number, position: w.position, weight: 1n, break: w.b ?? brk(w.number) })),
  searched: 50,
  totalBreaks: 50,
  recent: [],
});

const BASE = "https://files.example/published";
const RPC = "http://node.test";
/** The node (the program's config, break #8 and its three paid spots) and the published files, behind one fetch. */
function world(o: { file?: string | null; breakOver?: Partial<BreakFields>; nodeFails?: boolean } = {}) {
  const accounts = new Map<string, { data: Uint8Array; owner: string }>();
  accounts.set(configAddress(PROGRAM), { data: encodeConfig(CONFIG), owner: PROGRAM });
  const key = breakAddress(PROGRAM, 7n);
  accounts.set(key, { data: encodeBreak({ ...breakFieldsOf(), ...o.breakOver }), owner: PROGRAM });
  BUYERS.forEach((owner, i) => accounts.set(spotAddress(PROGRAM, key, i), { data: encodeSpot({ breakId: 7n, index: i, owner, paid: 20_000_000n, refunded: false }), owner: PROGRAM }));
  const node = fakeNode(accounts);
  const asked: string[] = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith(BASE)) {
      asked.push(url);
      const body = o.file === undefined ? LEDGER.text : o.file;
      return url === `${BASE}/ledger/${POOL_HASH}.json` && body !== null ? new Response(body, { status: 200 }) : new Response("not found", { status: 404 });
    }
    if (o.nodeFails) throw new TypeError("network down");
    return node.fetchFn(url, init as RequestInit);
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, asked, node };
}
function breakFieldsOf(): BreakFields {
  return {
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
  };
}
const load = (owner: string, m: Mine, w = world(), cache?: Map<string, Ledger>) =>
  loadMyCards({ rpcUrl: RPC, breaksProgram: PROGRAM, baseUrl: BASE, owner, mine: m, fetch: w.fetch, ...(cache ? { cache } : {}) });

describe("which breaks can have cards for the wallet", () => {
  it("is every drawn break it has a paid spot in that was not refunded, or a free spot it won, newest first, each once", () => {
    const m = mine({
      spots: [{ number: 8, index: 0 }, { number: 8, index: 2 }, { number: 7, index: 0, b: brk(7, { status: "Open" }) }, { number: 6, index: 0, refunded: true }, { number: 3, index: 1 }],
      wins: [{ number: 9, position: 1 }, { number: 8, position: 2 }, { number: 5, position: 1, b: brk(5, { status: "Settled" }) }],
    });
    expect(cardBreaks(m).map((b) => b.number)).toEqual([9, 8, 3]);
    expect(cardBreaks(mine())).toEqual([]);
  });
});

describe("the wallet's cards in a checked ledger", () => {
  it("are its spots in the ledger, each with its card, its delivery and the pack its card came from", () => {
    for (const [i, owner] of BUYERS.entries()) {
      const spot = golden.spots.find((s) => s.kind === "paid" && s.index === i);
      const pack = golden.packs.find((p) => p.card === spot?.card);
      expect(cardsOf(golden, owner), owner).toEqual([{ kind: "paid", index: i, card: spot?.card, ...(spot?.deliveryTx !== undefined ? { deliveryTx: spot.deliveryTx } : {}), pack }]);
    }
    // A free winner gets its free spot's card; a wallet with no spot gets nothing.
    const free = golden.spots.find((s) => s.kind === "free" && s.index === 0);
    expect(cardsOf(golden, WINNERS[0]?.wallet as string).map((c) => [c.kind, c.index, c.card])).toEqual([["free", 0, free?.card]]);
    expect(cardsOf(golden, STRANGER)).toEqual([]);
  });

  it("include a card that was found at the wallet without a transfer on record, and a pack whose price is not known", () => {
    const adopted = golden.spots.find((s) => s.deliveryTx === undefined);
    expect(adopted).toBeDefined();
    const c = cardsOf(golden, adopted?.wallet as string).find((x) => x.card === adopted?.card);
    expect(c && "deliveryTx" in c).toBe(false);
    const unpriced = golden.packs.find((p) => p.price === undefined);
    const owner = golden.spots.find((s) => s.card === unpriced?.card)?.wallet as string;
    expect(cardsOf(golden, owner).find((x) => x.card === unpriced?.card)?.pack?.price).toBeUndefined();
  });

  it("are said for each state of a break's ledger", () => {
    const at = { number: 8, break: brk() };
    expect(breakCards(at, { kind: "wrong", problems: ["x"] }, BUYERS[0] as string)).toEqual({ ...at, kind: "wrong", problems: ["x"] });
    expect(breakCards(at, { kind: "unavailable", why: "missing", message: "m" }, BUYERS[0] as string)).toEqual({ ...at, kind: "unavailable", why: "missing", message: "m" });
    expect(breakCards(at, { kind: "not-drawn" }, BUYERS[0] as string)).toMatchObject({ kind: "unavailable", why: "unreachable", message: "the break is not drawn on chain" });
  });
});

describe("loading the wallet's cards", () => {
  it("reads the break with all its paid spots and the ledger, checks it, and gives the wallet's cards", async () => {
    const w = world();
    const owner = BUYERS[0] as string;
    const got = await load(owner, mine({ spots: [{ number: 8, index: 0 }] }), w);
    expect(got.more).toBe(0);
    expect(got.breaks).toHaveLength(1);
    expect(got.breaks[0]).toMatchObject({ number: 8, kind: "cards", cards: cardsOf(golden, owner) });
    expect(w.asked).toEqual([`${BASE}/ledger/${POOL_HASH}.json`]);
    // Everything from the node at finalized: the break, its three spots (to check the ledger against every paid spot), the config.
    const read = w.node.requests.flatMap((r) => r.addresses);
    expect(read).toEqual(expect.arrayContaining([breakAddress(PROGRAM, 7n), ...[0, 1, 2].map((i) => spotAddress(PROGRAM, breakAddress(PROGRAM, 7n), i)), configAddress(PROGRAM)]));
    expect(w.node.requests.every((r) => r.config.commitment === "finalized")).toBe(true);
  });

  it("keeps a checked ledger for the visit, and does not keep one that could not be used", async () => {
    const cache = new Map<string, Ledger>();
    const first = world();
    await load(BUYERS[1] as string, mine({ spots: [{ number: 8, index: 1 }] }), first, cache);
    expect([...cache.keys()]).toEqual([`8:${POOL_HASH}`]);
    const again = world();
    const got = await load(BUYERS[2] as string, mine({ spots: [{ number: 8, index: 2 }] }), again, cache);
    expect(got.breaks[0]).toMatchObject({ kind: "cards", cards: cardsOf(golden, BUYERS[2] as string) });
    expect(again.asked).toEqual([]);
    expect(again.node.requests).toEqual([]);
    const empty = new Map<string, Ledger>();
    await load(BUYERS[0] as string, mine({ spots: [{ number: 8, index: 0 }] }), world({ file: null }), empty);
    expect(empty.size).toBe(0);
    // A ledger that does not agree with the draw is not kept either: it is read and checked again next time.
    await load(BUYERS[0] as string, mine({ spots: [{ number: 8, index: 0 }] }), world({ breakOver: { seed: new Uint8Array(32).fill(0x5b) } }), empty);
    expect(empty.size).toBe(0);
  });

  it("gives the break as it was just read, not as My spots last saw it", async () => {
    const stale = brk(8, { spotsSold: 2, packBudget: 1n });
    const got = await load(BUYERS[0] as string, mine({ spots: [{ number: 8, index: 0, b: stale }] }));
    expect(got.breaks[0]).toMatchObject({ kind: "cards", break: { spotsSold: 3, packBudget: 125_000_000n } });
  });

  it("says a ledger that is not published yet, one that does not agree with the draw, and a node that cannot be read", async () => {
    const owner = BUYERS[0] as string;
    const m = mine({ spots: [{ number: 8, index: 0 }] });
    expect((await load(owner, m, world({ file: null }))).breaks[0]).toMatchObject({ kind: "unavailable", why: "missing" });
    expect((await load(owner, m, world({ breakOver: { seed: new Uint8Array(32).fill(0x5b) } }))).breaks[0]).toMatchObject({ kind: "wrong", problems: expect.arrayContaining([expect.stringMatching(/the draw gives it/)]) });
    expect((await load(owner, m, world({ file: "{" }))).breaks[0]).toMatchObject({ kind: "unavailable", why: "invalid", message: "it is not JSON" });
    const down = (await load(owner, m, world({ nodeFails: true }))).breaks[0];
    expect(down).toMatchObject({ number: 8, kind: "unavailable", why: "unreachable" });
    expect(down?.kind === "unavailable" && down.message).toMatch(/network down/);
  });

  it("looks at the newest ten drawn breaks only, and says how many more there are", async () => {
    const spots = Array.from({ length: CARD_BREAKS + 3 }, (_, i) => ({ number: 30 - i, index: 0 }));
    const got = await load(STRANGER, mine({ spots }), world({ nodeFails: true }));
    expect(got.breaks.map((b) => b.number)).toEqual(spots.slice(0, CARD_BREAKS).map((s) => s.number));
    expect(got.more).toBe(3);
  });

  it("asks for nothing when no break the wallet has a spot in is drawn", async () => {
    const w = world();
    expect(await load(STRANGER, mine({ spots: [{ number: 8, index: 0, b: brk(8, { status: "Settled" }) }] }), w)).toEqual({ breaks: [], more: 0 });
    expect(w.asked).toEqual([]);
    expect(w.node.requests).toEqual([]);
  });
});

describe("the card on My spots", () => {
  const HOST = "files.example";
  const text = (h: string) => h.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  const render = (cards: MyCards, onRetry?: () => void) => renderToStaticMarkup(createElement(MyCardsView, { state: { kind: "loaded", cards }, host: HOST, ...(onRetry ? { onRetry } : {}) }));
  const at = (number: number) => ({ number, break: brk(number) });
  const withCards = (number: number, owner: string): BreakCards => ({ ...at(number), kind: "cards", cards: cardsOf(golden, owner) });

  it("says it is reading", () => {
    expect(text(renderToStaticMarkup(createElement(MyCardsView, { state: { kind: "loading" }, host: HOST })))).toBe("Your cards Reading the ledgers of the breaks you have spots in…");
  });

  it("lists every card with its break, its spot, its pack and how it got to the wallet, and says the transactions are the keeper's word", () => {
    const owner = BUYERS[0] as string;
    const card = cardsOf(golden, owner)[0];
    const html = render({ breaks: [withCards(8, owner)], more: 0 });
    const body = text(html);
    expect(body).toContain("1 card from 1 break.");
    expect(html).toContain('<a href="/breaks/8">Break #8</a><span class="block">Paid spot #1</span>');
    expect(html).toContain(`title="${card?.card}"`);
    expect(body).toContain(`from pack #${(card?.pack?.index ?? 0) + 1}`);
    expect(body).toContain("Cards are not on chain.");
    expect(body).toContain("The transactions are the keeper's word: look them up.");
    expect(body).toContain("Whether a card can still be sold back, and until when, is not shown here yet.");
    expect(html).not.toContain("Read the ledgers again");
  });

  it("shows a card found at the wallet, a pack whose price is not known, a free spot, and plurals", () => {
    const adopted = golden.spots.find((s) => s.deliveryTx === undefined);
    const unpricedOwner = golden.spots.find((s) => s.card === golden.packs.find((p) => p.price === undefined)?.card)?.wallet as string;
    const winner = WINNERS[0]?.wallet as string;
    const body = text(render({ breaks: [withCards(9, adopted?.wallet as string), withCards(8, unpricedOwner), withCards(8, winner)], more: 0 }));
    expect(body).toContain("found at your wallet");
    expect(body).toContain("price not known");
    expect(body).toContain("Free spot #1");
    expect(body).toMatch(/^Your cards 3 cards from 2 breaks\./);
  });

  it("says why a break's cards are not shown, and offers to read again only when that may change", () => {
    const retry = vi.fn();
    const breaks: BreakCards[] = [
      { ...at(9), kind: "unavailable", why: "missing", message: "there is no such file" },
      { ...at(8), kind: "wrong", problems: ["x"] },
      { ...at(7), kind: "unavailable", why: "invalid", message: "<b>bad</b>" },
      { ...at(6), kind: "unavailable", why: "unreachable", message: "the host answered 500" },
    ];
    const html = render({ breaks, more: 0 }, retry);
    const body = text(html);
    expect(body).toContain("No card can be shown yet.");
    expect(body).toContain("Break #9 : Its ledger is not published at files.example yet. The keeper publishes it once every card of the break is delivered.");
    expect(body).toContain("Break #8 : Its ledger at files.example does not agree with the chain or the draw, so it is not used.");
    expect(html).toContain("(&lt;b&gt;bad&lt;/b&gt;)");
    expect(body).toContain("Break #6 : Its ledger could not be read or checked (the host answered 500).");
    const [button] = buttons(createElement(MyCardsView, { state: { kind: "loaded", cards: { breaks, more: 0 } }, host: HOST, onRetry: retry }));
    expect(button?.text).toBe("Read the ledgers again");
    button?.onClick?.();
    expect(retry).toHaveBeenCalledOnce();
    for (const only of [breaks[1], breaks[2]] as BreakCards[]) {
      expect(buttons(createElement(MyCardsView, { state: { kind: "loaded", cards: { breaks: [only], more: 0 } }, host: HOST, onRetry: retry })), only.number.toString()).toHaveLength(0);
    }
    expect(notShownText(breaks[0] as Exclude<BreakCards, { kind: "cards" }>, HOST)).toMatch(/^Its ledger is not published/);
  });

  it("says when no break has been drawn yet, and when older breaks were left out", () => {
    expect(text(render({ breaks: [], more: 0 }))).toBe("Your cards No break you have a spot in has been drawn yet, so there are no cards to show.");
    const owner = BUYERS[0] as string;
    expect(text(render({ breaks: [withCards(8, owner)], more: 1 }))).toContain(`Only the newest ${CARD_BREAKS} drawn breaks you have a spot in are looked at; 1 older one is not.`);
    expect(text(render({ breaks: [withCards(8, owner)], more: 4 }))).toContain("4 older ones are not.");
  });
});
