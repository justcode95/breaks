import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Address, breakAddress, configAddress } from "../lib/chain/address";
import { LoadError } from "../lib/chain/load";
import { MAX_COUNT, loadBreakList } from "../lib/chain/list";
import { type BreakFields, type Served, breakFieldsFromVector, configFieldsFromVector, encodeBreak, encodeConfig, fakeNode } from "./support/accounts";

const vectors: { programs: { breaks: string }; cases: { name: string; outputs: Record<string, any> | null }[] } = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "programs", "breaks", "instruction-vectors.json"), "utf8"),
);
const PROGRAM = vectors.programs.breaks;
const OTHER_PROGRAM = "Bvq3U9fz2MiHkLH8u4zyt6T1bimxnaEuHkZhezNDT5R9";
const sample = (name: string) => vectors.cases.find((c) => c.name === name)?.outputs as Record<string, any>;
const BREAK = breakFieldsFromVector(sample("breaks.account.Break"));
const CONFIG = configFieldsFromVector(sample("breaks.account.BreaksConfig"));

const breakFields = (id: bigint, over: Partial<BreakFields> = {}): BreakFields => ({ ...BREAK, id, spotsSold: Number(id % 10n), ...over });

/** A program that has made `total` breaks: a config account and the accounts of break ids 0 .. total - 1. */
function world(total: number, over: { config?: Served; skip?: number[] } = {}) {
  const accounts = new Map<Address, Served>();
  accounts.set(configAddress(PROGRAM), over.config ?? { data: encodeConfig({ ...CONFIG, nextBreakId: BigInt(total) }), owner: PROGRAM });
  for (let id = 0; id < total; id++) {
    if (over.skip?.includes(id)) continue;
    accounts.set(breakAddress(PROGRAM, BigInt(id)), { data: encodeBreak(breakFields(BigInt(id))), owner: PROGRAM });
  }
  return accounts;
}

const list = (accounts: Map<Address, Served>, extra: { count?: number; before?: number; program?: string } = {}) => {
  const node = fakeNode(accounts);
  const promise = loadBreakList({ rpcUrl: "https://node.example", breaksProgram: extra.program ?? PROGRAM, count: extra.count ?? 3, ...(extra.before !== undefined ? { before: extra.before } : {}), fetch: node.fetchFn });
  return { node, promise };
};
const numbers = (l: { rows: { number: number }[] }) => l.rows.map((r) => r.number);

describe("the list of breaks", () => {
  it("reads the newest breaks first, with the config and the breaks in two requests at finalized", async () => {
    const { node, promise } = list(world(7));
    const l = await promise;
    expect(l.total).toBe(7);
    expect(numbers(l)).toEqual([7, 6, 5]);
    // The number is the id + 1: break #7 is id 6, and the account says so.
    expect(l.rows.map((r) => r.break.id)).toEqual([6n, 5n, 4n]);
    expect(l.rows.map((r) => r.break.spotsSold)).toEqual([6, 5, 4]);
    expect(l.older).toBe(5);
    expect(node.requests.map((r) => r.addresses)).toEqual([[configAddress(PROGRAM)], [6n, 5n, 4n].map((id) => breakAddress(PROGRAM, id))]);
    expect(node.requests.map((r) => r.config.commitment)).toEqual(["finalized", "finalized"]);
  });

  it("continues with older breaks until break #1, and then there is nothing older", async () => {
    const accounts = world(7);
    const second = await list(accounts, { before: 5 }).promise;
    expect(numbers(second)).toEqual([4, 3, 2]);
    expect(second.older).toBe(2);
    const third = await list(accounts, { before: 2 }).promise;
    expect(numbers(third)).toEqual([1]);
    expect(third.older).toBeUndefined();
    expect(third.total).toBe(7);
  });

  it("says there is nothing older when the page reaches break #1 exactly", async () => {
    const l = await list(world(3)).promise;
    expect(numbers(l)).toEqual([3, 2, 1]);
    expect(l.older).toBeUndefined();
    // Asking for more than there are is fine.
    const all = await list(world(2), { count: 10 }).promise;
    expect(numbers(all)).toEqual([2, 1]);
    expect(all.older).toBeUndefined();
  });

  it("has an empty list for a program that has made no break, after one request", async () => {
    const { node, promise } = list(world(0));
    const l = await promise;
    expect(l).toEqual({ total: 0, rows: [], older: undefined });
    expect(node.requests).toHaveLength(1);
  });

  it("does not ask for more than exists when `before` is out of range", async () => {
    const accounts = world(4);
    // Far past the newest: the newest breaks are read, not accounts that cannot exist.
    const past = list(accounts, { before: 500 });
    expect(numbers(await past.promise)).toEqual([4, 3, 2]);
    expect(past.node.requests[1]?.addresses).toHaveLength(3);
    // Nothing is below break #1.
    const none = list(accounts, { before: 1 });
    expect(await none.promise).toEqual({ total: 4, rows: [], older: undefined });
    expect(none.node.requests).toHaveLength(1);
  });

  it("takes as many as the page limit in one request to the node", async () => {
    const { node, promise } = list(world(60), { count: MAX_COUNT });
    const l = await promise;
    expect(l.rows).toHaveLength(MAX_COUNT);
    expect(l.older).toBe(11);
    expect(node.requests[1]?.addresses).toHaveLength(MAX_COUNT);
  });

  it("refuses a request that makes no sense", async () => {
    const accounts = world(3);
    for (const count of [0, -1, 1.5, MAX_COUNT + 1, Number.NaN]) await expect(list(accounts, { count }).promise, String(count)).rejects.toThrow(/holds 1 to 50 breaks/);
    for (const before of [0, -3, 2.5, Number.NaN]) await expect(list(accounts, { before }).promise, String(before)).rejects.toThrow(/whole number from 1/);
  });
});

