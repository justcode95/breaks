import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SPOT_ACCOUNT_BYTES, SPOT_OWNER_OFFSET } from "../lib/chain/accounts";
import { type Address, breakAddress, configAddress, spotAddress } from "../lib/chain/address";
import { FREE_WIN_BREAKS, MAX_SPOTS, loadMine, spotState } from "../lib/chain/mine";
import { type BreakFields, type ConfigFields, type Served, breakFieldsFromVector, configFieldsFromVector, encodeBreak, encodeConfig, encodeSpot } from "./support/accounts";
import { rpcNode } from "./support/node";
import { fill } from "./support/wallet";

const vectors: { programs: { breaks: string }; cases: { name: string; outputs?: Record<string, any> | null }[] } = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "programs", "breaks", "instruction-vectors.json"), "utf8"),
);
const named = (n: string) => vectors.cases.find((c) => c.name === n)?.outputs as Record<string, any>;
const PROGRAM = vectors.programs.breaks;
const CONFIG: ConfigFields = configFieldsFromVector(named("breaks.account.BreaksConfig"));
const SAMPLE = breakFieldsFromVector(named("breaks.account.Break"));
const ME = fill(4);
const OTHER = fill(6);
const NOW = 1_800_030_000;

interface SpotSpec {
  breakId: number;
  index: number;
  owner?: Address;
  refunded?: boolean;
  paid?: bigint;
}

function world(o: { breaks: number; override?: Record<number, Partial<BreakFields>>; spots?: SpotSpec[] }): Map<Address, Served> {
  const m = new Map<Address, Served>();
  m.set(configAddress(PROGRAM), { data: encodeConfig({ ...CONFIG, nextBreakId: BigInt(o.breaks) }), owner: PROGRAM });
  for (let id = 0; id < o.breaks; id++) {
    m.set(breakAddress(PROGRAM, BigInt(id)), { data: encodeBreak({ ...SAMPLE, id: BigInt(id), status: "Drawn", freeWinnerCount: 0, freeWinners: [], ...o.override?.[id] }), owner: PROGRAM });
  }
  const keys = new Map<number, Address>();
  for (const s of o.spots ?? []) {
    const key = keys.get(s.breakId) ?? breakAddress(PROGRAM, BigInt(s.breakId));
    keys.set(s.breakId, key);
    m.set(spotAddress(PROGRAM, key, s.index), { data: encodeSpot({ breakId: BigInt(s.breakId), index: s.index, owner: s.owner ?? ME, paid: s.paid ?? 20_000_000n, refunded: s.refunded ?? false }), owner: PROGRAM });
  }
  return m;
}

const load = (accounts: Map<Address, Served>, extra: { failing?: string[]; failMessage?: string } = {}) => {
  const node = rpcNode({ accounts, ...extra });
  return { node, result: loadMine({ rpcUrl: "http://node.test", breaksProgram: PROGRAM, owner: ME, fetch: node.fetchFn }) };
};
const win = (wallet: Address, weight = 600n) => ({ wallet, start: 0n, weight });

describe("the limits", () => {
  it("are 500 spots shown and the newest 50 breaks searched for free spots", () => {
    expect(MAX_SPOTS).toBe(500);
    expect(FREE_WIN_BREAKS).toBe(50);
  });
});

