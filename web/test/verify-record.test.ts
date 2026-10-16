import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MOST_OUT, RecordSection, reasonText } from "../app/verify/record-section";
import { WeightsSection } from "../app/verify/weights-section";
import { isOnCurve } from "../lib/chain/address";
import { addressToBytes } from "../lib/chain/address";
import { fromHex, hashv } from "../lib/draw/bytes";
import { decodeBreak } from "../lib/chain/accounts";
import { emptyInput } from "../lib/example";
import { fetchRecord } from "../lib/published";
import { parseInputs } from "../lib/twab/inputs";
import { type EligibilityRecord, type RecordContext, checkRecord, parseRecord } from "../lib/twab/record";
import { twabByOwner } from "../lib/twab/twab";
import { type RecordReport, type VerifyResult, type Verified, verifyDraw } from "../lib/verify";
import { breakFieldsFromVector, encodeBreak } from "./support/accounts";

// The keeper's golden files (keeper/test/publish.test.ts makes and pins them): a list of six, its balance events, its record
// (one wallet for each reason a wallet is out) and a pool.
const EXAMPLE = join(import.meta.dirname, "..", "..", "docs", "published-example");
const file = (folder: string) => {
  const [name] = readdirSync(join(EXAMPLE, folder));
  return { name: name as string, text: readFileSync(join(EXAMPLE, folder, name as string), "utf8") };
};
const ELIGIBILITY = file("eligibility");
const INPUTS = file("inputs");
const RECORD = file("records");
const POOL = file("pool");
const ROOT = ELIGIBILITY.name.replace(".json", "");
const INPUTS_HASH = INPUTS.name.replace(".txt", "");
const WINDOW = { start: 1_800_000_000n, end: 1_800_043_200n };

const record = (text = RECORD.text): EligibilityRecord => {
  const r = parseRecord(text);
  if (!r.ok) throw new Error(r.errors.join(" | "));
  return r.record;
};
/** The record's JSON with an edit applied. */
const edited = (edit: (doc: any) => void) => {
  const doc = JSON.parse(RECORD.text);
  edit(doc);
  return JSON.stringify(doc);
};
const doc = JSON.parse(RECORD.text) as { wallets: { wallet: string; twab: string; weight: string; reason: string | null }[] };
const walletWith = (reason: string | null) => doc.wallets.find((w) => w.reason === reason)?.wallet as string;
const LISTED = doc.wallets.filter((w) => w.reason === null);
const EXCHANGE = walletWith("excluded:exchange");
const SMALL = walletWith("below_min_twab");
const VAULT = walletWith("off_curve");

const twabs = (() => {
  const p = parseInputs(INPUTS.text);
  if (!p.ok) throw new Error("the golden balance events do not parse");
  return twabByOwner(p.events, p.window);
})();
const listed = (JSON.parse(ELIGIBILITY.text).entries as { wallet: string; weight: string }[]).map((e) => ({ wallet: e.wallet, weight: BigInt(e.weight) }));
const chain = { inputsHash: INPUTS_HASH, root: ROOT, totalWeight: 130n, entryCount: 6, window: WINDOW };
const full: RecordContext = { twabs, listed, chain };
const problems = (text: string, ctx: RecordContext = {}) => checkRecord(record(text), ctx).problems;
const refused = (text: string) => {
  const r = parseRecord(text);
  if (r.ok) throw new Error("expected the record to be refused");
  return r.errors;
};

