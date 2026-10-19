import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExclusionsSection, MOST_EXCLUDED } from "../app/verify/exclusions-section";
import { decodeBreak } from "../lib/chain/accounts";
import { addressFromBytes } from "../lib/chain/address";
import { fromHex, hashv } from "../lib/draw/bytes";
import { emptyInput } from "../lib/example";
import { NOT_PUBLISHED, applyLoad, fetchExclusions, loadPublishedLists } from "../lib/published";
import { type ExclusionList, checkExclusions, heldBy, parseExclusions } from "../lib/twab/exclusions";
import { type EligibilityRecord, parseRecord } from "../lib/twab/record";
import { type ExclusionsReport, type VerifyResult, type Verified, verifyDraw } from "../lib/verify";
import { breakFieldsFromVector, encodeBreak } from "./support/accounts";

// The keeper's golden files (keeper/test/publish.test.ts makes and pins them): a record with one wallet left out on purpose
// (an exchange that held the token) and the exclusion list it was made with, which also names a team wallet that held none.
const EXAMPLE = join(import.meta.dirname, "..", "..", "docs", "published-example");
const file = (folder: string) => {
  const [name] = readdirSync(join(EXAMPLE, folder));
  return { name: name as string, text: readFileSync(join(EXAMPLE, folder, name as string), "utf8") };
};
const ELIGIBILITY = file("eligibility");
const INPUTS = file("inputs");
const RECORD = file("records");
const EXCLUSIONS = file("exclusions");
const ROOT = ELIGIBILITY.name.replace(".json", "");
const INPUTS_HASH = INPUTS.name.replace(".txt", "");
const WINDOW = { start: 1_800_000_000n, end: 1_800_043_200n };

const record = (text = RECORD.text): EligibilityRecord => {
  const r = parseRecord(text);
  if (!r.ok) throw new Error(r.errors.join(" | "));
  return r.record;
};
const list = (text = EXCLUSIONS.text): ExclusionList => {
  const r = parseExclusions(text);
  if (!r.ok) throw new Error(r.errors.join(" | "));
  return r.list;
};
const refused = (text: string) => {
  const r = parseExclusions(text);
  if (r.ok) throw new Error("expected the list to be refused");
  return r.errors;
};
const golden = JSON.parse(EXCLUSIONS.text) as { inputsHash: string; entries: { wallet: string; code: string }[] };
const edited = (edit: (doc: any) => void) => {
  const doc = JSON.parse(EXCLUSIONS.text);
  edit(doc);
  return JSON.stringify(doc);
};
const recordDoc = JSON.parse(RECORD.text) as { wallets: { wallet: string; reason: string | null }[] };
const EXCHANGE = recordDoc.wallets.find((w) => w.reason === "excluded:exchange")?.wallet as string;
const TEAM = golden.entries.find((e) => e.code === "team")?.wallet as string;
const LISTED = recordDoc.wallets.find((w) => w.reason === null)?.wallet as string;
const SMALL = recordDoc.wallets.find((w) => w.reason === "below_min_twab")?.wallet as string;
const VAULT = recordDoc.wallets.find((w) => w.reason === "off_curve")?.wallet as string;
const with_ = (entries: { wallet: string; code: string }[]): ExclusionList => ({ inputsHash: INPUTS_HASH, entries });

describe("the keeper's golden exclusion list", () => {
  it("is read as it is: the exchange that held the token and the team wallet that held none, sorted by their bytes", () => {
    expect(list()).toEqual({ inputsHash: INPUTS_HASH, entries: golden.entries });
    expect(golden.entries.map((e) => e.code).sort()).toEqual(["exchange", "team"]);
    expect(golden.entries.map((e) => e.wallet)).toContain(EXCHANGE);
    expect(recordDoc.wallets.map((w) => w.wallet)).not.toContain(TEAM);
  });

  it("is the list the golden record was made with, against the chain too", () => {
    expect(checkExclusions(list(), { record: record(), inputsHash: INPUTS_HASH })).toEqual({ problems: [], held: 1, notHeld: 1, checked: { record: true, chain: true } });
  });

  it("can be checked with less, and says which comparisons it made", () => {
    expect(checkExclusions(list(), {})).toEqual({ problems: [], held: 0, notHeld: 0, checked: { record: false, chain: false } });
    expect(checkExclusions(list(), { inputsHash: INPUTS_HASH }).checked).toEqual({ record: false, chain: true });
  });
});

