// Time-weighted average balance (TWAB) over a break's window, from the indexed token transfers.
//
// An owner's balance at time t is the sum, over all of its token accounts, of the balance after
// that account's last event at or before t. TWAB = (integral of the owner's balance over the
// window) / (window length), in whole token base units (rounded down). Exact bigint arithmetic.

export interface BalanceEvent {
  signature: string;
  slot: bigint;
  /** Unix seconds. */
  time: number;
  /** The wallet that owns the token account. */
  owner: string;
  tokenAccount: string;
  /** Change in the token account's balance caused by this event. */
  delta: bigint;
  /** The token account's balance right after this event. */
  balanceAfter: bigint;
}

export interface Window {
  /** Unix seconds; `end` is exclusive and must be after `start`. */
  start: number;
  end: number;
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * A fixed order for events: by time, then slot, then signature, then token account, then owner. It is the order of the
 * published inputs text, so anyone can reproduce it. Inside one slot it is NOT the order the transactions ran in (the
 * data does not say); `chainOrder` recovers that where it matters.
 */
export function sortEvents(events: readonly BalanceEvent[]): BalanceEvent[] {
  return [...events].sort(
    (a, b) =>
      a.time - b.time ||
      (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0) ||
      compareText(a.signature, b.signature) ||
      compareText(a.tokenAccount, b.tokenAccount) ||
      compareText(a.owner, b.owner),
  );
}

/** Most events of one token account in one slot that `chainOrder` tries to put in order; more are left as they are. */
const MAX_SAME_SLOT_CHAIN = 24;

/**
 * Several transactions can change one token account in the same slot (a pool's vault does so all the time), and nothing
 * in the data says which ran first. What does: each event starts where the one before it ended
 * (`balanceAfter − delta` equals the earlier event's `balanceAfter`). Inside every (token account, slot) group this puts
 * the events in an order that chains, keeping the fixed order wherever that already chains. All events of a slot share
 * one block time, so the order inside it changes no area, only whether the history can be checked.
 *
 * A group that cannot be chained (a transaction is missing) is left as it is, and the caller's check then refuses it.
 */
function chainOrder(sorted: readonly BalanceEvent[]): BalanceEvent[] {
  const groups = new Map<string, number[]>();
  sorted.forEach((e, i) => {
    const key = `${e.tokenAccount}\u0000${e.slot}`;
    const list = groups.get(key);
    if (list) list.push(i);
    else groups.set(key, [i]);
  });

  const result = [...sorted];
  /** Where each token account's balance stands after the events handled so far. */
  const standing = new Map<string, bigint>();
  const handled = new Set<string>();
  for (const e of sorted) {
    const key = `${e.tokenAccount}\u0000${e.slot}`;
    const positions = groups.get(key) as number[];
    if (positions.length < 2 || positions.length > MAX_SAME_SLOT_CHAIN) {
      standing.set(e.tokenAccount, e.balanceAfter);
      continue;
    }
    if (handled.has(key)) continue;
    handled.add(key);
    const group = positions.map((i) => sorted[i] as BalanceEvent);
    const ordered = orderByChain(group, standing.get(e.tokenAccount)) ?? group;
    positions.forEach((position, k) => (result[position] = ordered[k] as BalanceEvent));
    standing.set(e.tokenAccount, (ordered[ordered.length - 1] as BalanceEvent).balanceAfter);
  }
  return result;
}

/**
 * An order of `group` in which every event starts where the previous one ended, the first one where the account stood
 * before the slot (`from`; unknown for the account's first events), or undefined if there is none.
 */
function orderByChain(group: readonly BalanceEvent[], from: bigint | undefined): BalanceEvent[] | undefined {
  const before = group.map((e) => e.balanceAfter - e.delta);
  const used = new Array<boolean>(group.length).fill(false);
  const path: number[] = [];

  const extend = (): boolean => {
    if (path.length === group.length) return true;
    const last = (group[path[path.length - 1] as number] as BalanceEvent).balanceAfter;
    for (let i = 0; i < group.length; i++) {
      if (used[i] || before[i] !== last) continue;
      used[i] = true;
      path.push(i);
      if (extend()) return true;
      path.pop();
      used[i] = false;
    }
    return false;
  };

  // The first event starts where the account stood. With no earlier event that is unknown, so it is an event whose
  // starting balance no other event ends on; a pure cycle may start anywhere. The fixed order is tried first.
  const ends = new Set(group.map((e) => e.balanceAfter));
  const all = group.map((_, i) => i);
  const free = all.filter((i) => !ends.has(before[i] as bigint));
  const candidates = from !== undefined ? all.filter((i) => before[i] === from) : free.length > 0 ? free : all;
  for (const start of candidates) {
    used.fill(false);
    path.length = 0;
    used[start] = true;
    path.push(start);
    if (extend()) return path.map((i) => group[i] as BalanceEvent);
  }
  return undefined;
}

/** TWAB of every owner that appears in `events` (including owners whose TWAB is zero). */
export function twabByOwner(events: readonly BalanceEvent[], window: Window): Map<string, bigint> {
  if (!(window.end > window.start)) throw new RangeError("the window must have a positive length");
  const length = BigInt(window.end - window.start);

  const byOwner = new Map<string, BalanceEvent[]>();
  for (const e of chainOrder(sortEvents(events))) {
    const list = byOwner.get(e.owner);
    if (list) list.push(e);
    else byOwner.set(e.owner, [e]);
  }

  const result = new Map<string, bigint>();
  for (const [owner, list] of byOwner) {
    // What each token account held before its first event: the history may start mid-way.
    const accounts = new Map<string, bigint>();
    let total = 0n;
    for (const e of list) {
      if (accounts.has(e.tokenAccount)) continue;
      const initial = e.balanceAfter - e.delta;
      if (initial < 0n) throw new Error(`inconsistent history for ${e.tokenAccount}: negative opening balance`);
      accounts.set(e.tokenAccount, initial);
      total += initial;
    }

    let area = 0n;
    let cursor = window.start;
    for (const e of list) {
      // Events before the window only set the opening balance; events after it change nothing.
      const t = Math.min(Math.max(e.time, window.start), window.end);
      area += total * BigInt(t - cursor);
      cursor = t;
      const before = accounts.get(e.tokenAccount) as bigint;
      if (before + e.delta !== e.balanceAfter) {
        throw new Error(`inconsistent history for ${e.tokenAccount} at ${e.signature}: delta does not lead to the balance`);
      }
      total += e.delta;
      accounts.set(e.tokenAccount, e.balanceAfter);
    }
    area += total * BigInt(window.end - cursor);
    result.set(owner, area / length);
  }
  return result;
}
