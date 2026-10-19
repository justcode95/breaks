import { describe, expect, it } from "vitest";
import { compareBytes } from "../src/draw/bytes.js";
import { checkExclusions, exclusionProblem, exclusionsDocument, parseExclusions } from "../src/eligibility/exclusions.js";
import type { EligibilityRecord } from "../src/publish/record.js";
import { addressFromBytes, addressToBytes } from "../src/solana/pubkey.js";
import { addr } from "./support/chain.js";

const HASH = "ab".repeat(32);

describe("a row of the exclusion list", () => {
  it("can go out when it is an address with a short code", () => {
    for (const code of ["team", "lp_pool", "exchange.binance", "bundle-7", "A".repeat(64), "x"]) expect(exclusionProblem(addr(1), code), code).toBeUndefined();
  });

  it("cannot when the wallet is not a Solana address", () => {
    for (const wallet of ["", "not a wallet", "0OIl", addressFromBytes(new Uint8Array(32)).slice(1), `1${addr(1)}`]) {
      expect(exclusionProblem(wallet, "team"), wallet).toBe(`${JSON.stringify(wallet)} is not a Solana address`);
    }
  });

  it("cannot when the code is not 1 to 64 letters, digits, _, . or -: it is shown to people as it is", () => {
    for (const code of ["", "A".repeat(65), "has space", "<b>", "team\n", "équipe", "a/b"]) {
      expect(exclusionProblem(addr(1), code), code).toBe(`the code of ${addr(1)}, ${JSON.stringify(code)}, is not 1 to 64 letters, digits, "_", "." or "-"`);
    }
  });
});

describe("the exclusion list document", () => {
  // addr(1) and addr(15) sort one way by their text and the other by their bytes: the list goes by the bytes.
  const list = new Map([[addr(15), "team"], [addr(1), "exchange"], [addr(2), "lp_pool"]]);
  const sorted = [...list.keys()].sort((a, b) => compareBytes(addressToBytes(a), addressToBytes(b)));

  it("is sorted by the wallets' bytes, which here is not the order of their text", () => {
    expect(sorted).not.toEqual([...list.keys()].sort());
  });

  it("pins its bytes: compact, the inputs hash, every wallet with its code sorted by the wallets' bytes, a newline at the end", () => {
    const body = exclusionsDocument(HASH, list);
    expect(body).toBe(`{"version":1,"kind":"exclusions","inputsHash":"${HASH}","entries":[${sorted.map((w) => `{"wallet":"${w}","code":"${list.get(w)}"}`).join(",")}]}\n`);
    expect(exclusionsDocument(new Uint8Array(32).fill(0xab), list)).toBe(body);
    expect(exclusionsDocument(HASH, new Map())).toBe(`{"version":1,"kind":"exclusions","inputsHash":"${HASH}","entries":[]}\n`);
  });

  it("reads back what it wrote, whatever order the rows came in", () => {
    const body = exclusionsDocument(HASH, new Map([...list].reverse()));
    expect(body).toBe(exclusionsDocument(HASH, list));
    expect(parseExclusions(body)).toEqual({ inputsHash: HASH, entries: sorted.map((wallet) => ({ wallet, code: list.get(wallet) })) });
    expect(parseExclusions(exclusionsDocument(HASH, new Map()))).toEqual({ inputsHash: HASH, entries: [] });
  });

  it("refuses anything the keeper would not have written, saying what", () => {
    const good = JSON.parse(exclusionsDocument(HASH, list));
    const text = (doc: unknown) => `${JSON.stringify(doc)}\n`;
    const cases: [string, string, string][] = [
      ["not JSON", "{", "is not JSON"],
      ["a list", "[]\n", "not an exclusion list of version 1"],
      ["another version", text({ ...good, version: 2 }), "not an exclusion list of version 1"],
      ["another kind", text({ ...good, kind: "record" }), "not an exclusion list of version 1"],
      ["no hash", text({ ...good, inputsHash: undefined }), "no valid inputs hash"],
      ["an upper-case hash", text({ ...good, inputsHash: HASH.toUpperCase() }), "no valid inputs hash"],
      ["no entries", text({ ...good, entries: {} }), "has no entries"],
      ["an entry with more", text({ ...good, entries: [{ ...good.entries[0], note: "x" }] }), "entry 1 of the stored exclusion list is not a wallet and a code"],
      ["an entry without a code", text({ ...good, entries: [{ wallet: addr(1) }] }), "entry 1 of the stored exclusion list is not a wallet and a code"],
      ["a code that is a number", text({ ...good, entries: [{ wallet: addr(1), code: 7 }] }), "entry 1 of the stored exclusion list is not a wallet and a code"],
      ["a bad wallet", text({ ...good, entries: [{ wallet: "nope", code: "team" }] }), 'entry 1 of the stored exclusion list: "nope" is not a Solana address'],
      ["a bad code", text({ ...good, entries: [good.entries[0], { wallet: good.entries[1].wallet, code: "<b>" }] }), "entry 2 of the stored exclusion list: the code of"],
      ["out of order", text({ ...good, entries: [good.entries[1], good.entries[0], good.entries[2]] }), "not sorted by wallet, or has a wallet twice (entry 2)"],
      ["a wallet twice", text({ ...good, entries: [good.entries[0], good.entries[0]] }), "not sorted by wallet, or has a wallet twice (entry 2)"],
      ["pretty-printed", `${JSON.stringify(good, null, 2)}\n`, "not written the way the keeper writes it"],
      ["no newline at the end", JSON.stringify(good), "not written the way the keeper writes it"],
      ["keys in another order", `{"kind":"exclusions","version":1,"inputsHash":"${HASH}","entries":[]}\n`, "not written the way the keeper writes it"],
    ];
    for (const [what, body, message] of cases) expect(() => parseExclusions(body), what).toThrow(message);
  });
});

