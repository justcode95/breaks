import { readFileSync } from "node:fs";
import { join } from "node:path";
import { base58 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { breakAddress, configAddress, treasuryAuthorityAddress } from "../lib/chain/address";
import { LoadError } from "../lib/chain/load";
import {
  BREAKS_STEPS,
  type HistoryPage,
  MAX_READ_PER_PAGE,
  MAX_SAME_SLOT,
  type Movement,
  ROWS_PER_PAGE,
  TREASURY_INSTRUCTIONS,
  chainStart,
  loadTreasuryHistory,
  splitDeposit,
  treasuryAction,
} from "../lib/chain/treasury-history";
import { fromHex, hashv, toHex, utf8 } from "../lib/draw/bytes";
import { breakFieldsFromVector, configFieldsFromVector, encodeBreak, encodeConfig } from "./support/accounts";
import { BREAKS, BUYER, ROUTER, TREASURY, TreasuryChain, USDC, wallet } from "./support/treasury-chain";

interface Vector {
  name: string;
  inputs: Record<string, any>;
  data?: string;
  accounts?: { pubkey: string }[];
}
const read = (program: string): { programs: Record<string, string>; cases: Vector[] } =>
  JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "programs", program, "instruction-vectors.json"), "utf8"));
const treasuryVectors = read("treasury");
const breaksVectors = read("breaks");

const load = (chain: TreasuryChain, node = chain.node(), cursor?: HistoryPage["cursor"]) =>
  loadTreasuryHistory({ rpcUrl: "http://node", fetch: node.fetch, treasuryProgram: TREASURY, breaksProgram: BREAKS }, cursor);

/** Every page, oldest last. */
async function all(chain: TreasuryChain, node = chain.node()): Promise<HistoryPage[]> {
  const pages = [await load(chain, node)];
  while (pages[pages.length - 1]?.cursor) pages.push(await load(chain, node, pages[pages.length - 1]?.cursor));
  return pages;
}

const sample = (name: string) => (breaksVectors.cases.find((c) => c.name === name) as Vector & { outputs: Record<string, any> }).outputs;
const configSample = () => configFieldsFromVector(sample("breaks.account.BreaksConfig"));
/** The bytes of the chain's break `id`, written as break `as`. */
const encodeBreakOf = (chain: TreasuryChain, id: bigint, as = id) => encodeBreak({ ...(chain.breaks.get(id) ?? breakFieldsFromVector(sample("breaks.account.Break"))), id: as });

const kinds = (m: Movement) => m.calls.flatMap((c) => c.actions.map((a) => a.kind));
const problemsOf = (pages: HistoryPage[]) => pages.flatMap((p) => [...p.problems, ...p.rows.flatMap((r) => r.problems)]);

/** A treasury that has seen a bit of everything: set up, deposits (one through another program), two breaks, a split change. */
function busy() {
  const chain = new TreasuryChain();
  const s: Record<string, string> = {};
  s.setUp = chain.setUp();
  s.controller = chain.setController(chain.authority);
  s.deposit1 = chain.deposit(wallet(1), 100_000_000n);
  s.deposit2 = chain.deposit(wallet(2), 50_000_000n, { via: ROUTER });
  s.noise = chain.noise();
  s.create0 = chain.createBreak(0n, 22_500_000n, 30_000_000n);
  s.straight = chain.straight("holder", 5_000_000n);
  s.fund0 = chain.fund(0n, 20_000_000n, 25_000_000n);
  s.split = chain.setSplit(6000, 4000);
  s.deposit3 = chain.deposit(wallet(3), 10_000_001n);
  s.create1 = chain.createBreak(1n, 10_000_000n, 5_000_000n);
  s.cancel1 = chain.cancel(1n, { unfundable: true });
  s.failed = chain.deposit(wallet(1), 7n, { failed: true });
  return { chain, s };
}

