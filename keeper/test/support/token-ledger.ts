// A pretend token on a pretend chain, for the indexer's tests. It records transactions in the shape a node answers
// with (`getTransaction` with `jsonParsed`, `getSignaturesForAddress`) and keeps its own books of what each one did,
// so a test can compare what the indexer stored with what really happened without using the indexer's own parser.

import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import type { BalanceEvent } from "../../src/eligibility/twab.js";
import type { SignatureInfo, SignaturesQuery, TokenReader } from "../../src/indexer/reader.js";
import { addressFromBytes } from "../../src/solana/pubkey.js";
import type { Fetch } from "../../src/solana/rpc.js";
import type { TransactionJson } from "../../src/indexer/parse.js";

export const address = (n: number): string => {
  const bytes = new Uint8Array(32);
  bytes[0] = n & 0xff;
  bytes[1] = (n >> 8) & 0xff;
  bytes[31] = 7;
  return base58.encode(bytes);
};

/** The ledger's token. */
export const MINT = address(1);

/** What a classic SPL token mint looks like on-chain (82 bytes, initialized). */
export function mintAccountData(): Uint8Array {
  const data = new Uint8Array(82);
  data[45] = 1;
  return data;
}

export interface Holder {
  name: string;
  wallet: string;
  account: string;
}

interface Entry {
  account: string;
  owner: string;
  amount: bigint;
}

interface Recorded {
  signature: string;
  slot: number;
  time: number;
  failed: boolean;
  /** Everything the transaction names, in the order of its account keys. */
  keys: string[];
  /** Keys that came from an address lookup table (version 0). */
  lookedUp: string[];
  /** The token balances a node lists before and after: only accounts that exist at that point. */
  pre: Entry[];
  post: Entry[];
  /** A balance of another token, which the indexer must ignore. */
  noise: boolean;
}

export interface TxOptions {
  /** Share the previous transaction's slot (and time). */
  sameSlot?: boolean;
  signature?: string;
  /** List the mint among the accounts (a `transferChecked` does, a plain `transfer` does not). */
  checked?: boolean;
  /** A version 0 transaction: the token accounts come from a lookup table. */
  v0?: boolean;
  /** Also carry a balance of some other token. */
  noise?: boolean;
}

const OTHER_MINT = address(9999);

/** A JSON-RPC request the pretend node received. */
export interface NodeRequest {
  method: string;
  params: unknown[];
}

export class TokenLedger implements TokenReader {
  readonly mint = MINT;
  readonly payer = address(2);
  /** What really happened, in order (the books). */
  readonly truth: BalanceEvent[] = [];
  readonly calls = { signatures: 0, transactions: 0, fetched: [] as string[] };
  private readonly txs: Recorded[] = [];
  private readonly balances = new Map<string, Entry>();
  private holders = 0;
  private slot = 1_000;
  private time: number;
  private serial = 0;
  /** Slots above this are not finalized yet: the node does not show them. */
  finalizedSlot = Number.POSITIVE_INFINITY;
  /** Make the next calls fail: the n-th call from now throws. */
  private failIn: number | undefined;

  constructor(startTime: number) {
    this.time = startTime;
  }

  holder(name: string): Holder {
    const n = ++this.holders;
    // A real wallet (on the curve): program-derived addresses are never eligible for a free spot.
    return { name, wallet: addressFromBytes(ed25519.getPublicKey(new Uint8Array(32).fill(10 + n))), account: address(500 + n) };
  }

  /** Moves the clock; transactions after this are at `time`. */
  at(time: number): this {
    this.time = time;
    return this;
  }

  get now(): number {
    return this.time;
  }

  balanceOf(h: Holder): bigint {
    return this.balances.get(h.account)?.amount ?? 0n;
  }

  /** Makes the n-th node call from now on throw (1 = the next one). */
  failOnCall(n: number): void {
    this.failIn = n;
  }

  mintTo(to: Holder, amount: bigint, o: TxOptions = {}): string {
    const pre = this.entry(to.account, to.wallet);
    const post = { ...pre, amount: pre.amount + amount };
    return this.record([pre], [post], [this.mint, to.account], { ...o, checked: true });
  }

  transfer(from: Holder, to: Holder, amount: bigint, o: TxOptions = {}): string {
    const a = this.entry(from.account, from.wallet);
    const b = this.entry(to.account, to.wallet);
    if (a.amount < amount) throw new Error(`${from.name} has only ${a.amount}`);
    return this.record(
      [a, b],
      [{ ...a, amount: a.amount - amount }, { ...b, amount: b.amount + amount }],
      [from.account, to.account, ...(o.checked ? [this.mint] : [])],
      o,
    );
  }

