// A pretend treasury on a pretend chain, for reading the treasury's history: every operation is a transaction in the shape a
// node gives for `getTransaction` (`jsonParsed`: the accounts, the instructions with their raw data, the treasury's instructions
// that the breaks program called as inner instructions, the token balances before and after), with the accounts the real
// programs would name, at their real addresses. The chain answers `getMultipleAccounts` (with the slot), `getSignaturesForAddress`
// and `getTransaction` like a node, and keeps the treasury's state (balances, reservations, split), the answer to compare with.

import { base58, base64 } from "@scure/base";
import { TREASURY_INSTRUCTIONS } from "../../lib/chain/treasury-history";
import {
  type Address,
  TOKEN_PROGRAM,
  addressFromBytes,
  addressToBytes,
  breakAddress,
  configAddress,
  escrowAddress,
  treasuryAuthorityAddress,
  vaultAddress,
} from "../../lib/chain/address";
import { concat, fromHex, u16le, u64le } from "../../lib/draw/bytes";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type BreakFields, breakFieldsFromVector, configFieldsFromVector, encodeBreak, encodeConfig, encodeTokenAccount, encodeTreasuryConfig } from "./accounts";

interface Case {
  name: string;
  outputs: Record<string, unknown>;
}
const vectors: { programs: { breaks: Address; treasury: Address }; cases: Case[] } = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "..", "programs", "breaks", "instruction-vectors.json"), "utf8"),
);

export const TREASURY: Address = vectors.programs.treasury;
export const BREAKS: Address = vectors.programs.breaks;
export const USDC: Address = addressFromBytes(new Uint8Array(32).fill(0xc5));
export const OTHER_MINT: Address = addressFromBytes(new Uint8Array(32).fill(0xd6));
export const ADMIN: Address = addressFromBytes(new Uint8Array(32).fill(0x0a));
export const KEEPER: Address = addressFromBytes(new Uint8Array(32).fill(0x0b));
export const BUYER: Address = addressFromBytes(new Uint8Array(32).fill(0x0c));
export const ROUTER: Address = addressFromBytes(new Uint8Array(32).fill(0x0d));
export const wallet = (n: number): Address => addressFromBytes(new Uint8Array(32).fill(n));
const SYSTEM: Address = "11111111111111111111111111111111";

const BREAK_SAMPLE = breakFieldsFromVector((vectors.cases.find((c) => c.name === "breaks.account.Break") as Case).outputs);
const CONFIG_SAMPLE = configFieldsFromVector((vectors.cases.find((c) => c.name === "breaks.account.BreaksConfig") as Case).outputs);

const BREAKS_DATA = { create_break: "3a83fddf434b2a52", fund_purchases: "a20d36a1406c7db0", cancel_break: "d71422201c140554", cancel_unfundable: "d0a13f4235a11852" };

interface RawIx {
  programId: Address;
  accounts: Address[];
  data: string;
  stackHeight: number | null;
}
interface ParsedIx {
  programId: Address;
  program: string;
  parsed: unknown;
  stackHeight: number | null;
}
type Ix = RawIx | ParsedIx;

export interface Tx {
  signature: string;
  slot: number;
  blockTime: number;
  keys: Address[];
  instructions: Ix[];
  inner: { index: number; instructions: Ix[] }[];
  pre: { accountIndex: number; mint: Address; owner: Address; uiTokenAmount: { amount: string } }[];
  post: { accountIndex: number; mint: Address; owner: Address; uiTokenAmount: { amount: string } }[];
  failed: boolean;
}

interface TokenState {
  mint: Address;
  owner: Address;
  amount: bigint;
}

const raw = (programId: Address, accounts: Address[], data: Uint8Array, stackHeight: number | null = null): RawIx => ({ programId, accounts, data: base58.encode(data), stackHeight });
const ix = (name: keyof typeof TREASURY_INSTRUCTIONS, ...args: Uint8Array[]) => concat(fromHex(TREASURY_INSTRUCTIONS[name]), ...args);

