// Which alerts one channel has been told about, and what to tell it next. Pure: `update` takes the alerts that are open now,
// `message` writes what is still to say (new problems, cleared ones, and now and then a reminder of what stays open), and
// `delivered` records that it arrived. Nothing is marked as told until it was delivered, so a message that could not be sent
// is written again, with what is true by then, on the next run.

import type { Alert } from "./rules.js";

export interface BookOptions {
  /** The first words of every message, like "BREAKS keeper on devnet". */
  title: string;
  /** How often what stays open is listed again; 0 never. */
  repeatMs: number;
  /**
   * The longest message (Telegram takes 4,096 characters). What does not fit comes in the next message. At least
   * `MIN_MESSAGE`, so the heading, a section title and the longest line always fit and every alert goes out in the end.
   */
  maxChars?: number;
}

export interface Outgoing {
  text: string;
  /** Something new is wrong: worth a sound on the phone. */
  urgent: boolean;
  readonly opened: readonly string[];
  readonly cleared: readonly string[];
  readonly reminder: boolean;
  readonly greeting: boolean;
}

/** The longest an alert's line may be; error messages can be long. */
export const MAX_LINE = 600;
export const MIN_MESSAGE = 1000;
const DEFAULT_MAX_CHARS = 4000;

const line = (text: string) => `• ${text.length > MAX_LINE ? `${text.slice(0, MAX_LINE - 1)}…` : text}`;

export class AlertBook {
  private readonly open = new Map<string, { text: string; told: boolean }>();
  /** Alerts this channel was told about that have cleared since, and the last thing they said. */
  private readonly cleared = new Map<string, string>();
  private remindAt: number | undefined;
  private greeted = false;

  constructor(private readonly opts: BookOptions) {
    if ((opts.maxChars ?? DEFAULT_MAX_CHARS) < MIN_MESSAGE) throw new RangeError(`a message must be allowed at least ${MIN_MESSAGE} characters`);
  }

  /** What is wrong now. An alert that comes back before its clearing was told is simply still open. */
  update(alerts: readonly Alert[]): void {
    const current = new Map(alerts.map((a) => [a.key, a.text]));
    for (const [key, text] of current) {
      const o = this.open.get(key);
      if (o) o.text = text;
      else if (this.cleared.delete(key)) this.open.set(key, { text, told: true });
      else this.open.set(key, { text, told: false });
    }
    for (const [key, o] of this.open) {
      if (current.has(key)) continue;
      this.open.delete(key);
      if (o.told) this.cleared.set(key, o.text);
    }
  }

  /** What to send now, if anything. */
  message(now: Date): Outgoing | undefined {
    const fresh = [...this.open].filter(([, o]) => !o.told);
    const cleared = [...this.cleared];
    const known = [...this.open].filter(([, o]) => o.told);
    const reminder = this.opts.repeatMs > 0 && this.remindAt !== undefined && now.getTime() >= this.remindAt && known.length > 0;
    const greeting = !this.greeted;
    if (fresh.length === 0 && cleared.length === 0 && !reminder && !greeting) return undefined;

    const max = this.opts.maxChars ?? DEFAULT_MAX_CHARS;
    const head: string[] = [];
    if (greeting) head.push(`${this.opts.title} started. A problem that lasts is reported here once, and again when it clears.`);
    const sections: [string, [string, string][]][] = [
      ["New:", fresh.map(([k, o]) => [k, o.text])],
      ["Cleared:", cleared],
      ...(reminder ? ([["Still open:", known.map(([k, o]) => [k, o.text])]] as [string, [string, string][]][]) : []),
    ];
    const parts = [
      fresh.length > 0 ? `${fresh.length} new ${fresh.length === 1 ? "problem" : "problems"}` : "",
      cleared.length > 0 ? `${cleared.length} cleared` : "",
      reminder ? `${known.length} still open` : "",
    ].filter(Boolean);
    if (parts.length > 0) head.unshift(`${this.opts.title}: ${parts.join(", ")}.`);

    const lines = [...head];
    const opened: string[] = [];
    const clearedKeys: string[] = [];
    let left = 0;
    let used = lines.join("\n").length;
    for (const [title, items] of sections) {
      if (items.length === 0) continue;
      let titled = false;
      for (const [key, text] of items) {
        const add = (titled ? "" : `\n${title}`) + `\n${line(text)}`;
        // Room is kept for the line that says how many more there are.
        if (used + add.length > max - 80) {
          left++;
          continue;
        }
        if (!titled) lines.push(title);
        titled = true;
        lines.push(line(text));
        used += add.length;
        if (title === "New:") opened.push(key);
        else if (title === "Cleared:") clearedKeys.push(key);
      }
    }
    if (left > 0) lines.push(`…and ${left} more, in the next message.`);
    return { text: lines.join("\n"), urgent: opened.length > 0, opened, cleared: clearedKeys, reminder, greeting };
  }

  /** The message arrived: what it said is now known to the channel. */
  delivered(out: Outgoing, now: Date): void {
    if (out.greeting) this.greeted = true;
    for (const key of out.opened) {
      const o = this.open.get(key);
      if (o) o.told = true;
    }
    for (const key of out.cleared) this.cleared.delete(key);
    const anyTold = [...this.open.values()].some((o) => o.told);
    if (!anyTold) this.remindAt = undefined;
    else if (out.opened.length > 0 || out.reminder || this.remindAt === undefined) this.remindAt = now.getTime() + this.opts.repeatMs;
  }
}