describe("the keeper's golden record", () => {
  it("is read as it is, with the rules and every wallet", () => {
    const r = record();
    expect(r).toMatchObject({ inputsHash: INPUTS_HASH, root: ROOT, totalWeight: 130n, entryCount: 6, window: { start: 1_800_000_000, end: 1_800_043_200 }, policy: { minTwab: 3n } });
    expect(r.policy.cap).toBeUndefined();
    expect(r.wallets).toHaveLength(9);
    expect(r.wallets.find((w) => w.wallet === EXCHANGE)?.reason).toEqual({ kind: "excluded", code: "exchange" });
  });

  it("adds up in every way the page can check: the rules, the chain, the balance events and the list", () => {
    const c = checkRecord(record(), full);
    expect(c.problems).toEqual([]);
    expect(c.counts).toEqual({ listed: 6, belowMin: 1, offCurve: 1, excluded: 1 });
    expect(c.checked).toEqual({ twabs: true, list: true, chain: true });
    // The wallets that are out, biggest average balance first.
    expect(c.out.map((r) => [r.wallet, r.twab])).toEqual([[EXCHANGE, 1000n], [VAULT, 7n], [SMALL, 2n]]);
  });

  it("says which checks it could not make when only the record is given", () => {
    const c = checkRecord(record());
    expect(c.problems).toEqual([]);
    expect(c.checked).toEqual({ twabs: false, list: false, chain: false });
  });

  it("has a pool vault that is really off the curve and holders that are really on it", () => {
    expect(isOnCurve(addressToBytes(VAULT))).toBe(false);
    for (const w of [...LISTED.map((l) => l.wallet), SMALL, EXCHANGE]) expect(isOnCurve(addressToBytes(w)), w).toBe(true);
  });
});

describe("reading a record", () => {
  it("refuses what is not a record of this format, saying what", () => {
    expect(refused("nope")).toEqual(["it is not JSON"]);
    expect(refused("[]")).toEqual(["it is not a JSON object"]);
    expect(refused(edited((d) => (d.version = 2)))).toEqual(["it is not a record of a version this page reads"]);
    expect(refused(edited((d) => (d.kind = "eligibility")))).toEqual(["it is not a record of a version this page reads"]);
    expect(refused(edited((d) => (d.inputsHash = d.inputsHash.toUpperCase())))).toEqual(["the inputs hash is not 64 lowercase hex digits"]);
    expect(refused(edited((d) => (d.root = "ab")))).toEqual(["the root is not 64 lowercase hex digits"]);
    expect(refused(edited((d) => (d.totalWeight = 130)))).toEqual(["the total weight is not a whole number from 0 to 18446744073709551615"]);
    expect(refused(edited((d) => (d.totalWeight = "0130")))).toEqual(["the total weight is not a whole number from 0 to 18446744073709551615"]);
    expect(refused(edited((d) => (d.totalWeight = "18446744073709551616")))).toEqual(["the total weight is not a whole number from 0 to 18446744073709551615"]);
    expect(refused(edited((d) => (d.entryCount = -1)))).toEqual(["the number of wallets is not a whole number"]);
    expect(refused(edited((d) => (d.window.end = d.window.start)))).toEqual(["the window is not two times in Unix seconds, the end after the start"]);
    expect(refused(edited((d) => delete d.policy))).toEqual(["it states no rules (policy)"]);
    expect(refused(edited((d) => (d.policy.minTwab = "-1")))).toEqual(["the minimum is not a whole number from 0 to 18446744073709551615"]);
    expect(refused(edited((d) => (d.policy.capPerWallet = "x")))).toEqual(["the cap is not a whole number from 0 to 18446744073709551615"]);
    expect(refused(edited((d) => (d.wallets = {})))).toEqual(["it has no list of wallets"]);
  });

  it("refuses a wallet that is not one, out of order or twice, or with a reason it does not know", () => {
    expect(refused(edited((d) => (d.wallets[0].wallet = "not an address")))).toEqual(["wallet 1 is not a Solana address"]);
    expect(refused(edited((d) => (d.wallets[0] = 5)))).toEqual(["wallet 1 is not a wallet with an average balance, a weight and a reason"]);
    expect(refused(edited((d) => d.wallets.reverse()))[0]).toMatch(/^wallet 2 \(.*\) is out of order or listed twice/);
    expect(refused(edited((d) => d.wallets.splice(1, 0, d.wallets[0])))[0]).toMatch(/^wallet 2 \(.*\) is out of order or listed twice/);
    expect(refused(edited((d) => (d.wallets[0].twab = "1.5")))).toEqual(["the average balance of wallet 1 is not a whole number from 0 to 18446744073709551615"]);
    expect(refused(edited((d) => (d.wallets[0].weight = null)))).toEqual(["the weight of wallet 1 is not a whole number from 0 to 18446744073709551615"]);
    for (const reason of ["below", "excluded:", "excluded:<b>x</b>", "excluded:a b", `excluded:${"a".repeat(65)}`, 3, undefined]) {
      expect(refused(edited((d) => (d.wallets[0].reason = reason))), String(reason)).toEqual(["the reason of wallet 1 is not one this page knows (null, below_min_twab, off_curve or excluded:<code>)"]);
    }
    expect(record(edited((d) => (d.wallets[0].reason = `excluded:${"a".repeat(64)}`))).wallets[0]?.reason).toEqual({ kind: "excluded", code: "a".repeat(64) });
  });

  it("says at most twenty problems, and how many more there are", () => {
    const errors = refused(edited((d) => d.wallets.forEach((w: any) => ((w.twab = "x"), (w.weight = "y"), (w.reason = "z")))));
    expect(errors).toHaveLength(21);
    expect(errors[20]).toBe("... and 7 more");
  });
});

