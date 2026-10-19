// The treasury's history, read in the browser from the chain (`finalized`): every transaction that named its config account or
// one of its two vaults, newest first, with what it did to the vaults and to what is reserved for breaks.
//
// The amounts are the vaults' balances before and after each transaction, as the network recorded them (the same token balances
// the wallet history reads, `balanceChanges`). What a transaction did comes from the treasury program's own instructions in it,
// called directly or by the breaks program (whose instruction, and the break it names, say what for): a deposit, a reservation, a
// release, a pay-out, a change of the split or of the controller, the set-up. Only a transaction that succeeded did anything.
//
// Checked on the way back from what the vaults hold now:
// - each vault's balances chain: every transaction starts where the one before it ended, and the newest ends at what the vault
//   holds now, so a transaction that moved money and is missing from what the node gave shows up as a gap. Transactions of one
//   slot have no order in the data, so within a slot it is enough that some order chains;
// - the money of each transaction is what its instructions say: a deposit adds its amount, split by the split in force (known
//   from the config back to the newest change of the split), a pay-out takes its amount; anything a vault gained beyond that
//   was sent straight to it, outside a deposit; anything it lost beyond that is a problem;
// - what is reserved never goes below nothing or above what a vault holds, and is nothing at the set-up, so a missing
//   reservation shows up once the history is read back to the set-up;
// - the newest change of the split is the split the config has now.

import { base58 } from "@scure/base";
import { toHex } from "../draw/bytes";
import { decodeBreak, decodeConfig } from "./accounts";
import { type Address, type Bucket, addressFromBytes, breakAddress, configAddress, treasuryAuthorityAddress } from "./address";
import { LoadError } from "./load";
import { RpcFailure, type SignatureInfo, getAccounts, getAccountsAt, getSignaturesForAddress, getTransaction } from "./rpc";
import { type TransactionEffects, balanceChanges } from "./history";
import { treasuryAddresses, treasuryFromAccounts } from "./treasury";
import { money, share } from "./view";

/** Rows shown at a time. */
export const ROWS_PER_PAGE = 20;
/** The most transactions read for one page: a page of transactions that changed nothing ends early. */
export const MAX_READ_PER_PAGE = 60;
/** The most transactions of one slot this page puts in order. */
export const MAX_SAME_SLOT = 12;
/** Signatures asked for at a time. */
const SIGNATURE_PAGE = 100;
/** The most signatures looked through for one page (failed transactions and newer ones are skipped without being read). */
const MAX_LISTED_PER_PAGE = 1000;
/** Transactions asked for at once. */
const AT_ONCE = 4;
const BPS = 10_000n;

/** The treasury program's instructions (the first 8 bytes of their data), as in programs/treasury/instruction-vectors.json. */
export const TREASURY_INSTRUCTIONS = {
  initialize: "afaf6d1f0d989bed",
  deposit_fees: "0dd7af4835155905",
  set_split: "854342f572af2033",
  set_controller: "89171295361dc3a5",
  lock_funds: "ab3109569c9b0258",
  unlock_funds: "af7710f58d37ff2b",
  pay_from_locked: "59f39cfbb3692d2b",
} as const;

/** The breaks program's instructions that call the treasury, and where the break is among each one's accounts. */
export const BREAKS_STEPS = {
  create_break: { data: "3a83fddf434b2a52", breakAccount: 2 },
  fund_purchases: { data: "a20d36a1406c7db0", breakAccount: 2 },
  cancel_break: { data: "d71422201c140554", breakAccount: 2 },
  cancel_unfundable: { data: "d0a13f4235a11852", breakAccount: 0 },
} as const;
export type BreakStep = keyof typeof BREAKS_STEPS;

export interface Split {
  subsidyBps: number;
  holderBps: number;
}

