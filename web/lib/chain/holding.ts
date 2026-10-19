// The coin a wallet holds, read in the browser at `finalized`, and the least average balance those tokens give it over the sale
// that is on if they stay where they are. A free-spot list weighs a wallet by its average balance over the sale (TWAB,
// docs/PUBLISHED.md): the area under its balance from the opening to the close, divided by the sale's length, rounded down.
// Tokens held from some moment until the close add at least their amount times the part of the sale still to come. What the
// wallet held earlier in the sale is not read here (that is its whole history, which the keeper reads), so the figure is a floor,
// not a forecast of the list.
//
// The coin's mint is a setting of the site (NEXT_PUBLIC_TOKEN_MINT), copied from the keeper's TOKEN_MINT: the chain does not name
// it anywhere the site could read. The mint may belong to either token program.

import { type Address, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "./address";
import type { BreakRow } from "./list";
import { LoadError } from "./load";
import { type ProgramAccount, RpcFailure, getAccounts, getBlockTime, getTokenAccountsByOwner } from "./rpc";
import { decodeTokenAccount } from "./treasury";

const MINT_LEN = 82;
const TOKEN_ACCOUNT_LEN = 165;
/** Token-2022 pads the classic layout to 165 bytes and then says what the account is (1 a mint, 2 a token account). */
const ACCOUNT_TYPE_OFFSET = 165;

export interface TokenMint {
  address: Address;
  /** The token program the mint belongs to: its token accounts belong to the same one. */
  program: Address;
  decimals: number;
  supply: bigint;
}

/** Reads a mint the way its token program lays it out (`supply` at 36, `decimals` at 44, `is_initialized` at 45). Throws, saying why. */
export function decodeMint(data: Uint8Array, program: Address): { supply: bigint; decimals: number } {
  if (program === TOKEN_PROGRAM) {
    if (data.length !== MINT_LEN) throw new RangeError(`a mint of the token program is ${MINT_LEN} bytes, not ${data.length}`);
  } else if (program === TOKEN_2022_PROGRAM) {
    const extended = data.length > ACCOUNT_TYPE_OFFSET && data[ACCOUNT_TYPE_OFFSET] === 1;
    if (data.length !== MINT_LEN && !extended) throw new RangeError("it is not laid out as a mint of the token program");
  } else {
    throw new RangeError("it is not owned by a token program");
  }
  if (data[45] !== 1) throw new RangeError("it is not an initialized mint");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { supply: view.getBigUint64(36, true), decimals: data[44] as number };
}

/** The tokens in one account the node listed for `owner`, once it is that wallet's account of this mint. Throws, saying why. */
export function tokenAccountAmount(entry: ProgramAccount, mint: TokenMint, owner: Address): bigint {
  const { data, owner: program } = entry.account;
  if (program !== mint.program) throw new RangeError("it does not belong to the token's program");
  const extended = program === TOKEN_2022_PROGRAM && data.length > ACCOUNT_TYPE_OFFSET && data[ACCOUNT_TYPE_OFFSET] === 2;
  if (data.length !== TOKEN_ACCOUNT_LEN && !extended) throw new RangeError("it is not laid out as a token account");
  const t = decodeTokenAccount(data);
  if (t.mint !== mint.address) throw new RangeError("it holds another token");
  if (t.owner !== owner) throw new RangeError("it belongs to another wallet");
  return t.amount;
}

export interface Holding {
  mint: TokenMint;
  /** Every token the wallet holds, in the token's smallest units, summed over its token accounts. */
  total: bigint;
  /** How many of its token accounts hold any. */
  accounts: number;
  /** The slot the balances are from. */
  slot: number;
  /** When that slot's block was made (seconds since 1970), by the chain's clock; `null` when the node could not say. */
  time: number | null;
}

export interface HoldingOptions {
  rpcUrl: string;
  mint: Address;
  owner: Address;
  fetch?: typeof fetch;
}

const short = (a: Address) => `${a.slice(0, 4)}…${a.slice(-4)}`;

/** The wallet's coin, at `finalized`. Throws a `LoadError` that says what is wrong; a block time the node cannot give is `null`. */
export async function loadHolding(opts: HoldingOptions): Promise<Holding> {
  const net = { url: opts.rpcUrl, ...(opts.fetch ? { fetch: opts.fetch } : {}) };
  try {
    const [account] = await getAccounts({ ...net, addresses: [opts.mint] });
    if (!account) throw new LoadError("The token this site is set up for (NEXT_PUBLIC_TOKEN_MINT) does not exist on this network.");
    let decoded: { supply: bigint; decimals: number };
    try {
      decoded = decodeMint(account.data, account.owner);
    } catch (err) {
      throw new LoadError(`The token this site is set up for (NEXT_PUBLIC_TOKEN_MINT) is not a token mint: ${err instanceof Error ? err.message : String(err)}.`);
    }
    const mint: TokenMint = { address: opts.mint, program: account.owner, ...decoded };

    const listed = await getTokenAccountsByOwner({ ...net, owner: opts.owner, mint: opts.mint });
    const seen = new Set<Address>();
    let total = 0n;
    let holding = 0;
    for (const entry of listed.accounts) {
      if (seen.has(entry.address)) throw new LoadError(`The node listed the token account ${short(entry.address)} twice.`);
      seen.add(entry.address);
      let amount: bigint;
      try {
        amount = tokenAccountAmount(entry, mint, opts.owner);
      } catch (err) {
        throw new LoadError(`The node listed ${short(entry.address)} as one of this wallet's token accounts, but ${err instanceof Error ? err.message : String(err)}.`);
      }
      total += amount;
      if (amount > 0n) holding++;
    }

    let time: number | null = null;
    try {
      time = await getBlockTime(net, listed.slot);
    } catch (err) {
      if (!(err instanceof RpcFailure)) throw err;
    }
    return { mint, total, accounts: holding, slot: listed.slot, time };
  } catch (err) {
    if (err instanceof LoadError) throw err;
    if (err instanceof RpcFailure) throw new LoadError(`The wallet's tokens could not be read: ${err.message}.`);
    throw new LoadError(`The wallet's tokens could not be read: ${err instanceof Error ? err.message : String(err)}.`);
  }
}

/** What the tokens held now give the wallet over the sale that is on. Times are the chain's, in seconds. */
export type SaleFloor =
  /** No break is on sale. */
  | { kind: "none" }
  /** A break is on sale, but the time of the balances is not known, so neither is the part of the sale still to come. */
  | { kind: "no-time"; number: number }
  /** The newest break still says it is on sale, but its sale had closed by the time of the balances. */
  | { kind: "closed"; number: number; closesAt: bigint }
  /** The sale had not opened yet: tokens held from the opening to the close count in full. */
  | { kind: "before"; number: number; opensAt: bigint; closesAt: bigint; floor: bigint }
  /** The sale is on: `left` of its `length` seconds were still to come. */
  | { kind: "on"; number: number; closesAt: bigint; left: bigint; length: bigint; floor: bigint };

/**
 * The least average balance over the sale that is on that `balance`, held at `time` and kept until the close, gives the wallet:
 * `balance × (close − max(time, opening)) ÷ length`, rounded down like the list. One break sells at a time; `rows` are newest
 * first, so the first that says it is on sale is the one.
 */
export function saleFloor(rows: readonly BreakRow[], balance: bigint, time: number | null): SaleFloor {
  const row = rows.find((r) => r.break.status === "Open");
  if (!row) return { kind: "none" };
  const { opensAt, closesAt } = row.break;
  if (time === null) return { kind: "no-time", number: row.number };
  const now = BigInt(time);
  if (now >= closesAt) return { kind: "closed", number: row.number, closesAt };
  if (now < opensAt) return { kind: "before", number: row.number, opensAt, closesAt, floor: balance };
  // Here opensAt <= now < closesAt, so the sale has a length.
  const left = closesAt - now;
  const length = closesAt - opensAt;
  return { kind: "on", number: row.number, closesAt, left, length, floor: (balance * left) / length };
}

/** Whether an average balance puts a wallet on a list with this minimum (the record's rule: at least the minimum, and not zero). */
export const reaches = (average: bigint, minTwab: bigint): boolean => average > 0n && average >= minTwab;

/** An amount in the token's smallest units, as tokens: `1234500` with 3 decimals is "1,234.5". */
export function tokenAmount(units: bigint, decimals: number): string {
  const unit = 10n ** BigInt(decimals);
  const whole = (units / unit).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = (units % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction === "" ? whole : `${whole}.${fraction}`;
}
