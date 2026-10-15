import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BreakDetails } from "../app/breaks/[number]/details";
import { type BreakAccount, decodeBreak } from "../lib/chain/accounts";
import type { Loaded } from "../lib/chain/load";
import { fromHex, toHex } from "../lib/draw/bytes";
import { poolHash } from "../lib/draw/pool";
import { type Leaf, treeRoot } from "../lib/draw/tree";
import { type Fetched, NOT_PUBLISHED, applyLoad, fetchEligibility, fetchPool, loadPublishedLists, publishedFileUrl, whatIsNeeded } from "../lib/published";
import { emptyInput } from "../lib/example";
import { type Verified, verifyDraw } from "../lib/verify";
import { addressToBytes } from "../lib/chain/address";
import { breakFieldsFromVector, encodeBreak, type BreakFields } from "./support/accounts";

// Made by the keeper's own code (keeper/test/publish.test.ts pins them): the files a break's lists are published as.
const EXAMPLE = join(import.meta.dirname, "..", "..", "docs", "published-example");
const file = (folder: string) => {
  const [name] = readdirSync(join(EXAMPLE, folder));
  return { name: name as string, text: readFileSync(join(EXAMPLE, folder, name as string), "utf8") };
};
const ELIGIBILITY = file("eligibility");
const POOL = file("pool");
const ROOT = ELIGIBILITY.name.replace(".json", "");
const POOL_HASH = POOL.name.replace(".json", "");
const BASE = "https://files.example/published";

const vectors: { cases: { name: string; outputs: Record<string, any> | null }[] } = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "programs", "breaks", "instruction-vectors.json"), "utf8"));
const SAMPLE = breakFieldsFromVector(vectors.cases.find((c) => c.name === "breaks.account.Break")?.outputs as Record<string, any>);

