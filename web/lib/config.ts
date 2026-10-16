// Where the site reads the chain from. Set when the site is built (the `NEXT_PUBLIC_` values are put into the page):
//   NEXT_PUBLIC_BREAKS_PROGRAM_ID     the deployed breaks program (no default: it belongs to one deployment)
//   NEXT_PUBLIC_TREASURY_PROGRAM_ID   the deployed treasury program (the treasury page is hidden without it)
//   NEXT_PUBLIC_PUBLISHED_URL         where the keeper's published lists are served (the verify page loads them from there)
//   NEXT_PUBLIC_SOLANA_RPC_URL        a node that answers browsers (default: the public devnet node)
//   NEXT_PUBLIC_BREAK_PAID_SPOTS, NEXT_PUBLIC_BREAK_FREE_SPOTS, NEXT_PUBLIC_BREAK_SPOT_PRICE, NEXT_PUBLIC_BREAK_PACKS
//                                     the shape of the next break, copied from the keeper's BREAK_* settings (all four or none:
//                                     without them there is no reserve bar). Prices are micro-USDC, as in the keeper, and
//                                     BREAK_PACKS is copied as it is written there (a JSON list of groups of packs).

import { MAX_FREE_SPOTS, MAX_PACKS, MAX_TIERS } from "./chain/accounts";
import { type Address, isAddress } from "./chain/address";
import { type BreakShape, type PackGroup, packTotals } from "./chain/reserve";

export const DEFAULT_RPC_URL = "https://api.devnet.solana.com";

export interface ChainConfig {
  rpcUrl: string;
  breaksProgram: Address;
}

export interface TreasuryConfigSetting {
  rpcUrl: string;
  treasuryProgram: Address;
}

export type Setup<T> = { kind: "off" } | { kind: "problem"; problem: string } | { kind: "on"; config: T };
export type ChainSetup = Setup<ChainConfig>;

/** The program's address and the node's, checked. `variable` names the setting in a problem report. */
function programAndNode(env: { rpcUrl?: string | undefined; program?: string | undefined }, variable: string): { kind: "off" } | { kind: "problem"; problem: string } | { kind: "ok"; program: Address; rpcUrl: string } {
  const program = env.program?.trim();
  if (!program) return { kind: "off" };
  if (!isAddress(program)) return { kind: "problem", problem: `${variable} is not a Solana address.` };
  const rpcUrl = env.rpcUrl?.trim() || DEFAULT_RPC_URL;
  let url: URL;
  try {
    url = new URL(rpcUrl);
  } catch {
    return { kind: "problem", problem: "NEXT_PUBLIC_SOLANA_RPC_URL is not a web address." };
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    return { kind: "problem", problem: "NEXT_PUBLIC_SOLANA_RPC_URL must be an https:// address." };
  }
  return { kind: "ok", program, rpcUrl };
}

export function chainSetup(env: { rpcUrl?: string | undefined; program?: string | undefined }): ChainSetup {
  const s = programAndNode(env, "NEXT_PUBLIC_BREAKS_PROGRAM_ID");
  return s.kind === "ok" ? { kind: "on", config: { rpcUrl: s.rpcUrl, breaksProgram: s.program } } : s;
}

export function treasurySetup(env: { rpcUrl?: string | undefined; program?: string | undefined }): Setup<TreasuryConfigSetting> {
  const s = programAndNode(env, "NEXT_PUBLIC_TREASURY_PROGRAM_ID");
  return s.kind === "ok" ? { kind: "on", config: { rpcUrl: s.rpcUrl, treasuryProgram: s.program } } : s;
}

export interface PublishedSetting {
  /** Where `eligibility/<root>.json` and `pool/<pool hash>.json` are served from: no trailing slash. */
  baseUrl: string;
}

