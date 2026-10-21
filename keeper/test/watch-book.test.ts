import { describe, expect, it } from "vitest";
import { AlertBook, MAX_LINE, MIN_MESSAGE } from "../src/watch/book.js";

const HOUR = 3_600_000;
const T0 = 1_800_000_000_000;
const at = (ms: number) => new Date(T0 + ms);
const a = (key: string, text = `${key} is wrong`) => ({ key, text });

/** A book that has already greeted its channel, so a test sees only what it is about. */
function book(repeatMs = 12 * HOUR, maxChars?: number) {
  const b = new AlertBook({ title: "BREAKS keeper on devnet", repeatMs, ...(maxChars !== undefined ? { maxChars } : {}) });
  const hello = b.message(at(0));
  if (hello) b.delivered(hello, at(0));
  return b;
}

/** Updates, writes and delivers; returns the text (or undefined when there was nothing to say). */
function step(b: AlertBook, alerts: { key: string; text: string }[], t: number): string | undefined {
  b.update(alerts);
  const out = b.message(at(t));
  if (out) b.delivered(out, at(t));
  return out?.text;
}

describe("AlertBook", () => {
  it("greets once, quietly, with what it will do", () => {
    const b = new AlertBook({ title: "BREAKS keeper on devnet", repeatMs: HOUR });
    b.update([]);
    const out = b.message(at(0));
    expect(out).toMatchObject({ urgent: false, greeting: true, text: "BREAKS keeper on devnet started. A problem that lasts is reported here once, and again when it clears." });
    b.delivered(out!, at(0));
    expect(b.message(at(1))).toBeUndefined();
  });

  it("puts the first problems into the greeting", () => {
    const b = new AlertBook({ title: "T", repeatMs: HOUR });
    b.update([a("x")]);
    expect(b.message(at(0))).toMatchObject({
      urgent: true,
      text: "T: 1 new problem.\nT started. A problem that lasts is reported here once, and again when it clears.\nNew:\n• x is wrong",
    });
  });

  it("tells a new problem once, urgently, and not again while it stays, even as its words change", () => {
    const b = book();
    b.update([a("job:pipeline", "failed for 15 min")]);
    const out = b.message(at(1));
    expect(out).toMatchObject({ urgent: true, opened: ["job:pipeline"], text: "BREAKS keeper on devnet: 1 new problem.\nNew:\n• failed for 15 min" });
    b.delivered(out!, at(1));
    expect(step(b, [a("job:pipeline", "failed for 16 min")], 2)).toBeUndefined();
  });

  it("tells a cleared problem once, quietly, with the last words it had", () => {
    const b = book();
    step(b, [a("k", "first words")], 1);
    step(b, [a("k", "last words")], 2);
    b.update([]);
    const out = b.message(at(3));
    expect(out).toMatchObject({ urgent: false, cleared: ["k"], text: "BREAKS keeper on devnet: 1 cleared.\nCleared:\n• last words" });
    b.delivered(out!, at(3));
    expect(step(b, [], 4)).toBeUndefined();
  });

  it("says nothing about a problem that cleared before it was told", () => {
    const b = book();
    b.update([a("k")]); // the message is not delivered
    expect(step(b, [], 1)).toBeUndefined();
  });

  it("writes an undelivered message again next time, with what is true by then", () => {
    const b = book();
    b.update([a("one", "one, 15 min")]);
    expect(b.message(at(1))?.text).toContain("one, 15 min");
    // Not delivered. The next run finds a second problem and newer words.
    b.update([a("one", "one, 16 min"), a("two")]);
    const out = b.message(at(2));
    expect(out?.text).toBe("BREAKS keeper on devnet: 2 new problems.\nNew:\n• one, 16 min\n• two is wrong");
    b.delivered(out!, at(2));
    expect(b.message(at(3))).toBeUndefined();
  });

  it("keeps a clearing that was not delivered, and treats a problem back before then as still open", () => {
    const b = book();
    step(b, [a("k")], 1);
    b.update([]);
    expect(b.message(at(2))?.cleared).toEqual(["k"]); // not delivered
    expect(step(b, [a("k", "back again")], 3)).toBeUndefined();
    // It is still open, and its clearing comes when it really clears.
    expect(step(b, [], 4)).toBe("BREAKS keeper on devnet: 1 cleared.\nCleared:\n• back again");
  });

  it("puts new and cleared problems in one message", () => {
    const b = book();
    step(b, [a("old")], 1);
    expect(step(b, [a("new1"), a("new2")], 2)).toBe(
      "BREAKS keeper on devnet: 2 new problems, 1 cleared.\nNew:\n• new1 is wrong\n• new2 is wrong\nCleared:\n• old is wrong",
    );
  });

  it("lists what stays open again after the repeat time, and then waits the repeat time again", () => {
    const b = book(12 * HOUR);
    step(b, [a("k", "still wrong")], 0);
    expect(step(b, [a("k", "still wrong")], 12 * HOUR - 1)).toBeUndefined();
    b.update([a("k", "still wrong, longer")]);
    const out = b.message(at(12 * HOUR));
    expect(out).toMatchObject({ urgent: false, reminder: true, text: "BREAKS keeper on devnet: 1 still open.\nStill open:\n• still wrong, longer" });
    b.delivered(out!, at(12 * HOUR));
    expect(step(b, [a("k")], 24 * HOUR - 1)).toBeUndefined();
    expect(step(b, [a("k")], 24 * HOUR)).toContain("Still open:");
  });

  it("starts the repeat time again when something new is told, and lists every open problem then", () => {
    const b = book(12 * HOUR);
    step(b, [a("one")], 0);
    step(b, [a("one"), a("two")], 6 * HOUR);
    expect(step(b, [a("one"), a("two")], 12 * HOUR)).toBeUndefined();
    expect(step(b, [a("one"), a("two")], 18 * HOUR)).toBe("BREAKS keeper on devnet: 2 still open.\nStill open:\n• one is wrong\n• two is wrong");
  });

  it("lists only what the channel already knows as still open, when a reminder comes with something new", () => {
    const b = book(12 * HOUR);
    step(b, [a("old")], 0);
    expect(step(b, [a("old"), a("new")], 12 * HOUR)).toBe(
      "BREAKS keeper on devnet: 1 new problem, 1 still open.\nNew:\n• new is wrong\nStill open:\n• old is wrong",
    );
  });

  it("keeps reminding of a problem that came back before its clearing was told", () => {
    const b = book(12 * HOUR);
    step(b, [a("k")], 0);
    b.update([]);
    expect(b.message(at(1))?.cleared).toEqual(["k"]); // not delivered
    b.update([a("k")]);
    expect(b.message(at(2))).toBeUndefined();
    expect(step(b, [a("k")], 12 * HOUR)).toBe("BREAKS keeper on devnet: 1 still open.\nStill open:\n• k is wrong");
  });

  it("fits about 4,000 characters in a message by default", () => {
    const b = book();
    b.update(Array.from({ length: 36 }, (_, i) => a(`k${i}`, `${String(i).padStart(2, "0")} ${"w".repeat(100)}`)));
    const out = b.message(at(1))!;
    expect(out.opened).toHaveLength(36);
    expect(out.text.length).toBeGreaterThan(3_700);
    expect(out.text.length).toBeLessThanOrEqual(4_000);
    b.update(Array.from({ length: 40 }, (_, i) => a(`k${i}`, `${String(i).padStart(2, "0")} ${"w".repeat(100)}`)));
    expect(b.message(at(2))!.text).toMatch(/…and \d+ more, in the next message\.$/);
  });

  it("never goes over its size, with the line that says how many more there are, whatever the length of the lines", () => {
    for (let len = 10; len <= MAX_LINE; len += 7) {
      const b = book(HOUR, MIN_MESSAGE);
      b.update(Array.from({ length: 40 }, (_, i) => a(`k${i}`, "z".repeat(len))));
      const out = b.message(at(1))!;
      expect(out.text.length, `lines of ${len}`).toBeLessThanOrEqual(MIN_MESSAGE);
      expect(out.opened.length, `lines of ${len}`).toBeGreaterThan(0);
    }
  });

  it("never repeats with a repeat time of 0, and has nothing to repeat once everything cleared", () => {
    const never = book(0);
    step(never, [a("k")], 0);
    expect(step(never, [a("k")], 1000 * HOUR)).toBeUndefined();
    const b = book(HOUR);
    step(b, [a("k")], 0);
    step(b, [], 1);
    step(b, [a("other")], 2);
    step(b, [], 3);
    expect(step(b, [], 10 * HOUR)).toBeUndefined();
  });

  it("cuts a long line, keeps a message under its size, and sends what did not fit next time", () => {
    const b = book(HOUR, MIN_MESSAGE);
    const long = "x".repeat(2 * MAX_LINE);
    b.update([...Array.from({ length: 20 }, (_, i) => a(`k${i}`, `problem number ${i} with some words`)), a("long", long)]);
    const first = b.message(at(1))!;
    expect(first.text.length).toBeLessThanOrEqual(MIN_MESSAGE);
    expect(first.text).toMatch(/…and \d+ more, in the next message\.$/);
    expect(first.text).not.toContain(long);
    b.delivered(first, at(1));
    const told = new Set(first.opened);
    let rest = first.text;
    for (let t = 2; t < 30; t++) {
      const out = b.message(at(t));
      if (!out) break;
      expect(out.text.length).toBeLessThanOrEqual(MIN_MESSAGE);
      out.opened.forEach((k) => told.add(k));
      rest += out.text;
      b.delivered(out, at(t));
    }
    expect(told.size).toBe(21);
    expect(rest).toContain("problem number 19");
    expect(rest).toContain(`• ${"x".repeat(MAX_LINE - 1)}…`);
    expect(() => new AlertBook({ title: "T", repeatMs: 0, maxChars: MIN_MESSAGE - 1 })).toThrow(/at least 1000/);

    const wide = book(HOUR);
    wide.update([a("long", long)]);
    const line = wide.message(at(1))!.text.split("\n").at(-1)!;
    expect(line).toBe(`• ${"x".repeat(MAX_LINE - 1)}…`);
  });
});