export type Action =
  | ({ kind: "set-up"; admin: Address } & Split)
  | { kind: "deposit"; amount: bigint; depositor: Address }
  | ({ kind: "split" } & Split)
  | { kind: "controller"; controller: Address }
  | { kind: "reserve"; subsidy: bigint; holder: bigint }
  | { kind: "release"; subsidy: bigint; holder: bigint }
  /** `recipient`: the wallet that owns the token account paid, when the transaction says. */
  | { kind: "pay"; bucket: Bucket; amount: bigint; destination: Address; recipient?: Address };

/** The treasury instructions one instruction of the transaction ran: itself, or the ones it called. */
export interface Call {
  /** The program of the transaction's instruction, when it is not the treasury itself. */
  caller?: Address;
  /** The breaks program's instruction that called the treasury. */
  step?: BreakStep;
  /** The break that instruction names, and "Break #n" once its account has been read. */
  breakKey?: Address;
  breakNumber?: number;
  actions: Action[];
}

export interface Movement {
  signature: string;
  slot: number;
  /** When its block was made, seconds since 1970, by the chain's clock. */
  time: number;
  calls: Call[];
  /** What each vault gained (above zero) or lost (below). */
  change: Record<Bucket, bigint>;
  /** Money that reached a vault without a deposit; without a bucket when the split in force is not known. */
  straight: { bucket?: Bucket; amount: bigint }[];
  /** What it did not add up to, in words. */
  problems: string[];
}

export interface HistoryOptions {
  rpcUrl: string;
  fetch?: typeof fetch;
  treasuryProgram: Address;
  /** To say which break a reservation or pay-out was for, and whether a pay-out went to the buyer wallet. */
  breaksProgram?: Address;
}

interface Stream {
  address: Address;
  buffer: SignatureInfo[];
  before?: string;
  lastSlot?: number;
  done: boolean;
}

/** Where a page ended: what reading older transactions starts from. Only `loadTreasuryHistory` looks inside. */
export interface HistoryCursor {
  usdcMint: Address;
  vaults: Record<Bucket, Address>;
  anchorSlot: number;
  streams: Stream[];
  seen: Set<string>;
  /** Each vault's balance before the oldest transaction read so far (`null`: before it existed), and which one that was. */
  balance: Record<Bucket, bigint | null>;
  /** Where the balance before that came from, in words: the next transaction that names the vault, or none (what it holds now). */
  newer: Record<Bucket, string | undefined>;
  reserved: Record<Bucket, bigint>;
  split: Split | undefined;
  breakNumbers: Map<Address, number | null>;
  buyer?: Address;
  authority?: Address;
}

export interface HistoryPage {
  rows: Movement[];
  /** Transactions that named the treasury and changed nothing in it: not listed. */
  quiet: number;
  /** Read back to the set-up: there is nothing older. */
  complete: boolean;
  /** The node has nothing older, yet the set-up was not among what it gave. */
  ended: boolean;
  /** What does not add up beyond a single transaction. */
  problems: string[];
  /** The buyer wallet the breaks program names now, and its signer for the treasury, when the breaks program is known. */
  buyer?: Address;
  authority?: Address;
  /** To read older transactions; none when there are none. */
  cursor?: HistoryCursor;
}

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const BUCKETS: readonly Bucket[] = ["subsidy", "holder"];

/** What `amount` gives each bucket at `split`: the program's own rule (programs/treasury/src/math.rs). */
export function splitDeposit(amount: bigint, split: Split): Record<Bucket, bigint> {
  const subsidy = (amount * BigInt(split.subsidyBps)) / BPS;
  return { subsidy, holder: amount - subsidy };
}