/** A host serving the given files, by path, and remembering what it was asked. */
function host(files: Record<string, string | Response | (() => never)> = {}) {
  const asked: { url: string; init: RequestInit | undefined }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    asked.push({ url, init });
    const hit = files[url.replace(`${BASE}/`, "")];
    if (hit === undefined) return new Response("not found", { status: 404 });
    if (typeof hit === "function") return hit();
    return hit instanceof Response ? hit : new Response(hit, { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, asked };
}
const served = (over: Record<string, string> = {}) => host({ [`eligibility/${ROOT}.json`]: ELIGIBILITY.text, [`pool/${POOL_HASH}.json`]: POOL.text, ...over });

const expectedList = { root: ROOT, totalWeight: 130n, entryCount: 6 };
const ok = <T>(r: Fetched<T>): T => {
  if (!r.ok) throw new Error(`${r.kind}: ${r.message}`);
  return r.value;
};
const failed = <T>(r: Fetched<T>) => {
  if (r.ok) throw new Error("expected a failure");
  return r;
};
const withBody = (text: string, edit: (doc: any) => void) => {
  const doc = JSON.parse(text);
  edit(doc);
  return JSON.stringify(doc) + "\n";
};

describe("the golden example the keeper made", () => {
  it("is a list and a pool whose hashes are the names of the files", () => {
    const doc = JSON.parse(ELIGIBILITY.text);
    const leaves: Leaf[] = doc.entries.map((e: { wallet: string; weight: string }) => ({ wallet: addressToBytes(e.wallet), weight: BigInt(e.weight) }));
    // This package's own tree reproduces the root the keeper's tree wrote into the name.
    expect(toHex(treeRoot(leaves).hash)).toBe(ROOT);
    expect(treeRoot(leaves).sum).toBe(130n);
    const pool = JSON.parse(POOL.text);
    expect(toHex(poolHash(pool.cards.map(addressToBytes)))).toBe(POOL_HASH);
  });
});

describe("reading the eligibility list", () => {
  it("reads the keeper's file, checks it against the root, and gives the verify page's text", async () => {
    const { fetchFn, asked } = served();
    const list = ok(await fetchEligibility({ baseUrl: BASE, fetch: fetchFn, expected: expectedList }));
    expect(list.entryCount).toBe(6);
    expect(list.totalWeight).toBe(130n);
    expect(list.holders.split("\n")).toHaveLength(6);
    expect(list.holders.split("\n")[0]).toBe("4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi 10");
    // One request, for this root only, with nothing that identifies the visitor or the page they are on.
    expect(asked).toHaveLength(1);
    expect(asked[0]?.url).toBe(`${BASE}/eligibility/${ROOT}.json`);
    expect(asked[0]?.init).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer" });
  });

  it("says when the file is not there, and when the host cannot be reached or refuses", async () => {
    const none = failed(await fetchEligibility({ baseUrl: BASE, fetch: host().fetchFn, expected: expectedList }));
    expect(none).toMatchObject({ kind: "missing" });
    const down = failed(await fetchEligibility({ baseUrl: BASE, fetch: (async () => { throw new Error("offline"); }) as unknown as typeof fetch, expected: expectedList }));
    expect(down).toMatchObject({ kind: "unreachable", message: "could not reach the host: offline" });
    const refused = failed(await fetchEligibility({ baseUrl: BASE, fetch: host({ [`eligibility/${ROOT}.json`]: new Response("", { status: 503 }) }).fetchFn, expected: expectedList }));
    expect(refused).toMatchObject({ kind: "unreachable", message: "the host answered 503" });
  });

  it("does not use a list whose wallets or weights were changed, even by one", async () => {
    const tampered = [
      withBody(ELIGIBILITY.text, (d) => { d.entries[2].weight = "6"; }),
      withBody(ELIGIBILITY.text, (d) => { d.entries[0].weight = "11"; }),
      withBody(ELIGIBILITY.text, (d) => { d.entries.pop(); d.entryCount = 5; d.totalWeight = "115"; }),
      withBody(ELIGIBILITY.text, (d) => { d.entries.push({ wallet: d.entries[0].wallet.replace(/.$/, "2"), weight: "1" }); }),
    ];
    for (const body of tampered) {
      const r = failed(await fetchEligibility({ baseUrl: BASE, fetch: served({ [`eligibility/${ROOT}.json`]: body }).fetchFn, expected: expectedList }));
      expect(r.kind).toBe("invalid");
    }
  });

  it("does not use a list that hashes right but does not add up to what the account says", async () => {
    const wrongTotal = failed(await fetchEligibility({ baseUrl: BASE, fetch: served().fetchFn, expected: { ...expectedList, totalWeight: 131n } }));
    expect(wrongTotal.message).toMatch(/add up to 130, not to the 131 that was committed/);
    const wrongCount = failed(await fetchEligibility({ baseUrl: BASE, fetch: served().fetchFn, expected: { ...expectedList, entryCount: 7 } }));
    expect(wrongCount.message).toMatch(/has 6 wallets, not the 7 that were committed/);
    // A file for another root, served under this root's name, does not hash to it.
    const otherRoot = "ab".repeat(32);
    const swapped = failed(await fetchEligibility({ baseUrl: BASE, fetch: host({ [`eligibility/${otherRoot}.json`]: ELIGIBILITY.text }).fetchFn, expected: { ...expectedList, root: otherRoot } }));
    expect(swapped.message).toMatch(/root inside the file is not the root it is named after/);
    const relabelled = failed(await fetchEligibility({ baseUrl: BASE, fetch: host({ [`eligibility/${otherRoot}.json`]: withBody(ELIGIBILITY.text, (d) => { d.root = otherRoot; }) }).fetchFn, expected: { ...expectedList, root: otherRoot } }));
    expect(relabelled.message).toMatch(/hash to .*, not to the root that was committed/);
  });

  it("does not use a file whose own totals disagree with its entries", async () => {
    for (const edit of [(d: any) => { d.totalWeight = "131"; }, (d: any) => { d.entryCount = 7; }]) {
      const r = failed(await fetchEligibility({ baseUrl: BASE, fetch: served({ [`eligibility/${ROOT}.json`]: withBody(ELIGIBILITY.text, edit) }).fetchFn, expected: expectedList }));
      expect(r.message).toBe("its own totals do not match its entries");
    }
  });

  it("refuses files that are not what the keeper writes, each for its own reason", async () => {
    const cases: [string, string, RegExp][] = [
      ["not json", "<html>nope</html>", /^it is not JSON$/],
      ["an array", "[]", /^it is not a JSON object$/],
      ["null", "null", /^it is not a JSON object$/],
      ["another version", withBody(ELIGIBILITY.text, (d) => { d.version = 2; }), /not an eligibility list of a version this page reads/],
      ["another kind", withBody(ELIGIBILITY.text, (d) => { d.kind = "pool"; }), /not an eligibility list of a version this page reads/],
      ["no entries", withBody(ELIGIBILITY.text, (d) => { delete d.entries; }), /no list of entries/],
      ["an entry that is not an object", withBody(ELIGIBILITY.text, (d) => { d.entries[1] = 5; }), /^entry 2 is not a wallet and a weight$/],
      ["a weight as a number", withBody(ELIGIBILITY.text, (d) => { d.entries[1].weight = 30; }), /^entry 2 is not a wallet and a weight$/],
      ["a wallet that is not an address", withBody(ELIGIBILITY.text, (d) => { d.entries[1].wallet = "nope"; }), /^entry 2 has a wallet that is not a Solana address$/],
      ["a zero weight", withBody(ELIGIBILITY.text, (d) => { d.entries[1].weight = "0"; }), /^entry 2 has a weight that is not a whole number from 1 to/],
      ["a weight beyond 64 bits", withBody(ELIGIBILITY.text, (d) => { d.entries[1].weight = "18446744073709551616"; }), /^entry 2 has a weight that is not a whole number from 1 to/],
      ["a weight with a sign", withBody(ELIGIBILITY.text, (d) => { d.entries[1].weight = "-30"; }), /^entry 2 has a weight that is not a whole number from 1 to/],
      ["a wallet twice", withBody(ELIGIBILITY.text, (d) => { d.entries[1].wallet = d.entries[0].wallet; }), /^entry 2: .* is listed twice$/],
      ["entries out of order", withBody(ELIGIBILITY.text, (d) => { d.entries.reverse(); }), /not in the order the tree uses/],
      ["no wallets at all", withBody(ELIGIBILITY.text, (d) => { d.entries = []; }), /^the list is empty, but a list was committed$/],
    ];
    for (const [what, body, message] of cases) {
      const r = failed(await fetchEligibility({ baseUrl: BASE, fetch: served({ [`eligibility/${ROOT}.json`]: body }).fetchFn, expected: expectedList }));
      expect(r.kind, what).toBe("invalid");
      expect(r.message, what).toMatch(message);
    }
  });

  it("refuses weights that add up to more than a 64-bit number", async () => {
    const big = (2n ** 64n - 1n).toString();
    const wallets = [addressToBytes("4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi"), addressToBytes("8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR")];
    const body = JSON.stringify({ version: 1, kind: "eligibility", root: ROOT, totalWeight: "0", entryCount: 2, entries: [{ wallet: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi", weight: big }, { wallet: "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR", weight: "1" }] });
    expect(wallets).toHaveLength(2);
    const r = failed(await fetchEligibility({ baseUrl: BASE, fetch: served({ [`eligibility/${ROOT}.json`]: body }).fetchFn, expected: expectedList }));
    expect(r.message).toBe("the weights in it add up to more than a 64-bit number");
  });

  it("refuses a file that is too large, by its announced size and by its real size", async () => {
    const announced = failed(await fetchEligibility({ baseUrl: BASE, maxBytes: 100, fetch: host({ [`eligibility/${ROOT}.json`]: new Response("{}", { status: 200, headers: { "content-length": "101" } }) }).fetchFn, expected: expectedList }));
    expect(announced).toMatchObject({ kind: "invalid", message: "the file is larger than 100 bytes" });
    const real = failed(await fetchEligibility({ baseUrl: BASE, maxBytes: 100, fetch: served().fetchFn, expected: expectedList }));
    expect(real).toMatchObject({ kind: "invalid", message: "the file is larger than 100 bytes" });
  });

  it("only builds an address from a root that is 64 lowercase hex digits", async () => {
    for (const root of ["", "../x", "AB".repeat(32), "ab".repeat(31), `${"ab".repeat(32)}/../x`]) {
      await expect(fetchEligibility({ baseUrl: BASE, fetch: served().fetchFn, expected: { ...expectedList, root } }), root).rejects.toThrow(/64 lowercase hex digits/);
    }
  });
});

describe("reading the cards", () => {
  const expected = { poolHash: POOL_HASH, poolSize: 5 };

  it("reads the keeper's file and checks it against the pool hash", async () => {
    const { fetchFn, asked } = served();
    const pool = ok(await fetchPool({ baseUrl: BASE, fetch: fetchFn, expected }));
    expect(pool.count).toBe(5);
    expect(pool.cards.split("\n")).toEqual(JSON.parse(POOL.text).cards);
    expect(asked[0]?.url).toBe(`${BASE}/pool/${POOL_HASH}.json`);
    expect(asked[0]?.init).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer" });
  });

  it("says when it is not there", async () => {
    expect(failed(await fetchPool({ baseUrl: BASE, fetch: host().fetchFn, expected }))).toMatchObject({ kind: "missing" });
  });

  it("does not use cards that were changed, added, removed or repeated", async () => {
    const other = "11111111111111111111111111111112";
    const tampered = [
      withBody(POOL.text, (d) => { d.cards[0] = other; }),
      withBody(POOL.text, (d) => { d.cards.push(other); }),
      withBody(POOL.text, (d) => { d.cards.pop(); }),
      withBody(POOL.text, (d) => { d.cards[1] = d.cards[0]; }),
    ];
    for (const body of tampered) {
      const r = failed(await fetchPool({ baseUrl: BASE, fetch: served({ [`pool/${POOL_HASH}.json`]: body }).fetchFn, expected }));
      expect(r.kind).toBe("invalid");
    }
  });

  it("does not use a pool of the right hash but the wrong size, or the wrong kind of file", async () => {
    const size = failed(await fetchPool({ baseUrl: BASE, fetch: served().fetchFn, expected: { ...expected, poolSize: 6 } }));
    expect(size.message).toMatch(/has 5 cards, not the 6 that were committed/);
    for (const edit of [(d: any) => { d.kind = "eligibility"; }, (d: any) => { d.version = 2; }, (d: any) => { d.poolHash = "00".repeat(32); }, (d: any) => { delete d.cards; }, (d: any) => { d.cards[0] = 7; }, (d: any) => { d.cards[0] = "nope"; }]) {
      expect(failed(await fetchPool({ baseUrl: BASE, fetch: served({ [`pool/${POOL_HASH}.json`]: withBody(POOL.text, edit) }).fetchFn, expected })).kind).toBe("invalid");
    }
    for (const body of ["nope", "[]"]) expect(failed(await fetchPool({ baseUrl: BASE, fetch: served({ [`pool/${POOL_HASH}.json`]: body }).fetchFn, expected })).kind).toBe("invalid");
  });

  it("accepts the cards in any order, since the pool hash sorts them", async () => {
    const body = withBody(POOL.text, (d) => { d.cards.reverse(); });
    expect(ok(await fetchPool({ baseUrl: BASE, fetch: served({ [`pool/${POOL_HASH}.json`]: body }).fetchFn, expected })).count).toBe(5);
  });
});

/** The break the golden files belong to: a drawn one whose commitments are the ones in their names. */
const account = (over: Partial<BreakFields> = {}): BreakAccount =>
  decodeBreak(encodeBreak({ ...SAMPLE, status: "Drawn", eligibilityRoot: fromHex(ROOT), eligibilityTotalWeight: 130n, eligibilityCount: 6, poolHash: fromHex(POOL_HASH), poolSize: 5, ...over }));

describe("what a break needs, and loading it", () => {
  it("needs the list once one is committed and the cards once the seed is final", () => {
    expect(whatIsNeeded(account())).toEqual({ list: true, cards: true });
    expect(whatIsNeeded(account({ status: "Settled" }))).toEqual({ list: true, cards: true });
    // Before the seed there is nothing to check the cards against, and before a list there is nothing to read.
    expect(whatIsNeeded(account({ status: "PoolCommitted" }))).toEqual({ list: true, cards: false });
    expect(whatIsNeeded(account({ status: "Open", eligibilityRoot: new Uint8Array(32), eligibilityCount: 0, eligibilityTotalWeight: 0n, poolHash: new Uint8Array(32) }))).toEqual({ list: false, cards: false });
    expect(whatIsNeeded(account({ eligibilityCount: 0, eligibilityRoot: new Uint8Array(32), eligibilityTotalWeight: 0n }))).toEqual({ list: false, cards: true });
    expect(whatIsNeeded(account({ poolHash: new Uint8Array(32) }))).toEqual({ list: true, cards: false });
    // The keeper publishes nothing for an empty list, so nothing is read for one, whatever the root says.
    expect(whatIsNeeded(account({ eligibilityCount: 0 })).list).toBe(false);
  });

  it("reads both, and says so in words", async () => {
    const r = await loadPublishedLists({ baseUrl: BASE, fetch: served().fetchFn, break: account() });
    expect(r.holders?.split("\n")).toHaveLength(6);
    expect(r.cards?.split("\n")).toHaveLength(5);
    expect(r.stillToPaste).toEqual([]);
    expect(r.notes).toEqual([
      "The eligibility list was read from files.example: 6 wallets, and it hashes to the root committed on chain.",
      "The cards were read from files.example: 5 cards, and they hash to the pool hash committed on chain.",
    ]);
  });

  it("asks for nothing it does not need: no request before a list or the seed exists", async () => {
    const early = host();
    const r = await loadPublishedLists({ baseUrl: BASE, fetch: early.fetchFn, break: account({ status: "Open", eligibilityRoot: new Uint8Array(32), eligibilityCount: 0, eligibilityTotalWeight: 0n, poolHash: new Uint8Array(32) }) });
    expect(r).toEqual({ notes: [], stillToPaste: [] });
    expect(early.asked).toEqual([]);
    const committed = host({ [`eligibility/${ROOT}.json`]: ELIGIBILITY.text });
    const mid = await loadPublishedLists({ baseUrl: BASE, fetch: committed.fetchFn, break: account({ status: "PoolCommitted" }) });
    expect(mid.holders).toBeDefined();
    expect(mid.cards).toBeUndefined();
    expect(committed.asked.map((a) => a.url)).toEqual([`${BASE}/eligibility/${ROOT}.json`]);
  });

  it("says what is missing, and that it has to be pasted", async () => {
    const r = await loadPublishedLists({ baseUrl: BASE, fetch: host().fetchFn, break: account() });
    expect(r.holders).toBeUndefined();
    expect(r.cards).toBeUndefined();
    expect(r.stillToPaste).toEqual(["the eligibility list", "the cards"]);
    expect(r.notes).toEqual([
      "The eligibility list is not published at files.example (there is no file for this break's commitment), so paste it.",
      "The cards are not published at files.example (there is no file for this break's commitment), so paste them.",
    ]);
  });

  it("says when the host cannot be reached, and when a file is not what the chain committed to", async () => {
    const down = await loadPublishedLists({ baseUrl: BASE, fetch: (async () => { throw new Error("offline"); }) as unknown as typeof fetch, break: account() });
    expect(down.notes[0]).toBe("The eligibility list could not be read from files.example (could not reach the host: offline), so paste it.");
    expect(down.notes[1]).toBe("The cards could not be read from files.example (could not reach the host: offline), so paste them.");
    expect(down.stillToPaste).toEqual(["the eligibility list", "the cards"]);
    const wrong = await loadPublishedLists({ baseUrl: BASE, fetch: served({ [`eligibility/${ROOT}.json`]: withBody(ELIGIBILITY.text, (d) => { d.entries[0].weight = "11"; }) }).fetchFn, break: account() });
    expect(wrong.holders).toBeUndefined();
    expect(wrong.cards).toBeDefined();
    expect(wrong.stillToPaste).toEqual(["the eligibility list"]);
    expect(wrong.notes[0]).toMatch(/^The file for the eligibility list at files\.example is not what the chain committed to \(.*\), so it was not used\. Paste the eligibility list instead\.$/);
  });

  it("a host that fails in an unexpected way is a note, not a failure to load the break", async () => {
    const r = await loadPublishedLists({ baseUrl: BASE, fetch: host({ [`eligibility/${ROOT}.json`]: () => { throw new TypeError("boom"); } }).fetchFn, break: account() });
    expect(r.stillToPaste).toContain("the eligibility list");
    expect(r.notes[0]).toMatch(/could not be read from files\.example/);
  });

  it("whatever goes wrong while reading, even outside the request itself, is a note and not a failure to load the break", async () => {
    const broken = (async () => ({ ok: true, status: 200, get headers(): never { throw new Error("boom"); }, text: async () => "" })) as unknown as typeof fetch;
    const r = await loadPublishedLists({ baseUrl: BASE, fetch: broken, break: account() });
    expect(r.stillToPaste).toEqual(["the eligibility list", "the cards"]);
    expect(r.notes).toHaveLength(2);
    expect(r.notes[0]).toMatch(/boom/);
  });

  it("tells the person what to paste when the site has nowhere to read from", async () => {
    const none = host();
    const r = await loadPublishedLists({ break: account(), fetch: none.fetchFn });
    expect(r).toEqual({ notes: [], stillToPaste: ["the eligibility list", "the cards"] });
    expect(none.asked).toEqual([]);
    expect((await loadPublishedLists({ break: account({ status: "Open", eligibilityRoot: new Uint8Array(32), eligibilityCount: 0, eligibilityTotalWeight: 0n, poolHash: new Uint8Array(32) }) })).stillToPaste).toEqual([]);
  });

  it("makes a link only to a name that is 64 lowercase hex digits", () => {
    expect(publishedFileUrl(BASE, "eligibility", ROOT)).toBe(`${BASE}/eligibility/${ROOT}.json`);
    expect(publishedFileUrl(BASE, "pool", POOL_HASH)).toBe(`${BASE}/pool/${POOL_HASH}.json`);
    expect(publishedFileUrl(BASE, "pool", "../../x")).toBeUndefined();
    expect(publishedFileUrl(BASE, "pool", ROOT.toUpperCase())).toBeUndefined();
  });
});

describe("the verifier with the published lists", () => {
  it("is satisfied with the keeper's files: the root, the total, the count and the pool hash all match the commitments", async () => {
    const r = await loadPublishedLists({ baseUrl: BASE, fetch: served().fetchFn, break: account() });
    const wallets = (r.holders as string).split("\n").map((l) => l.split(" ")[0] as string);
    const result = verifyDraw({
      seed: toHex(new Uint8Array(32).fill(9)),
      holders: r.holders as string,
      freeSpots: "2",
      paidOwners: wallets.slice(0, 3).join("\n"),
      cards: r.cards as string,
      expected: { root: ROOT, totalWeight: "130", entryCount: "6", poolHash: POOL_HASH },
    });
    if (!result.ok) throw new Error(result.errors.join(" | "));
    const verified: Verified = result;
    expect(verified.checks.map((c) => [c.label, c.matches])).toEqual([
      ["Eligibility root", true],
      ["Total weight", true],
      ["Eligible wallets", true],
      ["Pool hash", true],
    ]);
    expect(verified.winners).toHaveLength(2);
    expect(verified.assignment).toHaveLength(5);
  });
});

describe("the form after a break is loaded", () => {
  const loaded = { patch: { seed: "s", freeSpots: "2" }, onChain: { winners: [], complete: true } };
  const typed = { ...emptyInput(), holders: "typed holders", cards: "typed cards" };

  it("puts the published text in, and remembers where it came from", () => {
    const r = applyLoad(typed, NOT_PUBLISHED, loaded, { holders: "list", cards: "pool" });
    expect(r.input).toMatchObject({ seed: "s", freeSpots: "2", holders: "list", cards: "pool" });
    expect(r.provenance).toEqual({ holders: true, cards: true });
  });

  it("keeps what the person pasted when nothing was published", () => {
    const r = applyLoad(typed, NOT_PUBLISHED, loaded, { holders: undefined, cards: undefined });
    expect(r.input).toMatchObject({ holders: "typed holders", cards: "typed cards" });
    expect(r.provenance).toEqual(NOT_PUBLISHED);
    expect(applyLoad(typed, NOT_PUBLISHED, loaded, undefined).input).toMatchObject({ holders: "typed holders", cards: "typed cards" });
  });

  it("clears published text that belongs to the break loaded before, so it is not taken for the new one's", () => {
    const earlier = { ...emptyInput(), holders: "list of break 1", cards: "pool of break 1" };
    const r = applyLoad(earlier, { holders: true, cards: true }, loaded, { holders: undefined, cards: undefined });
    expect(r.input).toMatchObject({ holders: "", cards: "" });
    expect(r.provenance).toEqual(NOT_PUBLISHED);
    // Each field on its own.
    const half = applyLoad(earlier, { holders: true, cards: false }, loaded, { holders: undefined, cards: undefined });
    expect(half.input).toMatchObject({ holders: "", cards: "pool of break 1" });
    expect(applyLoad(earlier, { holders: true, cards: true }, loaded, { holders: "new list", cards: undefined }).input).toMatchObject({ holders: "new list", cards: "" });
  });

  it("brings in what the chain gave, and keeps the other fields", () => {
    const r = applyLoad({ ...typed, paidOwners: "old buyers" }, NOT_PUBLISHED, { patch: { paidOwners: "new buyers" }, onChain: { winners: [], complete: false } }, undefined);
    expect(r.input.paidOwners).toBe("new buyers");
    expect(r.input.onChain).toEqual({ winners: [], complete: false });
  });
});

describe("the links on a break's page", () => {
  const page = (publishedUrl: string | undefined, b = account()) => {
    const loaded: Loaded = { number: 8, break: b, paidOwners: [], notes: [] };
    return renderToStaticMarkup(createElement(BreakDetails, { loaded, now: 1_800_000_000, readAt: 1_800_000_000, program: "8tmJjCG3D4TF7oPiPWNoaCjZ4pN2U4H237BSGVw2B8KU", refresh: () => {}, ...(publishedUrl ? { publishedUrl } : {}) }));
  };

  it("links the lists that exist, by the names the chain's hashes give them", () => {
    const html = page(BASE);
    expect(html).toContain(`<a href="${BASE}/eligibility/${ROOT}.json">Eligible wallets</a>`);
    expect(html).toContain(`<a href="${BASE}/pool/${POOL_HASH}.json">Cards</a>`);
    expect(html).toContain("check it against that hash rather than trusting where it is hosted");
  });

  it("links no list for a break whose list is empty, only its cards", () => {
    const empty = page(BASE, account({ eligibilityRoot: new Uint8Array(32), eligibilityCount: 0, eligibilityTotalWeight: 0n }));
    expect(empty).not.toContain("/eligibility/");
    expect(empty).toContain(`${BASE}/pool/${POOL_HASH}.json`);
    const nothing = page(BASE, account({ status: "EligibilityCommitted", eligibilityRoot: new Uint8Array(32), eligibilityCount: 0, eligibilityTotalWeight: 0n, poolHash: new Uint8Array(32), seed: new Uint8Array(32), freeWinnerCount: 0, freeWinners: [] }));
    expect(nothing).not.toContain("Published lists");
  });

  it("links only the list before the seed is final, and nothing without a place to read from", () => {
    const mid = page(BASE, account({ status: "PoolCommitted", seed: new Uint8Array(32), freeWinnerCount: 0, freeWinners: [] }));
    expect(mid).toContain("/eligibility/");
    expect(mid).not.toContain("/pool/");
    expect(page(undefined)).not.toContain("Published lists");
    const open = page(BASE, account({ status: "Open", eligibilityRoot: new Uint8Array(32), eligibilityCount: 0, eligibilityTotalWeight: 0n, poolHash: new Uint8Array(32), seed: new Uint8Array(32), freeWinnerCount: 0, freeWinners: [] }));
    expect(open).not.toContain("Published lists");
  });
});