  /** Empties and closes the token account. */
  close(h: Holder, to: Holder, o: TxOptions = {}): string {
    const a = this.entry(h.account, h.wallet);
    const b = this.entry(to.account, to.wallet);
    const sig = this.record([a, b], [{ ...b, amount: b.amount + a.amount }], [h.account, to.account], o, { closed: h.account });
    return sig;
  }

  /** A change of the account's owner (SetAuthority), the balance staying where it is. */
  setOwner(h: Holder, newWallet: string, o: TxOptions = {}): string {
    const a = this.entry(h.account, h.wallet);
    return this.record([a], [{ ...a, owner: newWallet }], [h.account], o);
  }

  /** A transaction that names the mint and an account but changes no balance of the token. */
  touch(h: Holder, o: TxOptions = {}): string {
    const a = this.entry(h.account, h.wallet);
    return this.record([a], [a], [h.account, this.mint], { ...o, checked: true });
  }

  /** A transaction that failed: it names the accounts and changes nothing. */
  fail(from: Holder, to: Holder, o: TxOptions = {}): string {
    const a = this.entry(from.account, from.wallet);
    const b = this.entry(to.account, to.wallet);
    return this.record([a, b], [a, b], [from.account, to.account], o, { failed: true });
  }

  private entry(account: string, owner: string): Entry {
    return this.balances.get(account) ?? { account, owner, amount: 0n };
  }

  private record(pre: Entry[], post: Entry[], accounts: string[], o: TxOptions, special: { closed?: string; failed?: boolean } = {}): string {
    if (!o.sameSlot) this.slot += 1;
    const signature = o.signature ?? `sig-${String(++this.serial).padStart(6, "0")}`;
    const failed = special.failed === true;
    const lookedUp = o.v0 ? accounts.filter((a) => a !== this.mint) : [];
    const keys = [this.payer, ...accounts.filter((a) => !lookedUp.includes(a)), ...lookedUp];
    const existed = pre.filter((e) => this.balances.has(e.account));
    this.txs.push({ signature, slot: this.slot, time: this.time, failed, keys, lookedUp, pre: existed, post, noise: o.noise === true });

    if (!failed) {
      // The books: what each account's balance did, by the transaction's own arithmetic.
      const after = new Map(post.map((e) => [e.account, e]));
      for (const before of pre) {
        const now = after.get(before.account);
        if (!now) {
          // closed: its whole balance left
          if (before.amount !== 0n) this.truth.push({ signature, slot: BigInt(this.slot), time: this.time, owner: before.owner, tokenAccount: before.account, delta: -before.amount, balanceAfter: 0n });
          this.balances.delete(before.account);
          continue;
        }
        if (now.owner !== before.owner) {
          if (before.amount !== 0n) this.truth.push({ signature, slot: BigInt(this.slot), time: this.time, owner: before.owner, tokenAccount: before.account, delta: -before.amount, balanceAfter: 0n });
          if (now.amount !== 0n) this.truth.push({ signature, slot: BigInt(this.slot), time: this.time, owner: now.owner, tokenAccount: now.account, delta: now.amount, balanceAfter: now.amount });
        } else if (now.amount !== before.amount) {
          this.truth.push({ signature, slot: BigInt(this.slot), time: this.time, owner: now.owner, tokenAccount: now.account, delta: now.amount - before.amount, balanceAfter: now.amount });
        }
        this.balances.set(now.account, now);
      }
    }
    return signature;
  }

  // --- the node ---------------------------------------------------------------------------------------------------

  private maybeFail(): void {
    if (this.failIn === undefined) return;
    this.failIn -= 1;
    if (this.failIn <= 0) {
      this.failIn = undefined;
      throw new Error("node down");
    }
  }

  private visible(): Recorded[] {
    return this.txs.filter((t) => t.slot <= this.finalizedSlot);
  }

  async signatures(address: string, query: SignaturesQuery): Promise<SignatureInfo[]> {
    this.maybeFail();
    this.calls.signatures += 1;
    let list = this.visible()
      .filter((t) => t.keys.includes(address))
      .reverse();
    if (query.before !== undefined) {
      const at = list.findIndex((t) => t.signature === query.before);
      if (at < 0) throw new Error(`unknown signature ${query.before}`);
      list = list.slice(at + 1);
    }
    if (query.until !== undefined) {
      const at = list.findIndex((t) => t.signature === query.until);
      if (at >= 0) list = list.slice(0, at);
    }
    return list.slice(0, query.limit).map((t) => ({ signature: t.signature, slot: t.slot, failed: t.failed }));
  }