describe("the spots of a wallet", () => {
  it("are the paid spots it owns, newest break first and then by spot, with the break each is in", async () => {
    const { result } = load(
      world({
        breaks: 5,
        spots: [
          { breakId: 1, index: 3, paid: 15_000_000n },
          { breakId: 3, index: 2 },
          { breakId: 3, index: 0 },
          { breakId: 3, index: 1, owner: OTHER },
          { breakId: 0, index: 0, owner: OTHER },
        ],
      }),
    );
    const mine = await result;
    expect(mine.spots.map((s) => [s.breakNumber, s.index, s.paid, s.refunded])).toEqual([
      [4, 0, 20_000_000n, false],
      [4, 2, 20_000_000n, false],
      [2, 3, 15_000_000n, false],
    ]);
    expect(mine.spots[0]?.break.id).toBe(3n);
    expect(mine.truncated).toBe(false);
  });

  it("asks the node for this program's 60-byte Spot accounts with this owner at the owner's place, at finalized", async () => {
    const { node, result } = load(world({ breaks: 2, spots: [{ breakId: 1, index: 0 }] }));
    await result;
    const call = node.calls.find((c) => c.method === "getProgramAccounts");
    expect(call?.params).toEqual([PROGRAM, { encoding: "base64", commitment: "finalized", filters: [{ dataSize: 60 }, { memcmp: { offset: 18, bytes: ME } }] }]);
    expect(SPOT_ACCOUNT_BYTES).toBe(60);
    expect(SPOT_OWNER_OFFSET).toBe(18);
  });

  it("are none for a wallet that bought nothing", async () => {
    const mine = await load(world({ breaks: 3, spots: [{ breakId: 0, index: 0, owner: OTHER }] })).result;
    expect(mine.spots).toEqual([]);
    expect(mine.freeWins).toEqual([]);
  });

  it("show a refunded spot as refunded, even in a cancelled break, and a cancelled break's spot as refundable", async () => {
    const mine = await load(
      world({
        breaks: 3,
        override: { 1: { status: "Cancelled" }, 2: { status: "Cancelled" } },
        spots: [
          { breakId: 1, index: 0 },
          { breakId: 2, index: 0, refunded: true },
        ],
      }),
    ).result;
    const [refunded, refundable] = mine.spots;
    expect(refunded).toMatchObject({ breakNumber: 3, refunded: true });
    expect(refundable).toMatchObject({ breakNumber: 2, refunded: false });
    expect(spotState(refunded as never, NOW)).toEqual({ label: "Refunded", tone: "off" });
    expect(spotState(refundable as never, NOW)).toEqual({ label: "Cancelled: can be refunded", tone: "waiting" });
  });

  it("say where the break of a spot stands", async () => {
    const mine = await load(world({ breaks: 2, override: { 0: { status: "Drawn" }, 1: { status: "Funded" } }, spots: [{ breakId: 0, index: 0 }, { breakId: 1, index: 0 }] })).result;
    expect(mine.spots.map((s) => spotState(s, NOW))).toEqual([
      { label: "Packs paid for", tone: "waiting" },
      { label: "Drawn", tone: "done" },
    ]);
  });

  // 500 addresses are worked out by the test and again by the loader, which a slow machine takes seconds over.
  it("show only the newest 500 and say so when there are more", { timeout: 30_000 }, async () => {
    const spots = Array.from({ length: MAX_SPOTS + 1 }, (_, i) => ({ breakId: 0, index: i }));
    const mine = await load(world({ breaks: 1, spots })).result;
    expect(mine.spots).toHaveLength(MAX_SPOTS);
    expect(mine.truncated).toBe(true);
    expect(mine.spots.at(-1)?.index).toBe(MAX_SPOTS - 1);
    const exact = await load(world({ breaks: 1, spots: spots.slice(0, MAX_SPOTS) })).result;
    expect(exact.truncated).toBe(false);
  });
});

describe("the free spots of a wallet", () => {
  it("are the wins recorded on the newest breaks, with the place in the draw counting from 1", async () => {
    const mine = await load(
      world({
        breaks: 6,
        override: {
          2: { freeWinnerCount: 2, freeWinners: [win(OTHER), win(ME, 250n)], eligibilityTotalWeight: 1000n },
          4: { freeWinnerCount: 1, freeWinners: [win(ME, 500n)], eligibilityTotalWeight: 1000n },
          3: { freeWinnerCount: 1, freeWinners: [win(OTHER)] },
        },
      }),
    ).result;
    expect(mine.freeWins.map((w) => [w.breakNumber, w.position, w.weight])).toEqual([
      [5, 1, 500n],
      [3, 2, 250n],
    ]);
    expect(mine.searched).toBe(6);
    expect(mine.totalBreaks).toBe(6);
    // The breaks searched are handed on, newest first, for where the wallet stands on their lists.
    expect(mine.recent.map((r) => [r.number, r.break.id])).toEqual([6, 5, 4, 3, 2, 1].map((n) => [n, BigInt(n - 1)]));
  });

  it("look only at the newest 50 breaks, and say how many were looked at", async () => {
    const total = FREE_WIN_BREAKS + 2;
    const mine = await load(
      world({
        breaks: total,
        override: {
          0: { freeWinnerCount: 1, freeWinners: [win(ME)] },
          1: { freeWinnerCount: 1, freeWinners: [win(ME)] },
          2: { freeWinnerCount: 1, freeWinners: [win(ME)] },
        },
      }),
    ).result;
    // Breaks #1 and #2 are older than the newest 50 (#3 to #52).
    expect(mine.freeWins.map((w) => w.breakNumber)).toEqual([3]);
    expect(mine.searched).toBe(FREE_WIN_BREAKS);
    expect(mine.totalBreaks).toBe(total);
    expect(mine.recent.map((r) => r.number)).toEqual(Array.from({ length: FREE_WIN_BREAKS }, (_, i) => total - i));
  });
});

