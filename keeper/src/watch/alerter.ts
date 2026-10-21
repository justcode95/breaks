// Where the watchdog's messages go. The keeper's log always gets them; Telegram does too when it is set up (ALERTS=telegram).
//
// The Telegram channel is unverified against the live service (the cloud sandbox cannot reach it): the request and the
// answers are written from the Bot API's documentation (`sendMessage`, https://core.telegram.org/bots/api#sendmessage). The
// keeper sends a message when it starts, which is how to see that the token and the chat work.

import type { Logger } from "../job.js";

export interface AlertMessage {
  text: string;
  /** Something new is wrong. Other messages (cleared, still open, started) arrive without a sound. */
  urgent: boolean;
}

export interface Alerter {
  /** A name for the log ("log", "telegram"). */
  readonly name: string;
  /** Resolves once the message arrived; throws, with a reason that holds no secret, when it did not. */
  send(message: AlertMessage): Promise<void>;
}

/** The keeper's log: an urgent message is an error line, the rest are info lines. */
export class LogAlerter implements Alerter {
  readonly name = "log";
  constructor(private readonly log: Logger) {}

  async send(message: AlertMessage): Promise<void> {
    if (message.urgent) this.log.error("watchdog", { message: message.text });
    else this.log.info("watchdog", { message: message.text });
  }
}

/** A bot token as BotFather gives it: the bot's number, a colon, and the secret. */
export const TELEGRAM_TOKEN = /^\d{1,20}:[A-Za-z0-9_-]{20,100}$/;
/** A chat: a user's or a group's number (groups are negative), or a public channel's @name. */
export const TELEGRAM_CHAT = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;

export interface TelegramOptions {
  token: string;
  chatId: string;
  /** Default https://api.telegram.org */
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Sends each message to one Telegram chat as plain text (no markup, so nothing in an alert can format or link). */
export class TelegramAlerter implements Alerter {
  readonly name = "telegram";
  private readonly url: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: TelegramOptions) {
    if (!TELEGRAM_TOKEN.test(opts.token)) throw new Error("the Telegram bot token is not in the form BotFather gives (digits, a colon, then the secret)");
    if (!TELEGRAM_CHAT.test(opts.chatId)) throw new Error("the Telegram chat is not a chat number or an @name");
    // The token is part of the address, so the address is never written anywhere.
    this.url = `${(opts.baseUrl ?? "https://api.telegram.org").replace(/\/+$/, "")}/bot${opts.token}/sendMessage`;
    this.fetchFn = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  async send(message: AlertMessage): Promise<void> {
    let res: Response;
    try {
      res = await this.fetchFn(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: this.opts.chatId, text: message.text, disable_web_page_preview: true, disable_notification: !message.urgent }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new Error(`no answer from Telegram: ${this.hide(err instanceof Error ? err.message : String(err))}`);
    }
    const raw = await res.text().catch(() => "");
    let body: { ok?: unknown; description?: unknown } = {};
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      // not JSON
    }
    if (res.ok && body.ok === true) return;
    const said = this.hide(String(body.description ?? raw)).replace(/\s+/g, " ").slice(0, 200);
    throw new Error(`Telegram did not take the message (${res.status})${said ? `: ${said}` : ""}`);
  }

  /** Telegram's answers and a broken connection's message should never hold the token, but they are checked anyway. */
  private hide(text: string): string {
    return text.split(this.opts.token).join("[hidden]");
  }
}
