import { describe, expect, it } from "vitest";
import { main } from "../src/watch/test-alert.js";

const TOKEN = "123456789:AAH-secret_token_value_0123456789";
const BEAT = "https://hc.example/ping/HEARTBEAT-key-0123456789abcdef";
const telegramEnv = { ALERTS: "telegram", ALERT_TELEGRAM_BOT_TOKEN: TOKEN, ALERT_TELEGRAM_CHAT_ID: "-100200" };

function fakeFetch(answer: () => Response | Promise<Response>) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return answer();
  }) as typeof fetch;
  return { calls, fetchFn };
}
const ok = () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });

describe("send-test-alert", () => {
  it("sends one test message to the chat, with a sound, and only that", async () => {
    const f = fakeFetch(ok);
    const r = await main([], { env: { ...telegramEnv, ALERT_HEARTBEAT_URL: BEAT }, fetch: f.fetchFn });
    expect(r).toEqual({
      code: 0,
      out: "Telegram took the test message for the chat -100200: look for it there.\nThe outside check (ALERT_HEARTBEAT_URL) is set; it was not pinged, since a ping says the keeper is running.",
    });
    expect(f.calls).toEqual([
      {
        url: `https://api.telegram.org/bot${TOKEN}/sendMessage`,
        body: {
          chat_id: "-100200",
          text: "BREAKS keeper on devnet: a test message from send-test-alert. If you can read this, the watchdog's alerts reach this chat.",
          disable_web_page_preview: true,
          disable_notification: false,
        },
      },
    ]);
  });

  it("names the cluster and says when no outside check is set", async () => {
    const f = fakeFetch(ok);
    const r = await main(["--"], { env: { ...telegramEnv, SOLANA_CLUSTER: "localnet" }, fetch: f.fetchFn, telegramBase: "http://127.0.0.1:9" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("No outside check is set (ALERT_HEARTBEAT_URL): nobody is told if the keeper itself stops.");
    expect(f.calls[0]?.url).toBe(`http://127.0.0.1:9/bot${TOKEN}/sendMessage`);
    expect(f.calls[0]?.body.text).toBe("BREAKS keeper on localnet: a test message from send-test-alert. If you can read this, the watchdog's alerts reach this chat.");
  });

  it("says why Telegram did not take it, without the token, and exits 1", async () => {
    const refused = await main([], { env: telegramEnv, fetch: fakeFetch(() => new Response(JSON.stringify({ ok: false, description: "Bad Request: chat not found" }), { status: 400 })).fetchFn });
    expect(refused).toEqual({
      code: 1,
      out: "The test message did not reach the chat -100200: Telegram did not take the message (400): Bad Request: chat not found\nCheck the token with @BotFather, and that the bot was started in that chat (or added to the group).\nNo outside check is set (ALERT_HEARTBEAT_URL): nobody is told if the keeper itself stops.",
    });
    const unreachable = await main([], {
      env: telegramEnv,
      fetch: (async (url: string) => {
        throw new Error(`request to ${url} failed`);
      }) as unknown as typeof fetch,
    });
    expect(unreachable.code).toBe(1);
    expect(unreachable.out).toContain("no answer from Telegram: request to https://api.telegram.org/bot[hidden]/sendMessage failed");
    expect(unreachable.out).not.toContain(TOKEN);
  });

  it("has nothing to send to when alerts only go to the log, and exits 2", async () => {
    const f = fakeFetch(ok);
    const r = await main([], { env: { ALERT_HEARTBEAT_URL: BEAT }, fetch: f.fetchFn });
    expect(r.code).toBe(2);
    expect(r.out).toBe(
      "Alerts only go to the keeper's log (ALERTS=log), so there is no chat to send a test to. Set ALERTS=telegram with ALERT_TELEGRAM_BOT_TOKEN and ALERT_TELEGRAM_CHAT_ID (keeper/.env.example).\nThe outside check (ALERT_HEARTBEAT_URL) is set; it was not pinged, since a ping says the keeper is running.",
    );
    expect(f.calls).toEqual([]);
  });

  it("refuses settings it cannot read, without repeating a secret, and exits 2", async () => {
    const f = fakeFetch(ok);
    const r = await main([], { env: { ALERTS: "telegram", ALERT_TELEGRAM_CHAT_ID: TOKEN, ALERT_HEARTBEAT_URL: "http://hc.example/ping/HEARTBEAT-key-0123456789abcdef" }, fetch: f.fetchFn });
    expect(r.code).toBe(2);
    expect(r.out).toBe(
      [
        "The watchdog's settings cannot be read:",
        "  ALERT_TELEGRAM_CHAT_ID: must be a chat's number (a group's is negative) or a public channel's @name",
        "  ALERT_HEARTBEAT_URL: must be an https:// address (or http:// to this machine)",
        "  ALERT_TELEGRAM_BOT_TOKEN: is required when ALERTS=telegram",
      ].join("\n"),
    );
    expect(f.calls).toEqual([]);
  });

  it("reads only the watchdog's settings: the rest of the keeper's need not be there", async () => {
    const r = await main([], { env: { ...telegramEnv, DATABASE_URL: undefined, TOKEN_MINT: undefined }, fetch: fakeFetch(ok).fetchFn });
    expect(r.code).toBe(0);
  });

  it("has a help text and refuses other arguments", async () => {
    const help = await main(["--help"], { env: {} });
    expect(help.code).toBe(0);
    expect(help.out).toContain("usage: pnpm --filter keeper send-test-alert");
    expect((await main(["-h"], { env: {} })).code).toBe(0);
    const bad = await main(["--send"], { env: telegramEnv });
    expect(bad.code).toBe(2);
    expect(bad.out.startsWith("unknown argument --send\n")).toBe(true);
  });
});