/** One page of the treasury's history: the newest, or with `cursor` the next older ones. Throws a `LoadError` saying what went wrong. */
export async function loadTreasuryHistory(opts: HistoryOptions, cursor?: HistoryCursor): Promise<HistoryPage> {
  const net = { url: opts.rpcUrl, ...(opts.fetch ? { fetch: opts.fetch } : {}) };
  try {
    const c = cursor ? structuredClone(cursor) : await start(opts, net);
    const rows: Movement[] = [];
    const problems: string[] = [];
    let quiet = 0;
    let read = 0;
    let listed = 0;
    let complete = false;
    let ended = false;
    while (rows.length < ROWS_PER_PAGE && read < MAX_READ_PER_PAGE && listed < MAX_LISTED_PER_PAGE) {
      const group = await nextSlot(c, net, (n) => (listed += n));
      if (!group) {
        ended = true;
        break;
      }
      const live = group.filter((s) => !s.failed);
      if (live.length === 0) continue;
      if (live.length > MAX_SAME_SLOT) {
        throw new LoadError(`More than ${MAX_SAME_SLOT} transactions named the treasury in slot ${live[0]?.slot}: this page cannot put them in order.`);
      }
      const txs = await readAll(live, opts, c, net);
      read += live.length;
      const done = walk(c, txs);
      for (const m of txs.map((t) => t.movement)) {
        // A vault that changed with no instruction to explain it has money sent straight to it, or a problem.
        if (m.calls.length > 0 || m.straight.length > 0 || m.problems.length > 0) rows.push(m);
        else quiet++;
      }
      if (done) {
        complete = true;
        if (c.reserved.subsidy !== 0n || c.reserved.holder !== 0n) {
          problems.push(
            `What is reserved now is not explained by the reservations listed: they leave ${money(c.reserved.subsidy)} of the subsidy bucket and ${money(c.reserved.holder)} of the holder bucket reserved before the treasury was set up, when nothing could be. A reservation is missing from what the node gave.`,
          );
        }
        break;
      }
    }
    await nameBreaks(rows, opts, c, net, problems);
    const more = !complete && !ended;
    return {
      rows,
      quiet,
      complete,
      ended,
      problems,
      ...(c.buyer ? { buyer: c.buyer } : {}),
      ...(c.authority ? { authority: c.authority } : {}),
      ...(more ? { cursor: c } : {}),
    };
  } catch (err) {
    if (err instanceof LoadError) throw err;
    if (err instanceof RpcFailure) throw new LoadError(`Could not read the treasury's history: ${err.message}`);
    throw new LoadError(`Could not read the treasury's history: ${err instanceof Error ? err.message : String(err)}`);
  }
}

type Net = { url: string; fetch?: typeof fetch };

/** The state now: the treasury (and the breaks program's config, for the buyer wallet), and the slot it is from. */
async function start(opts: HistoryOptions, net: Net): Promise<HistoryCursor> {
  const addresses = treasuryAddresses(opts.treasuryProgram);
  const breaksConfig = opts.breaksProgram ? configAddress(opts.breaksProgram) : undefined;
  const { slot, accounts } = await getAccountsAt({ ...net, addresses: breaksConfig ? [...addresses, breaksConfig] : addresses });
  const treasury = treasuryFromAccounts(opts.treasuryProgram, accounts);
  let buyer: Address | undefined;
  const b = accounts[3];
  if (opts.breaksProgram && b && b.owner === opts.breaksProgram) {
    try {
      buyer = decodeConfig(b.data).buyer;
    } catch {
      // Without it, a pay-out names the wallet it went to and does not say whether that is the buyer wallet.
    }
  }
  const [config, subsidy, holder] = addresses;
  return {
    usdcMint: treasury.config.usdcMint,
    vaults: { subsidy, holder },
    anchorSlot: slot,
    streams: [config, subsidy, holder].map((address) => ({ address, buffer: [], done: false })),
    seen: new Set(),
    balance: { subsidy: treasury.subsidy.balance, holder: treasury.holder.balance },
    newer: { subsidy: undefined, holder: undefined },
    reserved: { subsidy: treasury.config.lockedSubsidy, holder: treasury.config.lockedHolder },
    split: { subsidyBps: treasury.config.subsidyBps, holderBps: treasury.config.holderBps },
    breakNumbers: new Map(),
    ...(buyer ? { buyer } : {}),
    ...(opts.breaksProgram ? { authority: treasuryAuthorityAddress(opts.breaksProgram) } : {}),
  };
}

