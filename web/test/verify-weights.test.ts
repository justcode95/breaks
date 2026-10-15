import { base58 } from "@scure/base";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MOST_OFF_LIST, MOST_ROWS, WeightsSection } from "../app/verify/weights-section";
import { hashv, toHex, utf8 } from "../lib/draw/bytes";
import { emptyInput, exampleInput } from "../lib/example";
import { inputsHash } from "../lib/twab/inputs";
import { type VerifyInput, type VerifyResult, type Verified, type WeightsReport, verifyDraw } from "../lib/verify";

const name = (word: string, i: number) => base58.encode(hashv(utf8(`example ${word} ${i}`)));
const ok = (r: VerifyResult): Verified => {
  if (!r.ok) throw new Error(`expected a result, got: ${r.errors.join(" | ")}`);
  return r;
};
const weightsOf = (r: VerifyResult) => {
  const w = ok(r).weights;
  if (!w?.ok) throw new Error(w ? `the weights could not be checked: ${w.errors.join(" | ")}` : "the weights were not checked");
  return w;
};
const failedWeights = (r: VerifyResult) => {
  const w = ok(r).weights;
  if (!w || w.ok) throw new Error("expected the weights to be refused");
  return w.errors;
};

const base = exampleInput();
/** The example's list with the weight of holder `i` set to `weight`. */
const withWeight = (i: number, weight: number): VerifyInput => ({ ...base, holders: base.holders.replace(new RegExp(`(${name("holder", i)}) \\d+`), `$1 ${weight}`) });
const EXCHANGE = name("exchange", 0);