describe("what the page reads the instructions by, pinned to the Rust programs", () => {
  it("knows each treasury instruction by its first 8 bytes, which are the Rust vectors' and Anchor's hash of its name", () => {
    for (const [name, hex] of Object.entries(TREASURY_INSTRUCTIONS)) {
      expect(toHex(hashv(utf8(`global:${name}`)).slice(0, 8)), name).toBe(hex);
      const vector = treasuryVectors.cases.find((c) => c.name === `treasury.${name}`) as Vector;
      expect(vector.data?.slice(0, 16), name).toBe(hex);
    }
    for (const [name, { data }] of Object.entries(BREAKS_STEPS)) {
      expect(toHex(hashv(utf8(`global:${name}`)).slice(0, 8)), name).toBe(data);
      expect((breaksVectors.cases.find((c) => c.name === `breaks.${name}`) as Vector).data?.slice(0, 16), name).toBe(data);
    }
  });

  it("finds the break among each breaks instruction's accounts where the Rust program puts it", () => {
    for (const [name, { breakAccount }] of Object.entries(BREAKS_STEPS)) {
      const v = breaksVectors.cases.find((c) => c.name === `breaks.${name}`) as Vector;
      expect(v.accounts?.[breakAccount]?.pubkey, name).toBe(breakAddress(breaksVectors.programs.breaks as string, BigInt(v.inputs.breakId)));
    }
    // The breaks program's signer for the treasury, which the treasury's controller is in production.
    const create = breaksVectors.cases.find((c) => c.name === "breaks.create_break") as Vector;
    expect(treasuryAuthorityAddress(breaksVectors.programs.breaks as string)).toBe(create.accounts?.[5]?.pubkey);
  });

  it("reads every treasury instruction of the Rust vectors: its amounts, split, controller and accounts", () => {
    const action = (name: string, i = 0) => {
      const v = treasuryVectors.cases.filter((c) => c.name === `treasury.${name}`)[i] as Vector;
      const problems: string[] = [];
      const a = treasuryAction({ programId: TREASURY, accounts: (v.accounts ?? []).map((x) => x.pubkey), data: fromHex(v.data as string) }, problems);
      expect(problems).toEqual([]);
      return { a, v };
    };
    let { a, v } = action("initialize");
    expect(a).toEqual({ kind: "set-up", admin: v.inputs.admin, subsidyBps: 7000, holderBps: 3000 });
    ({ a, v } = action("deposit_fees"));
    expect(a).toEqual({ kind: "deposit", amount: 123456789n, depositor: v.inputs.depositor });
    ({ a } = action("set_split"));
    expect(a).toEqual({ kind: "split", subsidyBps: 5000, holderBps: 5000 });
    ({ a, v } = action("set_controller"));
    expect(a).toEqual({ kind: "controller", controller: v.inputs.controller });
    ({ a } = action("lock_funds"));
    expect(a).toEqual({ kind: "reserve", subsidy: 1_000_000n, holder: 2_500_000n });
    ({ a } = action("unlock_funds"));
    expect(a).toEqual({ kind: "release", subsidy: 1_000_000n, holder: 2_500_000n });
    ({ a, v } = action("pay_from_locked", 0));
    expect(a).toEqual({ kind: "pay", bucket: "subsidy", amount: 42n, destination: v.inputs.destination });
    ({ a } = action("pay_from_locked", 1));
    expect(a).toMatchObject({ kind: "pay", bucket: "holder", amount: 42n });
  });

  it("refuses, in words, a treasury instruction it does not know, of the wrong length, of a bucket that does not exist or naming too few accounts", () => {
    const tryRead = (data: string, accounts: string[] = Array(6).fill(USDC)) => {
      const problems: string[] = [];
      return { a: treasuryAction({ programId: TREASURY, accounts, data: fromHex(data) }, problems), problems };
    };
    expect(tryRead("0102030405060708")).toEqual({ a: undefined, problems: ["This transaction runs an instruction of the treasury program that this page does not know."] });
    expect(tryRead(`${TREASURY_INSTRUCTIONS.deposit_fees}0100000000000000ff`)).toEqual({ a: undefined, problems: ["An instruction of the treasury program in this transaction is 17 bytes long where 16 were expected."] });
    expect(tryRead(`${TREASURY_INSTRUCTIONS.lock_funds}01000000000000000100000000000000`.slice(0, -2)).problems).toEqual(["An instruction of the treasury program in this transaction is 23 bytes long where 24 were expected."]);
    expect(tryRead(`${TREASURY_INSTRUCTIONS.pay_from_locked}022a00000000000000`)).toEqual({ a: undefined, problems: ["A pay-out in this transaction names bucket 2, which does not exist."] });
    expect(tryRead(`${TREASURY_INSTRUCTIONS.pay_from_locked}012a00000000000000`, [USDC, USDC, USDC, USDC])).toEqual({ a: undefined, problems: ["An instruction of the treasury program in this transaction names too few accounts."] });
    expect(tryRead(`${TREASURY_INSTRUCTIONS.deposit_fees}0100000000000000`, [])).toEqual({ a: undefined, problems: ["An instruction of the treasury program in this transaction names too few accounts."] });
    for (const name of ["initialize", "set_split", "set_controller", "unlock_funds"] as const) {
      expect(tryRead(`${TREASURY_INSTRUCTIONS[name]}00`).problems, name).toHaveLength(1);
    }
  });

  it("splits a deposit as the program does: the subsidy bucket gets the share rounded down, the holder bucket the rest", () => {
    expect(splitDeposit(100_000_000n, { subsidyBps: 7000, holderBps: 3000 })).toEqual({ subsidy: 70_000_000n, holder: 30_000_000n });
    expect(splitDeposit(1n, { subsidyBps: 7000, holderBps: 3000 })).toEqual({ subsidy: 0n, holder: 1n });
    expect(splitDeposit(3n, { subsidyBps: 7000, holderBps: 3000 })).toEqual({ subsidy: 2n, holder: 1n });
    expect(splitDeposit(123n, { subsidyBps: 0, holderBps: 10000 })).toEqual({ subsidy: 0n, holder: 123n });
    expect(splitDeposit(123n, { subsidyBps: 10000, holderBps: 0 })).toEqual({ subsidy: 123n, holder: 0n });
    const max = (1n << 64n) - 1n;
    expect(splitDeposit(max, { subsidyBps: 7000, holderBps: 3000 }).subsidy).toBe((max * 7000n) / 10000n);
  });
});

describe("putting one slot's balances in an order that chains", () => {
  const s = (from: bigint | null, to: bigint) => ({ from, to });
  it("starts where the steps must have started, in whatever order they are given", () => {
    expect(chainStart([], 5n)).toBe(5n);
    expect(chainStart([s(3n, 5n)], 5n)).toBe(3n);
    expect(chainStart([s(5n, 9n), s(3n, 5n)], 9n)).toBe(3n);
    expect(chainStart([s(3n, 5n), s(5n, 9n)], 9n)).toBe(3n);
    // A step that changes nothing, and steps that come back to where they started.
    expect(chainStart([s(5n, 5n)], 5n)).toBe(5n);
    expect(chainStart([s(5n, 7n), s(7n, 5n), s(5n, 5n)], 5n)).toBe(5n);
    expect(chainStart([s(2n, 5n), s(5n, 7n), s(7n, 5n)], 5n)).toBe(2n);
    // The vault made in this slot.
    expect(chainStart([s(0n, 4n), s(null, 0n)], 4n)).toBeNull();
  });

  it("finds no order when a step is missing, or when the steps do not reach the end", () => {
    expect(chainStart([s(3n, 5n)], 6n)).toBeUndefined();
    expect(chainStart([s(3n, 5n), s(6n, 9n)], 9n)).toBeUndefined();
    // Every balance is left as often as it is reached, but the loop at 7 is not connected to the rest.
    expect(chainStart([s(7n, 8n), s(8n, 7n)], 5n)).toBeUndefined();
    expect(chainStart([s(5n, 5n), s(7n, 8n), s(8n, 7n)], 5n)).toBeUndefined();
    // Two steps that both start the slot.
    expect(chainStart([s(null, 0n), s(null, 0n)], 0n)).toBeUndefined();
    expect(chainStart([s(1n, 5n), s(2n, 5n)], 5n)).toBeUndefined();
  });

  it("finds an order where trying the steps one after the other in the given order would not", () => {
    // From 1: 1→2, then at 2 the first step listed (2→1) would come back too early and miss 2→3→2; Hierholzer's walk still finds 1→2→3→2→1→… here.
    expect(chainStart([s(2n, 1n), s(1n, 2n), s(2n, 3n), s(3n, 2n)], 1n)).toBe(1n);
    expect(chainStart([s(2n, 4n), s(1n, 2n), s(2n, 3n), s(3n, 2n)], 4n)).toBe(1n);
  });
});