describe("reading an exclusion list", () => {
  it("reads any JSON formatting of the same list", () => {
    expect(list(JSON.stringify(golden, null, 2))).toEqual(list());
    expect(list(JSON.stringify({ entries: golden.entries, inputsHash: golden.inputsHash, kind: "exclusions", version: 1 }))).toEqual(list());
    expect(list(JSON.stringify({ ...golden, entries: [] }))).toEqual({ inputsHash: INPUTS_HASH, entries: [] });
  });

  it("refuses what is not an exclusion list of this format, saying what", () => {
    expect(refused("{")).toEqual(["it is not JSON"]);
    for (const text of ["[]", "null", "7", edited((d) => (d.version = 2)), edited((d) => (d.kind = "record")), edited((d) => delete d.kind)]) {
      expect(refused(text), text).toEqual(["it is not an exclusion list of a version this page reads"]);
    }
    expect(refused(edited((d) => (d.inputsHash = d.inputsHash.toUpperCase())))).toEqual(["the inputs hash is not 64 lowercase hex digits"]);
    expect(refused(edited((d) => delete d.inputsHash))).toEqual(["the inputs hash is not 64 lowercase hex digits"]);
    expect(refused(edited((d) => (d.entries = {})))).toEqual(["it has no list of entries"]);
  });

  it("refuses an entry that is not a wallet and a code, not an address, out of order or twice, or with a code that is not a short name", () => {
    expect(refused(edited((d) => (d.entries[0] = "x")))).toEqual(["entry 1 is not a wallet and a code"]);
    expect(refused(edited((d) => (d.entries[0].note = "private")))).toEqual(["entry 1 is not a wallet and a code"]);
    expect(refused(edited((d) => delete d.entries[1].code))).toEqual(["entry 2 is not a wallet and a code"]);
    expect(refused(edited((d) => (d.entries[1].code = 7)))).toEqual(["entry 2 is not a wallet and a code"]);
    expect(refused(edited((d) => (d.entries[0].wallet = "nope")))).toEqual(["entry 1 is not a Solana address"]);
    expect(refused(edited((d) => d.entries.reverse()))).toEqual([`entry 2 (${golden.entries[0]?.wallet}) is out of order or listed twice: the wallets are sorted by their bytes`]);
    expect(refused(edited((d) => (d.entries[1] = d.entries[0])))).toEqual([`entry 2 (${golden.entries[0]?.wallet}) is out of order or listed twice: the wallets are sorted by their bytes`]);
    for (const code of ["", "x".repeat(65), "two words", "<b>", "équipe"]) {
      expect(refused(edited((d) => (d.entries[0].code = code))), code).toEqual(['the code of entry 1 is not 1 to 64 letters, digits, "_", "." or "-"']);
    }
    expect(list(edited((d) => (d.entries[0].code = "A".repeat(64)))).entries[0]?.code).toBe("A".repeat(64));
  });

  it("says at most twenty problems, and how many more there are", () => {
    const many = edited((d) => (d.entries = Array.from({ length: 25 }, () => ({ wallet: "nope", code: "x" }))));
    const errors = refused(many);
    expect(errors).toHaveLength(21);
    expect(errors.at(-1)).toBe("... and 5 more");
  });
});