describe("the weights against the balance events", () => {
  it("are all its wallet's time-weighted average balance for the example, which also has a wallet that is not on the list", () => {
    const w = weightsOf(verifyDraw(base));
    expect(w.events).toBe(10);
    expect(w.window).toEqual({ start: 1_800_000_000, end: 1_800_043_200 });
    expect(w.check.verdict).toBe("equal");
    expect(w.check.counts).toEqual({ equal: 6, below: 0, above: 0, "no-history": 0 });
    expect(w.check.rows.map((r) => [r.weight, r.twab])).toEqual([[10n, 10n], [30n, 30n], [5n, 5n], [50n, 50n], [20n, 20n], [15n, 15n]]);
    expect(w.check.offList).toEqual([{ wallet: EXCHANGE, twab: 1000n }]);
  });

  it("is not part of the draw: the winners and the assignment are the same with or without them", () => {
    const without = ok(verifyDraw({ ...base, inputs: "" }));
    const withEvents = ok(verifyDraw(base));
    expect(without.weights).toBeUndefined();
    expect(withEvents.winners).toEqual(without.winners);
    expect(withEvents.assignment).toEqual(without.assignment);
    expect(withEvents.eligibility).toEqual(without.eligibility);
  });

  it("says a weight above the average balance cannot be explained, and one below it can only be a cap", () => {
    const above = weightsOf(verifyDraw(withWeight(0, 11)));
    expect(above.check.verdict).toBe("wrong");
    expect(above.check.rows[0]).toMatchObject({ weight: 11n, twab: 10n, status: "above" });
    const below = weightsOf(verifyDraw(withWeight(0, 9)));
    expect(below.check.verdict).toBe("capped");
    expect(below.check.rows[0]).toMatchObject({ weight: 9n, twab: 10n, status: "below" });
    // One of each: what cannot be explained wins.
    const both = weightsOf(verifyDraw({ ...withWeight(0, 9), holders: withWeight(1, 31).holders.replace(new RegExp(`(${name("holder", 0)}) \\d+`), "$1 9") }));
    expect(both.check.verdict).toBe("wrong");
    expect(both.check.counts).toMatchObject({ above: 1, below: 1, equal: 4 });
  });

  it("says a wallet on the list with no balance events at all cannot be explained", () => {
    const stranger = name("stranger", 0);
    const w = weightsOf(verifyDraw({ ...base, holders: `${base.holders}\n${stranger} 7` }));
    expect(w.check.verdict).toBe("wrong");
    expect(w.check.rows.find((r) => r.wallet === stranger)).toMatchObject({ weight: 7n, twab: undefined, status: "no-history" });
    expect(w.check.counts["no-history"]).toBe(1);
  });

  it("works for a list of nobody: every wallet with a balance is then off the list, the biggest first", () => {
    const w = weightsOf(verifyDraw({ ...base, holders: "", freeSpots: "0", paidOwners: "", cards: "" }));
    expect(w.check.rows).toEqual([]);
    expect(w.check.offList.map((o) => o.twab)).toEqual([1000n, 50n, 30n, 20n, 15n, 10n, 5n]);
    expect(w.check.offList[0]?.wallet).toBe(EXCHANGE);
  });

  it("is not checked when no balance events were given (spaces and blank lines do not count), and a note says what the chain commits to", () => {
    const hash = "ab".repeat(32);
    for (const inputs of ["", "   ", "\n\n  \n"]) {
      const r = ok(verifyDraw({ ...base, inputs, expected: { ...base.expected, inputsHash: hash } }));
      expect(r.weights).toBeUndefined();
      expect(r.checks).toEqual([]);
      expect(r.notes).toEqual([`The balance events were not given, so the weights were not checked against them (the chain commits to them with the inputs hash ${hash}).`]);
    }
    // No hash to point at, and no events: nothing to say.
    expect(ok(verifyDraw({ ...base, inputs: "" })).notes).toEqual([]);
  });

  describe("compared with what the chain committed", () => {
    const hash = inputsHash(base.inputs);

    it("checks the hash of the text, in upper or lower case", () => {
      for (const given of [hash, hash.toUpperCase()]) {
        const r = ok(verifyDraw({ ...base, expected: { ...base.expected, inputsHash: given } }));
        expect(r.checks).toEqual([{ label: "Balance-event hash", expected: hash, actual: hash, matches: true }]);
      }
      const flipped = (hash[0] === "a" ? "b" : "a") + hash.slice(1);
      const r = ok(verifyDraw({ ...base, expected: { ...base.expected, inputsHash: flipped } }));
      expect(r.checks).toEqual([{ label: "Balance-event hash", expected: flipped, actual: hash, matches: false }]);
    });

    it("sees a text that is not the committed one even though its weights still add up, and does not hide that the hash differs", () => {
      // One balance event of the wallet that is not on the list changed: every weight on the list is still its average balance.
      const changed = base.inputs.replace(",1000,1000", ",999,999");
      expect(changed).not.toBe(base.inputs);
      const r = ok(verifyDraw({ ...base, inputs: changed, expected: { ...base.expected, inputsHash: hash } }));
      expect(r.checks).toEqual([{ label: "Balance-event hash", expected: hash, actual: inputsHash(changed), matches: false }]);
      expect(weightsOf(r).check.verdict).toBe("equal");
    });

    it("refuses an inputs hash that is not 64 hex digits, and computes nothing", () => {
      for (const bad of ["12", "z".repeat(64), "ab".repeat(33)]) {
        expect(verifyDraw({ ...base, expected: { ...base.expected, inputsHash: bad } })).toEqual({ ok: false, errors: ["Expected inputs hash: 64 hex digits."] });
      }
    });

    it("compares the window of the text with the break's sale window, to the second", () => {
      const window = (start: bigint, end: bigint) => ok(verifyDraw({ ...base, onChain: { winners: [], complete: false, window: { start, end } } })).checks;
      expect(window(1_800_000_000n, 1_800_043_200n)).toEqual([{ label: "Window of the balance events", expected: "1800000000 to 1800043200", actual: "1800000000 to 1800043200", matches: true }]);
      expect(window(1_800_000_001n, 1_800_043_200n)[0]).toMatchObject({ expected: "1800000001 to 1800043200", matches: false });
      expect(window(1_800_000_000n, 1_800_043_199n)[0]).toMatchObject({ expected: "1800000000 to 1800043199", matches: false });
      // No window on chain (the form was filled by hand), nothing to compare with.
      expect(ok(verifyDraw({ ...base, onChain: { winners: [], complete: false } })).checks).toEqual([]);
    });

    it("has no window row for a text that could not be read", () => {
      const r = ok(verifyDraw({ ...base, inputs: "nope\n", onChain: { winners: [], complete: false, window: { start: 1n, end: 2n } } }));
      expect(r.checks).toEqual([]);
      expect(r.weights?.ok).toBe(false);
    });

    it("puts the balance-event rows after the list's and before the pool's", () => {
      const r = ok(
        verifyDraw({
          ...base,
          expected: { ...base.expected, root: ok(verifyDraw(base)).eligibility.root, totalWeight: "130", entryCount: "6", inputsHash: hash, poolHash: ok(verifyDraw(base)).poolHash as string },
          onChain: { winners: [], complete: false, window: { start: 1_800_000_000n, end: 1_800_043_200n } },
        }),
      );
      expect(r.checks.map((c) => c.label)).toEqual(["Eligibility root", "Total weight", "Eligible wallets", "Balance-event hash", "Window of the balance events", "Pool hash"]);
    });
  });

  describe("a text that cannot be used", () => {
    it("is said by line and the draw is still checked", () => {
      const lines = base.inputs.split("\n");
      lines[2] = lines[2]?.replace(/,\d+,\d+$/, ",abc,5") as string;
      const text = lines.join("\n");
      const r = verifyDraw({ ...base, inputs: text });
      expect(failedWeights(r)).toEqual(["Balance events: line 3: the change must be a whole number of base units (a u64 at most, with a minus sign for a withdrawal)"]);
      expect(ok(r).winners).toHaveLength(2);
      expect(ok(r).assignment).toHaveLength(5);
    });

    it("is refused when it has been cut off, when it is not the published format, or when its window is backwards", () => {
      expect(failedWeights(verifyDraw({ ...base, inputs: base.inputs.slice(0, -1) }))).toEqual(["Balance events: the text does not end with a line feed; it has probably been cut off"]);
      expect(failedWeights(verifyDraw({ ...base, inputs: "wallet weight\n" }))[0]).toMatch(/^Balance events: line 1: the first line must be "breaks:inputs:v1/);
      expect(failedWeights(verifyDraw({ ...base, inputs: base.inputs.replace("1800043200\n", "1799999999\n") }))).toEqual(["Balance events: line 1: the window must end after it starts"]);
    });

    it("is refused, naming the account and the transaction, when the history does not add up", () => {
      // The second event of a token account no longer follows from the first.
      const lines = base.inputs.split("\n");
      const at = lines.findIndex((l) => l.endsWith(",10,20"));
      lines[at] = (lines[at] as string).replace(/,10,20$/, ",10,25");
      const errors = failedWeights(verifyDraw({ ...base, inputs: lines.join("\n") }));
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/^Balance events: /);
      expect(errors[0]).toContain(name("account", 5));
      expect(errors[0]).toContain("the change does not lead to the balance");
    });

    it("never stops the list or the draw from being checked, even when the text is the most wrong it can be", () => {
      const r = ok(verifyDraw({ ...base, inputs: "x".repeat(10_000) }));
      expect(r.winners).toHaveLength(2);
      expect(r.weights?.ok).toBe(false);
    });
  });

  it("copes with a long list and a long record, and gets the same answer for any order of the lines", () => {
    const wallets = Array.from({ length: 400 }, (_, i) => name("big", i));
    const holders = wallets.map((w, i) => `${w} ${i + 1}`).join("\n");
    const lines = wallets.map((w, i) => `big-${i},${i + 10},${i + 10},${w},${name("bigacct", i)},${i + 1},${i + 1}`);
    const text = (order: string[]) => `breaks:inputs:v1,1800000000,1800043200\n${order.join("\n")}\n`;
    const a = weightsOf(verifyDraw({ ...emptyInput(), seed: base.seed, freeSpots: "0", holders, inputs: text(lines) }));
    const b = weightsOf(verifyDraw({ ...emptyInput(), seed: base.seed, freeSpots: "0", holders, inputs: text([...lines].reverse()) }));
    expect(a.check.verdict).toBe("equal");
    expect(a.check.counts.equal).toBe(400);
    expect(b.check).toEqual(a.check);
  });
});