/** The address the published lists are served from. Files are fetched from it by name, so it is only a folder. */
export function publishedSetup(raw: string | undefined): Setup<PublishedSetting> {
  const text = raw?.trim();
  if (!text) return { kind: "off" };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { kind: "problem", problem: "NEXT_PUBLIC_PUBLISHED_URL is not a web address." };
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    return { kind: "problem", problem: "NEXT_PUBLIC_PUBLISHED_URL must be an https:// address." };
  }
  if (url.username || url.password || url.search || url.hash) {
    return { kind: "problem", problem: "NEXT_PUBLIC_PUBLISHED_URL must be a plain folder address, without a login, a query or a fragment." };
  }
  return { kind: "on", config: { baseUrl: `${url.origin}${url.pathname.replace(/\/+$/, "")}` } };
}

/** The raw text of the four settings that describe the next break. */
export interface BreakShapeEnv {
  paidSpots?: string | undefined;
  freeSpots?: string | undefined;
  spotPrice?: string | undefined;
  /** The keeper's BREAK_PACKS, as it is written there: a JSON list of groups of packs. */
  packs?: string | undefined;
}

const U64_MAX = (1n << 64n) - 1n;
const PACKS = "NEXT_PUBLIC_BREAK_PACKS";
const PACK_KEYS = ["machine", "maxPrice", "count"];

/**
 * The keeper's BREAK_PACKS (keeper/src/scheduler/packs-config.ts, written again here): a JSON list of groups, each a machine, the
 * most one pack from it may cost in micro-USDC and how many of the break's packs come from it, put cheapest first. A machine is
 * text of 1 to 32 bytes without control characters, or `0x` and 64 hex digits. Returns the groups or what is wrong.
 */
function parsePacks(text: string): PackGroup[] | string {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return `${PACKS} is not valid JSON (copy the keeper's BREAK_PACKS as it is written there).`;
  }
  if (!Array.isArray(json) || json.length === 0) return `${PACKS} must be a list with at least one group of packs.`;
  const groups: PackGroup[] = [];
  for (const [i, item] of json.entries()) {
    const at = `${PACKS}, group ${i + 1}`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) return `${at}: must be an object with machine, maxPrice and count.`;
    const o = item as Record<string, unknown>;
    const unknown = Object.keys(o).find((k) => !PACK_KEYS.includes(k));
    if (unknown !== undefined) return `${at}: "${unknown}" is not one of machine, maxPrice, count.`;

    if (typeof o.machine !== "string") return `${at}: machine must be text.`;
    const bytes = new TextEncoder().encode(o.machine).length;
    if (/^0x/i.test(o.machine)) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(o.machine)) return `${at}: machine looks like a hex id but is not 0x followed by exactly 64 hex digits.`;
    } else if (bytes === 0) return `${at}: machine is empty.`;
    else if (bytes > 32) return `${at}: machine is ${bytes} bytes; at most 32 (or 0x and 64 hex digits).`;
    else if (/[\u0000-\u001f\u007f]/.test(o.machine)) return `${at}: machine has a control character.`;

    let maxPrice: bigint;
    if (typeof o.maxPrice === "string" && /^\d+$/.test(o.maxPrice)) maxPrice = BigInt(o.maxPrice);
    else if (typeof o.maxPrice === "number" && Number.isSafeInteger(o.maxPrice) && o.maxPrice >= 0) maxPrice = BigInt(o.maxPrice);
    else return `${at}: maxPrice must be a whole number of micro-USDC (so $20 is 20000000), as a string of digits.`;
    if (maxPrice < 1n || maxPrice > U64_MAX) return `${at}: maxPrice must be above zero and fit in 64 bits.`;

    if (typeof o.count !== "number" || !Number.isInteger(o.count) || o.count < 1) return `${at}: count must be a whole number, at least 1.`;
    groups.push({ machine: o.machine, maxPrice, count: o.count });
  }
  // A stable sort, as the keeper's: the program takes the packs cheapest first.
  return groups.sort((a, b) => (a.maxPrice < b.maxPrice ? -1 : a.maxPrice > b.maxPrice ? 1 : 0));
}

