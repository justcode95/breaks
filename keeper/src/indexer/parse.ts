// What one transaction did to the token accounts of one mint, read from a node's `getTransaction` answer (the
// `jsonParsed` encoding). The node reports every token account's balance before and after in raw base units, so the
// deltas are exact; nothing is taken from a third party's summary of the transaction.

import type { BalanceEvent } from "../eligibility/twab.js";
import type { Address } from "../solana/pubkey.js";

export interface TokenBalanceJson {
  accountIndex: number;
  mint: string;
  /** The wallet that owns the token account. */
  owner?: string;
  uiTokenAmount: { amount: string };
}

export interface TransactionJson {
  slot: number;
  blockTime: number | null;
  meta: {
    err: unknown;
    preTokenBalances?: TokenBalanceJson[] | null;
    postTokenBalances?: TokenBalanceJson[] | null;
    /** Accounts a v0 transaction took from address lookup tables. */
    loadedAddresses?: { writable: string[]; readonly: string[] };
  } | null;
  transaction: {
    signatures: string[];
    message: { accountKeys: (string | { pubkey: string })[] };
  };
}

export interface TransactionEffects {
  events: BalanceEvent[];
  /** The token accounts of the mint that changed or hold something after this transaction: they must be read as well. */
  accounts: Address[];
}

/**
 * The balance changes of `mint` caused by `tx`, which must be the transaction with signature `signature`.
 * Throws on anything it cannot read exactly (a token balance without an owner, no block time): a guess here would
 * put a wrong balance into the public eligibility record.
 */
export function readTransaction(tx: TransactionJson, mint: Address, signature: string): TransactionEffects {
  const first = tx.transaction.signatures[0];
  if (first !== signature) throw new Error(`the node answered with transaction ${first ?? "(none)"} for ${signature}`);
  if (tx.meta === null) throw new Error(`transaction ${signature} has no metadata`);
  // A failed transaction changes no token balance (only the fee is paid).
  if (tx.meta.err !== null && tx.meta.err !== undefined) return { events: [], accounts: [] };
  if (tx.blockTime === null || tx.blockTime === undefined) throw new Error(`transaction ${signature} has no block time yet`);

  const staticKeys = tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
  const loaded = [...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
  const addressAt = (index: number): Address => {
    const found = index < staticKeys.length ? staticKeys[index] : loaded[index - staticKeys.length];
    if (found === undefined) throw new Error(`transaction ${signature}: account index ${index} is out of range`);
    return found;
  };

  const sideOf = (list: TokenBalanceJson[] | null | undefined) => {
    const side = new Map<number, { owner: string; amount: bigint }>();
    for (const b of list ?? []) {
      if (b.mint !== mint) continue;
      if (b.owner === undefined) throw new Error(`transaction ${signature}: token account ${addressAt(b.accountIndex)} has no owner in the node's answer`);
      side.set(b.accountIndex, { owner: b.owner, amount: BigInt(b.uiTokenAmount.amount) });
    }
    return side;
  };
  const pre = sideOf(tx.meta.preTokenBalances);
  const post = sideOf(tx.meta.postTokenBalances);

  const events: BalanceEvent[] = [];
  const accounts: Address[] = [];
  const event = (index: number, owner: string, delta: bigint, balanceAfter: bigint): BalanceEvent => ({
    signature,
    slot: BigInt(tx.slot),
    time: tx.blockTime as number,
    owner,
    tokenAccount: addressAt(index),
    delta,
    balanceAfter,
  });

  for (const index of [...new Set([...pre.keys(), ...post.keys()])].sort((a, b) => a - b)) {
    const before = pre.get(index);
    const after = post.get(index);
    // A new account has no "before", a closed one no "after": both count as an empty balance.
    const beforeAmount = before?.amount ?? 0n;
    const afterAmount = after?.amount ?? 0n;
    const changed: BalanceEvent[] = [];
    if (before && after && before.owner !== after.owner) {
      // The owner changed inside the transaction: the old owner loses what the account held, the new owner gains it.
      if (beforeAmount !== 0n) changed.push(event(index, before.owner, -beforeAmount, 0n));
      if (afterAmount !== 0n) changed.push(event(index, after.owner, afterAmount, afterAmount));
    } else if (afterAmount !== beforeAmount) {
      changed.push(event(index, (after ?? before)!.owner, afterAmount - beforeAmount, afterAmount));
    }
    events.push(...changed);
    if (changed.length > 0 || afterAmount > 0n) accounts.push(addressAt(index));
  }
  return { events, accounts };
}