describe("checking a record", () => {
  const listedWallet = LISTED[0]?.wallet as string;

  it("refuses a wallet on the list that is a program's account, or below the minimum, or with a weight the rules do not give", () => {
    expect(problems(edited((d) => Object.assign(d.wallets.find((w: any) => w.reason === "off_curve"), { reason: null, weight: "7" })))).toEqual(
      expect.arrayContaining([`${VAULT} is on the list, but it is a program's account (off the curve), which can never be a holder`]),
    );
    expect(problems(edited((d) => (d.policy.minTwab = "6")))).toEqual(
      expect.arrayContaining([expect.stringMatching(/ is on the list with an average balance of 5, below the minimum of 6$/)]),
    );
    expect(problems(edited((d) => (d.policy.capPerWallet = "20")))).toEqual(
      expect.arrayContaining([expect.stringMatching(/ is on the list with weight 50, but the rules give 20 for an average balance of 50$/), expect.stringMatching(/ weight 30, but the rules give 20 /)]),
    );
    // With that cap and the capped weights, it all adds up again, except the root, which the list of the chain does not have.
    const capped = edited((d) => {
      d.policy.capPerWallet = "20";
      for (const w of d.wallets) if (w.reason === null && BigInt(w.weight) > 20n) w.weight = "20";
    });
    expect(problems(capped).filter((p) => !p.includes("build root"))).toEqual([]);
  });

  it("refuses a wallet said to be below the minimum that is not, or that is a program's account", () => {
    expect(problems(edited((d) => (d.policy.minTwab = "2")))).toEqual(expect.arrayContaining([`${SMALL} is said to be below the minimum of 2, but its average balance is 2`]));
    expect(problems(edited((d) => Object.assign(d.wallets.find((w: any) => w.reason === "off_curve"), { reason: "below_min_twab", twab: "1" })))).toEqual([
      `${VAULT} is said to be below the minimum, but it is a program's account (off the curve), which the rules leave out first`,
    ]);
    // A zero average balance is always below the minimum, even when the minimum is zero.
    expect(problems(edited((d) => ((d.policy.minTwab = "0"), Object.assign(d.wallets.find((w: any) => w.reason === "below_min_twab"), { twab: "0" }))))).toEqual([]);
  });

  it("refuses a wallet said to be a program's account that is an ordinary key, and a wallet out with a weight", () => {
    expect(problems(edited((d) => (d.wallets.find((w: any) => w.reason === "below_min_twab").reason = "off_curve")))).toEqual([`${SMALL} is said to be a program's account, but it is an ordinary key (on the curve)`]);
    expect(problems(edited((d) => (d.wallets.find((w: any) => w.reason === "excluded:exchange").weight = "5")))).toEqual([`${EXCHANGE} is not on the list but has weight 5`]);
  });

  it("refuses a record whose eligible wallets do not build the root, total and count it states", () => {
    expect(problems(edited((d) => (d.root = "11".repeat(32))))).toEqual([expect.stringMatching(/^the wallets it calls eligible build root [0-9a-f]{64} with 6 wallets and total 130, not the root (?:11){32} with 6 wallets and total 130 it states$/)]);
    expect(problems(edited((d) => (d.totalWeight = "131")))[0]).toMatch(/total 130, not the root .* total 131 it states$/);
    expect(problems(edited((d) => (d.entryCount = 5)))[0]).toMatch(/with 6 wallets .* with 5 wallets/);
    // Nobody eligible is the zero root.
    const nobody = edited((d) => {
      for (const w of d.wallets) if (w.reason === null) Object.assign(w, { reason: "excluded:team", weight: "0" });
      Object.assign(d, { root: "00".repeat(32), totalWeight: "0", entryCount: 0 });
    });
    expect(problems(nobody)).toEqual([]);
  });

  it("refuses a record that does not state what the chain committed", () => {
    const at = (c: RecordContext["chain"]) => problems(RECORD.text, { chain: c });
    expect(at(chain)).toEqual([]);
    expect(at({ inputsHash: "ee".repeat(32) })).toEqual([`it is for inputs hash ${INPUTS_HASH}, not the ${"ee".repeat(32)} committed on chain`]);
    expect(at({ root: "ee".repeat(32) })).toEqual([`it states root ${ROOT}, not the ${"ee".repeat(32)} committed on chain`]);
    expect(at({ totalWeight: 129n })).toEqual(["it states a total weight of 130, not the 129 committed on chain"]);
    expect(at({ entryCount: 7 })).toEqual(["it states 6 wallets on the list, not the 7 committed on chain"]);
    expect(at({ window: { start: WINDOW.start, end: WINDOW.end + 1n } })).toEqual([`it measures from 1800000000 to 1800043200, not over the break's window from 1800000000 to 1800043201`]);
    expect(at({ window: { start: WINDOW.start - 1n, end: WINDOW.end } })).toHaveLength(1);
  });

  it("refuses an average balance the balance events do not give, a wallet they do not have, and one they have that the record leaves out", () => {
    const changed = new Map(twabs);
    changed.set(SMALL, 3n);
    expect(problems(RECORD.text, { twabs: changed })).toEqual([`${SMALL} has an average balance of 3 in the balance events, not the 2 the record says`]);
    const without = new Map(twabs);
    without.delete(SMALL);
    expect(problems(RECORD.text, { twabs: without })).toEqual([`${SMALL} is in the record but has no balance events`]);
    const extra = new Map(twabs);
    extra.set(listedWallet.replace(/.$/, (c) => (c === "A" ? "B" : "A")), 4n);
    expect(problems(RECORD.text, { twabs: extra })).toEqual([expect.stringMatching(/ has balance events but is not in the record$/)]);
  });

  it("refuses a record whose eligible wallets are not the eligibility list", () => {
    expect(problems(RECORD.text, { listed: listed.slice(1) })).toEqual([`${listed[0]?.wallet} is on the list in the record but not in the eligibility list`]);
    expect(problems(RECORD.text, { listed: listed.map((l, i) => (i === 0 ? { ...l, weight: l.weight + 1n } : l)) })).toEqual([
      `${listed[0]?.wallet} has weight ${listed[0]?.weight} in the record but ${(listed[0]?.weight as bigint) + 1n} in the eligibility list`,
    ]);
    expect(problems(RECORD.text, { listed: [...listed, { wallet: EXCHANGE, weight: 1000n }] })).toEqual([`${EXCHANGE} is in the eligibility list but the record does not put it on the list`]);
    // An empty list against a record that calls six wallets eligible.
    expect(problems(RECORD.text, { listed: [] })).toHaveLength(6);
  });

  it("says at most twenty problems, and how many more there are", () => {
    const many = new Map([...twabs].map(([w, t]) => [w, t + 1n]));
    const lots = checkRecord(record(edited((d) => (d.policy.minTwab = "1000000"))), { twabs: many, listed: [], chain: { root: "ee".repeat(32), entryCount: 9 } }).problems;
    expect(lots).toHaveLength(21);
    expect(lots[20]).toMatch(/^\.\.\. and \d+ more$/);
  });
});