  async transactions(signatures: readonly string[]): Promise<TransactionJson[]> {
    this.maybeFail();
    this.calls.transactions += 1;
    this.calls.fetched.push(...signatures);
    const visible = this.visible();
    return signatures.map((s) => {
      const t = visible.find((x) => x.signature === s);
      if (!t) throw new Error(`no finalized transaction ${s}`);
      return this.wire(t);
    });
  }

  /** Every request that came in through `node()`. */
  readonly requests: NodeRequest[] = [];

  /**
   * The ledger as a JSON-RPC node (`fetch`-shaped), answering `getSignaturesForAddress` and `getTransaction` in the
   * wire format. It only answers finalized reads, like the indexer is meant to ask.
   */
  node(): Fetch {
    return async (_url, init) => {
      const { id, method, params } = JSON.parse(init.body) as { id: number; method: string; params: unknown[] };
      this.requests.push({ method, params });
      const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
      const refuse = (message: string) => ({ jsonrpc: "2.0", id, error: { code: -32602, message } });
      let body: unknown;
      const config = (params[1] ?? {}) as Record<string, unknown>;
      if (config.commitment !== "finalized") {
        body = refuse(`this node only answers finalized reads, got ${String(config.commitment)}`);
      } else if (method === "getSignaturesForAddress") {
        const infos = await this.signatures(params[0] as string, {
          limit: config.limit as number,
          ...(config.before !== undefined ? { before: config.before as string } : {}),
          ...(config.until !== undefined ? { until: config.until as string } : {}),
        });
        const byId = new Map(this.txs.map((t) => [t.signature, t]));
        body = reply(
          infos.map((i) => ({
            signature: i.signature,
            slot: i.slot,
            err: i.failed ? { InstructionError: [0, "Custom"] } : null,
            memo: null,
            blockTime: (byId.get(i.signature) as Recorded).time,
            confirmationStatus: "finalized",
          })),
        );
      } else if (method === "getTransaction") {
        const t = this.visible().find((x) => x.signature === params[0]);
        this.calls.transactions += 1;
        this.calls.fetched.push(params[0] as string);
        body = reply(t ? this.wire(t) : null);
      } else {
        body = refuse(`unexpected method ${method}`);
      }
      const text = JSON.stringify(body);
      return { ok: true, status: 200, statusText: "OK", text: async () => text } as ReturnType<Fetch> extends Promise<infer R> ? R : never;
    };
  }

  /** The transaction as a node answers `getTransaction` with `jsonParsed`. */
  wire(t: Recorded): TransactionJson {
    const index = (account: string) => t.keys.indexOf(account);
    const side = (entries: Entry[], after: boolean) => [
      ...entries.map((e) => ({
        accountIndex: index(e.account),
        mint: this.mint,
        owner: e.owner,
        programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        uiTokenAmount: { amount: e.amount.toString(), decimals: 6, uiAmount: Number(e.amount) / 1e6, uiAmountString: (Number(e.amount) / 1e6).toString() },
      })),
      ...(t.noise
        ? // Another token whose balance really changes in this transaction (a fee paid in it, say): not ours to count.
          [{ accountIndex: 0, mint: OTHER_MINT, owner: this.payer, uiTokenAmount: { amount: after ? "123456789" : "1000", decimals: 6, uiAmount: 0, uiAmountString: "0" } }]
        : []),
    ];
    const answer = {
      slot: t.slot,
      blockTime: t.time,
      version: t.lookedUp.length > 0 ? 0 : "legacy",
      transaction: {
        signatures: [t.signature],
        message: {
          accountKeys: t.keys.map((pubkey, i) => ({
            pubkey,
            signer: i === 0,
            writable: true,
            source: t.lookedUp.includes(pubkey) ? "lookupTable" : "transaction",
          })),
          instructions: [],
          recentBlockhash: "11111111111111111111111111111111",
        },
      },
      meta: {
        err: t.failed ? { InstructionError: [0, "Custom"] } : null,
        fee: 5000,
        preBalances: t.keys.map(() => 1_000_000),
        postBalances: t.keys.map(() => 1_000_000),
        innerInstructions: [],
        logMessages: [],
        preTokenBalances: side(t.pre, false),
        postTokenBalances: side(t.post, true),
        loadedAddresses: { writable: t.lookedUp, readonly: [] },
      },
    };
    return answer as unknown as TransactionJson;
  }
}
