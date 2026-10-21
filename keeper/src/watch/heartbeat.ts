// The outside check: a service (healthchecks.io, Better Stack, Cronitor, UptimeRobot's heartbeats and others) that expects a
// request every so often and raises the alarm when they stop. That covers what the watchdog cannot report itself: the keeper
// stopped, its machine gone, or its alerts no longer getting through. Every such service takes a plain GET of the address it
// gives; the address is usually its secret, so it is never written anywhere.

export interface Heartbeat {
  /** Resolves once the check took the ping; throws, with a reason that holds no part of the address, when it did not. */
  ping(): Promise<void>;
}

export interface HttpHeartbeatOptions {
  url: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class HttpHeartbeat implements Heartbeat {
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: HttpHeartbeatOptions) {
    this.fetchFn = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async ping(): Promise<void> {
    let res: Response;
    try {
      res = await this.fetchFn(this.opts.url, { method: "GET", signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      throw new Error(`no answer from the outside check: ${this.hide(err instanceof Error ? err.message : String(err))}`);
    }
    // The answer's body says nothing the keeper needs; it is read only so the connection can be reused.
    await res.text().catch(() => "");
    if (!res.ok) throw new Error(`the outside check did not take the ping (${res.status})`);
  }

  /** A broken connection's message may repeat the address. */
  private hide(text: string): string {
    const u = new URL(this.opts.url);
    const parts = [this.opts.url, `${u.host}${u.pathname}${u.search}`, `${u.pathname}${u.search}`].filter((p) => p.length > 1);
    return parts.reduce((acc, p) => acc.split(p).join("[hidden]"), text);
  }
}