describe("the record on the verify page", () => {
  const ok = (r: VerifyResult): Verified => {
    if (!r.ok) throw new Error(r.errors.join(" | "));
    return r;
  };
  const input = (over: Partial<Parameters<typeof verifyDraw>[0]> = {}) => ({
    ...emptyInput(),
    seed: "09".repeat(32),
    holders: (JSON.parse(ELIGIBILITY.text).entries as { wallet: string; weight: string }[]).map((e) => `${e.wallet} ${e.weight}`).join("\n"),
    inputs: INPUTS.text,
    record: RECORD.text,
    expected: { root: ROOT, totalWeight: "130", entryCount: "6", inputsHash: INPUTS_HASH, poolHash: "" },
    onChain: { winners: [], complete: false, window: WINDOW },
    ...over,
  });

  it("checks the record against everything given, and it all adds up for the keeper's files", () => {
    const r = ok(verifyDraw(input()));
    expect(r.record).toMatchObject({ ok: true, check: { problems: [], checked: { twabs: true, list: true, chain: true } } });
    expect(r.weights).toMatchObject({ ok: true, check: { verdict: "equal" } });
  });

  it("checks it with what there is: without balance events, list or chain values, it says so", () => {
    const r = ok(verifyDraw(input({ inputs: "", holders: "", expected: { root: "", totalWeight: "", entryCount: "", inputsHash: "", poolHash: "" }, onChain: undefined })));
    expect(r.record).toMatchObject({ ok: true, check: { problems: [], checked: { twabs: false, list: false, chain: false } } });
    // Balance events that cannot be read are not used to check the record either.
    const broken = ok(verifyDraw(input({ inputs: "nonsense\n" })));
    expect(broken.record).toMatchObject({ ok: true, check: { checked: { twabs: false } } });
  });

  it("finds a record that does not match the chain the break was loaded from", () => {
    const r = ok(verifyDraw(input({ expected: { root: ROOT, totalWeight: "130", entryCount: "6", inputsHash: "ee".repeat(32), poolHash: "" } })));
    expect(r.record?.ok && r.record.check.problems).toEqual([`it is for inputs hash ${INPUTS_HASH}, not the ${"ee".repeat(32)} committed on chain`]);
  });

  it("compares the record's window with the break's sale window when the break was loaded", () => {
    const r = ok(verifyDraw(input({ onChain: { winners: [], complete: false, window: { start: WINDOW.start, end: WINDOW.end + 60n } } })));
    expect(r.record?.ok && r.record.check.problems).toEqual(expect.arrayContaining([`it measures from 1800000000 to 1800043200, not over the break's window from 1800000000 to 1800043260`]));
  });

  it("never stops the draw from being checked: a record that cannot be read is said in its own section", () => {
    const r = ok(verifyDraw(input({ record: "nope" })));
    expect(r.record).toEqual({ ok: false, errors: ["Record: it is not JSON"] });
    expect(r.winners).toHaveLength(2);
    // Without a record nothing is said about it.
    expect(ok(verifyDraw(input({ record: "  " }))).record).toBeUndefined();
  });
});

