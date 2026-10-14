// The words of the X bot. Pure functions from facts to text, so every post can be checked without a network.
//
// The five posts are the ones in CLAUDE.md ("X bot"). Everything that comes from outside the chain (a wallet's X
// handle, a machine label) is checked or shortened here before it can end up in public text.

/** X's limit. Counted the way X counts (`tweetLength`), not in characters. */
export const MAX_POST_LENGTH = 280;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** The number people see for an on-chain break id: the first break is #1. */
export const breakNumber = (onchainId: bigint): string => (onchainId + 1n).toString();

const group = (n: bigint): string => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** micro-USDC as dollars, rounded UP to the cent so a price or a target is never shown lower than it is. */
export function usd(micro: bigint): string {
  const cents = (micro + 9_999n) / 10_000n;
  const whole = cents / 100n;
  const rest = cents % 100n;
  return rest === 0n ? `$${group(whole)}` : `$${group(whole)}.${rest.toString().padStart(2, "0")}`;
}

/** "Oct 14, 09:05 UTC". */
export function utc(unixSecs: bigint): string {
  const d = new Date(Number(unixSecs) * 1000);
  const two = (n: number) => n.toString().padStart(2, "0");
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
}

/** "3h" for hours (rounded to the nearest), "45 min" under an hour and a half. */
export function timeLeft(secs: number): string {
  if (secs < 5_400) return `${Math.max(1, Math.round(secs / 60))} min`;
  return `${Math.round(secs / 3_600)}h`;
}

export const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** AbCd…wxYz. */
export function shortWallet(address: string): string {
  return address.length <= 9 ? address : `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/** X handles are 1 to 15 letters, digits or underscores. Anything else is not tagged. */
export const isHandle = (s: string): boolean => /^[A-Za-z0-9_]{1,15}$/.test(s);

/**
 * Text from outside the bot (a card's name, a machine label) as it may appear in a post: no links, no mentions, no
 * line breaks, at most `max` characters. It never becomes a way to tag someone or to put a link in a post.
 */
export function plainText(s: string, max = 60): string {
  const clean = s
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[@\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return [...clean].slice(0, max).join("");
}

/** A machine label for a post: plain text as it is, a raw id shortened. */
export function machineText(label: string): string {
  return /^0x[0-9a-fA-F]{64}$/.test(label) ? `${label.slice(0, 6)}…${label.slice(-4)}` : plainText(label, 40);
}

// How X counts a post (twitter-text, weight 100 = one character): most Latin text counts 1, anything outside these
// ranges (emoji, arrows, the ellipsis) counts 2, and a link counts 23 whatever its length.
const LIGHT: readonly (readonly [number, number])[] = [
  [0, 4351],
  [8192, 8205],
  [8208, 8223],
  [8242, 8247],
];
const LINK_LENGTH = 23;

export function tweetLength(text: string): number {
  let n = 0;
  for (const ch of text.replace(/https?:\/\/\S+/g, " ".repeat(LINK_LENGTH))) {
    const cp = ch.codePointAt(0) as number;
    n += LIGHT.some(([a, b]) => cp >= a && cp <= b) ? 1 : 2;
  }
  return n;
}

// ---------------------------------------------------------------- the five posts

export function reservePost(a: { breakId: bigint; percent: number; target: bigint }): string {
  return `Break #${breakNumber(a.breakId)} is ${a.percent}% funded 🔥 Unlocks at ${usd(a.target)}.`;
}

export function openPost(a: { breakId: bigint; paid: number; free: number; price: bigint; machine: string; closesAt: bigint }): string {
  const spots = `${a.paid} paid ${plural(a.paid, "spot", "spots")} @ ${usd(a.price)}`;
  const free = a.free > 0 ? ` + ${a.free} FREE holder ${plural(a.free, "spot", "spots")}` : "";
  return `Break #${breakNumber(a.breakId)} is LIVE — ${spots}${free}. Packs: ${machineText(a.machine)}. Closes ${utc(a.closesAt)}.`;
}

export function reminderPost(a: { breakId: bigint; left: number; secsLeft: number }): string {
  return `${a.left} ${plural(a.left, "spot", "spots")} left in Break #${breakNumber(a.breakId)}. Closes in ${timeLeft(a.secsLeft)}.`;
}

/**
 * `names` are already what to show: "@handle" for a wallet that agreed to be tagged (and whose handle is valid),
 * otherwise a short wallet. If they do not fit, the last ones are dropped for "and N more".
 */
export function winnersPost(a: { breakId: bigint; names: readonly string[] }): string {
  const build = (shown: readonly string[]) => {
    const more = a.names.length - shown.length;
    return `Free holder spots in Break #${breakNumber(a.breakId)} go to ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""} 🎉`;
  };
  let shown = a.names;
  while (shown.length > 1 && tweetLength(build(shown)) > MAX_POST_LENGTH) shown = shown.slice(0, -1);
  return build(shown);
}

/**
 * The results post. With a known best card: "Break #n results: <card> → <winner>". Without one (no card catalogue
 * yet): how many cards went to how many wallets. The link is left out when the site's address is not configured.
 */
export function resultsPost(a: { breakId: bigint; cards: number; wallets: number; link?: string; topHit?: { name: string; winner: string } }): string {
  const head = a.topHit
    ? `Break #${breakNumber(a.breakId)} results: ${plainText(a.topHit.name)} → ${a.topHit.winner}.`
    : `Break #${breakNumber(a.breakId)} results are in: ${a.cards} ${plural(a.cards, "card", "cards")} sent to ${a.wallets} ${plural(a.wallets, "wallet", "wallets")}.`;
  return a.link ? `${head} Full results + proof: ${a.link}` : head;
}
