// A wallet's balance of the coin over the sale that is on, read in the browser from the chain (`finalized`), and the average a
// list would give it: so far, and if it holds what it holds now until the close. The rule is the lists' own (docs/PUBLISHED.md),
// worked out with the page's own `twabByOwner`, from balance events made the way the keeper makes them: one per balance change of
// a token account of the coin, read from the node's balances before and after each transaction.
//
// Which transactions: every one since the opening that names one of the wallet's token accounts of the coin. Those accounts are
// the ones it holds now and any that show up in its own transactions since the opening (one it closed, or gave to another
// wallet, which only it can sign for). Each account's history is pinned at both ends: at the opening by the newest transaction
// before it (the node reports the account's balance after every transaction that names it, a failed one too), or, for an
// account opened during the sale, by its first transaction having found no such account; and at the slot the balances were read
// by what it holds there (nothing, for one it no longer holds). So a history with a transaction missing anywhere does not add up
// and is refused, never shown as a smaller or bigger average.
//
// Written on its own, not shared with the keeper's indexer (keeper/src/indexer/parse.ts reads transactions the same way).

import { U64_MAX } from "../draw/bytes";
import type { InputEvent } from "../twab/inputs";
import { TwabError, twabByOwner } from "../twab/twab";
import type { Address } from "./address";
import { type SignatureInfo, getSignaturesForAddress, getTransaction } from "./rpc";

/** Signatures asked for at a time. */
export const SIGNATURE_PAGE = 100;
/** The most signatures read for one address since the opening. */
export const MAX_SIGNATURES = 1000;
/** The most transactions read for one wallet: more is a history this page does not read. */
export const MAX_TRANSACTIONS = 200;
/** Transactions asked for at once. */
const AT_ONCE = 4;

/** The token balances of one transaction that the node reports for the coin, by the place of the account in the transaction. */
interface Side {
  owner: Address;
  amount: bigint;
}

const DECIMAL = /^(0|[1-9]\d{0,19})$/;

export interface TransactionEffects {
  slot: bigint;
  time: number;
  /** One per balance of the mint that changed; none for a failed transaction. */
  events: InputEvent[];
  /** Every token account of the mint it names, with its owners before and after. */
  holders: { tokenAccount: Address; owner: Address }[];
  /** What each of those accounts held, and who owned it, before and after (an account missing on a side did not exist there). */
  before: ReadonlyMap<Address, Side>;
  after: ReadonlyMap<Address, Side>;
}

/**
 * What `tx`, the node's answer for `signature` (`jsonParsed`), did to the token accounts of `mint`: one event per balance that
 * changed (an account whose owner changed inside it is two: the old owner loses what it held, the new owner gains what it holds),
 * and every account of the mint it names with what it held and who owned it. Throws, saying why, on anything it cannot read
 * exactly.
 */