/** The next signature of `s` that is not newer than the state the walk starts from, reading more of its list when needed. */
async function head(s: Stream, c: HistoryCursor, net: Net, count: (n: number) => void): Promise<SignatureInfo | undefined> {
  for (;;) {
    while (s.buffer.length > 0 && (s.buffer[0] as SignatureInfo).slot > c.anchorSlot) s.buffer.shift();
    if (s.buffer.length > 0 || s.done) return s.buffer[0];
    const page = await getSignaturesForAddress({ ...net, address: s.address, limit: SIGNATURE_PAGE, ...(s.before !== undefined ? { before: s.before } : {}) });
    count(page.length);
    for (const entry of page) {
      if (s.lastSlot !== undefined && entry.slot > s.lastSlot) throw new LoadError(`The node listed the transactions of ${short(s.address)} out of order.`);
      s.lastSlot = entry.slot;
    }
    if (page.length < SIGNATURE_PAGE) s.done = true;
    if (page.length > 0) s.before = (page[page.length - 1] as SignatureInfo).signature;
    s.buffer.push(...page);
  }
}

/** Every transaction of the newest slot not read yet, from the three lists together, each once; none when the lists are done. */
async function nextSlot(c: HistoryCursor, net: Net, count: (n: number) => void): Promise<SignatureInfo[] | undefined> {
  let slot: number | undefined;
  for (const s of c.streams) {
    const h = await head(s, c, net, count);
    if (h && (slot === undefined || h.slot > slot)) slot = h.slot;
  }
  if (slot === undefined) return undefined;
  const group: SignatureInfo[] = [];
  for (const s of c.streams) {
    for (let h = await head(s, c, net, count); h && h.slot === slot; h = await head(s, c, net, count)) {
      s.buffer.shift();
      if (c.seen.has(h.signature)) continue;
      c.seen.add(h.signature);
      group.push(h);
    }
  }
  return group;
}

interface Read {
  movement: Movement;
  effects: TransactionEffects;
  /** The transaction failed: it did nothing. */
  failed: boolean;
}

async function readAll(list: readonly SignatureInfo[], opts: HistoryOptions, c: HistoryCursor, net: Net): Promise<Read[]> {
  const out: Read[] = [];
  for (let i = 0; i < list.length; i += AT_ONCE) {
    out.push(
      ...(await Promise.all(
        list.slice(i, i + AT_ONCE).map(async (info) => {
          const tx = await getTransaction({ ...net, signature: info.signature });
          if (tx === null || tx === undefined) throw new LoadError(`The node lists transaction ${short(info.signature)} but does not give it.`);
          let effects: TransactionEffects;
          try {
            effects = balanceChanges(tx, info.signature, c.usdcMint);
          } catch (err) {
            throw new LoadError(`Transaction ${short(info.signature)} could not be read: ${err instanceof Error ? err.message : String(err)}`);
          }
          if (effects.slot !== BigInt(info.slot)) throw new LoadError(`The node gives transaction ${short(info.signature)} two different slots.`);
          return read(tx, info, effects, opts, c);
        }),
      )),
    );
  }
  return out;
}

/** What one transaction did, before it is checked against the others. */
function read(tx: unknown, info: SignatureInfo, effects: TransactionEffects, opts: HistoryOptions, c: HistoryCursor): Read {
  const meta = (tx as { meta?: { err?: unknown } }).meta;
  const failed = meta?.err !== null && meta?.err !== undefined;
  const problems: string[] = [];
  const calls = failed ? [] : treasuryCalls(tx, opts, problems);
  for (const call of calls) {
    for (const a of call.actions) if (a.kind === "pay") {
      const recipient = effects.after.get(a.destination)?.owner;
      if (recipient !== undefined) a.recipient = recipient;
    }
  }
  const change = {} as Record<Bucket, bigint>;
  for (const b of BUCKETS) {
    const before = effects.before.get(c.vaults[b]);
    const after = effects.after.get(c.vaults[b]);
    change[b] = (after?.amount ?? 0n) - (before?.amount ?? 0n);
    if (before && !after) problems.push(`The node gives the ${b} vault a balance before this transaction and none after it.`);
  }
  return { movement: { signature: info.signature, slot: info.slot, time: Number(effects.time), calls, change, straight: [], problems }, effects, failed };
}