export class TreasuryChain {
  slot = 500;
  time = 1_800_000_000;
  readonly txs: Tx[] = [];
  readonly tokens = new Map<Address, TokenState>();
  readonly config = { admin: ADMIN, usdcMint: USDC, controller: SYSTEM, subsidyBps: 0, holderBps: 0, lockedSubsidy: 0n, lockedHolder: 0n, bump: 254 };
  readonly breaks = new Map<bigint, BreakFields>();
  readonly configKey = configAddress(TREASURY);
  readonly vaults = { subsidy: vaultAddress(TREASURY, "subsidy"), holder: vaultAddress(TREASURY, "holder") };
  readonly authority = treasuryAuthorityAddress(BREAKS);
  setUpDone = false;
  /** The newest slot the chain has: what a read of the accounts says it is from. */
  get now() {
    return this.slot;
  }

  /** A transaction in a slot of its own (or in the same slot as the one before it). */
  private record(build: (t: { keys: Address[]; instructions: Ix[]; inner: Tx["inner"] }) => void, opts: { failed?: boolean; sameSlot?: boolean } = {}): string {
    if (!opts.sameSlot) this.slot++;
    this.time += 10;
    const signature = base58.encode(new Uint8Array(64).fill(0).map((_, i) => (i === 0 ? 1 + (this.txs.length % 250) : i === 1 ? Math.floor(this.txs.length / 250) + 1 : 7)));
    const before = new Map([...this.tokens].map(([k, v]) => [k, { ...v }]));
    const configBefore = { ...this.config };
    const breaksBefore = new Map(this.breaks);
    const t = { keys: [] as Address[], instructions: [] as Ix[], inner: [] as Tx["inner"] };
    build(t);
    if (opts.failed) {
      this.tokens.clear();
      for (const [k, v] of before) this.tokens.set(k, v);
      Object.assign(this.config, configBefore);
      this.breaks.clear();
      for (const [k, v] of breaksBefore) this.breaks.set(k, v);
    }
    const named = (i: Ix): Address[] => {
      if ("accounts" in i) return i.accounts;
      const info = (i.parsed as { info?: { source?: Address; destination?: Address; authority?: Address } }).info ?? {};
      return [info.authority, info.source, info.destination].filter((a): a is Address => a !== undefined);
    };
    const keys = [...new Set([...t.keys, ...t.instructions.flatMap(named), ...t.inner.flatMap((g) => g.instructions.flatMap(named)), ...t.instructions.map((i) => i.programId)])];
    const side = (state: Map<Address, TokenState>) =>
      keys.flatMap((k, accountIndex) => {
        const s = state.get(k);
        return s ? [{ accountIndex, mint: s.mint, owner: s.owner, uiTokenAmount: { amount: s.amount.toString() } }] : [];
      });
    this.txs.push({ signature, slot: this.slot, blockTime: this.time, keys, instructions: t.instructions, inner: t.inner, pre: side(before), post: side(this.tokens), failed: opts.failed ?? false });
    return signature;
  }

  private move(from: Address, to: Address, amount: bigint) {
    const a = this.tokens.get(from) as TokenState;
    const b = this.tokens.get(to) as TokenState;
    if (a.amount < amount) throw new Error(`${from} holds ${a.amount}, cannot move ${amount}`);
    a.amount -= amount;
    b.amount += amount;
  }

  private transferIx(from: Address, to: Address, authority: Address, amount: bigint, stackHeight: number | null): ParsedIx {
    return { programId: TOKEN_PROGRAM, program: "spl-token", parsed: { type: "transfer", info: { source: from, destination: to, authority, amount: amount.toString() } }, stackHeight };
  }

  /** A USDC account of `owner` holding plenty, made outside the history (as if long ago). */
  usdcAccount(owner: Address, mint: Address = USDC): Address {
    const account = addressFromBytes(Uint8Array.from(addressToBytes(owner)).map((x, i) => (i === 31 ? x ^ 0x55 : i === 30 ? (mint === USDC ? 1 : 2) : x)));
    if (!this.tokens.has(account)) this.tokens.set(account, { mint, owner, amount: 1_000_000_000_000_000_000n });
    return account;
  }

