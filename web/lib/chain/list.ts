// The breaks a program has made, newest first, for the list and the home page. Read at `finalized` like the rest.
// A break's number is its on-chain id + 1 (the first break is "Break #1").

import { type BreakAccount, decodeBreak, decodeConfig } from "./accounts";
import { type Address, breakAddress, configAddress } from "./address";
import { LoadError } from "./load";
import { RpcFailure, getAccounts } from "./rpc";

export interface BreakRow {
  number: number;
  break: BreakAccount;
}

export interface BreakList {
  /** How many breaks the program has made. */
  total: number;
  /** Newest first. */
  rows: BreakRow[];
  /** Where to continue for older ones (pass it as `before`); undefined when these reach break #1. */
  older: number | undefined;
}

export interface ListOptions {
  rpcUrl: string;
  breaksProgram: Address;
  /** How many to read (1 to 50). */
  count: number;
  /** Only breaks numbered below this (to continue a list); the newest are read when it is left out. */
  before?: number;
  fetch?: typeof fetch;
}

export const MAX_COUNT = 50;

export async function loadBreakList(opts: ListOptions): Promise<BreakList> {
  if (!Number.isSafeInteger(opts.count) || opts.count < 1 || opts.count > MAX_COUNT) throw new LoadError(`A list holds 1 to ${MAX_COUNT} breaks.`);
  if (opts.before !== undefined && (!Number.isSafeInteger(opts.before) || opts.before < 1)) throw new LoadError("`before` is a break number, a whole number from 1.");
  const read = (addresses: Address[]) => getAccounts({ url: opts.rpcUrl, addresses, ...(opts.fetch ? { fetch: opts.fetch } : {}) });

  try {
    const [config] = await read([configAddress(opts.breaksProgram)]);
    if (!config) throw new LoadError("The breaks program has not been set up on this network (its config account does not exist).");
    if (config.owner !== opts.breaksProgram) throw new LoadError("The config account is not owned by the breaks program.");
    const next = decodeConfig(config.data).nextBreakId;
    if (next > BigInt(Number.MAX_SAFE_INTEGER)) throw new LoadError("The breaks program reports more breaks than this page can count.");
    const total = Number(next);

    // Numbers newest..oldest: from the one below `before` (or the newest) down `count` breaks.
    const newest = Math.min(opts.before === undefined ? total : opts.before - 1, total);
    const oldest = Math.max(1, newest - opts.count + 1);
    const numbers = Array.from({ length: Math.max(0, newest - oldest + 1) }, (_, i) => newest - i);
    const accounts = await read(numbers.map((n) => breakAddress(opts.breaksProgram, BigInt(n - 1))));

    const rows = numbers.map((n, i): BreakRow => {
      const account = accounts[i];
      if (!account) throw new LoadError(`Break #${n} should exist but its account is missing.`);
      if (account.owner !== opts.breaksProgram) throw new LoadError(`The account for break #${n} is not owned by the breaks program.`);
      let b: BreakAccount;
      try {
        b = decodeBreak(account.data);
      } catch (err) {
        throw new LoadError(`The account for break #${n} could not be read: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (b.id !== BigInt(n - 1)) throw new LoadError(`The account for break #${n} says it is break id ${b.id}.`);
      return { number: n, break: b };
    });
    return { total, rows, older: oldest > 1 ? oldest : undefined };
  } catch (err) {
    if (err instanceof LoadError) throw err;
    if (err instanceof RpcFailure) throw new LoadError(err.message);
    throw new LoadError(`Could not read the breaks: ${err instanceof Error ? err.message : String(err)}`);
  }
}