describe("checking an exclusion list against the record and the chain", () => {
  const r = record();

  it("finds a wallet the record leaves out that the list does not name", () => {
    expect(checkExclusions(with_([{ wallet: TEAM, code: "team" }]), { record: r }).problems).toEqual([`the record leaves ${EXCHANGE} out on purpose (exchange), but this list does not name it`]);
  });

  it("finds a wallet the list names that held the token and that the record does not leave out, whatever its reason", () => {
    for (const w of [LISTED, SMALL, VAULT]) {
      const l = with_([...golden.entries, { wallet: w, code: "team" }]);
      expect(checkExclusions(l, { record: r }).problems, w).toEqual([`this list names ${w} (team), but the record does not leave it out on purpose`]);
    }
  });

  it("finds a wallet given another code", () => {
    const l = with_(golden.entries.map((e) => (e.wallet === EXCHANGE ? { ...e, code: "lp_pool" } : e)));
    expect(checkExclusions(l, { record: r }).problems).toEqual([`this list gives ${EXCHANGE} the code lp_pool, but the record says exchange`]);
  });

  it("finds a list for another inputs hash than the chain's or the record's", () => {
    const other = { inputsHash: "ee".repeat(32), entries: golden.entries };
    expect(checkExclusions(other, { inputsHash: INPUTS_HASH }).problems).toEqual([`it is for inputs hash ${"ee".repeat(32)}, not the ${INPUTS_HASH} committed on chain`]);
    expect(checkExclusions(other, { record: r }).problems).toEqual([`it is for inputs hash ${"ee".repeat(32)}, but the record is for ${INPUTS_HASH}`]);
  });

  it("says at most twenty problems", () => {
    const wallets = Array.from({ length: 25 }, (_, i) => ({ wallet: addressFromBytes(new Uint8Array(32).fill(i + 1)), twab: 5n, weight: 0n, reason: { kind: "excluded" as const, code: "team" } }));
    const check = checkExclusions(with_([]), { record: { ...r, wallets } });
    expect(check.problems).toHaveLength(21);
    expect(check.problems.at(-1)).toBe("... and 5 more");
  });

  it("tells whether a wallet held the token by the record, and nothing without one", () => {
    expect(heldBy(r)(EXCHANGE)).toBe(true);
    expect(heldBy(r)(TEAM)).toBe(false);
    expect(heldBy(undefined)(EXCHANGE)).toBeUndefined();
  });
});

describe("the exclusion list on the verify page", () => {
  const ok = (v: VerifyResult): Verified => {
    if (!v.ok) throw new Error(v.errors.join(" | "));
    return v;
  };
  const input = (over: Partial<Parameters<typeof verifyDraw>[0]> = {}) => ({
    ...emptyInput(),
    seed: "09".repeat(32),
    holders: (JSON.parse(ELIGIBILITY.text).entries as { wallet: string; weight: string }[]).map((e) => `${e.wallet} ${e.weight}`).join("\n"),
    inputs: INPUTS.text,
    record: RECORD.text,
    exclusions: EXCLUSIONS.text,
    expected: { root: ROOT, totalWeight: "130", entryCount: "6", inputsHash: INPUTS_HASH, poolHash: "" },
    onChain: { winners: [], complete: false, window: WINDOW },
    ...over,
  });

  it("checks it against the record and the chain, and the keeper's files add up", () => {
    const v = ok(verifyDraw(input()));
    expect(v.exclusions).toEqual({ ok: true, list: list(), check: { problems: [], held: 1, notHeld: 1, checked: { record: true, chain: true } }, record: record() });
  });

  it("does not use a record that cannot be read, nor one that was not given", () => {
    expect(ok(verifyDraw(input({ record: "nope" }))).exclusions).toMatchObject({ ok: true, check: { checked: { record: false } } });
    const alone = ok(verifyDraw(input({ record: "", expected: { root: "", totalWeight: "", entryCount: "", inputsHash: "", poolHash: "" } })));
    expect(alone.exclusions).toMatchObject({ ok: true, check: { problems: [], checked: { record: false, chain: false } } });
    expect(alone.exclusions && alone.exclusions.ok && alone.exclusions.record).toBeUndefined();
  });

  it("finds a list that is not the chain's, and one that does not fit the record", () => {
    const other = ok(verifyDraw(input({ expected: { root: ROOT, totalWeight: "130", entryCount: "6", inputsHash: "ee".repeat(32), poolHash: "" } })));
    expect(other.exclusions?.ok && other.exclusions.check.problems).toContain(`it is for inputs hash ${INPUTS_HASH}, not the ${"ee".repeat(32)} committed on chain`);
    const lacking = ok(verifyDraw(input({ exclusions: edited((d) => (d.entries = d.entries.filter((e: { code: string }) => e.code !== "exchange"))) })));
    expect(lacking.exclusions?.ok && lacking.exclusions.check.problems).toEqual([`the record leaves ${EXCHANGE} out on purpose (exchange), but this list does not name it`]);
  });

  it("never stops the draw from being checked: a list that cannot be read is said in its own section", () => {
    const v = ok(verifyDraw(input({ exclusions: "nope" })));
    expect(v.exclusions).toEqual({ ok: false, errors: ["Exclusion list: it is not JSON"] });
    expect(v.winners).toHaveLength(2);
    expect(ok(verifyDraw(input({ exclusions: "  " }))).exclusions).toBeUndefined();
  });
});