export interface Instruction {
  programId: string;
  accounts: string[];
  data: Uint8Array;
}

/** The transaction's instruction as the node gives it (`jsonParsed`): only an instruction of a program the node cannot parse has raw data. */
function instruction(ix: unknown): Instruction | { programId: string; parsed: true } | undefined {
  const i = ix as { programId?: unknown; accounts?: unknown; data?: unknown; parsed?: unknown } | null;
  if (typeof i?.programId !== "string") return undefined;
  if (i.parsed !== undefined) return { programId: i.programId, parsed: true };
  if (!Array.isArray(i.accounts) || i.accounts.some((a) => typeof a !== "string") || typeof i.data !== "string") return undefined;
  let data: Uint8Array;
  try {
    data = base58.decode(i.data);
  } catch {
    return undefined;
  }
  return { programId: i.programId, accounts: i.accounts as string[], data };
}

/** The treasury instructions of a transaction that succeeded, grouped by the instruction of the transaction they belong to. */
function treasuryCalls(tx: unknown, opts: HistoryOptions, problems: string[]): Call[] {
  const t = tx as { transaction?: { message?: { instructions?: unknown } }; meta?: { innerInstructions?: unknown } };
  const top = t.transaction?.message?.instructions;
  if (!Array.isArray(top)) {
    problems.push("The node does not give this transaction's instructions, so what it did is not known.");
    return [];
  }
  const inner = new Map<number, unknown[]>();
  const listed = t.meta?.innerInstructions;
  if (Array.isArray(listed)) {
    for (const entry of listed as { index?: unknown; instructions?: unknown }[]) {
      if (typeof entry?.index === "number" && Array.isArray(entry.instructions)) inner.set(entry.index, entry.instructions);
    }
  } else if (listed !== undefined && listed !== null) {
    problems.push("The node gives this transaction's inner instructions in a form this page cannot read.");
  }

  const calls: Call[] = [];
  for (const [index, raw] of top.entries()) {
    const ix = instruction(raw);
    if (!ix) {
      problems.push(`Instruction ${index + 1} of this transaction could not be read.`);
      continue;
    }
    if (ix.programId === opts.treasuryProgram) {
      const action = "parsed" in ix ? undefined : treasuryAction(ix, problems);
      if ("parsed" in ix) problems.push("The node gives an instruction of the treasury program in a form this page cannot read.");
      if (action) calls.push({ actions: [action] });
      continue;
    }
    const actions: Action[] = [];
    for (const r of inner.get(index) ?? []) {
      const sub = instruction(r);
      if (sub?.programId !== opts.treasuryProgram) continue;
      if ("parsed" in sub) {
        problems.push("The node gives an instruction of the treasury program in a form this page cannot read.");
        continue;
      }
      const action = treasuryAction(sub, problems);
      if (action) actions.push(action);
    }
    if (actions.length === 0) continue;
    const call: Call = { caller: ix.programId, actions };
    if (opts.breaksProgram && ix.programId === opts.breaksProgram && !("parsed" in ix)) {
      const disc = toHex(ix.data.slice(0, 8));
      for (const [step, { data, breakAccount }] of Object.entries(BREAKS_STEPS) as [BreakStep, (typeof BREAKS_STEPS)[BreakStep]][]) {
        if (disc !== data) continue;
        call.step = step;
        const key = ix.accounts[breakAccount];
        if (key !== undefined) call.breakKey = key;
      }
    }
    calls.push(call);
  }
  return calls;
}

