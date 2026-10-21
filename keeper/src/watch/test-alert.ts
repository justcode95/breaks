// Test alert: `pnpm --filter keeper send-test-alert`
//
// Sends one test message through the watchdog's Telegram channel, so the bot token and the chat can be checked before the
// keeper's first start (the keeper itself sends a message there when it starts). It reads only the watchdog's settings
// (keeper/.env), never prints the token or the outside check's address, and does not ping the outside check, which would
// tell it the keeper is running.
//
// Exit code: 0 when Telegram took the message, 1 when it did not, 2 for a bad command line, bad settings or nothing to send to.

import { pathToFileURL } from "node:url";
import { parseWatchConfig } from "../config.js";
import { TelegramAlerter } from "./alerter.js";

const USAGE = `usage: pnpm --filter keeper send-test-alert [-- --help]

Sends one test message to the Telegram chat the watchdog's alerts go to (ALERTS=telegram, ALERT_TELEGRAM_BOT_TOKEN and
ALERT_TELEGRAM_CHAT_ID in keeper/.env), so you can see that the token and the chat work before the keeper runs.
`;

export interface TestAlertDeps {
  env?: Record<string, string | undefined>;
  /** For tests: where Telegram is, and how to reach it. */
  telegramBase?: string;
  fetch?: typeof fetch;
}

export async function main(argv: string[], deps: TestAlertDeps = {}): Promise<{ code: number; out: string }> {
  const args = argv.filter((a) => a !== "--");
  if (args.includes("--help") || args.includes("-h")) return { code: 0, out: USAGE };
  if (args.length > 0) return { code: 2, out: `unknown argument ${args[0]}\n\n${USAGE}` };

  // Nothing printed here can hold a secret: a problem with a setting never repeats its value, the chat is a number or an
  // @name, the outside check's address is not printed, and the Telegram channel hides its token in what it throws.
  const parsed = parseWatchConfig(deps.env ?? process.env);
  if ("problems" in parsed) return { code: 2, out: `The watchdog's settings cannot be read:\n${parsed.problems.map((p) => `  ${p}`).join("\n")}` };

  const { watch, cluster } = parsed;
  const outside = watch.heartbeatUrl
    ? "The outside check (ALERT_HEARTBEAT_URL) is set; it was not pinged, since a ping says the keeper is running."
    : "No outside check is set (ALERT_HEARTBEAT_URL): nobody is told if the keeper itself stops.";
  if (watch.alerts !== "telegram" || !watch.telegram) {
    return { code: 2, out: `Alerts only go to the keeper's log (ALERTS=log), so there is no chat to send a test to. Set ALERTS=telegram with ALERT_TELEGRAM_BOT_TOKEN and ALERT_TELEGRAM_CHAT_ID (keeper/.env.example).\n${outside}` };
  }

  const telegram = new TelegramAlerter({
    ...watch.telegram,
    ...(deps.telegramBase !== undefined ? { baseUrl: deps.telegramBase } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  const text = `BREAKS keeper on ${cluster}: a test message from send-test-alert. If you can read this, the watchdog's alerts reach this chat.`;
  try {
    await telegram.send({ text, urgent: true });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { code: 1, out: `The test message did not reach the chat ${watch.telegram.chatId}: ${reason}\nCheck the token with @BotFather, and that the bot was started in that chat (or added to the group).\n${outside}` };
  }
  return { code: 0, out: `Telegram took the test message for the chat ${watch.telegram.chatId}: look for it there.\n${outside}` };
}

// Run when started from the command line.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await main(process.argv.slice(2));
  process.stdout.write(`${result.out}\n`);
  process.exit(result.code);
}