describe("reading the record from the published files", () => {
  const BASE = "https://files.example/published";
  const serve = (body: string | undefined) =>
    (async (url: string) => (url === `${BASE}/records/${INPUTS_HASH}.json` && body !== undefined ? new Response(body, { status: 200 }) : new Response("not found", { status: 404 }))) as unknown as typeof fetch;
  const expected = { inputsHash: INPUTS_HASH, root: ROOT, totalWeight: 130n, entryCount: 6, window: WINDOW };
  const get = (body: string | undefined, over: Partial<typeof expected> = {}) => fetchRecord({ baseUrl: BASE, fetch: serve(body), expected: { ...expected, ...over } });

  it("reads the keeper's record under the committed inputs hash", async () => {
    expect(await get(RECORD.text)).toEqual({ ok: true, value: { text: RECORD.text, wallets: 9, record: record() } });
  });

  it("does not use a record that is missing, unreadable, or does not state the chain's commitments", async () => {
    expect(await get(undefined)).toMatchObject({ ok: false, kind: "missing" });
    expect(await get("nope")).toEqual({ ok: false, kind: "invalid", message: "it is not JSON" });
    expect(await get(edited((d) => (d.inputsHash = "ee".repeat(32))))).toEqual({ ok: false, kind: "invalid", message: "the inputs hash inside the file is not the one it is named after" });
    for (const over of [{ root: "ee".repeat(32) }, { totalWeight: 131n }, { entryCount: 7 }]) {
      expect(await get(RECORD.text, over), JSON.stringify(over, (_, v) => (typeof v === "bigint" ? v.toString() : v))).toMatchObject({ ok: false, kind: "invalid", message: expect.stringMatching(/not what was committed on chain$/) });
    }
    expect(await get(RECORD.text, { window: { start: WINDOW.start, end: WINDOW.end + 1n } })).toEqual({ ok: false, kind: "invalid", message: "it was measured over another window than the break's" });
    expect(await get(RECORD.text, { window: { start: WINDOW.start + 1n, end: WINDOW.end } })).toMatchObject({ ok: false, kind: "invalid" });
  });

  it("is what the break's page links, under the same inputs hash as the balance events", async () => {
    const { publishedFileUrl } = await import("../lib/published");
    expect(publishedFileUrl(BASE, "records", INPUTS_HASH)).toBe(`${BASE}/records/${INPUTS_HASH}.json`);
  });
});