describe("what can go wrong with the list", () => {
  const fails = async (p: Promise<unknown>, message: RegExp) => {
    const err = await p.then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(LoadError);
    expect((err as Error).message).toMatch(message);
  };

  it("says when the program has no config account, or it is not the program's", async () => {
    const empty = new Map<Address, Served>();
    await fails(list(empty).promise, /has not been set up on this network/);
    await fails(list(world(3, { config: { data: encodeConfig({ ...CONFIG, nextBreakId: 3n }), owner: OTHER_PROGRAM } })).promise, /config account is not owned by the breaks program/);
    await fails(list(world(3, { config: { data: new Uint8Array(40), owner: PROGRAM } })).promise, /Could not read the breaks: not a BreaksConfig account/);
  });

  it("refuses a break that should exist but does not, is not the program's, is not a break, or is another break", async () => {
    await fails(list(world(5, { skip: [4] })).promise, /Break #5 should exist but its account is missing/);

    const foreign = world(5);
    foreign.set(breakAddress(PROGRAM, 3n), { data: encodeBreak(breakFields(3n)), owner: OTHER_PROGRAM });
    await fails(list(foreign).promise, /break #4 is not owned by the breaks program/);

    const garbage = world(5);
    garbage.set(breakAddress(PROGRAM, 4n), { data: new Uint8Array(100), owner: PROGRAM });
    await fails(list(garbage).promise, /break #5 could not be read: not a Break account/);

    const swapped = world(5);
    swapped.set(breakAddress(PROGRAM, 4n), { data: encodeBreak(breakFields(2n)), owner: PROGRAM });
    await fails(list(swapped).promise, /break #5 says it is break id 2/);
  });

  it("reports a node that cannot be reached, answers badly or refuses", async () => {
    const down = loadBreakList({ rpcUrl: "https://node.example", breaksProgram: PROGRAM, count: 3, fetch: (async () => { throw new Error("offline"); }) as unknown as typeof fetch });
    await fails(down, /could not reach the node: offline/);
    const refused = loadBreakList({ rpcUrl: "https://node.example", breaksProgram: PROGRAM, count: 3, fetch: (async () => new Response("", { status: 503 })) as unknown as typeof fetch });
    await fails(refused, /the node answered 503/);
  });

  it("will not count more breaks than a number can hold", async () => {
    const huge = world(3, { config: { data: encodeConfig({ ...CONFIG, nextBreakId: 2n ** 60n }), owner: PROGRAM } });
    await fails(list(huge).promise, /more breaks than this page can count/);
  });
});