/**
 * The shape of the next break, from the four settings. Off when none is set; a problem (naming the setting) when only some are set
 * or one is not usable, so a typo does not quietly become a wrong progress bar. The same limits as the keeper's BREAK_* settings
 * and the program's: whole numbers, prices in micro-USDC (so $20 is 20000000), one pack per spot (the counts add up to the spots,
 * at most 64, in at most 8 groups) and the spot price not above the average pack price.
 */
export function breakShapeSetup(env: BreakShapeEnv): Setup<BreakShape> {
  const fields = [
    ["NEXT_PUBLIC_BREAK_PAID_SPOTS", env.paidSpots?.trim()],
    ["NEXT_PUBLIC_BREAK_FREE_SPOTS", env.freeSpots?.trim()],
    ["NEXT_PUBLIC_BREAK_SPOT_PRICE", env.spotPrice?.trim()],
    [PACKS, env.packs?.trim()],
  ] as const;
  const missing = fields.filter(([, v]) => !v).map(([name]) => name);
  if (missing.length === fields.length) return { kind: "off" };
  if (missing.length > 0) return { kind: "problem", problem: `The next break's shape needs all four settings; missing ${missing.join(", ")}.` };

  const whole = (name: string, text: string, min: number, max: number): number | string => {
    if (!/^\d+$/.test(text)) return `${name} is not a whole number.`;
    const n = Number(text);
    return n >= min && n <= max ? n : `${name} must be from ${min} to ${max}.`;
  };
  const price = (name: string, text: string): bigint | string => {
    if (!/^\d+$/.test(text)) return `${name} is not a whole number of micro-USDC (so $20 is 20000000).`;
    const n = BigInt(text);
    return n >= 1n && n <= U64_MAX ? n : `${name} must be above zero and fit in 64 bits.`;
  };
  const paid = whole("NEXT_PUBLIC_BREAK_PAID_SPOTS", env.paidSpots?.trim() ?? "", 1, 65_535);
  const free = whole("NEXT_PUBLIC_BREAK_FREE_SPOTS", env.freeSpots?.trim() ?? "", 0, MAX_FREE_SPOTS);
  const spot = price("NEXT_PUBLIC_BREAK_SPOT_PRICE", env.spotPrice?.trim() ?? "");
  const packs = parsePacks(env.packs?.trim() ?? "");
  for (const v of [paid, free, spot, packs]) if (typeof v === "string") return { kind: "problem", problem: v };
  const shape: BreakShape = { paidSpots: paid as number, freeSpots: free as number, spotPrice: spot as bigint, packs: packs as PackGroup[] };

  const spots = shape.paidSpots + shape.freeSpots;
  if (shape.packs.length > MAX_TIERS) return { kind: "problem", problem: `${PACKS} has ${shape.packs.length} groups; a break lists at most ${MAX_TIERS} machines.` };
  if (spots > MAX_PACKS) return { kind: "problem", problem: `NEXT_PUBLIC_BREAK_PAID_SPOTS + NEXT_PUBLIC_BREAK_FREE_SPOTS is ${spots}; a break has at most ${MAX_PACKS} spots (one pack each).` };
  const { total, count } = packTotals(shape.packs);
  if (count !== spots) return { kind: "problem", problem: `${PACKS} lists ${count} packs but NEXT_PUBLIC_BREAK_PAID_SPOTS + NEXT_PUBLIC_BREAK_FREE_SPOTS is ${spots}: one pack per spot.` };
  // The worst case must fit in 64 bits, as the program checks when it creates the break.
  if (total > U64_MAX) return { kind: "problem", problem: "The next break's worst case does not fit in 64 bits." };
  if (shape.spotPrice > total / BigInt(spots)) return { kind: "problem", problem: "NEXT_PUBLIC_BREAK_SPOT_PRICE must not be above the average pack price in NEXT_PUBLIC_BREAK_PACKS." };
  return { kind: "on", config: shape };
}