  /** `initialize`; `extra` is sent straight to the holder vault in the same transaction. */
  setUp(subsidyBps = 7000, holderBps = 3000, opts: { failed?: boolean; extra?: bigint } = {}): string {
    const from = opts.extra ? this.usdcAccount(wallet(0x41)) : undefined;
    return this.record((t) => {
      if (!opts.failed) {
        Object.assign(this.config, { subsidyBps, holderBps });
        for (const v of Object.values(this.vaults)) this.tokens.set(v, { mint: USDC, owner: this.configKey, amount: 0n });
        this.setUpDone = true;
      }
      t.instructions.push(
        raw(TREASURY, [ADMIN, TREASURY, wallet(0x31), this.configKey, USDC, this.vaults.subsidy, this.vaults.holder, TOKEN_PROGRAM, SYSTEM], ix("initialize", addressToBytes(ADMIN), u16le(subsidyBps), u16le(holderBps))),
      );
      if (opts.extra && from) {
        this.move(from, this.vaults.holder, opts.extra);
        t.instructions.push(this.transferIx(from, this.vaults.holder, wallet(0x41), opts.extra, null));
      }
    }, opts);
  }

  /** One transaction that deposits (at the split in force) and then changes the split. */
  depositAndSplit(depositor: Address, amount: bigint, subsidyBps: number, holderBps: number): string {
    const from = this.usdcAccount(depositor);
    return this.record((t) => {
      const toSubsidy = (amount * BigInt(this.config.subsidyBps)) / 10_000n;
      this.move(from, this.vaults.subsidy, toSubsidy);
      this.move(from, this.vaults.holder, amount - toSubsidy);
      t.instructions.push(raw(TREASURY, [depositor, from, this.configKey, this.vaults.subsidy, this.vaults.holder, TOKEN_PROGRAM], ix("deposit_fees", u64le(amount))));
      Object.assign(this.config, { subsidyBps, holderBps });
      t.instructions.push(raw(TREASURY, [ADMIN, this.configKey], ix("set_split", u16le(subsidyBps), u16le(holderBps))));
    });
  }

  /** `deposit_fees` from `depositor`; `via` a program that calls the treasury (a router), as an inner instruction. */
  deposit(
    depositor: Address,
    amount: bigint,
    opts: { via?: Address; viaData?: Uint8Array; failed?: boolean; sameSlot?: boolean; extra?: { bucket: "subsidy" | "holder"; amount: bigint } } = {},
  ): string {
    const from = this.usdcAccount(depositor);
    return this.record((t) => {
      const toSubsidy = (amount * BigInt(this.config.subsidyBps)) / 10_000n;
      const shares = { subsidy: toSubsidy, holder: amount - toSubsidy };
      const call = raw(TREASURY, [depositor, from, this.configKey, this.vaults.subsidy, this.vaults.holder, TOKEN_PROGRAM], ix("deposit_fees", u64le(amount)), opts.via ? 2 : null);
      const transfers: Ix[] = [];
      for (const b of ["subsidy", "holder"] as const) {
        if (shares[b] === 0n) continue;
        this.move(from, this.vaults[b], shares[b]);
        transfers.push(this.transferIx(from, this.vaults[b], depositor, shares[b], opts.via ? 3 : 2));
      }
      if (opts.via) {
        t.instructions.push(raw(opts.via, [depositor, from, this.configKey, this.vaults.subsidy, this.vaults.holder, TREASURY, TOKEN_PROGRAM], opts.viaData ?? Uint8Array.of(9)));
        t.inner.push({ index: 0, instructions: [call, ...transfers] });
      } else {
        t.instructions.push(call);
        t.inner.push({ index: 0, instructions: transfers });
      }
      if (opts.extra) {
        // A plain transfer next to the deposit, in the same transaction.
        this.move(from, this.vaults[opts.extra.bucket], opts.extra.amount);
        t.instructions.push(this.transferIx(from, this.vaults[opts.extra.bucket], depositor, opts.extra.amount, null));
      }
    }, opts);
  }