export function balanceChanges(tx: unknown, signature: string, mint: Address): TransactionEffects {
  const t = tx as {
    slot?: unknown;
    blockTime?: unknown;
    meta?: { err?: unknown; preTokenBalances?: unknown; postTokenBalances?: unknown; loadedAddresses?: { writable?: unknown; readonly?: unknown } } | null;
    transaction?: { signatures?: unknown; message?: { accountKeys?: unknown } };
  } | null;
  const first = Array.isArray(t?.transaction?.signatures) ? t.transaction.signatures[0] : undefined;
  if (first !== signature) throw new Error(`the node answered with another transaction than ${signature}`);
  if (!t?.meta) throw new Error(`transaction ${signature} has no metadata`);
  if (typeof t.slot !== "number" || !Number.isSafeInteger(t.slot) || t.slot < 0) throw new Error(`transaction ${signature} has no slot`);
  if (typeof t.blockTime !== "number" || !Number.isSafeInteger(t.blockTime)) throw new Error(`transaction ${signature} has no block time`);
  const slot = BigInt(t.slot);
  const time = t.blockTime;

  const keys = t.transaction?.message?.accountKeys;
  if (!Array.isArray(keys)) throw new Error(`transaction ${signature} has no list of accounts`);
  const strings = (list: unknown): string[] => {
    if (list === undefined) return [];
    if (!Array.isArray(list) || list.some((x) => typeof x !== "string")) throw new Error(`transaction ${signature} has a malformed list of accounts`);
    return list as string[];
  };
  const addresses = [
    ...keys.map((k: unknown) => {
      const key = typeof k === "string" ? k : (k as { pubkey?: unknown } | null)?.pubkey;
      if (typeof key !== "string") throw new Error(`transaction ${signature} has a malformed list of accounts`);
      return key;
    }),
    // A v0 transaction takes more accounts from lookup tables: the writable ones, then the read-only ones.
    ...strings(t.meta.loadedAddresses?.writable),
    ...strings(t.meta.loadedAddresses?.readonly),
  ];

  const side = (list: unknown): Map<number, Side> => {
    const out = new Map<number, Side>();
    if (list === null || list === undefined) return out;
    if (!Array.isArray(list)) throw new Error(`transaction ${signature} has a malformed list of token balances`);
    for (const b of list as { accountIndex?: unknown; mint?: unknown; owner?: unknown; uiTokenAmount?: { amount?: unknown } }[]) {
      if (typeof b?.mint !== "string") throw new Error(`transaction ${signature} has a token balance without a mint`);
      if (b.mint !== mint) continue;
      const index = b.accountIndex;
      if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index >= addresses.length) {
        throw new Error(`transaction ${signature} has a token balance of an account it does not name`);
      }
      if (out.has(index)) throw new Error(`transaction ${signature} gives one token account two balances`);
      if (typeof b.owner !== "string") throw new Error(`transaction ${signature} does not say who owns token account ${addresses[index]}`);
      const amount = b.uiTokenAmount?.amount;
      if (typeof amount !== "string" || !DECIMAL.test(amount) || BigInt(amount) > U64_MAX) {
        throw new Error(`transaction ${signature} has a balance that is not a whole number of base units`);
      }
      out.set(index, { owner: b.owner, amount: BigInt(amount) });
    }
    return out;
  };
  const pre = side(t.meta.preTokenBalances);
  const post = side(t.meta.postTokenBalances);
  const byAddress = (m: Map<number, Side>) => new Map([...m].map(([index, v]) => [addresses[index] as Address, v]));
  // A failed transaction changes no balance (it only pays its fee), but still says what each account held.
  const failed = t.meta.err !== null && t.meta.err !== undefined;

  const events: InputEvent[] = [];
  const holders: { tokenAccount: Address; owner: Address }[] = [];
  for (const index of [...new Set([...pre.keys(), ...post.keys()])].sort((a, b) => a - b)) {
    const tokenAccount = addresses[index] as Address;
    const before = pre.get(index);
    const after = post.get(index);
    for (const owner of new Set([before?.owner, after?.owner])) if (owner !== undefined) holders.push({ tokenAccount, owner });
    if (failed) continue;
    const event = (owner: Address, delta: bigint, balanceAfter: bigint): InputEvent => ({ signature, slot, time, owner, tokenAccount, delta, balanceAfter });
    // A new account has no balance before, a closed one none after: both count as empty.
    const was = before?.amount ?? 0n;
    const is = after?.amount ?? 0n;
    if (before && after && before.owner !== after.owner) {
      if (was !== 0n) events.push(event(before.owner, -was, 0n));
      if (is !== 0n) events.push(event(after.owner, is, is));
    } else if (is !== was) {
      events.push(event(((after ?? before) as Side).owner, is - was, is));
    }
  }
  return { slot, time, events, holders, before: byAddress(pre), after: byAddress(post) };
}

export interface Sale {
  /** Seconds since 1970, by the chain's clock. */
  opensAt: number;
  closesAt: number;
}

export interface SaleAverages {
  /** The average from the opening to `time`; none when `time` is the opening itself. */
  soFar: bigint | undefined;
  /** The average over the whole sale if the balances stay as they are at `time`. */
  toClose: bigint;
}

/**
 * The wallet's averages over the sale from its balance events (the standing balances included), by the lists' rule. Throws a
 * `TwabError` when the history does not add up.
 */
export function saleAverages(events: readonly InputEvent[], owner: Address, sale: Sale, time: number): SaleAverages {
  const toClose = twabByOwner(events, { start: sale.opensAt, end: sale.closesAt }).get(owner) ?? 0n;
  const soFar = time > sale.opensAt ? (twabByOwner(events, { start: sale.opensAt, end: Math.min(time, sale.closesAt) }).get(owner) ?? 0n) : undefined;
  return { soFar, toClose };
}

/** What each of the wallet's token accounts held at the slot the balances were read: the end every history must reach. */
export function standingEvents(owner: Address, accounts: Iterable<Address>, held: ReadonlyMap<Address, bigint>, slot: number, time: number): InputEvent[] {
  return [...accounts].map((tokenAccount) => {
    const amount = held.get(tokenAccount) ?? 0n;
    return { signature: `(balance at slot ${slot})`, slot: BigInt(slot), time, owner, tokenAccount, delta: 0n, balanceAfter: amount };
  });
}

export interface HistoryOptions {
  rpcUrl: string;
  fetch?: typeof fetch;
  owner: Address;
  mint: Address;
  sale: Sale;
  /** What the wallet's token accounts of the mint held (`loadHolding`), at `slot`, whose block was made at `time`. */
  held: ReadonlyMap<Address, bigint>;
  slot: number;
  time: number;
}