/** One treasury instruction, read by its first 8 bytes; a problem (and nothing) for one this page does not know or cannot read. */
export function treasuryAction(ix: Instruction, problems: string[]): Action | undefined {
  const d = ix.data;
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const u64 = (at: number) => view.getBigUint64(at, true);
  const u16 = (at: number) => view.getUint16(at, true);
  const sized = (n: number) => {
    if (d.length === n) return true;
    problems.push(`An instruction of the treasury program in this transaction is ${d.length} bytes long where ${n} were expected.`);
    return false;
  };
  const account = (i: number): Address | undefined => {
    const a = ix.accounts[i];
    if (a === undefined) problems.push("An instruction of the treasury program in this transaction names too few accounts.");
    return a;
  };
  switch (toHex(d.slice(0, 8))) {
    case TREASURY_INSTRUCTIONS.initialize:
      return sized(44) ? { kind: "set-up", admin: addressFromBytes(d.slice(8, 40)), subsidyBps: u16(40), holderBps: u16(42) } : undefined;
    case TREASURY_INSTRUCTIONS.deposit_fees: {
      const depositor = account(0);
      return sized(16) && depositor !== undefined ? { kind: "deposit", amount: u64(8), depositor } : undefined;
    }
    case TREASURY_INSTRUCTIONS.set_split:
      return sized(12) ? { kind: "split", subsidyBps: u16(8), holderBps: u16(10) } : undefined;
    case TREASURY_INSTRUCTIONS.set_controller:
      return sized(40) ? { kind: "controller", controller: addressFromBytes(d.slice(8, 40)) } : undefined;
    case TREASURY_INSTRUCTIONS.lock_funds:
      return sized(24) ? { kind: "reserve", subsidy: u64(8), holder: u64(16) } : undefined;
    case TREASURY_INSTRUCTIONS.unlock_funds:
      return sized(24) ? { kind: "release", subsidy: u64(8), holder: u64(16) } : undefined;
    case TREASURY_INSTRUCTIONS.pay_from_locked: {
      if (!sized(17)) return undefined;
      const bucket = d[8] === 0 ? "subsidy" : d[8] === 1 ? "holder" : undefined;
      if (!bucket) {
        problems.push(`A pay-out in this transaction names bucket ${d[8]}, which does not exist.`);
        return undefined;
      }
      const destination = account(4);
      return destination !== undefined ? { kind: "pay", bucket, amount: u64(9), destination } : undefined;
    }
    default:
      problems.push("This transaction runs an instruction of the treasury program that this page does not know.");
      return undefined;
  }
}

/** Where a vault's balance went in one transaction: `from` is `null` when the vault did not exist before it. */
interface Step {
  from: bigint | null;
  to: bigint;
}

const node = (v: bigint | null) => (v === null ? "none" : v.toString());

/**
 * Where a vault stood before `steps` (one slot's transactions, in no known order), given that it stands at `end` after them:
 * the start of an order in which each step starts where the one before it ended and the last ends at `end`. `undefined` when no
 * such order exists (a step is missing).
 */
export function chainStart(steps: readonly Step[], end: bigint): bigint | null | undefined {
  if (steps.length === 0) return end;
  const out = new Map<string, Step[]>();
  const degree = new Map<string, number>();
  const value = new Map<string, bigint | null>([[node(end), end]]);
  for (const s of steps) {
    const [f, t] = [node(s.from), node(s.to)];
    value.set(f, s.from);
    value.set(t, s.to);
    out.set(f, [...(out.get(f) ?? []), s]);
    degree.set(f, (degree.get(f) ?? 0) + 1);
    degree.set(t, (degree.get(t) ?? 0) - 1);
  }
  // A walk through every step once leaves every balance as often as it reaches it, except where it starts (once more) and where
  // it ends (`end`, given one more leaving here). The degrees add up to one, so a single balance left over is the start.
  degree.set(node(end), (degree.get(node(end)) ?? 0) + 1);
  const starts = [...degree].filter(([, d]) => d !== 0);
  if (starts.length > 1) return undefined;
  const first = (starts[0] as [string, number])[0];
  // Hierholzer's walk from there: it uses every step exactly when the steps hang together, and then ends at `end`.
  const stack = [first];
  const path: string[] = [];
  while (stack.length > 0) {
    const at = stack[stack.length - 1] as string;
    const next = out.get(at)?.pop();
    if (next) stack.push(node(next.to));
    else path.push(stack.pop() as string);
  }
  if (path.length !== steps.length + 1) return undefined;
  return value.get(first) as bigint | null;
}