  setSplit(subsidyBps: number, holderBps: number, opts: { sameSlot?: boolean } = {}): string {
    return this.record((t) => {
      Object.assign(this.config, { subsidyBps, holderBps });
      t.instructions.push(raw(TREASURY, [ADMIN, this.configKey], ix("set_split", u16le(subsidyBps), u16le(holderBps))));
    }, opts);
  }

  setController(controller: Address): string {
    return this.record((t) => {
      this.config.controller = controller;
      t.instructions.push(raw(TREASURY, [ADMIN, this.configKey], ix("set_controller", addressToBytes(controller))));
    });
  }

  /** `create_break` of the breaks program, which reserves `subsidy` and `holder` (`lock_funds`, inner); `second`: after another instruction. */
  createBreak(id: bigint, subsidy: bigint, holder: bigint, opts: { sameSlot?: boolean; second?: boolean } = {}): string {
    return this.record((t) => {
      const key = breakAddress(BREAKS, id);
      const escrow = escrowAddress(BREAKS, key);
      if (subsidy + this.config.lockedSubsidy > (this.tokens.get(this.vaults.subsidy)?.amount ?? 0n)) throw new Error("not enough in the subsidy vault");
      if (holder + this.config.lockedHolder > (this.tokens.get(this.vaults.holder)?.amount ?? 0n)) throw new Error("not enough in the holder vault");
      this.config.lockedSubsidy += subsidy;
      this.config.lockedHolder += holder;
      this.breaks.set(id, { ...BREAK_SAMPLE, id, status: "Open", lockedSubsidy: subsidy, lockedHolder: holder });
      this.tokens.set(escrow, { mint: USDC, owner: key, amount: 0n });
      if (opts.second) t.instructions.push(raw(ROUTER, [KEEPER], Uint8Array.of(2, 0, 0, 0)));
      t.instructions.push(
        raw(BREAKS, [KEEPER, configAddress(BREAKS), key, USDC, escrow, this.authority, this.configKey, this.vaults.subsidy, this.vaults.holder, TREASURY, TOKEN_PROGRAM, SYSTEM], concat(fromHex(BREAKS_DATA.create_break), u64le(id))),
      );
      t.inner.push({ index: opts.second ? 1 : 0, instructions: [raw(TREASURY, [this.authority, this.configKey, this.vaults.subsidy, this.vaults.holder], ix("lock_funds", u64le(subsidy), u64le(holder)), 2)] });
    }, opts);
  }

  /** `fund_purchases`: pays `subsidy` and `holder` of what was reserved to the buyer wallet and releases the rest. */
  fund(id: bigint, subsidy: bigint, holder: bigint, opts: { to?: Address; sameSlot?: boolean } = {}): string {
    return this.record((t) => {
      const b = this.breaks.get(id) as BreakFields;
      const key = breakAddress(BREAKS, id);
      const escrow = escrowAddress(BREAKS, key);
      const buyerUsdc = this.usdcAccount(opts.to ?? BUYER);
      const inner: Ix[] = [];
      for (const [bucket, amount, flag] of [["subsidy", subsidy, 0], ["holder", holder, 1]] as const) {
        if (amount === 0n) continue;
        this.move(this.vaults[bucket], buyerUsdc, amount);
        inner.push(raw(TREASURY, [this.authority, this.configKey, this.vaults.subsidy, this.vaults.holder, buyerUsdc, TOKEN_PROGRAM], ix("pay_from_locked", Uint8Array.of(flag), u64le(amount)), 2));
        inner.push(this.transferIx(this.vaults[bucket], buyerUsdc, this.configKey, amount, 3));
      }
      const release = { subsidy: b.lockedSubsidy - subsidy, holder: b.lockedHolder - holder };
      this.config.lockedSubsidy -= b.lockedSubsidy;
      this.config.lockedHolder -= b.lockedHolder;
      if (release.subsidy > 0n || release.holder > 0n) inner.push(raw(TREASURY, [this.authority, this.configKey, this.vaults.subsidy, this.vaults.holder], ix("unlock_funds", u64le(release.subsidy), u64le(release.holder)), 2));
      this.breaks.set(id, { ...b, status: "Funded", lockedSubsidy: 0n, lockedHolder: 0n });
      t.instructions.push(
        raw(BREAKS, [KEEPER, configAddress(BREAKS), key, escrow, buyerUsdc, this.authority, this.configKey, this.vaults.subsidy, this.vaults.holder, TREASURY, TOKEN_PROGRAM], fromHex(BREAKS_DATA.fund_purchases)),
      );
      t.inner.push({ index: 0, instructions: inner });
    }, opts);
  }

