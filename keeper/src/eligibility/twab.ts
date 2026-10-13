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

/** Events in the order they happened: by time, then slot, then signature, then token account. */
export function sortEvents(events: readonly BalanceEvent[]): BalanceEvent[] {
  return [...events].sort(
    (a, b) =>
      a.time - b.time ||
      (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0) ||
      (a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0) ||
      (a.tokenAccount < b.tokenAccount ? -1 : a.tokenAccount > b.tokenAccount ? 1 : 0),
  );
}

/** TWAB of every owner that appears in `events` (including owners whose TWAB is zero). */
export function twabByOwner(events: readonly BalanceEvent[], window: Window): Map<string, bigint> {
  if (!(window.end > window.start)) throw new RangeError("the window must have a positive length");
  const length = BigInt(window.end - window.start);

  const byOwner = new Map<string, BalanceEvent[]>();
  for (const e of sortEvents(events)) {
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
