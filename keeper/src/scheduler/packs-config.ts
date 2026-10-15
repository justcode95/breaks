// The pack list of the break the scheduler makes, as the `BREAK_PACKS` setting writes it: a JSON list of groups, each a
// machine, the most one pack from it may cost (micro-USDC) and how many of the break's packs come from it.
//
//   [{"machine":"pokemon-10","maxPrice":"10000000","count":4},{"machine":"grail-50","maxPrice":"50000000","count":2}]
//
// JSON because a machine label may hold any text (spaces, commas, a dollar sign). Prices are written as strings of digits
// (a number is accepted if it is a whole number the language can hold exactly). The groups are put in order, cheapest
// first, because the program refuses a list that goes down in price: the order they are written in does not matter.

import { packMachineBytes } from "./machine.js";
import type { PackGroup } from "./policy.js";

const U64_MAX = (1n << 64n) - 1n;
const KEYS = ["machine", "maxPrice", "count"];

export type PackGroupsResult = { ok: true; groups: PackGroup[] } | { ok: false; error: string };

export function parsePackGroups(text: string): PackGroupsResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: 'is not valid JSON (write it like [{"machine":"pokemon-25","maxPrice":"25000000","count":12}])' };
  }
  if (!Array.isArray(json) || json.length === 0) return { ok: false, error: "must be a list with at least one group of packs" };

  const groups: PackGroup[] = [];
  for (const [i, item] of json.entries()) {
    const at = `group ${i + 1}`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) return { ok: false, error: `${at} must be an object with machine, maxPrice and count` };
    const o = item as Record<string, unknown>;
    const unknown = Object.keys(o).find((k) => !KEYS.includes(k));
    if (unknown !== undefined) return { ok: false, error: `${at} has "${unknown}", which is not one of machine, maxPrice, count` };

    if (typeof o.machine !== "string") return { ok: false, error: `${at}: machine must be text` };
    let machine: Uint8Array;
    try {
      machine = packMachineBytes(o.machine);
    } catch (err) {
      return { ok: false, error: `${at}: ${err instanceof Error ? err.message : String(err)}` };
    }

    let maxPrice: bigint;
    if (typeof o.maxPrice === "string" && /^\d+$/.test(o.maxPrice)) maxPrice = BigInt(o.maxPrice);
    else if (typeof o.maxPrice === "number" && Number.isSafeInteger(o.maxPrice) && o.maxPrice >= 0) maxPrice = BigInt(o.maxPrice);
    else return { ok: false, error: `${at}: maxPrice must be a whole number of micro-USDC, as a string of digits` };
    if (maxPrice <= 0n || maxPrice > U64_MAX) return { ok: false, error: `${at}: maxPrice must be above zero and fit in 64 bits` };

    if (typeof o.count !== "number" || !Number.isInteger(o.count) || o.count < 1) return { ok: false, error: `${at}: count must be a whole number, at least 1` };

    groups.push({ machine, maxPrice, count: o.count });
  }
  // A stable sort: groups with the same price keep the order they were written in.
  return { ok: true, groups: groups.sort((a, b) => (a.maxPrice < b.maxPrice ? -1 : a.maxPrice > b.maxPrice ? 1 : 0)) };
}