  /** `cancel_break` (the admin's) or `cancel_unfundable` (anyone's): releases what the break reserved. */
  cancel(id: bigint, opts: { unfundable?: boolean } = {}): string {
    return this.record((t) => {
      const b = this.breaks.get(id) as BreakFields;
      const key = breakAddress(BREAKS, id);
      this.config.lockedSubsidy -= b.lockedSubsidy;
      this.config.lockedHolder -= b.lockedHolder;
      this.breaks.set(id, { ...b, status: "Cancelled", lockedSubsidy: 0n, lockedHolder: 0n });
      const treasury = [this.authority, this.configKey, this.vaults.subsidy, this.vaults.holder, TREASURY];
      t.instructions.push(
        opts.unfundable
          ? raw(BREAKS, [key, ...treasury], fromHex(BREAKS_DATA.cancel_unfundable))
          : raw(BREAKS, [ADMIN, configAddress(BREAKS), key, ...treasury], fromHex(BREAKS_DATA.cancel_break)),
      );
      t.inner.push({ index: 0, instructions: [raw(TREASURY, [this.authority, this.configKey, this.vaults.subsidy, this.vaults.holder], ix("unlock_funds", u64le(b.lockedSubsidy), u64le(b.lockedHolder)), 2)] });
    });
  }

  /** A plain token transfer into a vault, outside `deposit_fees`. */
  straight(bucket: "subsidy" | "holder", amount: bigint, from: Address = wallet(0x41)): string {
    const source = this.usdcAccount(from);
    return this.record((t) => {
      this.move(source, this.vaults[bucket], amount);
      t.instructions.push(this.transferIx(source, this.vaults[bucket], from, amount, null));
    });
  }

  /** A transaction of another program that names the config (and a vault) and changes nothing in the treasury. */
  noise(opts: { sameSlot?: boolean } = {}): string {
    return this.record((t) => {
      t.instructions.push(raw(ROUTER, [wallet(0x42), this.configKey, this.vaults.subsidy], Uint8Array.of(1, 2, 3)));
    }, opts);
  }

  /** Any transaction, written by hand: `build` names its instructions and changes the state itself. */
  custom(build: (t: { keys: Address[]; instructions: Ix[]; inner: Tx["inner"] }) => void, opts: { failed?: boolean; sameSlot?: boolean } = {}): string {
    return this.record(build, opts);
  }

  /** What the vaults hold now. */
  held(bucket: "subsidy" | "holder"): bigint {
    return this.tokens.get(this.vaults[bucket])?.amount ?? 0n;
  }