describe("the record's section", () => {
  const render = (report: RecordReport) => renderToStaticMarkup(createElement(RecordSection, { record: report }));
  const reportOf = (text = RECORD.text, ctx: RecordContext = full): RecordReport => ({ ok: true, record: record(text), check: checkRecord(record(text), ctx) });

  it("says it all adds up, the rules, the counts, and every wallet that is out with why", () => {
    const out = render(reportOf());
    expect(out).toContain("Why each wallet is in or out");
    expect(out).toContain('<div class="verdict ok" role="status">Every wallet&#x27;s reason follows from the rules the record states.</div>');
    expect(out).toContain("<dt>Minimum average balance</dt><dd class=\"mono\">3</dd>");
    expect(out).toContain("No cap: a wallet&#x27;s weight is its average balance.");
    expect(out).toContain("6 on the list, 1 below the minimum, 1 program&#x27;s account, 1 left out on purpose");
    expect(out).toContain("the chain commits to none of them");
    expect(out).not.toContain("Not checked");
    // The three wallets that are out, biggest first, with their reasons.
    const rows = [...out.matchAll(/<tr><th scope="row" class="mono wrap">([^<]+)<\/th><td class="mono">(\d+)<\/td><td>([^<]+)<\/td><\/tr>/g)].map((m) => [m[1], m[2], m[3]]);
    expect(rows).toEqual([
      [EXCHANGE, "1000", "left out on purpose: exchange"],
      [VAULT, "7", "a program&#x27;s account (off the curve), never a holder"],
      [SMALL, "2", "below the minimum of 3"],
    ]);
  });

  it("shows a cap when there is one, and says what was not checked", () => {
    const capped = edited((d) => (d.policy.capPerWallet = "60"));
    const out = render(reportOf(capped, {}));
    expect(out).toContain('<dt>Most weight one wallet can have</dt><dd><span class="mono">60</span></dd>');
    expect(out).toContain(
      "Not checked: the balance events were not given, so the average balances in it were not worked out again; the eligibility list was not given, so it was not compared with the list; no values from the break&#x27;s account were given, so it was not compared with the chain.",
    );
    expect(render(reportOf(RECORD.text, { twabs }))).toContain("Not checked: the eligibility list was not given");
  });

  it("lists what does not add up, and a record that cannot be read", () => {
    const bad = render(reportOf(RECORD.text, { chain: { entryCount: 7 } }));
    expect(bad).toContain('<div class="verdict bad" role="alert">1 thing in the record does not add up.</div>');
    expect(bad).toContain("<li>it states 6 wallets on the list, not the 7 committed on chain</li>");
    const two = render(reportOf(RECORD.text, { chain: { entryCount: 7, totalWeight: 1n } }));
    expect(two).toContain("2 things in the record do not add up.");
    const unreadable = render({ ok: false, errors: ["Record: it is not JSON"] });
    expect(unreadable).toContain('<div class="verdict bad" role="alert">The record could not be read.</div>');
    expect(unreadable).toContain("<li>Record: it is not JSON</li>");
  });

  it("shows only the first fifty wallets that are out, counts the rest, and says plurals right", () => {
    const many = Array.from({ length: MOST_OUT + 3 }, (_, i) => ({ wallet: `W${i}`, twab: BigInt(1000 - i), weight: 0n, reason: { kind: "below-min" as const } }));
    const base = reportOf();
    if (!base.ok) throw new Error("unreachable");
    const out = render({ ...base, check: { ...base.check, out: many, counts: { listed: 1, belowMin: 53, offCurve: 2, excluded: 0 } } });
    expect(out.match(/<tr><th scope="row"/g)).toHaveLength(MOST_OUT);
    expect(out).toContain("… and 3 more.");
    expect(out).toContain("1 on the list, 53 below the minimum, 2 programs&#x27; accounts, 0 left out on purpose");
    const exact = render({ ...base, check: { ...base.check, out: many.slice(0, MOST_OUT) } });
    expect(exact).not.toContain("more.");
  });

  it("puts each reason in words", () => {
    expect(reasonText({ kind: "listed" }, 3n)).toBe("on the list");
    expect(reasonText({ kind: "below-min" }, 3n)).toBe("below the minimum of 3");
    expect(reasonText({ kind: "off-curve" }, 3n)).toBe("a program's account (off the curve), never a holder");
    expect(reasonText({ kind: "excluded", code: "team" }, 3n)).toBe("left out on purpose: team");
  });

  it("the weights section points to the record when there is one, and says it was not given when there is none", () => {
    const r = verifyDraw({ ...emptyInput(), seed: "09".repeat(32), holders: listed.map((l) => `${l.wallet} ${l.weight}`).join("\n"), inputs: INPUTS.text, record: RECORD.text });
    if (!r.ok || !r.weights) throw new Error("expected weights");
    expect(renderToStaticMarkup(createElement(WeightsSection, { weights: r.weights, reasons: true }))).toContain("Why each one is out is checked in the record below.");
    expect(renderToStaticMarkup(createElement(WeightsSection, { weights: r.weights }))).toContain("The record of why each wallet is in or out says which; it was not given.");
  });
});

