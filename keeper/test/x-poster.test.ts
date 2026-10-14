import { describe, expect, it } from "vitest";
import { XPoster, oauthHeader, oauthSignature } from "../src/bot/x-poster.js";

const CREDS = { consumerKey: "ck-key", consumerSecret: "ck-secret", accessToken: "at-token", accessTokenSecret: "at-secret" };

describe("OAuth 1.0a signing", () => {
  it("reproduces the worked example in X's documentation (\"Creating a signature\")", () => {
    const signature = oauthSignature({
      method: "POST",
      url: "https://api.twitter.com/1.1/statuses/update.json?include_entities=true",
      params: {
        status: "Hello Ladies + Gentlemen, a signed OAuth request!",
        oauth_consumer_key: "xvz1evFS4wEEPTGEFPHBog",
        oauth_nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
        oauth_signature_method: "HMAC-SHA1",
        oauth_timestamp: "1318622958",
        oauth_token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
        oauth_version: "1.0",
      },
      consumerSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
      tokenSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
    });
    expect(signature).toBe("hCtSmYh+iHYCEqBWrE7C7hYmtUk=");
  });

  it("builds the header with every OAuth field, sorted and percent-encoded, and never the secrets", () => {
    const header = oauthHeader({ method: "POST", url: "https://api.x.com/2/tweets", creds: CREDS, nonce: "n0nce", timestamp: "1700000000" });
    expect(header).toMatch(/^OAuth oauth_consumer_key="ck-key", oauth_nonce="n0nce", oauth_signature="[^"]+", oauth_signature_method="HMAC-SHA1", oauth_timestamp="1700000000", oauth_token="at-token", oauth_version="1\.0"$/);
    expect(header).not.toContain("ck-secret");
    expect(header).not.toContain("at-secret");
    // The signature has characters that must be encoded in a header (+ / =).
    expect(header).toMatch(/oauth_signature="[A-Za-z0-9%.\-_~]+"/);
  });

  it("changes the signature when anything signed changes", () => {
    const base = { method: "POST", url: "https://api.x.com/2/tweets", params: { oauth_nonce: "a", oauth_timestamp: "1" }, consumerSecret: "c", tokenSecret: "t" };
    const s = oauthSignature(base);
    expect(oauthSignature({ ...base, params: { oauth_nonce: "b", oauth_timestamp: "1" } })).not.toBe(s);
    expect(oauthSignature({ ...base, url: "https://api.x.com/2/other" })).not.toBe(s);
    expect(oauthSignature({ ...base, consumerSecret: "c2" })).not.toBe(s);
    expect(oauthSignature({ ...base, tokenSecret: "t2" })).not.toBe(s);
    expect(oauthSignature({ ...base, method: "GET" })).not.toBe(s);
  });
});

/** A fetch that answers with a fixed response and remembers the request. */
function node(answer: { status: number; body?: unknown; raw?: string } | Error) {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    if (answer instanceof Error) throw answer;
    return new Response(answer.raw ?? JSON.stringify(answer.body ?? {}), { status: answer.status });
  }) as unknown as typeof fetch;
  return { seen, fetchFn };
}

const poster = (fetchFn: typeof fetch, over: { baseUrl?: string } = {}) =>
  new XPoster({ credentials: CREDS, fetch: fetchFn, now: () => 1_700_000_000_000, nonce: () => "fixed-nonce", ...over });

describe("XPoster", () => {
  it("posts the text as JSON to /2/tweets with a signed header", async () => {
    const n = node({ status: 201, body: { data: { id: "1849", text: "hello" } } });
    const result = await poster(n.fetchFn).post("Break #1 is LIVE — 10 paid spots @ $20.");

    expect(result).toEqual({ outcome: "posted", id: "1849" });
    expect(n.seen).toHaveLength(1);
    expect(n.seen[0]?.url).toBe("https://api.x.com/2/tweets");
    const init = n.seen[0]?.init as RequestInit & { headers: Record<string, string> };
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ text: "Break #1 is LIVE — 10 paid spots @ $20." });
    expect(init.headers["content-type"]).toBe("application/json");
    // The same header an independent computation gives for this request.
    expect(init.headers.authorization).toBe(oauthHeader({ method: "POST", url: "https://api.x.com/2/tweets", creds: CREDS, nonce: "fixed-nonce", timestamp: "1700000000" }));
  });

  it("uses another API address when configured", async () => {
    const n = node({ status: 201, body: { data: { id: "1" } } });
    await poster(n.fetchFn, { baseUrl: "https://proxy.example.org/x/" }).post("hi");
    expect(n.seen[0]?.url).toBe("https://proxy.example.org/x/2/tweets");
  });

  it("is posted even if X does not say the id", async () => {
    expect(await poster(node({ status: 200, body: {} }).fetchFn).post("hi")).toEqual({ outcome: "posted" });
  });

  it("reads a refusal as a duplicate as 'already posted'", async () => {
    const n = node({ status: 403, body: { detail: "You are not allowed to create a Tweet with duplicate content.", title: "Forbidden", status: 403 } });
    expect(await poster(n.fetchFn).post("hi")).toEqual({ outcome: "duplicate" });
  });

  it("rejects text X will never take, and repeats what may pass", async () => {
    expect(await poster(node({ status: 400, body: { detail: "Tweet needs to be a bit shorter." } }).fetchFn).post("x")).toEqual({
      outcome: "rejected",
      reason: "X refused the post (400): Tweet needs to be a bit shorter.",
    });
    expect((await poster(node({ status: 422, body: { title: "Unprocessable" } }).fetchFn).post("x")).outcome).toBe("rejected");

    for (const [status, mention] of [
      [429, /rate limited/],
      [401, /credentials/],
      [403, /403/],
      [402, /402/],
      [500, /500/],
      [503, /503/],
    ] as const) {
      const r = await poster(node({ status, body: { detail: "nope" } }).fetchFn).post("x");
      expect(r.outcome, String(status)).toBe("retry");
      expect(r.outcome === "retry" && r.reason, String(status)).toMatch(mention);
    }
  });

  it("calls a failed or timed out request 'no answer': it may have been posted", async () => {
    const r = await poster(node(new Error("socket hang up")).fetchFn).post("x");
    expect(r).toEqual({ outcome: "retry", reason: "no answer from X: socket hang up" });
  });

  it("copes with answers that are not JSON, and keeps what it quotes short", async () => {
    const html = await poster(node({ status: 502, raw: "<html>Bad gateway</html>" }).fetchFn).post("x");
    expect(html).toEqual({ outcome: "retry", reason: "X answered 502: <html>Bad gateway</html>" });
    const long = await poster(node({ status: 500, body: { detail: "z".repeat(5000) } }).fetchFn).post("x");
    expect(long.outcome === "retry" && long.reason.length).toBeLessThan(260);
  });

  it("never puts a secret in a reason", async () => {
    const cases = [node({ status: 401, body: { detail: "bad" } }), node(new Error("boom")), node({ status: 500, raw: "oops" })];
    for (const n of cases) {
      const r = await poster(n.fetchFn).post("x");
      const text = JSON.stringify(r);
      for (const secret of [CREDS.consumerSecret, CREDS.accessTokenSecret, CREDS.accessToken, CREDS.consumerKey]) expect(text).not.toContain(secret);
    }
  });
});