describe("the weights section", () => {
  const render = (weights: WeightsReport) => renderToStaticMarkup(createElement(WeightsSection, { weights }));
  const html = (input: VerifyInput) => render(weightsOf(verifyDraw(input)) as WeightsReport);

  it("says every weight is the average balance, shows how it was measured, and the wallet that is not on the list", () => {
    const out = html(base);
    expect(out).toContain("Weights from the balance events");
    expect(out).toContain('<div class="verdict ok" role="status">Every one of the 6 weights on the list is its wallet&#x27;s time-weighted average balance over the window.</div>');
    expect(out).toContain("10 balance events read; the average is taken over the window from 1800000000 to 1800043200 (Unix seconds) and rounded down to a whole base unit.");
    // Nothing is shown for weights that are as they should be.
    expect(out).not.toContain("Weights that are not their wallet");
    expect(out).toContain("1 wallet has an average balance above zero but is not on the list: below the minimum, or left out on purpose. The reasons are not published yet.");
    expect(out).toContain(EXCHANGE);
    expect(out).toContain("Not on the list, biggest average balance first");
  });

  it("says a cap is the only thing that explains a weight below the average balance, and that whether one applies is still being decided", () => {
    const out = html(withWeight(1, 29));
    expect(out).toContain('class="verdict ok"');
    expect(out).toContain("No weight is above its wallet&#x27;s average balance, but 1 of 6 is below it. Only a cap on a wallet&#x27;s weight explains that, and whether a cap applies is still being decided.");
    expect(out).toContain("Weights that are not their wallet&#x27;s average balance");
    expect(out).toContain("below the average balance");
    expect(out).toContain(">29<");
    expect(out).toContain(">30<");
  });

  it("says what cannot be explained and why, and shows those wallets and no others", () => {
    const stranger = name("stranger", 0);
    const out = html({ ...withWeight(0, 11), holders: `${withWeight(0, 11).holders}\n${stranger} 7` });
    expect(out).toContain('class="verdict bad"');
    expect(out).toContain("2 of 7 weights cannot be explained by these balance events: 1 above the average balance and 1 for a wallet with no balance events.");
    expect(out).toContain("✗ above the average balance");
    expect(out).toContain("✗ no balance events");
    expect(out).toContain(">none<");
    expect(out).toContain(stranger);
    expect(out).not.toContain(name("holder", 3));
  });

  it("names only the kinds of mistake there are, and counts the wallets without balance events in the plural", () => {
    expect(html(withWeight(0, 11))).toContain("1 of 6 weights cannot be explained by these balance events: 1 above the average balance.");
    const strangers = `${base.holders}\n${name("stranger", 0)} 7\n${name("stranger", 1)} 8`;
    const out = html({ ...base, holders: strangers });
    expect(out).toContain("2 of 8 weights cannot be explained by these balance events: 2 for wallets with no balance events.");
    expect(html({ ...base, holders: `${base.holders}\n${name("stranger", 0)} 7` })).toContain("1 of 7 weights cannot be explained by these balance events: 1 for a wallet with no balance events.");
    // A below weight (a cap would explain it) is not counted among the ones that cannot be explained.
    expect(html({ ...withWeight(0, 9), holders: `${withWeight(0, 9).holders}\n${name("stranger", 0)} 7` })).toContain("1 of 7 weights cannot be explained by these balance events: 1 for a wallet with no balance events.");
  });

  it("uses the singular for one weight and one wallet, and has nothing to say about a list of nobody but who was left off", () => {
    const one = html({ ...base, holders: base.holders.split("\n").slice(0, 2).join("\n"), freeSpots: "0", paidOwners: "", cards: "" });
    expect(one).toContain("The one weight on the list is its wallet&#x27;s time-weighted average balance over the window.");
    const nobody = html({ ...base, holders: "", freeSpots: "0", paidOwners: "", cards: "" });
    expect(nobody).toContain('<div class="verdict ok" role="status">Nobody is on the list.</div>');
    expect(nobody).toContain("7 wallets have an average balance above zero but are not on the list");
    const oneEvent = render({ ok: true, window: { start: 1, end: 2 }, events: 1, check: { rows: [], counts: { equal: 0, below: 0, above: 0, "no-history": 0 }, offList: [], verdict: "equal" } });
    expect(oneEvent).toContain("1 balance event read;");
    expect(oneEvent).not.toContain("are not on the list");
    expect(oneEvent).not.toContain("is not on the list");
  });

  it("shows only the first fifty weights that are wrong and the first ten wallets that are off the list, and counts the rest", () => {
    const rows = Array.from({ length: MOST_ROWS + 5 }, (_, i) => ({ wallet: `W${i}`, weight: 9n, twab: 10n, status: "below" as const }));
    const offList = Array.from({ length: MOST_OFF_LIST + 3 }, (_, i) => ({ wallet: `O${i}`, twab: BigInt(1000 - i) }));
    const out = render({ ok: true, window: { start: 1, end: 2 }, events: 5, check: { rows, counts: { equal: 0, below: rows.length, above: 0, "no-history": 0 }, offList, verdict: "capped" } });
    expect(out.match(/<th scope="row" class="mono wrap">W\d+<\/th>/g)).toHaveLength(MOST_ROWS);
    expect(out).toContain("… and 5 more.");
    expect(out.match(/<th scope="row" class="mono wrap">O\d+<\/th>/g)).toHaveLength(MOST_OFF_LIST);
    expect(out).toContain("… and 3 more.");
    // At the limits, nothing is left over to count.
    const exact = render({ ok: true, window: { start: 1, end: 2 }, events: 5, check: { rows: rows.slice(0, MOST_ROWS), counts: { equal: 0, below: MOST_ROWS, above: 0, "no-history": 0 }, offList: offList.slice(0, MOST_OFF_LIST), verdict: "capped" } });
    expect(exact).not.toContain("more.");
  });

  it("says why the weights could not be checked, line by line, as an alert", () => {
    const out = render({ ok: false, errors: ["Balance events: line 3: the slot must be a whole number", "Balance events: line 9: an empty line"] });
    expect(out).toContain('<div class="verdict bad" role="alert">The weights could not be checked.</div>');
    expect(out).toContain("<li>Balance events: line 3: the slot must be a whole number</li>");
    expect(out).toContain("<li>Balance events: line 9: an empty line</li>");
  });

  it("shows a name from the record as text, never as markup", () => {
    const owner = "<img/src=x/onerror=alert(1)>";
    const text = `breaks:inputs:v1,1800000000,1800043200\ns,1,1,${owner},acct,5,5\n`;
    const out = html({ ...emptyInput(), seed: base.seed, freeSpots: "0", inputs: text });
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img/src=x/onerror=alert(1)&gt;");
  });

  it("is what the example shows when its hash is the one the chain would hold", () => {
    expect(toHex(hashv(utf8(base.inputs)))).toBe(inputsHash(base.inputs));
  });
});
