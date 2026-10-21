import { describe, expect, it } from "vitest";
import { LogAlerter, TELEGRAM_CHAT, TELEGRAM_TOKEN, TelegramAlerter } from "../src/watch/alerter.js";
import { logger } from "./support/world.js";

const TOKEN = "123456789:AAH-secret_token_value_0123456789";

/** A fake `fetch` that records the request and answers what the test says. */
function fakeFetch(answer: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return answer();
  }) as typeof fetch;
  return { calls, fetchFn };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("TelegramAlerter", () => {
  it("posts the text, as plain text, to sendMessage of the bot, with a sound only when it is urgent", async () => {
    const f = fakeFetch(() => json(200, { ok: true, result: { message_id: 7 } }));
    const t = new TelegramAlerter({ token: TOKEN, chatId: "-1001234567890", fetch: f.fetchFn });
    await t.send({ text: "Break #7 is stuck", urgent: true });
    await t.send({ text: "cleared", urgent: false });
    expect(f.calls.map((c) => c.url)).toEqual([`https://api.telegram.org/bot${TOKEN}/sendMessage`, `https://api.telegram.org/bot${TOKEN}/sendMessage`]);
    expect(f.calls[0]?.init.method).toBe("POST");
    expect(f.calls[0]?.init.headers).toEqual({ "content-type": "application/json" });
    expect(f.calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(f.calls[0]?.init.body))).toEqual({ chat_id: "-1001234567890", text: "Break #7 is stuck", disable_web_page_preview: true, disable_notification: false });
    expect(JSON.parse(String(f.calls[1]?.init.body))).toMatchObject({ disable_notification: true });
    // No parse_mode: nothing in an alert (an error message, a machine label) can turn into markup or a link.
    expect(JSON.parse(String(f.calls[0]?.init.body))).not.toHaveProperty("parse_mode");
  });

  it("uses another server when told (one slash or many at the end)", async () => {
    const f = fakeFetch(() => json(200, { ok: true }));
    await new TelegramAlerter({ token: TOKEN, chatId: "@breaks_alerts", baseUrl: "http://127.0.0.1:9/", fetch: f.fetchFn }).send({ text: "x", urgent: false });
    expect(f.calls[0]?.url).toBe(`http://127.0.0.1:9/bot${TOKEN}/sendMessage`);
  });

  it("throws, with Telegram's reason and without the token, when the message was not taken", async () => {
    const cases: [Response, string][] = [
      [json(401, { ok: false, error_code: 401, description: "Unauthorized" }), "Telegram did not take the message (401): Unauthorized"],
      [json(400, { ok: false, description: "Bad Request: chat not found" }), "Telegram did not take the message (400): Bad Request: chat not found"],
      [json(429, { ok: false, description: "Too Many Requests: retry after 5", parameters: { retry_after: 5 } }), "Telegram did not take the message (429): Too Many Requests: retry after 5"],
      [json(200, { ok: false, description: "odd" }), "Telegram did not take the message (200): odd"],
      [new Response("<html>bad gateway</html>", { status: 502 }), "Telegram did not take the message (502): <html>bad gateway</html>"],
      [new Response("", { status: 503 }), "Telegram did not take the message (503)"],
      [json(500, { ok: false, description: `the url was /bot${TOKEN}/sendMessage` }), "Telegram did not take the message (500): the url was /bot[hidden]/sendMessage"],
    ];
    for (const [answer, reason] of cases) {
      const t = new TelegramAlerter({ token: TOKEN, chatId: "42", fetch: fakeFetch(() => answer).fetchFn });
      await expect(t.send({ text: "x", urgent: true })).rejects.toThrow(reason);
    }
    const long = new TelegramAlerter({ token: TOKEN, chatId: "42", fetch: fakeFetch(() => json(400, { description: `a\n\n${"b".repeat(500)}` })).fetchFn });
    await expect(long.send({ text: "x", urgent: true })).rejects.toThrow(/\(400\): a b{198}$/);
  });

  it("throws when Telegram cannot be reached, hiding the token if the error repeats the address", async () => {
    const t = new TelegramAlerter({
      token: TOKEN,
      chatId: "42",
      fetch: (async (url: string) => {
        throw new Error(`request to ${url} failed: ECONNREFUSED`);
      }) as unknown as typeof fetch,
    });
    const err = await t.send({ text: "x", urgent: true }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("no answer from Telegram: request to https://api.telegram.org/bot[hidden]/sendMessage failed: ECONNREFUSED");
  });

  it("refuses a token or a chat that cannot be one, without repeating the token", () => {
    const bad = "no-number-XYZZY-0123456789abcdef";
    expect(() => new TelegramAlerter({ token: bad, chatId: "42" })).toThrow(/not in the form BotFather gives/);
    expect(() => new TelegramAlerter({ token: bad, chatId: "42" })).not.toThrow(/XYZZY/);
    expect(() => new TelegramAlerter({ token: TOKEN, chatId: "my chat" })).toThrow(/not a chat number or an @name/);
  });
});

describe("the token and chat patterns", () => {
  it("accept what BotFather and Telegram give and nothing else", () => {
    expect(TELEGRAM_TOKEN.test(TOKEN)).toBe(true);
    expect(TELEGRAM_TOKEN.test("1:abcdefghijklmnopqrst")).toBe(true);
    for (const bad of ["", ":abcdefghijklmnopqrst", "1:short", "1:abc def ghi jkl mno pqr", "abc:abcdefghijklmnopqrst", `1:${"a".repeat(101)}`, `${TOKEN}\n`]) {
      expect(TELEGRAM_TOKEN.test(bad), bad).toBe(false);
    }
    for (const good of ["42", "-1001234567890", "@breaks", "@a2345", `@a${"b".repeat(31)}`]) expect(TELEGRAM_CHAT.test(good), good).toBe(true);
    for (const bad of ["", "-", "@abcd", "@1abcd", "@has space", `@a${"b".repeat(32)}`, "4 2", "1.5", "42\n"]) expect(TELEGRAM_CHAT.test(bad), bad).toBe(false);
  });
});

describe("LogAlerter", () => {
  it("writes an urgent message as an error line and the rest as info lines", async () => {
    const lines: [string, string, unknown][] = [];
    const log = { info: (m: string, e?: unknown) => lines.push(["info", m, e]), error: (m: string, e?: unknown) => lines.push(["error", m, e]) };
    const alerter = new LogAlerter(log);
    await alerter.send({ text: "new problem", urgent: true });
    await alerter.send({ text: "cleared", urgent: false });
    expect(lines).toEqual([
      ["error", "watchdog", { message: "new problem" }],
      ["info", "watchdog", { message: "cleared" }],
    ]);
    expect(alerter.name).toBe("log");
    expect(logger().errors).toEqual([]);
  });
});