describe("the treasury's history", () => {
  it("lists every transaction of a busy treasury, newest first, with what it did and what each vault gained or lost", async () => {
    const { chain, s } = busy();
    const node = chain.node();
    const page = await load(chain, node);
    expect(page.complete).toBe(true);
    expect(page.ended).toBe(false);
    expect(page.cursor).toBeUndefined();
    expect(problemsOf([page])).toEqual([]);
    expect(page.buyer).toBe(BUYER);
    expect(page.authority).toBe(chain.authority);
    // The failed deposit is not listed and the transaction that changed nothing is counted.
    expect(page.quiet).toBe(1);
    expect(page.rows.map((r) => r.signature)).toEqual(
      [s.cancel1, s.create1, s.deposit3, s.split, s.fund0, s.straight, s.create0, s.deposit2, s.deposit1, s.controller, s.setUp].map((x) => x as string),
    );
    const row = (k: string) => page.rows.find((r) => r.signature === s[k]) as Movement;

    expect(row("setUp").calls).toEqual([{ actions: [{ kind: "set-up", admin: expect.any(String), subsidyBps: 7000, holderBps: 3000 }] }]);
    expect(row("setUp").change).toEqual({ subsidy: 0n, holder: 0n });
    expect(row("controller").calls[0]?.actions).toEqual([{ kind: "controller", controller: chain.authority }]);
    expect(row("deposit1").calls).toEqual([{ actions: [{ kind: "deposit", amount: 100_000_000n, depositor: wallet(1) }] }]);
    expect(row("deposit1").change).toEqual({ subsidy: 70_000_000n, holder: 30_000_000n });
    expect(row("deposit2").calls).toEqual([{ caller: ROUTER, actions: [{ kind: "deposit", amount: 50_000_000n, depositor: wallet(2) }] }]);
    expect(row("deposit2").change).toEqual({ subsidy: 35_000_000n, holder: 15_000_000n });
    expect(row("create0").calls).toEqual([
      { caller: BREAKS, step: "create_break", breakKey: breakAddress(BREAKS, 0n), breakNumber: 1, actions: [{ kind: "reserve", subsidy: 22_500_000n, holder: 30_000_000n }] },
    ]);
    expect(row("create0").change).toEqual({ subsidy: 0n, holder: 0n });
    expect(row("straight").calls).toEqual([]);
    expect(row("straight").straight).toEqual([{ bucket: "holder", amount: 5_000_000n }]);
    expect(row("straight").change).toEqual({ subsidy: 0n, holder: 5_000_000n });
    const fund = row("fund0").calls[0];
    expect(fund).toMatchObject({ caller: BREAKS, step: "fund_purchases", breakNumber: 1 });
    expect(fund?.actions).toEqual([
      { kind: "pay", bucket: "subsidy", amount: 20_000_000n, destination: expect.any(String), recipient: BUYER },
      { kind: "pay", bucket: "holder", amount: 25_000_000n, destination: expect.any(String), recipient: BUYER },
      { kind: "release", subsidy: 2_500_000n, holder: 5_000_000n },
    ]);
    expect(row("fund0").change).toEqual({ subsidy: -20_000_000n, holder: -25_000_000n });
    expect(row("split").calls[0]?.actions).toEqual([{ kind: "split", subsidyBps: 6000, holderBps: 4000 }]);
    // After the change, a deposit is split 60/40, rounding down for the subsidy bucket.
    expect(row("deposit3").change).toEqual({ subsidy: 6_000_000n, holder: 4_000_001n });
    expect(row("deposit3").straight).toEqual([]);
    expect(row("create1").calls[0]).toMatchObject({ step: "create_break", breakNumber: 2 });
    expect(row("cancel1").calls).toEqual([
      { caller: BREAKS, step: "cancel_unfundable", breakKey: breakAddress(BREAKS, 1n), breakNumber: 2, actions: [{ kind: "release", subsidy: 10_000_000n, holder: 5_000_000n }] },
    ]);
    for (const r of page.rows) expect(r.time).toBe(chain.txs.find((t) => t.signature === r.signature)?.blockTime);

    // Every change, added up, is what the vaults hold now.
    for (const b of ["subsidy", "holder"] as const) expect(page.rows.reduce((sum, r) => sum + r.change[b], 0n)).toBe(chain.held(b));
  });

  it("reads the accounts once with the slot, every list at finalized a hundred at a time, each transaction once, and never a failed one", async () => {
    const { chain, s } = busy();
    const node = chain.node();
    await load(chain, node);
    const lists = node.calls.filter((c) => c.method === "getSignaturesForAddress");
    expect(lists.map((c) => c.params[0])).toEqual([chain.configKey, chain.vaults.subsidy, chain.vaults.holder]);
    for (const c of lists) expect(c.params[1]).toEqual({ limit: 100, commitment: "finalized" });
    const txs = node.calls.filter((c) => c.method === "getTransaction").map((c) => c.params[0]);
    expect(new Set(txs).size).toBe(txs.length);
    expect(txs).not.toContain(s.failed);
    expect(txs).toHaveLength(12);
    for (const c of node.calls.filter((c) => c.method === "getTransaction")) expect(c.params[1]).toEqual({ encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 });
    const accounts = node.calls.filter((c) => c.method === "getMultipleAccounts");
    // The treasury and the breaks program's config together; then the break accounts the rows name.
    expect(accounts.map((c) => (c.params[0] as string[]).length)).toEqual([4, 2]);
    expect(accounts[0]?.params[1]).toEqual({ encoding: "base64", commitment: "finalized" });
  });

  it("leaves out the transactions newer than the accounts it starts from, which the next read will find", async () => {
    const { chain } = busy();
    const node = chain.node({ frozen: true });
    const later = [chain.deposit(wallet(5), 1_000_000n), chain.createBreak(2n, 100n, 100n)];
    const page = await load(chain, node);
    expect(problemsOf([page])).toEqual([]);
    expect(page.complete).toBe(true);
    for (const sig of later) expect(page.rows.map((r) => r.signature)).not.toContain(sig);
    expect(node.calls.filter((c) => c.method === "getTransaction").map((c) => c.params[0])).not.toContain(later[0]);
  });

  it("names the treasury's transactions without the breaks program, but not the breaks or the buyer wallet", async () => {
    const { chain, s } = busy();
    const node = chain.node();
    const page = await loadTreasuryHistory({ rpcUrl: "http://node", fetch: node.fetch, treasuryProgram: TREASURY });
    expect(problemsOf([page])).toEqual([]);
    expect(page.buyer).toBeUndefined();
    expect(page.authority).toBeUndefined();
    const fund = page.rows.find((r) => r.signature === s.fund0)?.calls[0];
    expect(fund?.step).toBeUndefined();
    expect(fund?.breakKey).toBeUndefined();
    expect(fund?.caller).toBe(BREAKS);
    expect(fund?.actions.map((a) => a.kind)).toEqual(["pay", "pay", "release"]);
    expect(node.calls.filter((c) => c.method === "getMultipleAccounts")).toHaveLength(1);
  });

  it("reads older transactions a page at a time, the chain of balances carried from one page to the next", async () => {
    const chain = new TreasuryChain();
    chain.setUp();
    const deposits = Array.from({ length: 45 }, (_, i) => chain.deposit(wallet(10 + (i % 5)), BigInt(1_000_000 + i)));
    const node = chain.node();
    const pages = await all(chain, node);
    expect(pages.map((p) => p.rows.length)).toEqual([ROWS_PER_PAGE, ROWS_PER_PAGE, 6]);
    expect(pages.map((p) => p.complete)).toEqual([false, false, true]);
    expect(problemsOf(pages)).toEqual([]);
    expect(pages.flatMap((p) => p.rows.map((r) => r.signature))).toEqual([...deposits].reverse().concat(chain.txs[0]?.signature as string));
    // Each page starts its lists where the last one stopped, and reads no transaction twice.
    const txs = node.calls.filter((c) => c.method === "getTransaction").map((c) => c.params[0]);
    expect(txs).toHaveLength(46);
    expect(new Set(txs).size).toBe(46);
  });

  it("does not change the cursor it is given, so reading older transactions can be tried again", async () => {
    const chain = new TreasuryChain();
    chain.setUp();
    for (let i = 0; i < 25; i++) chain.deposit(wallet(10), 1_000_000n);
    const first = await load(chain);
    const before = JSON.stringify(first.cursor, (_, v) => (typeof v === "bigint" ? v.toString() : v instanceof Set || v instanceof Map ? [...v] : v));
    await expect(load(chain, chain.node({ failing: "getTransaction" }), first.cursor)).rejects.toThrow(LoadError);
    expect(JSON.stringify(first.cursor, (_, v) => (typeof v === "bigint" ? v.toString() : v instanceof Set || v instanceof Map ? [...v] : v))).toBe(before);
    const again = await load(chain, chain.node(), first.cursor);
    expect(again.rows).toHaveLength(6);
    expect(again.complete).toBe(true);
    expect(problemsOf([first, again])).toEqual([]);
  });

  it("reads the lists of signatures past a hundred, and ends a page early after reading many transactions that changed nothing", async () => {
    const chain = new TreasuryChain();
    chain.setUp();
    chain.deposit(wallet(10), 5_000_000n);
    for (let i = 0; i < 130; i++) chain.noise();
    chain.deposit(wallet(11), 1_000_000n);
    const node = chain.node();
    const pages = await all(chain, node);
    expect(pages[0]?.rows).toHaveLength(1);
    expect(pages[0]?.quiet).toBe(MAX_READ_PER_PAGE - 1);
    expect(pages[0]?.cursor).toBeDefined();
    expect(pages.flatMap((p) => p.rows)).toHaveLength(3);
    expect(pages.reduce((n, p) => n + p.quiet, 0)).toBe(130);
    expect(pages[pages.length - 1]?.complete).toBe(true);
    expect(problemsOf(pages)).toEqual([]);
    const configLists = node.calls.filter((c) => c.method === "getSignaturesForAddress" && c.params[0] === chain.configKey);
    expect(configLists.length).toBeGreaterThan(1);
    expect((configLists[1]?.params[1] as { before?: string }).before).toBeDefined();
  });

  it("puts a slot's transactions in an order that chains, however the node lists them", async () => {
    const chain = new TreasuryChain();
    chain.setUp();
    chain.deposit(wallet(10), 100_000_000n);
    chain.createBreak(0n, 10_000_000n, 5_000_000n);
    chain.deposit(wallet(11), 3_000_000n, { sameSlot: true });
    chain.fund(0n, 9_000_000n, 5_000_000n, { sameSlot: true });
    chain.deposit(wallet(12), 3_000_000n, { sameSlot: true });
    chain.straight("subsidy", 1n);
    for (const reverseSlots of [false, true]) {
      const page = await load(chain, chain.node({ reverseSlots }));
      expect(problemsOf([page]), `reversed: ${reverseSlots}`).toEqual([]);
      expect(page.complete).toBe(true);
    }
  });

  it("refuses a slot with more transactions than it puts in order", async () => {
    const chain = new TreasuryChain();
    chain.setUp();
    chain.deposit(wallet(10), 1n);
    for (let i = 1; i < MAX_SAME_SLOT; i++) chain.deposit(wallet(10), 1n, { sameSlot: true });
    expect(problemsOf([await load(chain)])).toEqual([]);
    chain.deposit(wallet(10), 1n);
    for (let i = 0; i < MAX_SAME_SLOT; i++) chain.deposit(wallet(10), 1n, { sameSlot: true });
    await expect(load(chain)).rejects.toThrow(`More than ${MAX_SAME_SLOT} transactions named the treasury in slot ${chain.slot}: this page cannot put them in order.`);
  });

  it("says when the node has nothing older and the set-up was not among what it gave", async () => {
    const { chain, s } = busy();
    const page = await load(chain, chain.node({ hide: new Set([s.setUp, s.controller] as string[]) }));
    expect(page.complete).toBe(false);
    expect(page.ended).toBe(true);
    expect(page.cursor).toBeUndefined();
    expect(problemsOf([page])).toEqual([]);
  });
});