  /**
   * A node answering from this chain. `hide` leaves signatures out of the address lists; `drop` makes those transactions unknown;
   * `reverseSlots` lists each slot's transactions the other way round; `edit` changes a transaction as the node gives it.
   */
  node(
    opts: {
      hide?: Set<string>;
      drop?: Set<string>;
      failing?: string;
      reverseSlots?: boolean;
      edit?: (signature: string, tx: any) => void;
      /** Lists these failed transactions as if they succeeded. */
      listAsOk?: Set<string>;
      /** Serves the accounts as they are now, at the slot of now, however many transactions come after. */
      frozen?: boolean;
      /** The slot the accounts are said to be from. */
      slot?: number;
      /** Serves these accounts instead (`null`: none). */
      override?: Map<Address, { data: Uint8Array; owner: Address } | null>;
    } = {},
  ) {
    const calls: { method: string; params: unknown[] }[] = [];
    const live = (): Map<Address, { data: Uint8Array; owner: Address }> => {
      const m = new Map<Address, { data: Uint8Array; owner: Address }>();
      if (this.setUpDone) {
        m.set(this.configKey, { data: encodeTreasuryConfig(this.config), owner: TREASURY });
        for (const v of Object.values(this.vaults)) m.set(v, { data: encodeTokenAccount({ mint: USDC, owner: this.configKey, amount: this.tokens.get(v)?.amount ?? 0n }), owner: TOKEN_PROGRAM });
      }
      m.set(configAddress(BREAKS), { data: encodeConfig({ ...CONFIG_SAMPLE, buyer: BUYER, usdcMint: USDC, nextBreakId: BigInt(this.breaks.size) }), owner: BREAKS });
      for (const [id, b] of this.breaks) m.set(breakAddress(BREAKS, id), { data: encodeBreak(b), owner: BREAKS });
      return m;
    };
    const frozen = opts.frozen ? { accounts: live(), slot: this.slot } : undefined;
    const accounts = () => {
      const m = new Map(frozen?.accounts ?? live());
      for (const [k, v] of opts.override ?? []) {
        if (v) m.set(k, v);
        else m.delete(k);
      }
      return m;
    };
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      calls.push({ method, params });
      const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
      if (method === opts.failing) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: `${method} is failing` } }), { status: 200 });
      if (method === "getMultipleAccounts") {
        const known = accounts();
        const value = (params[0] as Address[]).map((a) => {
          const s = known.get(a);
          return s ? { data: [base64.encode(s.data), "base64"], owner: s.owner, lamports: 1, executable: false } : null;
        });
        return reply({ context: { slot: opts.slot ?? frozen?.slot ?? this.slot }, value });
      }
      if (method === "getSignaturesForAddress") {
        const [address, config] = params as [Address, { limit: number; before?: string }];
        let naming = this.txs.filter((t) => t.keys.includes(address) && !opts.hide?.has(t.signature)).reverse();
        if (opts.reverseSlots) {
          const bySlot = new Map<number, Tx[]>();
          for (const t of naming) bySlot.set(t.slot, [...(bySlot.get(t.slot) ?? []), t]);
          naming = [...bySlot.values()].flatMap((g) => g.reverse());
        }
        const from = config.before === undefined ? 0 : naming.findIndex((t) => t.signature === config.before) + 1;
        return reply(naming.slice(from, from + config.limit).map((t) => ({ signature: t.signature, slot: t.slot, blockTime: t.blockTime, err: t.failed && !opts.listAsOk?.has(t.signature) ? { InstructionError: [0, "Custom"] } : null })));
      }
      if (method === "getTransaction") {
        const [signature] = params as [string];
        const t = this.txs.find((x) => x.signature === signature);
        if (!t || opts.drop?.has(signature)) return reply(null);
        const tx = {
          slot: t.slot,
          blockTime: t.blockTime,
          transaction: { signatures: [t.signature], message: { accountKeys: t.keys.map((pubkey, i) => ({ pubkey, signer: i === 0, writable: true })), instructions: t.instructions } },
          meta: { err: t.failed ? { InstructionError: [0, "Custom"] } : null, innerInstructions: t.inner, preTokenBalances: t.pre, postTokenBalances: t.post },
        };
        // A copy, so an edit changes what this node says and never the chain itself.
        const copy = JSON.parse(JSON.stringify(tx));
        opts.edit?.(signature, copy);
        return reply(copy);
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: `no ${method} here` } }), { status: 200 });
    }) as unknown as typeof fetch;
    return { fetch: fetchFn, calls };
  }
}
