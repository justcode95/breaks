import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { INPUTS_HEADER, inputsHash, parseInputs } from "../lib/twab/inputs";

const HEAD = "breaks:inputs:v1,1000,2000\n";
const LINE = "5Kq1sig,123,1500,OwnerWallet111,TokenAcct111,100,100\n";
const errorsOf = (text: string): string[] => {
  const r = parseInputs(text);
  if (r.ok) throw new Error("accepted");
  return r.errors;
};

describe("the inputs hash", () => {
  it("is the SHA-256 of the text, which is what the chain holds", () => {
    for (const text of [HEAD, HEAD + LINE, "breaks:inputs:v1,1,2\n", "é\n"]) {
      expect(inputsHash(text)).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
    }
    expect(inputsHash(HEAD)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes with a single character, and with the final line feed", () => {
    expect(inputsHash(HEAD + LINE)).not.toBe(inputsHash(HEAD + LINE.replace("100,100", "100,101")));
    expect(inputsHash(HEAD)).not.toBe(inputsHash(HEAD.trimEnd()));
  });
});

describe("reading the text", () => {
  it("reads the window and every event, with amounts as exact numbers", () => {
    const r = parseInputs(HEAD + LINE + "sig2,124,1501,Owner2,Acct2,-18446744073709551615,0\nsig3,125,1502,Owner2,Acct3,0,18446744073709551615\n");
    expect(r).toEqual({
      ok: true,
      window: { start: 1000, end: 2000 },
      events: [
        { signature: "5Kq1sig", slot: 123n, time: 1500, owner: "OwnerWallet111", tokenAccount: "TokenAcct111", delta: 100n, balanceAfter: 100n },
        { signature: "sig2", slot: 124n, time: 1501, owner: "Owner2", tokenAccount: "Acct2", delta: -18446744073709551615n, balanceAfter: 0n },
        { signature: "sig3", slot: 125n, time: 1502, owner: "Owner2", tokenAccount: "Acct3", delta: 0n, balanceAfter: 18446744073709551615n },
      ],
    });
    expect(INPUTS_HEADER).toBe("breaks:inputs:v1");
  });

  it("reads a record with no events: a window and nothing else", () => {
    expect(parseInputs(HEAD)).toEqual({ ok: true, window: { start: 1000, end: 2000 }, events: [] });
  });

  it("does not mind the order of the events: the TWAB puts them in order, and the hash ties the text to the chain", () => {
    const a = "s1,1,1100,O,A,5,5\n";
    const b = "s2,2,1200,O,A,5,10\n";
    expect(parseInputs(HEAD + b + a)).toMatchObject({ ok: true });
    expect((parseInputs(HEAD + b + a) as { events: unknown[] }).events).toHaveLength(2);
  });
});

describe("a text that is not the record is refused, by line", () => {
  it("an empty text, carriage returns, and a text that was cut off", () => {
    expect(errorsOf("")).toEqual(["the text is empty"]);
    expect(errorsOf(HEAD.replace("\n", "\r\n") + LINE)[0]).toMatch(/carriage returns/);
    expect(errorsOf(HEAD + LINE.slice(0, -1))[0]).toMatch(/does not end with a line feed.*cut off/);
    expect(errorsOf("breaks:inputs:v1,1000,2000")[0]).toMatch(/does not end with a line feed/);
  });

  it("a header that is not the header: name, version, window", () => {
    for (const head of ["", "breaks:inputs:v2,1000,2000", "inputs:v1,1000,2000", "breaks:inputs:v1,1000", "breaks:inputs:v1,1000,2000,3", "breaks:inputs:v1,01000,2000", "breaks:inputs:v1,1000,2e3", "breaks:inputs:v1,-1,2000", "breaks:inputs:v1, 1000,2000"]) {
      const errors = errorsOf(head + "\n" + LINE);
      expect(errors[0], head).toMatch(/^line 1: the first line must be "breaks:inputs:v1,<window start>,<window end>"/);
    }
  });

  it("a window that does not end after it starts, or that is not a usable time", () => {
    expect(errorsOf("breaks:inputs:v1,2000,2000\n")).toEqual(["line 1: the window must end after it starts"]);
    expect(errorsOf("breaks:inputs:v1,2000,1000\n")).toEqual(["line 1: the window must end after it starts"]);
    expect(errorsOf("breaks:inputs:v1,1000,99999999999999999999\n")).toEqual(["line 1: the window is not a usable time"]);
  });

  it("an event with too few or too many fields, and an empty line, with the line number", () => {
    expect(errorsOf(HEAD + LINE + "a,b,c\n")).toEqual(["line 3: an event has 7 fields separated by commas, this has 3"]);
    expect(errorsOf(HEAD + "a,1,2,o,t,3,4,5\n")).toEqual(["line 2: an event has 7 fields separated by commas, this has 8"]);
    expect(errorsOf(HEAD + LINE + "\n" + LINE)).toEqual(["line 3: an empty line"]);
  });

  it("names that are empty or contain spaces", () => {
    expect(errorsOf(HEAD + ",1,1500,O,A,1,1\n")).toEqual(["line 2: the signature must be a name without spaces or commas"]);
    expect(errorsOf(HEAD + "s,1,1500,,A,1,1\n")).toEqual(["line 2: the owner must be a name without spaces or commas"]);
    expect(errorsOf(HEAD + "s,1,1500,O,A B,1,1\n")).toEqual(["line 2: the token account must be a name without spaces or commas"]);
    expect(errorsOf(HEAD + "s s,1,1500,O,A,1,1\n")).toEqual(["line 2: the signature must be a name without spaces or commas"]);
  });

  it("a slot or a time that is not a whole number", () => {
    for (const slot of ["", "-1", "1.5", "01", "1e3", "abc", " 1"]) expect(errorsOf(HEAD + `s,${slot},1500,O,A,1,1\n`), slot).toEqual(["line 2: the slot must be a whole number"]);
    for (const time of ["", "-1", "1.5", "01", "x", "99999999999999999999"]) expect(errorsOf(HEAD + `s,1,${time},O,A,1,1\n`), time).toEqual(["line 2: the time must be whole seconds"]);
  });

  it("a change or a balance that is not a whole number of base units, or does not fit in a u64", () => {
    const delta = "line 2: the change must be a whole number of base units (a u64 at most, with a minus sign for a withdrawal)";
    for (const d of ["", "+5", "05", "-0", "-05", "1.5", "x", "18446744073709551616", "-18446744073709551616"]) expect(errorsOf(HEAD + `s,1,1500,O,A,${d},1\n`), d).toEqual([delta]);
    const balance = "line 2: the balance must be a whole number of base units, a u64 at most";
    for (const b of ["", "-1", "01", "1.5", "x", "18446744073709551616"]) expect(errorsOf(HEAD + `s,1,1500,O,A,1,${b}\n`), b).toEqual([balance]);
    expect(parseInputs(HEAD + "s,1,1500,O,A,0,0\n").ok).toBe(true);
    expect(parseInputs(HEAD + "s,1,1500,O,A,-18446744073709551615,18446744073709551615\n").ok).toBe(true);
  });

  it("reports every problem on a line, and the problems of several lines, not just the first", () => {
    expect(errorsOf(HEAD + "s,x,y,O,A,z,w\n" + LINE + "t,1,1500,O,A,1\n")).toEqual([
      "line 2: the slot must be a whole number",
      "line 2: the time must be whole seconds",
      expect.stringContaining("line 2: the change must be a whole number"),
      expect.stringContaining("line 2: the balance must be a whole number"),
      "line 4: an event has 7 fields separated by commas, this has 6",
    ]);
  });

  it("stops at twenty problems and says there may be more", () => {
    const errors = errorsOf(HEAD + "bad\n".repeat(30));
    expect(errors).toHaveLength(21);
    expect(errors[19]).toBe("line 21: an event has 7 fields separated by commas, this has 1");
    expect(errors[20]).toBe("there may be more problems after these");
    // Exactly twenty problems is still reported as such.
    expect(errorsOf(HEAD + "bad\n".repeat(19))).toHaveLength(19);
  });

  it("returns nothing at all when any line is wrong: no half-read record", () => {
    const r = parseInputs(HEAD + LINE + "broken\n" + LINE);
    expect(r.ok).toBe(false);
    expect("events" in r).toBe(false);
  });
});
