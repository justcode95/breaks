// What a break page says about a break, worked out from its account alone (the chain, read at `finalized`). Pure
// functions: the page only lays the results out. Nothing here is a claim about cards or deliveries, which are not on chain.

import { toHex } from "../draw/bytes";
import type { BreakAccount, BreakStatus } from "./accounts";

const USDC_DECIMALS = 6;

/** USDC base units as dollars: `20000000` is "$20", `20500000` is "$20.50". */
export function money(micro: bigint): string {
  const unit = 10n ** BigInt(USDC_DECIMALS);
  const whole = (micro / unit).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = (micro % unit).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return fraction === "" ? `$${whole}` : `$${whole}.${fraction.padEnd(2, "0")}`;
}

/** Lamports as SOL, to the digits that matter: `1_320_000` is "0.00132 SOL", `1_000_000_000` is "1 SOL". */
export function sol(lamports: bigint): string {
  const unit = 1_000_000_000n;
  const whole = (lamports / unit).toString();
  const fraction = (lamports % unit).toString().padStart(9, "0").replace(/0+$/, "");
  return `${fraction === "" ? whole : `${whole}.${fraction}`} SOL`;
}

/** "2026-10-14 09:00 UTC". Times on the account are seconds since 1970. */
export function utcTime(secs: bigint): string {
  const ms = Number(secs) * 1000;
  if (secs <= 0n || !Number.isFinite(ms) || ms > 8.64e15) return "an unknown time";
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** "3h 12m", "2d 4h", "9m", "under a minute". */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return "under a minute";
  const days = Math.floor(s / 86_400);
  const hours = Math.floor((s % 86_400) / 3_600);
  const minutes = Math.floor((s % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** The machine as people configured it: text up to 32 bytes, zero-padded. Anything else (a raw id) is shown shortened. */
export function machineLabel(bytes: Uint8Array): string {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  const text = bytes.subarray(0, end);
  if (text.length > 0 && text.every((b) => b >= 0x20 && b <= 0x7e)) return new TextDecoder().decode(text);
  const hex = toHex(bytes);
  return `0x${hex.slice(0, 6)}…${hex.slice(-4)}`;
}

/** A wallet's weight as a share of the list: "12.5%", "<0.01%" when it is real but tiny, "—" when it cannot be one. */
export function share(weight: bigint, total: bigint): string {
  if (total <= 0n || weight <= 0n) return "0%";
  // A winner's range lies inside the list, so a weight above the total is not a share of anything.
  if (weight > total) return "—";
  const hundredths = (weight * 10_000n) / total;
  if (hundredths === 0n) return "<0.01%";
  const whole = hundredths / 100n;
  const rest = hundredths % 100n;
  return rest === 0n ? `${whole}%` : `${whole}.${rest.toString().padStart(2, "0").replace(/0$/, "")}%`;
}

export type StepState = "done" | "current" | "todo";

export interface Step {
  label: string;
  state: StepState;
  /** What is happening or what comes next; only on the step the break is at. */
  detail?: string;
}

/** The states a break goes through, in order. A break is *at* the step of its status. */
const STEPS: readonly { status: BreakStatus; label: string }[] = [
  { status: "Open", label: "Spots on sale" },
  { status: "Closed", label: "Sale closed" },
  { status: "EligibilityCommitted", label: "Eligible holders committed" },
  { status: "Funded", label: "Packs paid for" },
  { status: "PoolCommitted", label: "Cards pulled and committed" },
  { status: "RandomnessRequested", label: "Randomness requested" },
  { status: "Settled", label: "Randomness received" },
  { status: "Drawn", label: "Free-spot winners recorded" },
];

/** How many free winners the draw will record: one per free spot, or fewer if too few wallets are eligible. */
export function expectedWinners(b: BreakAccount): number {
  return Math.min(b.freeSpots, b.eligibilityCount);
}

function detailFor(b: BreakAccount, nowSecs: number): string {
  switch (b.status) {
    case "Open": {
      const left = Number(b.closesAt) - nowSecs;
      return left > 0
        ? `Closes ${utcTime(b.closesAt)} (${duration(left)} left by your clock).`
        : `The closing time (${utcTime(b.closesAt)}) has passed; the sale is waiting to be closed on chain.`;
    }
    case "Closed":
      return "Waiting for the list of eligible holders to be committed.";
    case "EligibilityCommitted":
      return `${b.eligibilityCount} eligible ${b.eligibilityCount === 1 ? "wallet" : "wallets"} committed. Next: the packs are paid for.`;
    case "Funded":
      return `${b.poolSize} ${b.poolSize === 1 ? "pack is" : "packs are"} being bought and pulled.`;
    case "PoolCommitted":
      return `${b.poolSize} ${b.poolSize === 1 ? "card is" : "cards are"} committed as the pool. Next: randomness is requested.`;
    case "RandomnessRequested":
      return "Waiting for ORAO's answer.";
    case "Settled":
      return `Seed recorded ${utcTime(b.seededAt)}. Free winners recorded: ${b.freeWinnerCount} of ${expectedWinners(b)}.`;
    case "Drawn":
      return `${b.freeWinnerCount} free ${b.freeWinnerCount === 1 ? "winner" : "winners"} recorded. Delivery of the cards is not shown on this page yet.`;
    case "Cancelled":
      return "";
  }
}

/** The progress of a break. A cancelled break has none: the chain does not say how far it got. */
export function steps(b: BreakAccount, nowSecs: number): Step[] {
  if (b.status === "Cancelled") return [];
  const at = STEPS.findIndex((s) => s.status === b.status);
  return STEPS.map((s, i) => {
    // The last step has nothing after it, so reaching it is being done.
    const state: StepState = i < at || (i === at && b.status === "Drawn") ? "done" : i === at ? "current" : "todo";
    return i === at ? { label: s.label, state, detail: detailFor(b, nowSecs) } : { label: s.label, state };
  });
}

/** One line for the top of the page. */
export function headline(b: BreakAccount, nowSecs: number): string {
  switch (b.status) {
    case "Open":
      return Number(b.closesAt) > nowSecs ? "On sale" : "Sale over, closing";
    case "Cancelled":
      return "Cancelled";
    case "Drawn":
      return "Drawn";
    default:
      return "Being settled";
  }
}

/** The stage of a break in a few words, for lists: where the sale or the settling stands. */
export function stageLabel(b: BreakAccount, nowSecs: number): string {
  const step = STEPS.find((s) => s.status === b.status);
  // "On sale" and "Drawn" read better than the steps' own words, and a cancelled break has no step.
  return step && b.status !== "Open" && b.status !== "Drawn" ? step.label : headline(b, nowSecs);
}

/** `part` of `whole` as a whole percent from 0 to 100, for a progress bar; 0 when there is no whole. */
export function percent(part: number, whole: number): number {
  if (!(whole > 0) || !(part > 0)) return 0;
  return Math.min(100, Math.round((part / whole) * 100));
}

export type Tone = "live" | "waiting" | "done" | "off";

/** How a break's badge is coloured: on sale (live), being settled (waiting), drawn (done), cancelled (off). */
export function tone(b: BreakAccount, nowSecs: number): Tone {
  switch (b.status) {
    case "Open":
      return Number(b.closesAt) > nowSecs ? "live" : "waiting";
    case "Drawn":
      return "done";
    case "Cancelled":
      return "off";
    default:
      return "waiting";
  }
}

export interface SpotSlot {
  /** A paid spot, or one of the free spots for holders. */
  kind: "paid" | "free";
  /** A paid spot that has been bought, or a free spot that has a winner recorded. */
  taken: boolean;
}

/** More spots than this are not drawn one by one: a row of hundreds of circles says nothing the bar does not. */
export const MAX_DRAWN_SPOTS = 60;

/**
 * Every spot of a break, paid ones first, then the free ones: which are taken. `undefined` when there are too many to draw.
 * A free spot is taken once its winner is recorded, so before the draw (and when too few wallets were eligible) some stay open.
 */
export function spotSlots(b: BreakAccount): SpotSlot[] | undefined {
  if (b.paidSpots + b.freeSpots > MAX_DRAWN_SPOTS) return undefined;
  return [
    ...Array.from({ length: b.paidSpots }, (_, i): SpotSlot => ({ kind: "paid", taken: i < b.spotsSold })),
    ...Array.from({ length: b.freeSpots }, (_, i): SpotSlot => ({ kind: "free", taken: i < b.freeWinnerCount })),
  ];
}
