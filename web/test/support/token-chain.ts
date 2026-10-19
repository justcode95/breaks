// A pretend token on a pretend chain, for reading a wallet's history: every operation is a transaction in the shape a node gives
// for `getTransaction` (`jsonParsed`: the accounts it names, and the token balances before and after with their owners), and the
// chain answers `getSignaturesForAddress` (newest first, `limit` and `before`) and `getTransaction` like a node. It also keeps
// its own books of every token account's balance over time, which the tests use as the answer to compare with.

import type { Address } from "../../lib/chain/address";

export interface Tx {
  signature: string;
  slot: number;
  blockTime: number;
  /** Every address the transaction names; the first ones are its signers. */
  keys: Address[];
  pre: { accountIndex: number; mint: Address; owner: Address; uiTokenAmount: { amount: string } }[];
  post: { accountIndex: number; mint: Address; owner: Address; uiTokenAmount: { amount: string } }[];
  failed: boolean;
}

interface AccountState {
  owner: Address;
  mint: Address;
  amount: bigint;
  open: boolean;
}

export class TokenChain {
  slot = 100;
  time: number;
  readonly txs: Tx[] = [];
  readonly accounts = new Map<Address, AccountState>();
  /** Every account's (time, owner, amount) after each change, in order: the books. */
  readonly books = new Map<Address, { time: number; slot: number; owner: Address; amount: bigint }[]>();

  constructor(
    readonly mint: Address,
    start: number,
  ) {
    this.time = start;
  }

  /** Moves the clock; each later transaction gets its own slot unless `sameSlot`. */
  at(time: number): this {
    this.time = time;
    return this;
  }

  /** A transaction signed by `signers` that changes `changes` accounts; `others` are named too (another mint, a program). */
  private record(signers: Address[], change: (state: Map<Address, AccountState>) => Address[], opts: { failed?: boolean; sameSlot?: boolean; extra?: Address[] } = {}): string {
    if (!opts.sameSlot) this.slot++;
    const signature = `sig${String(this.txs.length + 1).padStart(4, "0")}`;
    const before = new Map([...this.accounts].map(([k, v]) => [k, { ...v }]));
    const touched = change(this.accounts);
    if (opts.failed) {
      this.accounts.clear();
      for (const [k, v] of before) this.accounts.set(k, v);
    }
    const keys = [...new Set([...signers, ...touched, ...(opts.extra ?? [])])];
    const side = (state: Map<Address, AccountState>) =>
      touched.flatMap((account) => {
        const s = state.get(account);
        if (!s || !s.open) return [];
        return [{ accountIndex: keys.indexOf(account), mint: s.mint, owner: s.owner, uiTokenAmount: { amount: s.amount.toString() } }];
      });
    this.txs.push({ signature, slot: this.slot, blockTime: this.time, keys, pre: side(before), post: side(this.accounts), failed: opts.failed ?? false });
    if (!opts.failed) {
      for (const account of touched) {
        const s = this.accounts.get(account);
        const list = this.books.get(account) ?? [];
        list.push({ time: this.time, slot: this.slot, owner: s?.owner ?? "", amount: s?.open ? s.amount : 0n });
        this.books.set(account, list);
      }
    }
    return signature;
  }

  open(account: Address, owner: Address, payer: Address = owner, mint: Address = this.mint): string {
    return this.record([payer], (s) => {
      s.set(account, { owner, mint, amount: 0n, open: true });
      return [account];
    });
  }

  /** Mints `amount` to `account`, signed by the mint's authority. */
  mintTo(account: Address, amount: bigint, opts: { sameSlot?: boolean; failed?: boolean } = {}): string {
    return this.record(
      ["authority"],
      (s) => {
        (s.get(account) as AccountState).amount += amount;
        return [account];
      },
      opts,
    );
  }

  /** Moves `amount` from `from` to `to`, signed by `signer` (the owner of `from`, or a delegate). */
  transfer(from: Address, to: Address, amount: bigint, signer: Address, opts: { sameSlot?: boolean; failed?: boolean; extra?: Address[] } = {}): string {
    return this.record(
      [signer],
      (s) => {
        const a = s.get(from) as AccountState;
        const b = s.get(to) as AccountState;
        if (a.amount < amount) throw new Error("not enough");
        a.amount -= amount;
        b.amount += amount;
        return [from, to];
      },
      opts,
    );
  }

