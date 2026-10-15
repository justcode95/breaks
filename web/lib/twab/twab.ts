// A wallet's time-weighted average balance over a break's window, recomputed from the published balance events.
//
// The definition, which docs/PUBLISHED.md also gives: an owner's balance at a time t is the sum, over the owner's token
// accounts, of the balance each held after its last event at or before t. The TWAB is the area under that balance over the
// window divided by the window's length, rounded down to a whole base unit. A token account held, before its first event, what
// that event shows it held before (`balance after − change`): the history may start mid-way. Exact bigint arithmetic.
//
// One thing the data does not say: transactions in the same slot share one block time, and nothing in the record tells which
// ran first. They are put in the one order in which each starts where the one before it ended. That order never changes an area
// (the events share one time), but it decides what an account held before its first slot and whether the history adds up.
// Written on its own, not shared with the keeper's; web/test/twab.test.ts runs it against what the keeper makes of the same
// text (docs/twab-vectors.json).

import type { InputEvent, InputWindow } from "./inputs";

/** Why a history was refused. `opening`: an account would have held less than nothing. `chain`: the events do not add up. */
export class TwabError extends Error {
  constructor(
    readonly kind: "opening" | "chain",
    message: string,
  ) {
    super(message);
    this.name = "TwabError";
  }
}

/** The most transactions in one slot, on one token account, that are put in order; a bigger slot is read in the published order. */
export const MAX_SAME_SLOT = 24;

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The published order: by time, then slot, signature, token account and owner. */
function publishedOrder(events: readonly InputEvent[]): InputEvent[] {
  return [...events].sort(
    (a, b) => a.time - b.time || (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0) || compareText(a.signature, b.signature) || compareText(a.tokenAccount, b.tokenAccount) || compareText(a.owner, b.owner),
  );
}

/**
 * An order of `group` in which every event starts where the one before it ended, or undefined if there is none. Each event is
 * a step from the balance it starts at to the balance it leaves, so an order is a walk that uses every step once (an Eulerian
 * trail), found without trying orders one after another: that would take for ever on a slot of many alike steps.
 *
 * The first event starts where the account stood before the slot (`standing`). Where that is not known, the starting balances
 * are tried in the published order, the first one that has a walk wins: an event that starts where no other event ends
 * when there is one (it is the only start that can work), and otherwise the first event in the published order.
 */
function inChainOrder(group: readonly InputEvent[], standing: bigint | undefined): InputEvent[] | undefined {
  const startsAt = group.map((e) => e.balanceAfter - e.delta);
  const stepsFrom = new Map<bigint, number[]>(); // balance -> the events that start there, in the published order
  startsAt.forEach((balance, i) => {
    const steps = stepsFrom.get(balance);
    if (steps) steps.push(i);
    else stepsFrom.set(balance, [i]);
  });

  const walkFrom = (start: bigint): number[] | undefined => {
    const next = new Map<bigint, number>(); // how many of each balance's steps are used
    const stack: { balance: bigint; via: number | undefined }[] = [{ balance: start, via: undefined }];
    const walk: number[] = [];
    while (stack.length > 0) {
      const top = stack[stack.length - 1] as (typeof stack)[number];
      const steps = stepsFrom.get(top.balance) ?? [];
      const used = next.get(top.balance) ?? 0;
      if (used < steps.length) {
        next.set(top.balance, used + 1);
        const step = steps[used] as number;
        stack.push({ balance: (group[step] as InputEvent).balanceAfter, via: step });
      } else {
        stack.pop();
        if (top.via !== undefined) walk.push(top.via);
      }
    }
    walk.reverse();
    // The search only says what it could reach: it is an order only if it uses every event and each starts where the last ended.
    if (walk.length !== group.length) return undefined;
    let at = start;
    for (const i of walk) {
      if (startsAt[i] !== at) return undefined;
      at = (group[i] as InputEvent).balanceAfter;
    }
    return walk;
  };

  const starts = standing !== undefined ? [standing] : [...new Set(startsAt)];
  for (const start of starts) {
    if (!stepsFrom.has(start)) continue;
    const walk = walkFrom(start);
    if (walk) return walk.map((i) => group[i] as InputEvent);
  }
  return undefined;
}

/** The events with every same-slot group of one token account put in the order its transactions ran in, where that can be told. */
function inRunOrder(events: readonly InputEvent[]): InputEvent[] {
  const sameSlot = new Map<string, number[]>();
  events.forEach((e, position) => {
    const key = `${e.tokenAccount}\n${e.slot}`;
    const positions = sameSlot.get(key);
    if (positions) positions.push(position);
    else sameSlot.set(key, [position]);
  });

  const out = [...events];
  const standing = new Map<string, bigint>(); // what each token account held after the events handled so far
  const done = new Set<string>();
  for (const e of events) {
    const key = `${e.tokenAccount}\n${e.slot}`;
    const positions = sameSlot.get(key) as number[];
    if (positions.length < 2 || positions.length > MAX_SAME_SLOT) {
      standing.set(e.tokenAccount, e.balanceAfter);
      continue;
    }
    if (done.has(key)) continue;
    done.add(key);
    const group = positions.map((p) => events[p] as InputEvent);
    // Events that share a slot share a block time. A record where they do not was not made from one chain.
    if (group.some((g) => g.time !== e.time)) throw new TwabError("chain", `the transactions of slot ${e.slot} on ${e.tokenAccount} do not share one block time`);
    const ordered = inChainOrder(group, standing.get(e.tokenAccount)) ?? group;
    positions.forEach((p, k) => (out[p] = ordered[k] as InputEvent));
    standing.set(e.tokenAccount, (ordered[ordered.length - 1] as InputEvent).balanceAfter);
  }
  return out;
}

/** The TWAB of every owner that has an event in the record (an owner who held nothing in the window is there with zero). */
export function twabByOwner(events: readonly InputEvent[], window: InputWindow): Map<string, bigint> {
  if (!(window.end > window.start)) throw new RangeError("the window must end after it starts");
  const length = BigInt(window.end - window.start);

  const perOwner = new Map<string, InputEvent[]>();
  for (const e of inRunOrder(publishedOrder(events))) {
    const list = perOwner.get(e.owner);
    if (list) list.push(e);
    else perOwner.set(e.owner, [e]);
  }

  const result = new Map<string, bigint>();
  for (const [owner, list] of perOwner) {
    // What each token account held before its first event.
    const held = new Map<string, bigint>();
    let total = 0n;
    for (const e of list) {
      if (held.has(e.tokenAccount)) continue;
      const opening = e.balanceAfter - e.delta;
      if (opening < 0n) throw new TwabError("opening", `${e.tokenAccount} would have held less than nothing before ${e.signature}`);
      held.set(e.tokenAccount, opening);
      total += opening;
    }

    let area = 0n;
    let at = window.start;
    for (const e of list) {
      // An event before the window only sets what the account holds when it opens; one after the window changes nothing.
      const t = Math.min(Math.max(e.time, window.start), window.end);
      area += total * BigInt(t - at);
      at = t;
      if ((held.get(e.tokenAccount) as bigint) + e.delta !== e.balanceAfter) {
        throw new TwabError("chain", `${e.tokenAccount} at ${e.signature}: the change does not lead to the balance, so a transaction is missing`);
      }
      total += e.delta;
      held.set(e.tokenAccount, e.balanceAfter);
    }
    area += total * BigInt(window.end - at);
    result.set(owner, area / length);
  }
  return result;
}