describe("reading the exclusion list from the published files", () => {
  const BASE = "https://files.example/published";
  const serve = (body: string | undefined) =>
    (async (url: string) => (url === `${BASE}/exclusions/${INPUTS_HASH}.json` && body !== undefined ? new Response(body, { status: 200 }) : new Response("not found", { status: 404 }))) as unknown as typeof fetch;
  const get = (body: string | undefined) => fetchExclusions({ baseUrl: BASE, fetch: serve(body), expected: { inputsHash: INPUTS_HASH } });

  it("reads the keeper's list under the committed inputs hash", async () => {
    expect(await get(EXCLUSIONS.text)).toEqual({ ok: true, value: { text: EXCLUSIONS.text, wallets: 2 } });
  });

  it("does not use a list that is missing, unreadable, or for another inputs hash", async () => {
    expect(await get(undefined)).toMatchObject({ ok: false, kind: "missing" });
    expect(await get("nope")).toEqual({ ok: false, kind: "invalid", message: "it is not JSON" });
    expect(await get(edited((d) => (d.inputsHash = "ee".repeat(32))))).toEqual({ ok: false, kind: "invalid", message: "the inputs hash inside the file is not the one it is named after" });
  });

  it("is read with the record when a break is loaded, and remembered as read from the files", async () => {
    const vectors = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "programs", "breaks", "instruction-vectors.json"), "utf8"));
    const sample = breakFieldsFromVector(vectors.cases.find((c: { name: string }) => c.name === "breaks.account.Break").outputs);
    const b = decodeBreak(
      encodeBreak({ ...sample, status: "Drawn", eligibilityRoot: fromHex(ROOT), eligibilityTotalWeight: 130n, eligibilityCount: 6, eligibilityInputsHash: fromHex(INPUTS_HASH), poolHash: hashv(new Uint8Array(1)), poolSize: 5, opensAt: WINDOW.start, closesAt: WINDOW.end }),
    );
    const published = await loadPublishedLists({ baseUrl: BASE, fetch: serve(EXCLUSIONS.text), break: b });
    expect(published.exclusions).toBe(EXCLUSIONS.text);
    const loaded = { patch: {}, onChain: { winners: [], complete: true } };
    const first = applyLoad({ ...emptyInput(), exclusions: "typed" }, NOT_PUBLISHED, loaded, published);
    expect(first.input.exclusions).toBe(EXCLUSIONS.text);
    expect(first.provenance.exclusions).toBe(true);
    // The next break has none: the one read for this break is cleared, a typed one would be kept.
    expect(applyLoad(first.input, first.provenance, loaded, { exclusions: undefined }).input.exclusions).toBe("");
    expect(applyLoad({ ...emptyInput(), exclusions: "typed" }, NOT_PUBLISHED, loaded, { exclusions: undefined }).input.exclusions).toBe("typed");
  });
});

