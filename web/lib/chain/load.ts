// Loads a break from the chain for the verify page: its account and the accounts of its paid spots, read at
// `finalized`. What the chain does not hold (the eligibility list and the cards) is left for the person to paste.

import type { VerifyInput } from "../verify";
import { toHex } from "../draw/bytes";
import { type BreakAccount, type BreakStatus, type FreeWinner, decodeBreak, decodeSpot } from "./accounts";
import { type Address, breakAddress, spotAddress } from "./address";
import { RpcFailure, getAccounts } from "./rpc";

export class LoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoadError";
  }
}

export interface Loaded {
  /** The number people see: the on-chain id + 1. */
  number: number;
  break: BreakAccount;
  /** The wallet of each paid spot, in purchase order. */
  paidOwners: Address[];
  notes: string[];
}

export interface LoadOptions {
  rpcUrl: string;
  breaksProgram: Address;
  /** "Break #n": the on-chain id + 1. */
  number: number;
  fetch?: typeof fetch;
}

export async function loadBreak(opts: LoadOptions): Promise<Loaded> {
  if (!Number.isSafeInteger(opts.number) || opts.number < 1) throw new LoadError("The break number is a whole number from 1.");
  const id = BigInt(opts.number - 1);
  const read = (addresses: Address[]) => getAccounts({ url: opts.rpcUrl, addresses, ...(opts.fetch ? { fetch: opts.fetch } : {}) });

  try {
    const key = breakAddress(opts.breaksProgram, id);
    const [account] = await read([key]);
    if (!account) throw new LoadError(`There is no break #${opts.number} on this program (yet).`);
    if (account.owner !== opts.breaksProgram) throw new LoadError(`The account for break #${opts.number} is not owned by the breaks program.`);
    const b = decodeBreak(account.data);
    if (b.id !== id) throw new LoadError(`The account for break #${opts.number} says it is break id ${b.id}.`);

    const notes: string[] = [];
    if (b.status === "Cancelled") notes.push("This break was cancelled: nothing was drawn.");

    const addresses = Array.from({ length: b.spotsSold }, (_, i) => spotAddress(opts.breaksProgram, key, i));
    const spots = await read(addresses);
    const paidOwners: Address[] = [];
    for (const [i, s] of spots.entries()) {
      if (!s) throw new LoadError(`Paid spot ${i + 1} of break #${opts.number} should exist but its account is missing.`);
      if (s.owner !== opts.breaksProgram) throw new LoadError(`Paid spot ${i + 1} is not owned by the breaks program.`);
      const spot = decodeSpot(s.data);
      if (spot.breakId !== id || spot.index !== i) throw new LoadError(`The account for paid spot ${i + 1} belongs to another spot.`);
      if (spot.refunded) notes.push(`Paid spot ${i + 1} was refunded.`);
      paidOwners.push(spot.owner);
    }
    return { number: opts.number, break: b, paidOwners, notes };
  } catch (err) {
    if (err instanceof LoadError) throw err;
    if (err instanceof RpcFailure) throw new LoadError(err.message);
    throw new LoadError(`Could not read break #${opts.number}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface FromChain {
  /** Fields of the verify form to fill in. */
  patch: Pick<VerifyInput, "seed" | "freeSpots" | "paidOwners" | "expected">;
  /** The free-spot winners recorded on the break, to compare with the recomputed ones. */
  onChain: NonNullable<VerifyInput["onChain"]>;
  /** What was not filled in, and why. */
  notes: string[];
}

const COMMITTED: readonly BreakStatus[] = ["EligibilityCommitted", "Funded", "PoolCommitted", "RandomnessRequested", "Settled", "Drawn"];
const POOL_COMMITTED: readonly BreakStatus[] = ["PoolCommitted", "RandomnessRequested", "Settled", "Drawn"];
const SEEDED: readonly BreakStatus[] = ["Settled", "Drawn"];

export function inputFromBreak(loaded: Loaded): FromChain {
  const b = loaded.break;
  const notes = [...loaded.notes];
  const expected = { root: "", totalWeight: "", entryCount: "", poolHash: "" };

  if (COMMITTED.includes(b.status)) {
    expected.root = toHex(b.eligibilityRoot);
    expected.totalWeight = b.eligibilityTotalWeight.toString();
    expected.entryCount = String(b.eligibilityCount);
  } else if (b.status !== "Cancelled") {
    notes.push("The eligibility list has not been committed yet, so there is nothing to compare it with.");
  }
  if (POOL_COMMITTED.includes(b.status)) expected.poolHash = toHex(b.poolHash);

  let seed = "";
  if (SEEDED.includes(b.status)) seed = toHex(b.seed);
  else if (b.status !== "Cancelled") notes.push("The randomness has not been settled yet, so there is no seed: the draw has not happened.");

  const winners: FreeWinner[] = b.freeWinners;
  return {
    patch: { seed, freeSpots: String(b.freeSpots), paidOwners: loaded.paidOwners.join("\n"), expected },
    onChain: { winners: winners.map((w) => ({ wallet: w.wallet, start: w.start, weight: w.weight })), complete: b.status === "Drawn" },
    notes,
  };
}
