import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramAlerter } from "../src/watch/alerter.js";
import { HttpHeartbeat } from "../src/watch/heartbeat.js";

const URL_ = "https://hc.example/ping/5f1e2d3c-0123-4567-89ab-cdef01234567";

function fakeFetch(answer: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return answer();
  }) as typeof fetch;
  return { calls, fetchFn };
}

describe("HttpHeartbeat", () => {
  it("pings with a plain GET of the address, with a time limit", async () => {
    const f = fakeFetch(() => new Response("OK", { status: 200 }));
    await new HttpHeartbeat({ url: URL_, fetch: f.fetchFn }).ping();
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toBe(URL_);
    expect(f.calls[0]?.init.method).toBe("GET");
    expect(f.calls[0]?.init.body).toBeUndefined();
    expect(f.calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("takes any 2xx and refuses the rest, saying only the status", async () => {
    for (const status of [200, 201, 204, 299]) {
      await expect(new HttpHeartbeat({ url: URL_, fetch: fakeFetch(() => new Response(status === 204 ? null : "", { status })).fetchFn }).ping()).resolves.toBeUndefined();
    }
    for (const status of [301, 400, 404, 429, 500, 503]) {
      const err = await new HttpHeartbeat({ url: URL_, fetch: fakeFetch(() => new Response(`bad ${URL_}`, { status })).fetchFn }).ping().catch((e: Error) => e);
      expect((err as Error).message).toBe(`the outside check did not take the ping (${status})`);
    }
  });

  it("says when the check cannot be reached, without any part of its address", async () => {
    const throwing = (msg: string) => (async () => {
      throw new Error(msg);
    }) as unknown as typeof fetch;
    const cases: [string, string][] = [
      [`request to ${URL_} failed`, "no answer from the outside check: request to [hidden] failed"],
      ["getaddrinfo ENOTFOUND hc.example/ping/5f1e2d3c-0123-4567-89ab-cdef01234567", "no answer from the outside check: getaddrinfo ENOTFOUND [hidden]"],
      ["GET /ping/5f1e2d3c-0123-4567-89ab-cdef01234567 timed out", "no answer from the outside check: GET [hidden] timed out"],
      ["fetch failed", "no answer from the outside check: fetch failed"],
    ];
    for (const [thrown, said] of cases) {
      const err = await new HttpHeartbeat({ url: URL_, fetch: throwing(thrown) }).ping().catch((e: Error) => e);
      expect((err as Error).message).toBe(said);
    }
    // An address with nothing after the host has nothing to hide but itself.
    const bare = await new HttpHeartbeat({ url: "https://hc.example/", fetch: throwing("to https://hc.example/ and / failed") }).ping().catch((e: Error) => e);
    expect((bare as Error).message).toBe("no answer from the outside check: to [hidden] and / failed");
  });

  it("gives up after its time limit", async () => {
    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted due to timeout")));
      })) as unknown as typeof fetch;
    const err = await new HttpHeartbeat({ url: URL_, fetch: hanging, timeoutMs: 20 }).ping().catch((e: Error) => e);
    expect((err as Error).message).toBe("no answer from the outside check: The operation was aborted due to timeout");
  });
});

describe("the time limits", () => {
  afterEach(() => vi.restoreAllMocks());

  it("are 10 s for a ping and 15 s for a Telegram message, unless told otherwise", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const f = fakeFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await new HttpHeartbeat({ url: URL_, fetch: f.fetchFn }).ping();
    await new HttpHeartbeat({ url: URL_, fetch: f.fetchFn, timeoutMs: 3 }).ping();
    await new TelegramAlerter({ token: "1:abcdefghijklmnopqrstuvwxyz", chatId: "42", fetch: f.fetchFn }).send({ text: "x", urgent: false });
    await new TelegramAlerter({ token: "1:abcdefghijklmnopqrstuvwxyz", chatId: "42", fetch: f.fetchFn, timeoutMs: 4 }).send({ text: "x", urgent: false });
    expect(timeout.mock.calls.map((c) => c[0])).toEqual([10_000, 3, 15_000, 4]);
  });
});
