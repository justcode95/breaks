// What a wallet has in the breaks, read from the chain at `finalized`: the paid spots it owns (found by asking the node for the
// program's Spot accounts with this owner, then checking every one that comes back) and the free spots it won (recorded on the
// breaks themselves, so only the newest breaks are looked at). Nothing here is sent anywhere but to the node.

import { type BreakAccount, SPOT_ACCOUNT_BYTES, SPOT_OWNER_OFFSET, decodeBreak, decodeSpot } from "./accounts";
import { type Address, breakAddress, spotAddress } from "./address";
import { type BreakRow, loadBreakList } from "./list";
import { LoadError } from "./load";
import { RpcFailure, getAccounts, getProgramAccounts } from "./rpc";
import { stageLabel, type Tone, tone } from "./view";

/** The most spots shown for one wallet; a wallet with more is shown its newest and told so. */
export const MAX_SPOTS = 500;
/** How many of the newest breaks are searched for free-spot wins. */
export const FREE_WIN_BREAKS = 50;

export interface MySpot {
  /** The number people see: the on-chain id + 1. */
  breakNumber: number;
  /** Which paid spot of the break, counting from 0. */
  index: number;
  paid: bigint;
  refunded: boolean;
  break: BreakAccount;
}

export interface MyFreeWin {
  breakNumber: number;
  /** The place in the draw order, counting from 1. */
  position: number;
  weight: bigint;
  break: BreakAccount;
}

export interface Mine {
  /** Newest break first, then by spot. */
  spots: MySpot[];
  /** More spots than `MAX_SPOTS` were found; the newest are in `spots`. */
  truncated: boolean;
  /** Newest break first. */
  freeWins: MyFreeWin[];
  /** How many of the breaks were searched for free-spot wins, out of `totalBreaks`. */
  searched: number;
  totalBreaks: number;
  /** The breaks that were searched, newest first (where the wallet stands on their lists is read from these). */
  recent: BreakRow[];
}

export interface MineOptions {
  rpcUrl: string;
  breaksProgram: Address;
  owner: Address;
  fetch?: typeof fetch;
}

export async function loadMine(opts: MineOptions): Promise<Mine> {
  const net = { url: opts.rpcUrl, ...(opts.fetch ? { fetch: opts.fetch } : {}) };
  try {
    const [found, list] = await Promise.all([
      getProgramAccounts({ ...net, program: opts.breaksProgram, dataSize: SPOT_ACCOUNT_BYTES, memcmp: { offset: SPOT_OWNER_OFFSET, bytes: opts.owner } }),
      loadBreakList({ rpcUrl: opts.rpcUrl, breaksProgram: opts.breaksProgram, count: FREE_WIN_BREAKS, ...(opts.fetch ? { fetch: opts.fetch } : {}) }),
    ]);

    // The node did the searching; each answer is only believed if the program's own rules say it can be what it claims.
    // (A break's address is worked out once, not once per spot: finding an address costs about a millisecond.)
    const breakKeys = new Map<bigint, Address>();
    const breakKey = (id: bigint): Address => {
      let key = breakKeys.get(id);
      if (!key) breakKeys.set(id, (key = breakAddress(opts.breaksProgram, id)));
      return key;
    };
    const spots = found.map(({ address, account }) => {
      if (account.owner !== opts.breaksProgram) throw new LoadError("The node returned a spot account that is not owned by the breaks program.");
      let spot: ReturnType<typeof decodeSpot>;
      try {
        spot = decodeSpot(account.data);
      } catch (err) {
        throw new LoadError(`A spot account could not be read: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (spot.owner !== opts.owner) throw new LoadError("The node returned a spot that belongs to another wallet.");
      if (address !== spotAddress(opts.breaksProgram, breakKey(spot.breakId), spot.index)) {
        throw new LoadError("The node returned a spot account at an address the program would not use for it.");
      }
      return spot;
    });
    spots.sort((a, b) => (a.breakId === b.breakId ? a.index - b.index : a.breakId > b.breakId ? -1 : 1));
    const truncated = spots.length > MAX_SPOTS;
    const kept = spots.slice(0, MAX_SPOTS);

    // The breaks those spots are in: they must exist, since a spot cannot be bought without one.
    const ids = [...new Set(kept.map((s) => s.breakId))];
    const accounts = await getAccounts({ ...net, addresses: ids.map(breakKey) });
    const breaks = new Map<bigint, BreakAccount>();
    ids.forEach((id, i) => {
      const number = Number(id) + 1;
      const account = accounts[i];
      if (!account) throw new LoadError(`Break #${number} has a spot of this wallet but its account is missing.`);
      if (account.owner !== opts.breaksProgram) throw new LoadError(`The account for break #${number} is not owned by the breaks program.`);
      let b: BreakAccount;
      try {
        b = decodeBreak(account.data);
      } catch (err) {
        throw new LoadError(`The account for break #${number} could not be read: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (b.id !== id) throw new LoadError(`The account for break #${number} says it is break id ${b.id}.`);
      breaks.set(id, b);
    });

    const freeWins = list.rows.flatMap(({ number, break: b }) =>
      b.freeWinners.flatMap((w, i) => (w.wallet === opts.owner ? [{ breakNumber: number, position: i + 1, weight: w.weight, break: b }] : [])),
    );
    return {
      spots: kept.map((s) => ({ breakNumber: Number(s.breakId) + 1, index: s.index, paid: s.paid, refunded: s.refunded, break: breaks.get(s.breakId) as BreakAccount })),
      truncated,
      freeWins,
      searched: list.rows.length,
      totalBreaks: list.total,
      recent: list.rows,
    };
  } catch (err) {
    if (err instanceof LoadError) throw err;
    if (err instanceof RpcFailure) throw new LoadError(err.message);
    throw new LoadError(`Could not read this wallet's spots: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Where one paid spot stands, in a few words, with the badge colour for it. A refunded spot is over whatever the break did next. */
export function spotState(spot: Pick<MySpot, "refunded" | "break">, now: number): { label: string; tone: Tone } {
  if (spot.refunded) return { label: "Refunded", tone: "off" };
  if (spot.break.status === "Cancelled") return { label: "Cancelled: can be refunded", tone: "waiting" };
  return { label: stageLabel(spot.break, now), tone: tone(spot.break, now) };
}