describe("what does not add up", () => {
  it("a deposit missing from the lists: a gap in the chain of balances, said once, on the transaction before it", async () => {
    const { chain, s } = busy();
    const page = await load(chain, chain.node({ hide: new Set([s.deposit2 as string]) }));
    const before = page.rows.find((r) => r.signature === s.deposit1) as Movement;
    const short = (x: string | undefined) => `${x?.slice(0, 4)}…${x?.slice(-4)}`;
    // The next transaction that names the subsidy vault changed nothing (it is not listed): it is named all the same.
    expect(before.problems).toEqual([
      `The subsidy vault held $70 after this transaction, but the next transaction that names it (${short(s.noise)}) starts from $105: a transaction that moved money is missing from what the node gave.`,
      `The holder vault held $30 after this transaction, but the next transaction that names it (${short(s.create0)}) starts from $45: a transaction that moved money is missing from what the node gave.`,
    ]);
    expect(problemsOf([page])).toHaveLength(2);
    expect(page.complete).toBe(true);
  });

  it("the newest transaction missing: the last one listed does not end at what the vault holds now", async () => {
    const { chain, s } = busy();
    const late = chain.deposit(wallet(4), 1_000_000n);
    const page = await load(chain, chain.node({ hide: new Set([late]) }));
    const newest = page.rows[0] as Movement;
    expect(newest.signature).toBe(s.cancel1);
    expect(newest.problems).toEqual([
      "The subsidy vault held $91 after this transaction, but it holds $91.60 now: a transaction that moved money is missing from what the node gave.",
      "The holder vault held $29.000001 after this transaction, but it holds $29.400001 now: a transaction that moved money is missing from what the node gave.",
    ]);
  });

  it("a slot whose transactions do not chain says so for the slot", async () => {
    const chain = new TreasuryChain();
    chain.setUp();
    chain.deposit(wallet(10), 100_000_000n);
    const hidden = chain.deposit(wallet(11), 1_000_000n, { sameSlot: true });
    chain.deposit(wallet(12), 2_000_000n, { sameSlot: true });
    const page = await load(chain, chain.node({ hide: new Set([hidden]) }));
    expect(problemsOf([page])).toEqual([
      `The subsidy vault's balances in the 2 transactions of slot ${chain.slot} do not lead to what came after them (it holds $72.10 now): a transaction that moved money is missing from what the node gave.`,
      `The holder vault's balances in the 2 transactions of slot ${chain.slot} do not lead to what came after them (it holds $30.90 now): a transaction that moved money is missing from what the node gave.`,
    ]);
    // Said once: the walk carries on from where the oldest of them started, which the set-up leads to.
  });

  it("a pay-out missing: the vaults' balances do not chain", async () => {
    const { chain, s } = busy();
    const page = await load(chain, chain.node({ hide: new Set([s.fund0 as string]) }));
    // The straight transfer only names the holder vault; the next older one that names the subsidy vault is the reservation.
    expect(page.rows.find((r) => r.signature === s.straight)?.problems).toEqual([expect.stringMatching(/^The holder vault held \$50 after this transaction, but the next transaction that names it \(.{9}\) starts from \$25: /)]);
    // The pay-out's release went missing with it, so the reservation is more than what is reserved after it.
    expect(page.rows.find((r) => r.signature === s.create0)?.problems).toEqual([
      expect.stringMatching(/^The subsidy vault held \$105 after this transaction, but the next transaction that names it \(.{9}\) starts from \$85: /),
      "This transaction reserved $22.50 more of the subsidy bucket than is reserved after it, less what it released or paid out: a release or pay-out is missing from what the node gave.",
      "This transaction reserved $30 more of the holder bucket than is reserved after it, less what it released or paid out: a release or pay-out is missing from what the node gave.",
    ]);
    expect(problemsOf([page])).toHaveLength(4);
  });

  it("a reservation missing moves no money: it is caught back at the set-up, where nothing can have been reserved", async () => {
    const { chain, s } = busy();
    const holderOnly = chain.createBreak(2n, 0n, 1n);
    for (const hidden of [s.create0, s.create1, holderOnly]) {
      const page = await load(chain, chain.node({ hide: new Set([hidden as string]) }));
      expect(page.complete).toBe(true);
      const reserved = hidden === s.create0 ? ["$22.50", "$30"] : hidden === s.create1 ? ["$10", "$5"] : ["$0", "$0.000001"];
      expect(page.problems, hidden).toEqual([
        `What is reserved now is not explained by the reservations listed: they leave ${reserved[0]} of the subsidy bucket and ${reserved[1]} of the holder bucket reserved before the treasury was set up, when nothing could be. A reservation is missing from what the node gave.`,
      ]);
    }
  });

  it("a release missing: a reservation of more than is reserved after it", async () => {
    const { chain, s } = busy();
    const page = await load(chain, chain.node({ hide: new Set([s.cancel1 as string]) }));
    expect(page.rows.find((r) => r.signature === s.create1)?.problems).toEqual([
      "This transaction reserved $10 more of the subsidy bucket than is reserved after it, less what it released or paid out: a release or pay-out is missing from what the node gave.",
      "This transaction reserved $5 more of the holder bucket than is reserved after it, less what it released or paid out: a release or pay-out is missing from what the node gave.",
    ]);
  });

  it("a release of a single base unit missing", async () => {
    const chain = new TreasuryChain();
    chain.setUp();
    chain.deposit(wallet(10), 10_000_000n);
    const create = chain.createBreak(0n, 1n, 0n);
    const cancel = chain.cancel(0n);
    const page = await load(chain, chain.node({ hide: new Set([cancel]) }));
    expect(page.rows.find((r) => r.signature === create)?.problems).toEqual([
      "This transaction reserved $0.000001 more of the subsidy bucket than is reserved after it, less what it released or paid out: a release or pay-out is missing from what the node gave.",
    ]);
  });

  it("more reserved than a vault holds, before a transaction", async () => {
    const chain = new TreasuryChain();
    chain.setUp();
    const deposit = chain.deposit(wallet(10), 10_000_000n);
    chain.createBreak(0n, 7_000_000n, 0n);
    // The config says more is reserved than any transaction listed reserved: one base unit more than the vault held then.
    chain.config.lockedSubsidy += 1n;
    const page = await load(chain);
    expect(page.rows.find((r) => r.signature === deposit)?.problems).toEqual(["Before this transaction, $0.000001 of the subsidy bucket would have been reserved while its vault held $0."]);
    expect(page.problems).toEqual([expect.stringMatching(/^What is reserved now is not explained by the reservations listed: they leave \$0.000001 of the subsidy bucket and \$0 of the holder bucket reserved/)]);
  });

  it("a change of the split missing: the one before it is not the split the config has", async () => {
    const chain = new TreasuryChain();
    chain.setUp();
    chain.deposit(wallet(10), 10_000_000n);
    const first = chain.setSplit(5000, 5000);
    const hidden = chain.setSplit(6000, 4000);
    chain.deposit(wallet(11), 10_000_000n);
    const page = await load(chain, chain.node({ hide: new Set([hidden]) }));
    expect(page.rows.find((r) => r.signature === first)?.problems).toEqual(["This set the split of new deposits to 50% / 50%, but the split after it is 60% / 40%: a change of the split is missing from what the node gave."]);
    // Without it, everything adds up; the deposit before the change is only checked on its total.
    expect(problemsOf([await load(chain)])).toEqual([]);
  });

  it("checks a deposit against the split in force, and against the total once the split is not known", async () => {
    const chain = new TreasuryChain();
    chain.setUp();
    const old = chain.deposit(wallet(10), 10_000_000n, { extra: { bucket: "subsidy", amount: 1_000_000n } });
    chain.setSplit(5000, 5000);
    const recent = chain.deposit(wallet(11), 10_000_000n, { extra: { bucket: "holder", amount: 2_000_000n } });
    const page = await load(chain);
    expect(problemsOf([page])).toEqual([]);
    expect(page.rows.find((r) => r.signature === recent)?.straight).toEqual([{ bucket: "holder", amount: 2_000_000n }]);
    // Before the newest change, the split in force is not known: only the total.
    expect(page.rows.find((r) => r.signature === old)?.straight).toEqual([{ amount: 1_000_000n }]);
  });

  it("a deposit in the same slot as a change of the split is only checked on its total, made before the change or after it", async () => {
    const chain = new TreasuryChain();
    chain.setUp();
    chain.deposit(wallet(10), 10_000_000n);
    const before = chain.deposit(wallet(11), 10_000_000n);
    chain.setSplit(5000, 5000, { sameSlot: true });
    const after = chain.deposit(wallet(11), 10_000_000n, { sameSlot: true });
    const page = await load(chain);
    expect(problemsOf([page])).toEqual([]);
    for (const sig of [before, after]) expect(page.rows.find((r) => r.signature === sig)?.straight).toEqual([]);
  });

  it("within one transaction, a deposit made before a change of the split is not checked against the new split", async () => {
    const chain = new TreasuryChain();
    chain.setUp();
    const both = chain.depositAndSplit(wallet(10), 10_000_000n, 5000, 5000);
    chain.deposit(wallet(11), 10_000_000n);
    const page = await load(chain);
    expect(problemsOf([page])).toEqual([]);
    const row = page.rows.find((r) => r.signature === both) as Movement;
    expect(row.calls.flatMap((c) => c.actions.map((a) => a.kind))).toEqual(["deposit", "split"]);
    expect(row.change).toEqual({ subsidy: 7_000_000n, holder: 3_000_000n });
    expect(row.straight).toEqual([]);
  });

  it("a change of the split that the node says set shares other than the config's, in either share alone", async () => {
    const chain = new TreasuryChain();
    chain.setUp();
    const change = chain.setSplit(6000, 4000);
    const edited = (offset: number, bps: number) =>
      chain.node({
        edit: (sig, tx) => {
          if (sig !== change) return;
          const ix = tx.transaction.message.instructions[0];
          const data = base58.decode(ix.data);
          new DataView(data.buffer).setUint16(offset, bps, true);
          ix.data = base58.encode(data);
        },
      });
    for (const [offset, bps, said] of [
      [10, 3000, "60% / 30%"],
      [8, 5000, "50% / 40%"],
    ] as const) {
      const page = await load(chain, edited(offset, bps));
      expect(page.rows.find((r) => r.signature === change)?.problems).toEqual([`This set the split of new deposits to ${said}, but the split after it is 60% / 40%: a change of the split is missing from what the node gave.`]);
    }
  });

  it("a deposit whose amount is not what reached the vaults", async () => {
    const { chain, s } = busy();
    const edit = (amount: bigint, which = s.deposit3) => (sig: string, tx: any) => {
      if (sig !== which) return;
      const ix = tx.transaction.message.instructions[0];
      const data = base58.decode(ix.data);
      new DataView(data.buffer).setBigUint64(8, amount, true);
      ix.data = base58.encode(data);
    };
    // At the split in force (60/40), said to be more than arrived: each vault got less than its share.
    let page = await load(chain, chain.node({ edit: edit(11_000_001n) }));
    expect(page.rows.find((r) => r.signature === s.deposit3)?.problems).toEqual([
      "The subsidy vault lost $0.60 that no pay-out in this transaction explains.",
      "The holder vault lost $0.40 that no pay-out in this transaction explains.",
    ]);
    expect(problemsOf([page])).toHaveLength(2);
    // Said to be less: the rest was sent straight to the vaults.
    page = await load(chain, chain.node({ edit: edit(9_000_001n) }));
    expect(page.rows.find((r) => r.signature === s.deposit3)?.straight).toEqual([
      { bucket: "subsidy", amount: 600_000n },
      { bucket: "holder", amount: 400_000n },
    ]);
    expect(problemsOf([page])).toEqual([]);
    // One base unit either way.
    page = await load(chain, chain.node({ edit: edit(10_000_002n) }));
    expect(page.rows.find((r) => r.signature === s.deposit3)?.problems).toEqual(["The subsidy vault lost $0.000001 that no pay-out in this transaction explains."]);
    page = await load(chain, chain.node({ edit: edit(10_000_000n) }));
    expect(page.rows.find((r) => r.signature === s.deposit3)?.straight).toEqual([{ bucket: "holder", amount: 1n }]);
    expect(page.rows.find((r) => r.signature === s.deposit3)?.problems).toEqual([]);
    // Before the newest change of the split, only the total can be checked.
    page = await load(chain, chain.node({ edit: edit(110_000_000n, s.deposit1) }));
    expect(page.rows.find((r) => r.signature === s.deposit1)?.problems).toEqual(["The vaults gained $10 less than this transaction's deposits."]);
  });

  it("reads amounts of any size the program takes", async () => {
    const chain = new TreasuryChain();
    chain.setUp();
    const big = chain.deposit(wallet(10), 5_000_000_000_000n);
    const page = await load(chain);
    expect(problemsOf([page])).toEqual([]);
    expect(page.rows.find((r) => r.signature === big)?.calls[0]?.actions[0]).toEqual({ kind: "deposit", amount: 5_000_000_000_000n, depositor: wallet(10) });
    expect(page.rows.find((r) => r.signature === big)?.change).toEqual({ subsidy: 3_500_000_000_000n, holder: 1_500_000_000_000n });
  });

  it("money sent to a vault in the transaction that set the treasury up", async () => {
    const chain = new TreasuryChain();
    const setUp = chain.setUp(7000, 3000, { extra: 2_000_000n });
    chain.deposit(wallet(10), 10_000_000n);
    const page = await load(chain);
    expect(problemsOf([page])).toEqual([]);
    expect(page.complete).toBe(true);
    const row = page.rows.find((r) => r.signature === setUp) as Movement;
    expect(row.change).toEqual({ subsidy: 0n, holder: 2_000_000n });
    expect(row.straight).toEqual([{ bucket: "holder", amount: 2_000_000n }]);
  });

  it("money that left a vault without a pay-out, also when the split is not known", async () => {
    const chain = new TreasuryChain();
    chain.setUp();
    const deposit = chain.deposit(wallet(10), 10_000_000n);
    chain.setSplit(5000, 5000);
    chain.deposit(wallet(10), 1_000_000n);
    const edit = (shares: [string, string], amount: bigint) => (sig: string, tx: any) => {
      if (sig !== deposit) return;
      const ix = tx.transaction.message.instructions[0];
      const data = base58.decode(ix.data);
      new DataView(data.buffer).setBigUint64(8, amount, true);
      ix.data = base58.encode(data);
      void shares;
    };
    // Split not known at that deposit: a total that is more than arrived.
    const page = await load(chain, chain.node({ edit: edit(["", ""], 12_000_000n) }));
    expect(page.rows.find((r) => r.signature === deposit)?.problems).toEqual(["The vaults gained $2 less than this transaction's deposits."]);
  });

  it("a transaction listed as succeeded that failed did nothing, whatever its instructions say", async () => {
    const { chain, s } = busy();
    const page = await load(chain, chain.node({ listAsOk: new Set([s.failed as string]) }));
    expect(problemsOf([page])).toEqual([]);
    expect(page.rows.map((r) => r.signature)).not.toContain(s.failed);
    expect(page.quiet).toBe(2);
  });

  it("refuses what the node gives that cannot be read, and the history of a node that changes its story", async () => {
    const { chain, s } = busy();
    await expect(load(chain, chain.node({ drop: new Set([s.deposit1 as string]) }))).rejects.toThrow(/^The node lists transaction .{9} but does not give it\.$/);
    await expect(load(chain, chain.node({ edit: (sig, tx) => sig === s.deposit1 && (tx.slot += 1) }))).rejects.toThrow(/two different slots/);
    await expect(load(chain, chain.node({ edit: (sig, tx) => sig === s.deposit1 && (tx.blockTime = null) }))).rejects.toThrow(/^Transaction .{9} could not be read: transaction .* has no block time$/);
    await expect(load(chain, chain.node({ failing: "getSignaturesForAddress" }))).rejects.toThrow("Could not read the treasury's history: the node refused the request: getSignaturesForAddress is failing");
    await expect(load(chain, chain.node({ failing: "getMultipleAccounts" }))).rejects.toThrow("Could not read the treasury's history: the node refused the request: getMultipleAccounts is failing");
    await expect(load(new TreasuryChain())).rejects.toThrow("The treasury has not been set up on this network (its config account does not exist).");
  });

  it("refuses lists that are not newest first", async () => {
    const { chain } = busy();
    const node = chain.node();
    const out = (async (url: string, init: RequestInit) => {
      const res = await node.fetch(url, init);
      const { method } = JSON.parse(String(init.body)) as { method: string };
      if (method !== "getSignaturesForAddress") return res;
      const body = (await res.json()) as { result: unknown[] };
      return new Response(JSON.stringify({ ...body, result: [...body.result].reverse() }));
    }) as unknown as typeof fetch;
    await expect(loadTreasuryHistory({ rpcUrl: "http://node", fetch: out, treasuryProgram: TREASURY, breaksProgram: BREAKS })).rejects.toThrow(/^The node listed the transactions of .{9} out of order\.$/);
  });

  it("says what it could not read in a transaction's instructions, and what a break account named is not", async () => {
    const { chain, s } = busy();
    const page = await load(
      chain,
      chain.node({
        edit: (sig, tx) => {
          if (sig === s.deposit1) tx.transaction.message.instructions.push({ programId: TREASURY, accounts: [], data: "!!" });
          if (sig === s.controller) tx.transaction.message.instructions[0] = { programId: TREASURY, program: "treasury", parsed: {} };
          if (sig === s.noise) delete tx.transaction.message.instructions;
          if (sig === s.deposit2) tx.meta.innerInstructions = "x";
          // The fund names another account where its break should be.
          if (sig === s.fund0) tx.transaction.message.instructions[0].accounts[2] = USDC;
        },
      }),
    );
    const row = (k: string) => page.rows.find((r) => r.signature === s[k]) as Movement;
    expect(row("deposit1").problems).toEqual(["Instruction 2 of this transaction could not be read."]);
    expect(row("controller").problems).toContain("The node gives an instruction of the treasury program in a form this page cannot read.");
    expect(row("noise").problems).toEqual(["The node does not give this transaction's instructions, so what it did is not known."]);
    expect(row("deposit2").problems).toContain("The node gives this transaction's inner instructions in a form this page cannot read.");
    expect(page.problems).toEqual([`The account ${USDC.slice(0, 4)}…${USDC.slice(-4)} that a transaction names as its break is not a break of the breaks program.`]);
    expect(row("fund0").calls[0]?.breakNumber).toBeUndefined();
  });

  it("a vault with a balance before a transaction and none after, and a vault that existed before the set-up", async () => {
    const { chain, s } = busy();
    const page = await load(
      chain,
      chain.node({
        edit: (sig, tx) => {
          const subsidy = tx.transaction.message.accountKeys.findIndex((k: { pubkey: string }) => k.pubkey === chain.vaults.subsidy);
          if (sig === s.deposit3) tx.meta.postTokenBalances = tx.meta.postTokenBalances.filter((b: { accountIndex: number }) => b.accountIndex !== subsidy);
          if (sig === s.setUp) tx.meta.preTokenBalances = tx.meta.postTokenBalances.filter((b: { accountIndex: number }) => b.accountIndex === subsidy);
        },
      }),
    );
    expect(page.rows.find((r) => r.signature === s.deposit3)?.problems).toContain("The node gives the subsidy vault a balance before this transaction and none after it.");
    expect(page.rows.find((r) => r.signature === s.setUp)?.problems).toContain("The subsidy vault existed before the transaction that set the treasury up.");
  });

  it("finds the treasury instructions a breaks instruction called wherever it sits in the transaction", async () => {
    const chain = new TreasuryChain();
    chain.setUp();
    chain.deposit(wallet(10), 10_000_000n);
    const create = chain.createBreak(0n, 1_000_000n, 1_000_000n, { second: true });
    const page = await load(chain);
    expect(problemsOf([page])).toEqual([]);
    expect(page.rows.find((r) => r.signature === create)?.calls).toEqual([
      { caller: BREAKS, step: "create_break", breakKey: breakAddress(BREAKS, 0n), breakNumber: 1, actions: [{ kind: "reserve", subsidy: 1_000_000n, holder: 1_000_000n }] },
    ]);
  });

  it("takes only the breaks program's instructions for steps of a break, whatever another program's data looks like", async () => {
    const chain = new TreasuryChain();
    chain.setUp();
    const deposit = chain.deposit(wallet(10), 10_000_000n, { via: ROUTER, viaData: fromHex(`${BREAKS_STEPS.create_break.data}00`) });
    const node = chain.node();
    const page = await load(chain, node);
    expect(problemsOf([page])).toEqual([]);
    expect(page.rows.find((r) => r.signature === deposit)?.calls).toEqual([{ caller: ROUTER, actions: [{ kind: "deposit", amount: 10_000_000n, depositor: wallet(10) }] }]);
    expect(node.calls.filter((c) => c.method === "getMultipleAccounts")).toHaveLength(1);
  });

  it("names a break only from an account of the breaks program at the address of its id", async () => {
    const { chain, s } = busy();
    const key = breakAddress(BREAKS, 0n);
    const wrong = new Map([[key, { data: encodeBreakOf(chain, 0n), owner: TREASURY }]]);
    let page = await load(chain, chain.node({ override: wrong }));
    expect(page.problems).toEqual([`The account ${key.slice(0, 4)}…${key.slice(-4)} that a transaction names as its break is not a break of the breaks program.`]);
    expect(page.rows.find((r) => r.signature === s.fund0)?.calls[0]?.breakNumber).toBeUndefined();
    // The breaks program's account, but of break #6, which lives at another address.
    page = await load(chain, chain.node({ override: new Map([[key, { data: encodeBreakOf(chain, 0n, 5n), owner: BREAKS }]]) }));
    expect(page.problems).toHaveLength(1);
    expect(page.rows.find((r) => r.signature === s.fund0)?.calls[0]?.breakNumber).toBeUndefined();
    // No account at all.
    page = await load(chain, chain.node({ override: new Map([[key, null]]) }));
    expect(page.problems).toHaveLength(1);
    // Break #2 is still named.
    expect(page.rows.find((r) => r.signature === s.cancel1)?.calls[0]?.breakNumber).toBe(2);
  });

  it("takes the buyer wallet only from the breaks program's own config account", async () => {
    const { chain } = busy();
    const config = configAddress(BREAKS);
    const page = await load(chain, chain.node({ override: new Map([[config, { data: encodeConfig({ ...configSample(), buyer: BUYER }), owner: TREASURY }]]) }));
    expect(page.buyer).toBeUndefined();
    expect(problemsOf([page])).toEqual([]);
    const unreadable = await load(chain, chain.node({ override: new Map([[config, { data: Uint8Array.of(1, 2, 3), owner: BREAKS }]]) }));
    expect(unreadable.buyer).toBeUndefined();
  });

  it("says an instruction whose accounts are not a list of addresses could not be read", async () => {
    const { chain, s } = busy();
    for (const accounts of [undefined, "x", [1]]) {
      const page = await load(chain, chain.node({ edit: (sig, tx) => sig === s.deposit1 && (tx.transaction.message.instructions[0].accounts = accounts) }));
      expect(page.rows.find((r) => r.signature === s.deposit1)?.problems[0], JSON.stringify(accounts)).toBe("Instruction 1 of this transaction could not be read.");
    }
  });

  it("names each break once across pages", async () => {
    const chain = new TreasuryChain();
    chain.setUp();
    chain.deposit(wallet(10), 100_000_000n);
    chain.createBreak(0n, 1_000_000n, 1_000_000n);
    for (let i = 0; i < 25; i++) chain.deposit(wallet(10), 1n);
    chain.fund(0n, 1_000_000n, 1_000_000n);
    const node = chain.node();
    const pages = await all(chain, node);
    expect(problemsOf(pages)).toEqual([]);
    const reads = node.calls.filter((c) => c.method === "getMultipleAccounts").map((c) => c.params[0] as string[]);
    expect(reads.filter((r) => r.includes(breakAddress(BREAKS, 0n)))).toHaveLength(1);
    expect(pages.flatMap((p) => p.rows).filter((r) => r.calls.some((c) => c.breakNumber === 1))).toHaveLength(2);
  });

  it("names the wallet a pay-out went to when it is not the buyer wallet, and the account when the transaction does not say whose it is", async () => {
    const chain = new TreasuryChain();
    chain.setUp();
    chain.deposit(wallet(10), 100_000_000n);
    chain.createBreak(0n, 1_000_000n, 0n);
    const fund = chain.fund(0n, 1_000_000n, 0n, { to: wallet(0x77) });
    let page = await load(chain);
    expect(page.rows[0]?.calls[0]?.actions[0]).toMatchObject({ kind: "pay", recipient: wallet(0x77) });
    page = await load(
      chain,
      chain.node({
        edit: (sig, tx) => {
          if (sig !== fund) return;
          const vaults = new Set([chain.vaults.subsidy, chain.vaults.holder]);
          const keep = (b: { accountIndex: number }) => vaults.has(tx.transaction.message.accountKeys[b.accountIndex].pubkey);
          tx.meta.preTokenBalances = tx.meta.preTokenBalances.filter(keep);
          tx.meta.postTokenBalances = tx.meta.postTokenBalances.filter(keep);
        },
      }),
    );
    const pay = page.rows[0]?.calls[0]?.actions[0];
    expect(pay).toMatchObject({ kind: "pay" });
    expect(pay && "recipient" in pay ? pay.recipient : undefined).toBeUndefined();
  });
});