describe("what the node says is not simply believed", () => {
  const failure = (accounts: Map<Address, Served>, extra?: Parameters<typeof load>[1]) => load(accounts, extra).result;

  it("refuses a spot account that the breaks program does not own", async () => {
    const w = world({ breaks: 2, spots: [{ breakId: 1, index: 0 }] });
    const key = spotAddress(PROGRAM, breakAddress(PROGRAM, 1n), 0);
    w.set(key, { ...(w.get(key) as Served), owner: fill(9) });
    // The pretend node only answers for accounts owned by the program asked about, so serve it a lie about the owner itself.
    const node = rpcNode({ accounts: w });
    const liar = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (body.method !== "getProgramAccounts") return node.fetchFn(url, init);
      const entry = { pubkey: key, account: { data: [Buffer.from((w.get(key) as Served).data).toString("base64"), "base64"], owner: fill(9), lamports: 1, executable: false } };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [entry] }));
    }) as unknown as typeof fetch;
    await expect(loadMine({ rpcUrl: "http://node.test", breaksProgram: PROGRAM, owner: ME, fetch: liar })).rejects.toThrow("not owned by the breaks program");
  });

  it("refuses a spot that cannot be read, that belongs to another wallet, or that sits at the wrong address", async () => {
    const answer = async (entry: unknown) => {
      const node = rpcNode({ accounts: world({ breaks: 2 }) });
      const fetchFn = (async (url: string, init: RequestInit) => {
        if (JSON.parse(init.body as string).method !== "getProgramAccounts") return node.fetchFn(url, init);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [entry] }));
      }) as unknown as typeof fetch;
      return loadMine({ rpcUrl: "http://node.test", breaksProgram: PROGRAM, owner: ME, fetch: fetchFn });
    };
    const spotKey = spotAddress(PROGRAM, breakAddress(PROGRAM, 1n), 0);
    const served = (data: Uint8Array, pubkey = spotKey) => ({ pubkey, account: { data: [Buffer.from(data).toString("base64"), "base64"], owner: PROGRAM } });
    await expect(answer(served(new Uint8Array(60)))).rejects.toThrow("A spot account could not be read");
    await expect(answer(served(encodeSpot({ breakId: 1n, index: 0, owner: OTHER, paid: 1n, refunded: false })))).rejects.toThrow("belongs to another wallet");
    await expect(answer(served(encodeSpot({ breakId: 1n, index: 0, owner: ME, paid: 1n, refunded: false }), fill(8)))).rejects.toThrow("at an address the program would not use");
    // The right bytes at the address of another spot of the same break are refused as well.
    await expect(answer(served(encodeSpot({ breakId: 1n, index: 1, owner: ME, paid: 1n, refunded: false })))).rejects.toThrow("at an address the program would not use");
    await expect(answer(served(encodeSpot({ breakId: 0n, index: 0, owner: ME, paid: 1n, refunded: false })))).rejects.toThrow("at an address the program would not use");
  });

  it("refuses a break that is missing, not the program's, unreadable or another break", async () => {
    const spots = [{ breakId: 1, index: 0 }];
    const missing = world({ breaks: 2, spots });
    missing.delete(breakAddress(PROGRAM, 1n));
    // The list of newest breaks is read as well, and would stop first: the missing break is named either way.
    await expect(failure(missing)).rejects.toThrow("Break #2");

    // A break the free-spot search does not read (older than the newest 50) but a spot is in.
    const total = FREE_WIN_BREAKS + 1;
    const old = (over: (m: Map<Address, Served>) => void) => {
      const w = world({ breaks: total, spots: [{ breakId: 0, index: 0 }] });
      over(w);
      return w;
    };
    const key0 = breakAddress(PROGRAM, 0n);
    await expect(failure(old((w) => w.delete(key0)))).rejects.toThrow("Break #1 has a spot of this wallet but its account is missing");
    await expect(failure(old((w) => w.set(key0, { ...(w.get(key0) as Served), owner: fill(9) })))).rejects.toThrow("The account for break #1 is not owned by the breaks program");
    await expect(failure(old((w) => w.set(key0, { data: new Uint8Array(5), owner: PROGRAM })))).rejects.toThrow("The account for break #1 could not be read");
    await expect(failure(old((w) => w.set(key0, { data: encodeBreak({ ...SAMPLE, id: 5n, status: "Drawn", freeWinnerCount: 0, freeWinners: [] }), owner: PROGRAM })))).rejects.toThrow("says it is break id 5");
  });

  it("says in words when the node cannot be read, or the program is not set up", async () => {
    await expect(failure(world({ breaks: 2 }), { failing: ["getProgramAccounts"], failMessage: "Method not allowed" })).rejects.toThrow("the node refused the request: Method not allowed");
    await expect(failure(world({ breaks: 2 }), { failing: ["getMultipleAccounts"] })).rejects.toThrow("getMultipleAccounts is failing");
    const bare = new Map<Address, Served>();
    await expect(failure(bare)).rejects.toThrow("has not been set up on this network");
    const garbled = rpcNode({ accounts: world({ breaks: 2 }) });
    const notAList = (async (url: string, init: RequestInit) => {
      if (JSON.parse(init.body as string).method !== "getProgramAccounts") return garbled.fetchFn(url, init);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: [] } }));
    }) as unknown as typeof fetch;
    await expect(loadMine({ rpcUrl: "http://node.test", breaksProgram: PROGRAM, owner: ME, fetch: notAList })).rejects.toThrow("was not a list of accounts");
    const malformed = (async (url: string, init: RequestInit) => {
      if (JSON.parse(init.body as string).method !== "getProgramAccounts") return garbled.fetchFn(url, init);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [{ pubkey: 5 }] }));
    }) as unknown as typeof fetch;
    await expect(loadMine({ rpcUrl: "http://node.test", breaksProgram: PROGRAM, owner: ME, fetch: malformed })).rejects.toThrow("for an account was malformed");
  });
});