// The break account of the golden files, for the loader (a drawn break whose commitments are the files' names).
describe("loading a break with its record", () => {
  it("fills the record in, and remembers it came from the published files", async () => {
    const vectors = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "programs", "breaks", "instruction-vectors.json"), "utf8"));
    const sample = breakFieldsFromVector(vectors.cases.find((c: { name: string }) => c.name === "breaks.account.Break").outputs);
    const b = decodeBreak(
      encodeBreak({ ...sample, status: "Drawn", eligibilityRoot: fromHex(ROOT), eligibilityTotalWeight: 130n, eligibilityCount: 6, eligibilityInputsHash: fromHex(INPUTS_HASH), poolHash: hashv(new Uint8Array(1)), poolSize: 5, opensAt: WINDOW.start, closesAt: WINDOW.end }),
    );
    const { loadPublishedLists, applyLoad, NOT_PUBLISHED } = await import("../lib/published");
    const BASE = "https://files.example/published";
    const files: Record<string, string> = { [`records/${INPUTS_HASH}.json`]: RECORD.text, [`inputs/${INPUTS_HASH}.txt`]: INPUTS.text, [`eligibility/${ROOT}.json`]: ELIGIBILITY.text, [`pool/x`]: POOL.text };
    const fetchFn = (async (url: string) => (files[url.replace(`${BASE}/`, "")] !== undefined ? new Response(files[url.replace(`${BASE}/`, "")], { status: 200 }) : new Response("", { status: 404 }))) as unknown as typeof fetch;
    const published = await loadPublishedLists({ baseUrl: BASE, fetch: fetchFn, break: b });
    expect(published.record).toBe(RECORD.text);
    const loaded = { patch: {}, onChain: { winners: [], complete: true } };
    const first = applyLoad({ ...emptyInput(), record: "typed" }, NOT_PUBLISHED, loaded, published);
    expect(first.input.record).toBe(RECORD.text);
    expect(first.provenance.record).toBe(true);
    // The next break has no record: the one read for this break is cleared, a typed one would be kept.
    expect(applyLoad(first.input, first.provenance, loaded, { record: undefined }).input.record).toBe("");
    expect(applyLoad({ ...emptyInput(), record: "typed" }, NOT_PUBLISHED, loaded, { record: undefined }).input.record).toBe("typed");
  });
});