/**
 * Takes one slot's transactions (newest slot first) back from the state the cursor holds: checks them as the top of this file
 * says and moves the cursor to before them. True when one of them was the set-up.
 */
function walk(c: HistoryCursor, txs: readonly Read[]): boolean {
  const first = txs[0]?.movement;
  // Each vault's balances.
  for (const b of BUCKETS) {
    const steps: (Step & { m: Movement })[] = [];
    for (const { effects, movement } of txs) {
      const after = effects.after.get(c.vaults[b]);
      if (!after) continue;
      steps.push({ from: effects.before.get(c.vaults[b])?.amount ?? null, to: after.amount, m: movement });
    }
    if (steps.length === 0) continue;
    const end = c.balance[b];
    let begin = end === null ? undefined : chainStart(steps, end);
    if (begin === undefined) {
      const now = end === null ? "the vault did not exist yet" : c.newer[b] ? `${c.newer[b]} ${money(end)}` : `it holds ${money(end)} now`;
      const only = steps.length === 1 ? (steps[0] as Step & { m: Movement }) : undefined;
      (only?.m ?? (first as Movement)).problems.push(
        only
          ? `The ${b} vault held ${money(only.to)} after this transaction, but ${now}: a transaction that moved money is missing from what the node gave.`
          : `The ${b} vault's balances in the ${steps.length} transactions of slot ${first?.slot} do not lead to what came after them (${now}): a transaction that moved money is missing from what the node gave.`,
      );
      // Carry on from where the oldest of them (the last listed) started, so one gap is said once.
      begin = (steps[steps.length - 1] as Step).from;
    }
    c.balance[b] = begin;
    c.newer[b] =
      steps.length === 1
        ? `the next transaction that names it (${short((steps[0] as Step & { m: Movement }).m.signature)}) starts from`
        : `the ${steps.length} transactions of slot ${first?.slot} that name it start from`;
  }

  // The split each deposit was made at, and the split before these transactions. The order of one slot's transactions is not
  // known, so a deposit in a slot that also changed the split is only checked against the total.
  const setting = txs.filter((t) => t.movement.calls.some((call) => call.actions.some((a) => a.kind === "split" || a.kind === "set-up")));
  const net: Record<Bucket, bigint> = { subsidy: 0n, holder: 0n };
  let setUp = false;
  for (const t of txs) {
    const m = t.movement;
    let split = setting.length === 0 || (setting.length === 1 && setting[0] === t) ? c.split : undefined;
    const deposits: { amount: bigint; split: Split | undefined }[] = [];
    const paid: Record<Bucket, bigint> = { subsidy: 0n, holder: 0n };
    // Back through its instructions, newest first, so what each one finds is what was in force when it ran.
    for (const a of m.calls.flatMap((call) => call.actions).reverse()) {
      if (a.kind === "deposit") deposits.push({ amount: a.amount, split });
      else if (a.kind === "split" || a.kind === "set-up") {
        if (split && (split.subsidyBps !== a.subsidyBps || split.holderBps !== a.holderBps)) {
          m.problems.push(`This set the split of new deposits to ${pct(a)}, but the split after it is ${pct(split)}: a change of the split is missing from what the node gave.`);
        }
        split = undefined;
        if (a.kind === "set-up") setUp = true;
      } else if (a.kind === "pay") {
        paid[a.bucket] += a.amount;
        net[a.bucket] -= a.amount;
      } else if (a.kind === "reserve" || a.kind === "release") {
        for (const b of BUCKETS) net[b] += a.kind === "reserve" ? a[b] : -a[b];
      }
    }
    checkMoney(m, deposits, paid);
  }
  if (setting.length > 0) c.split = undefined;

  // What is reserved before these transactions: what is reserved after them, less what they reserved, plus what they released
  // or paid out (in any order).
  for (const b of BUCKETS) {
    const before = c.reserved[b] - net[b];
    if (before < 0n) {
      (first as Movement).problems.push(
        `${txs.length === 1 ? "This transaction" : `The ${txs.length} transactions of this slot`} reserved ${money(-before)} more of the ${b} bucket than is reserved after ${txs.length === 1 ? "it" : "them"}, less what ${txs.length === 1 ? "it" : "they"} released or paid out: a release or pay-out is missing from what the node gave.`,
      );
    }
    c.reserved[b] = before < 0n ? 0n : before;
    const held = c.balance[b] ?? 0n;
    if (!setUp && c.reserved[b] > held) {
      (first as Movement).problems.push(`Before ${txs.length === 1 ? "this transaction" : "these transactions"}, ${money(c.reserved[b])} of the ${b} bucket would have been reserved while its vault held ${money(held)}.`);
    }
  }
  if (setUp) {
    for (const b of BUCKETS) {
      if (c.balance[b] !== null) (first as Movement).problems.push(`The ${b} vault existed before the transaction that set the treasury up.`);
    }
  }
  return setUp;
}