describe("whether a list is the one a record was made with", () => {
  const record = (rows: [number, string | null][]): EligibilityRecord => ({
    inputsHash: HASH,
    root: "cd".repeat(32),
    totalWeight: 1n,
    entryCount: 1,
    window: { start: 1, end: 2 },
    policy: { minTwab: 1n },
    wallets: rows.map(([n, reason]) => ({ wallet: addr(n), twab: 5n, weight: reason === null ? 5n : 0n, reason })),
  });
  const list = (rows: [number, string][], inputsHash = HASH) => ({ inputsHash, entries: rows.map(([n, code]) => ({ wallet: addr(n), code })) });
  const r = record([[1, null], [2, "excluded:team"], [3, "below_min_twab"], [4, "off_curve"]]);

  it("is, when it names exactly the record's excluded wallets with their codes, and maybe wallets that held nothing", () => {
    expect(() => checkExclusions(list([[2, "team"]]), r)).not.toThrow();
    expect(() => checkExclusions(list([[2, "team"], [50, "exchange"], [51, "bundle"]]), r)).not.toThrow();
    expect(() => checkExclusions(list([]), record([[1, null]]))).not.toThrow();
    expect(() => checkExclusions(list([[50, "team"]]), record([]))).not.toThrow();
  });

  it("is not, when it leaves out a wallet the record excludes", () => {
    expect(() => checkExclusions(list([[50, "exchange"]]), r)).toThrow(`the record leaves ${addr(2)} out as "team", but the stored exclusion list does not name it`);
  });

  it("is not, when it names a wallet that held the token and that the record does not exclude, whatever its reason", () => {
    for (const n of [1, 3, 4]) {
      expect(() => checkExclusions(list([[2, "team"], [n, "exchange"]]), r), `${n}`).toThrow(`the stored exclusion list names ${addr(n)} ("exchange"), but the record does not leave it out`);
    }
  });

  it("is not, when it gives a wallet another code", () => {
    expect(() => checkExclusions(list([[2, "exchange"]]), r)).toThrow(`the stored exclusion list gives ${addr(2)} the code "exchange", but the record says "team"`);
  });

  it("is not, when it is for another list", () => {
    expect(() => checkExclusions(list([[2, "team"]], "ef".repeat(32)), r)).toThrow(`the stored exclusion list is for inputs hash ${"ef".repeat(32)}, not the ${HASH} of its record`);
  });
});