export type SaleHistory =
  | ({ kind: "read"; transactions: number; accounts: number } & SaleAverages)
  /** More history than this page reads. */
  | { kind: "too-much"; message: string }
  /** The node could not give it, or gave something that cannot be read. */
  | { kind: "unreadable"; message: string }
  /** It was read, but a transaction is missing from it. */
  | { kind: "does-not-add-up"; message: string };

class TooMuch extends Error {}

/** The wallet's averages over the sale that is on, from its history of the coin since the opening. Never throws. */
export async function loadSaleHistory(opts: HistoryOptions): Promise<SaleHistory> {
  const net = { url: opts.rpcUrl, ...(opts.fetch ? { fetch: opts.fetch } : {}) };
  const read = new Map<string, TransactionEffects>();
  /** The transactions since the opening: their changes are the history. */
  const inSale = new Set<string>();

  /**
   * The transactions that name `address` since the opening, no later than the balances, that did not fail, newest first; and
   * the newest one before the opening, which says what the address held when the sale opened (none: it did not exist yet).
   */
  const since = async (address: Address): Promise<{ signatures: SignatureInfo[]; opening: SignatureInfo | undefined }> => {
    const signatures: SignatureInfo[] = [];
    let before: string | undefined;
    for (let listed = 0; ; ) {
      const page = await getSignaturesForAddress({ ...net, address, limit: SIGNATURE_PAGE, ...(before !== undefined ? { before } : {}) });
      for (const s of page) {
        if (s.blockTime !== null && s.blockTime < opts.sale.opensAt) return { signatures, opening: s };
        // A transaction after the balances were read belongs to the next read.
        if (s.slot <= opts.slot && !s.failed) signatures.push(s);
      }
      listed += page.length;
      if (page.length < SIGNATURE_PAGE) return { signatures, opening: undefined };
      if (listed >= MAX_SIGNATURES) throw new TooMuch(`more than ${MAX_SIGNATURES} transactions name ${short(address)} since the sale opened`);
      before = (page[page.length - 1] as SignatureInfo).signature;
    }
  };
  const fetchAll = async (signatures: readonly SignatureInfo[]) => {
    const missing = [...new Set(signatures.map((s) => s.signature))].filter((s) => !read.has(s));
    if (read.size + missing.length > MAX_TRANSACTIONS) throw new TooMuch(`it has more than ${MAX_TRANSACTIONS} transactions to read since the sale opened`);
    for (let i = 0; i < missing.length; i += AT_ONCE) {
      await Promise.all(
        missing.slice(i, i + AT_ONCE).map(async (signature) => {
          const tx = await getTransaction({ ...net, signature });
          if (tx === null || tx === undefined) throw new Error(`the node does not have transaction ${signature}`);
          read.set(signature, balanceChanges(tx, signature, opts.mint));
        }),
      );
    }
  };
  const effects = (signature: string) => read.get(signature) as TransactionEffects;

  try {
    // The wallet's own transactions name every account it closed or gave away, which it alone can sign for.
    const own = await since(opts.owner);
    await fetchAll(own.signatures);
    const accounts = new Set<Address>(opts.held.keys());
    for (const s of own.signatures) for (const h of effects(s.signature).holders) if (h.owner === opts.owner) accounts.add(h.tokenAccount);

    const openings: InputEvent[] = [];
    for (const account of accounts) {
      const { signatures, opening } = await since(account);
      await fetchAll(opening ? [...signatures, opening] : signatures);
      for (const s of signatures) inSale.add(s.signature);
      if (opening) {
        // What the account held when the sale opened, for this wallet: nothing if it was another wallet's then.
        const tx = effects(opening.signature);
        const side = tx.after.get(account);
        const amount = side && side.owner === opts.owner ? side.amount : 0n;
        openings.push({ signature: opening.signature, slot: tx.slot, time: tx.time, owner: opts.owner, tokenAccount: account, delta: 0n, balanceAfter: amount });
      } else {
        // Opened during the sale: its first transaction must be the one that opened it.
        const first = signatures[signatures.length - 1];
        if (!first || effects(first.signature).before.has(account)) {
          throw new TwabError("chain", `the history of ${account} as the node gave it does not start where the account was opened, so a transaction is missing`);
        }
      }
    }

    const events = [...inSale].flatMap((s) => effects(s).events).filter((e) => e.owner === opts.owner);
    events.push(...openings, ...standingEvents(opts.owner, accounts, opts.held, opts.slot, opts.time));
    const averages = saleAverages(events, opts.owner, opts.sale, opts.time);
    return { kind: "read", transactions: read.size, accounts: accounts.size, ...averages };
  } catch (err) {
    if (err instanceof TooMuch) return { kind: "too-much", message: err.message };
    if (err instanceof TwabError) return { kind: "does-not-add-up", message: err.message };
    return { kind: "unreadable", message: err instanceof Error ? err.message : String(err) };
  }
}

const short = (a: Address) => `${a.slice(0, 4)}…${a.slice(-4)}`;
