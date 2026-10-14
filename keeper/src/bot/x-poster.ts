// Posts to X (API v2, `POST /2/tweets`) as one account, signed with OAuth 1.0a ("user context").
//
// Unverified against the live API (the cloud sandbox cannot reach X): the signature is checked against the worked
// example in X's documentation, and the requests and answers against what the documentation says. Confirm the plan,
// the price per post and the account's permissions in X's developer console before turning the bot on (CLAUDE.md).

import { createHmac, randomBytes } from "node:crypto";
import type { Poster, PostResult } from "./poster.js";

export interface XCredentials {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

/** RFC 3986 percent-encoding, which is stricter than `encodeURIComponent`. */
const enc = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** The OAuth 1.0a HMAC-SHA1 signature of a request (`params` are the OAuth parameters plus the query's). */
export function oauthSignature(a: { method: string; url: string; params: Record<string, string>; consumerSecret: string; tokenSecret: string }): string {
  const u = new URL(a.url);
  const all: [string, string][] = Object.entries(a.params).map(([k, v]) => [enc(k), enc(v)]);
  u.searchParams.forEach((v, k) => all.push([enc(k), enc(v)]));
  all.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0));
  const parameterString = all.map(([k, v]) => `${k}=${v}`).join("&");
  const base = [a.method.toUpperCase(), enc(`${u.origin}${u.pathname}`), enc(parameterString)].join("&");
  return createHmac("sha1", `${enc(a.consumerSecret)}&${enc(a.tokenSecret)}`).update(base).digest("base64");
}

/** The `Authorization` header for a request with a JSON body (the body is not part of an OAuth 1.0a signature). */
export function oauthHeader(a: { method: string; url: string; creds: XCredentials; nonce: string; timestamp: string }): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: a.creds.consumerKey,
    oauth_nonce: a.nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: a.timestamp,
    oauth_token: a.creds.accessToken,
    oauth_version: "1.0",
  };
  oauth.oauth_signature = oauthSignature({ method: a.method, url: a.url, params: oauth, consumerSecret: a.creds.consumerSecret, tokenSecret: a.creds.accessTokenSecret });
  return `OAuth ${Object.keys(oauth)
    .sort()
    .map((k) => `${enc(k)}="${enc(oauth[k] as string)}"`)
    .join(", ")}`;
}

export interface XPosterOptions {
  credentials: XCredentials;
  /** Default https://api.x.com */
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** For tests. */
  now?: () => number;
  nonce?: () => string;
}

export class XPoster implements Poster {
  private readonly url: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: XPosterOptions) {
    this.url = `${(opts.baseUrl ?? "https://api.x.com").replace(/\/+$/, "")}/2/tweets`;
    this.fetchFn = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  async post(text: string): Promise<PostResult> {
    const authorization = oauthHeader({
      method: "POST",
      url: this.url,
      creds: this.opts.credentials,
      nonce: (this.opts.nonce ?? (() => randomBytes(16).toString("hex")))(),
      timestamp: String(Math.floor((this.opts.now ?? Date.now)() / 1000)),
    });
    let res: Response;
    try {
      res = await this.fetchFn(this.url, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // The request may have reached X before the connection broke: the answer is unknown.
      return { outcome: "retry", reason: `no answer from X: ${err instanceof Error ? err.message : String(err)}` };
    }

    const raw = await res.text().catch(() => "");
    let body: { data?: { id?: unknown }; detail?: unknown; title?: unknown } = {};
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      // not JSON
    }
    const said = String(body.detail ?? body.title ?? raw).replace(/\s+/g, " ").slice(0, 200);

    if (res.status === 200 || res.status === 201) {
      const id = body.data?.id;
      return typeof id === "string" ? { outcome: "posted", id } : { outcome: "posted" };
    }
    if (res.status === 403 && /duplicate/i.test(said)) return { outcome: "duplicate" };
    if (res.status === 400 || res.status === 422) return { outcome: "rejected", reason: `X refused the post (${res.status}): ${said}` };
    if (res.status === 429) return { outcome: "retry", reason: "rate limited by X (429)" };
    if (res.status === 401) return { outcome: "retry", reason: `X refused the credentials (401): ${said}` };
    return { outcome: "retry", reason: `X answered ${res.status}: ${said}` };
  }
}