const pct = (s: Split) => `${share(BigInt(s.subsidyBps), BPS)} / ${share(BigInt(s.holderBps), BPS)}`;

/** The money of one transaction against what its instructions say. */
function checkMoney(m: Movement, deposits: readonly { amount: bigint; split: Split | undefined }[], paid: Record<Bucket, bigint>): void {
  const known = deposits.every((d) => d.split);
  if (known) {
    for (const b of BUCKETS) {
      const expected = deposits.reduce((sum, d) => sum + splitDeposit(d.amount, d.split as Split)[b], 0n) - paid[b];
      const extra = m.change[b] - expected;
      if (extra < 0n) m.problems.push(`The ${b} vault lost ${money(-extra)} that no pay-out in this transaction explains.`);
      if (extra > 0n) m.straight.push({ bucket: b, amount: extra });
    }
    return;
  }
  let lost = false;
  for (const b of BUCKETS) {
    if (m.change[b] + paid[b] < 0n) {
      m.problems.push(`The ${b} vault lost ${money(-(m.change[b] + paid[b]))} that no pay-out in this transaction explains.`);
      lost = true;
    }
  }
  const extra = m.change.subsidy + m.change.holder - (deposits.reduce((sum, d) => sum + d.amount, 0n) - paid.subsidy - paid.holder);
  if (extra < 0n && !lost) m.problems.push(`The vaults gained ${money(-extra)} less than this transaction's deposits.`);
  if (extra > 0n) m.straight.push({ amount: extra });
}

/** "Break #n" for the breaks the rows name, from their accounts (checked: the breaks program's, and at the address of that id). */
async function nameBreaks(rows: readonly Movement[], opts: HistoryOptions, c: HistoryCursor, net: Net, problems: string[]): Promise<void> {
  if (!opts.breaksProgram) return;
  const program = opts.breaksProgram;
  const keys = [...new Set(rows.flatMap((r) => r.calls.flatMap((call) => (call.breakKey ? [call.breakKey] : []))))].filter((k) => !c.breakNumbers.has(k));
  if (keys.length > 0) {
    const accounts = await getAccounts({ ...net, addresses: keys });
    for (const [i, key] of keys.entries()) {
      const a = accounts[i];
      let number: number | null = null;
      try {
        if (a && a.owner === program) {
          const id = decodeBreak(a.data).id;
          if (breakAddress(program, id) === key) number = Number(id) + 1;
        }
      } catch {
        // Not a break: said below.
      }
      if (number === null) problems.push(`The account ${short(key)} that a transaction names as its break is not a break of the breaks program.`);
      c.breakNumbers.set(key, number);
    }
  }
  for (const r of rows) {
    for (const call of r.calls) {
      const n = call.breakKey ? c.breakNumbers.get(call.breakKey) : undefined;
      if (n !== undefined && n !== null) call.breakNumber = n;
    }
  }
}