describe("the exclusion list's section", () => {
  const text = (h: string) => h.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  const render = (exclusions: ExclusionsReport) => renderToStaticMarkup(createElement(ExclusionsSection, { exclusions }));
  const report = (l: ExclusionList, r?: EligibilityRecord, inputsHash?: string): ExclusionsReport => ({
    ok: true,
    list: l,
    check: checkExclusions(l, { ...(r ? { record: r } : {}), ...(inputsHash ? { inputsHash } : {}) }),
    ...(r ? { record: r } : {}),
  });

  it("says it is the list the record was made with, how many held the token, and every wallet with its code", () => {
    const html = render(report(list(), record(), INPUTS_HASH));
    const body = text(html);
    expect(body).toContain("It is the exclusion list the record was made with: every wallet the record leaves out on purpose is on it, with the same code, and no other.");
    expect(body).toContain("2 wallets were left out on purpose: 1 held the token, 1 held none of it (only this list shows that one).");
    expect(html).toContain(`<th scope="row" class="mono wrap">${EXCHANGE}</th><td>exchange</td><td>Yes</td>`);
    expect(html).toContain(`<th scope="row" class="mono wrap">${TEAM}</th><td>team</td><td>No</td>`);
    expect(body).toContain("Why a wallet is on this list is the keeper's word: the chain commits to none of it.");
    expect(body).not.toContain("Not checked");
    expect(html).toContain('role="status"');
  });

  it("without a record: no column for holding, and it says what was not checked", () => {
    const html = render(report(list()));
    const body = text(html);
    expect(body).toContain("The exclusion list reads as one.");
    expect(body).toContain("2 wallets were left out on purpose.");
    expect(body).toContain("Not checked: the record was not given (or could not be read), so it was not compared with it; no inputs hash from the break's account was given, so it was not compared with the chain.");
    expect(html).not.toContain("Held the token?");
  });

  it("lists what does not add up, and a list that cannot be read, as alerts", () => {
    const wrong = render(report(with_([{ wallet: TEAM, code: "team" }]), record()));
    expect(wrong).toContain('role="alert"');
    expect(text(wrong)).toContain("1 thing about the exclusion list does not add up.");
    expect(text(wrong)).toContain(`the record leaves ${EXCHANGE} out on purpose (exchange), but this list does not name it`);
    const two = render(report({ inputsHash: "ee".repeat(32), entries: [{ wallet: TEAM, code: "team" }] }, record()));
    expect(text(two)).toContain("2 things about the exclusion list do not add up.");
    const unread = render({ ok: false, errors: ["Exclusion list: it is not JSON"] });
    expect(text(unread)).toBe("The exclusion list The exclusion list could not be read. Exclusion list: it is not JSON");
  });

  it("says nobody was left out, the singular, and shows only the first fifty", () => {
    expect(text(render(report(with_([]), record())))).toContain("Nobody was left out on purpose.");
    const one = with_([{ wallet: TEAM, code: "team" }]);
    expect(text(render(report(one)))).toContain("1 wallet was left out on purpose.");
    const r = { ...record(), wallets: record().wallets.filter((w) => w.reason.kind !== "excluded") };
    expect(text(render(report(one, r)))).toContain("1 wallet was left out on purpose: 0 held the token, 1 held none of it (only this list shows that one).");
    const many = with_(Array.from({ length: MOST_EXCLUDED + 3 }, (_, i) => ({ wallet: addressFromBytes(new Uint8Array(32).fill(i + 1)), code: "bundle" })));
    const html = render(report(many, { ...r, wallets: [] }));
    expect(html.match(/<tr><th scope="row"/g)).toHaveLength(MOST_EXCLUDED);
    expect(text(html)).toContain("… and 3 more.");
    expect(text(html)).toContain("53 wallets were left out on purpose: 0 held the token, 53 held none of it (only this list shows those).");
  });
});