  /** Closes an empty account, signed by its owner. */
  close(account: Address): string {
    const owner = (this.accounts.get(account) as AccountState).owner;
    return this.record([owner], (s) => {
      const a = s.get(account) as AccountState;
      if (a.amount !== 0n) throw new Error("not empty");
      a.open = false;
      return [account];
    });
  }

  /** Gives the account to another wallet, signed by its owner. */
  setOwner(account: Address, owner: Address): string {
    const was = (this.accounts.get(account) as AccountState).owner;
    return this.record([was], (s) => {
      (s.get(account) as AccountState).owner = owner;
      return [account];
    });
  }

  /** A transaction of the wallet that names no token account of the mint (a payment in SOL, say). */
  other(signer: Address): string {
    return this.record([signer], () => []);
  }

  /**
   * The balances as a node gives them now: in a slot of their own, made at the current time, so a later transaction comes in a
   * later slot. What each account of `owner` holds (open accounts only), as `loadHolding` would list them.
   */
  snapshot(owner: Address): { held: Map<Address, bigint>; slot: number; time: number } {
    this.slot++;
    return { held: this.held(owner), slot: this.slot, time: this.time };
  }

  /** What each account of `owner` holds now (open accounts only), as `loadHolding` would list them. */
  held(owner: Address): Map<Address, bigint> {
    return new Map([...this.accounts].filter(([, s]) => s.open && s.owner === owner && s.mint === this.mint).map(([k, s]) => [k, s.amount]));
  }

  /** The books' average balance of `owner` over [start, end): the definition, second by second in bigints. */
  average(owner: Address, start: number, end: number): bigint {
    let area = 0n;
    for (const list of this.books.values()) {
      let amount = 0n;
      let mine = false;
      let at = start;
      for (const entry of list) {
        const t = Math.min(Math.max(entry.time, start), end);
        if (mine) area += amount * BigInt(t - at);
        at = t;
        amount = entry.amount;
        mine = entry.owner === owner;
      }
      if (mine) area += amount * BigInt(end - at);
    }
    return area / BigInt(end - start);
  }

  /**
   * A node answering from this chain. `hide` leaves signatures out of the address lists; `drop` makes those transactions unknown;
   * `untimed` lists those signatures without a block time (a node may not know it yet).
   */
  node(opts: { hide?: Set<string>; drop?: Set<string>; failing?: string; untimed?: Set<string> } = {}) {
    const calls: { method: string; params: unknown[] }[] = [];
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      calls.push({ method, params });
      const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
      if (method === opts.failing) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: `${method} is failing` } }), { status: 200 });
      if (method === "getSignaturesForAddress") {
        const [address, config] = params as [Address, { limit: number; before?: string }];
        const naming = this.txs.filter((t) => t.keys.includes(address) && !opts.hide?.has(t.signature)).reverse();
        const from = config.before === undefined ? 0 : naming.findIndex((t) => t.signature === config.before) + 1;
        return reply(
          naming
            .slice(from, from + config.limit)
            .map((t) => ({ signature: t.signature, slot: t.slot, blockTime: opts.untimed?.has(t.signature) ? null : t.blockTime, err: t.failed ? { InstructionError: [0, "Custom"] } : null })),
        );
      }
      if (method === "getTransaction") {
        const [signature] = params as [string];
        const t = this.txs.find((x) => x.signature === signature);
        if (!t || opts.drop?.has(signature)) return reply(null);
        return reply({
          slot: t.slot,
          blockTime: t.blockTime,
          transaction: { signatures: [t.signature], message: { accountKeys: t.keys.map((pubkey, i) => ({ pubkey, signer: i === 0, writable: true })) } },
          meta: { err: t.failed ? { InstructionError: [0, "Custom"] } : null, preTokenBalances: t.pre, postTokenBalances: t.post },
        });
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: `no ${method} here` } }), { status: 200 });
    }) as unknown as typeof fetch;
    return { fetch: fetchFn, calls };
  }
}
