import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type BreakStatus, decodeBreak } from "../lib/chain/accounts";
import { type Address, breakAddress, spotAddress } from "../lib/chain/address";
import { type Loaded, LoadError, inputFromBreak, loadBreak } from "../lib/chain/load";
import { getAccounts } from "../lib/chain/rpc";
import { fromHex, toHex } from "../lib/draw/bytes";
import { exampleInput } from "../lib/example";
import { type Verified, type VerifyResult, verifyDraw } from "../lib/verify";
import { type BreakFields, type Served, breakFieldsFromVector, configFieldsFromVector, encodeBreak, encodeConfig, encodeSpot, fakeNode } from "./support/accounts";

const vectors: { programs: { breaks: string }; cases: { name: string; inputs: Record<string, string>; outputs: Record<string, unknown> | null }[] } = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "programs", "breaks", "instruction-vectors.json"), "utf8"),
);
const PROGRAM = vectors.programs.breaks;
const OTHER_PROGRAM = "Bvq3U9fz2MiHkLH8u4zyt6T1bimxnaEuHkZhezNDT5R9";
const ID = 7n;
const NUMBER = 8;

const ok = (r: VerifyResult): Verified => {
  if (!r.ok) throw new Error(r.errors.join(" | "));
  return r;
};

describe("the test encoder", () => {
  it("writes exactly the bytes the Rust program writes", () => {
    const v = vectors.cases.find((c) => c.name === "breaks.account.Break")!;
    const o = v.outputs as Record<string, any>;
    const fields = breakFieldsFromVector(o);
    expect(toHex(encodeBreak(fields))).toBe(v.inputs.data);

    const c = vectors.cases.find((x) => x.name === "breaks.account.BreaksConfig")!;
    expect(toHex(encodeConfig(configFieldsFromVector(c.outputs as Record<string, any>)))).toBe(c.inputs.data);

    const s = vectors.cases.find((c) => c.name === "breaks.account.Spot")!;
    const so = s.outputs as Record<string, any>;
    expect(toHex(encodeSpot({ breakId: BigInt(so.breakId), index: so.index, owner: so.owner, paid: BigInt(so.paid), refunded: so.refunded, bump: so.bump }))).toBe(s.inputs.data);
  });
});

/** The example break from the verify page, as the chain would hold it after the draw. */
function consistentBreak(over: Partial<BreakFields> = {}) {
  const input = exampleInput();
  const r = ok(verifyDraw(input));
  const paidOwners = input.paidOwners.split("\n");
  const fields: BreakFields = {
    id: ID,
    status: "Drawn",
    paidSpots: 10,
    freeSpots: 2,
    spotPrice: 20_000_000n,
    tiers: [{ machine: new Uint8Array(32).fill(0x77), maxPrice: 25_000_000n }],
    packs: Array<number>(12).fill(0),
    opensAt: 1_800_000_000n,
    closesAt: 1_800_021_600n,
    spotsSold: paidOwners.length,
    lockedSubsidy: 0n,
    lockedHolder: 0n,
    eligibilityRoot: fromHex(r.eligibility.root),
    eligibilityTotalWeight: r.eligibility.totalWeight,
    eligibilityCount: r.eligibility.entries,
    eligibilityInputsHash: new Uint8Array(32).fill(2),
    poolSize: 5,
    packBudget: 125_000_000n,
    poolHash: fromHex(r.poolHash as string),
    randomnessAttempt: 0,
    randomnessRequestId: new Uint8Array(32).fill(5),
    randomnessRequestedAt: 1_800_022_000n,
    seed: fromHex(input.seed),
    seededAt: 1_800_022_100n,
    freeWinnerCount: r.winners.length,
    freeWinners: r.winners.map((w) => ({ wallet: w.wallet, start: w.start, weight: w.weight })),
    bump: 255,
    escrowBump: 254,
    ...over,
  };
  const accounts = new Map<Address, Served>();
  const key = breakAddress(PROGRAM, ID);
  accounts.set(key, { data: encodeBreak(fields), owner: PROGRAM });
  paidOwners.forEach((owner, i) => accounts.set(spotAddress(PROGRAM, key, i), { data: encodeSpot({ breakId: ID, index: i, owner, paid: 20_000_000n, refunded: false }), owner: PROGRAM }));
  return { input, r, fields, accounts, key, paidOwners };
}

const load = (accounts: Map<Address, Served>, number = NUMBER, program = PROGRAM) => {
  const node = fakeNode(accounts);
  return { node, promise: loadBreak({ rpcUrl: "https://node.example", breaksProgram: program, number, fetch: node.fetchFn }) };
};

describe("loading a break and checking it against what the chain recorded", () => {
  it("fills in the form from the chain, and a draw that follows from the pasted list matches everything", async () => {
    const b = consistentBreak();
    const { node, promise } = load(b.accounts);
    const loaded = await promise;
    expect(loaded.number).toBe(NUMBER);
    expect(loaded.paidOwners).toEqual(b.paidOwners);

    const { patch, onChain, notes } = inputFromBreak(loaded);
    expect(notes).toEqual([]);
    expect(patch.seed).toBe(b.input.seed);
    expect(patch.freeSpots).toBe("2");
    expect(patch.paidOwners).toBe(b.paidOwners.join("\n"));
    expect(patch.expected).toEqual({ root: toHex(b.fields.eligibilityRoot), totalWeight: String(b.r.eligibility.totalWeight), entryCount: "6", poolHash: toHex(b.fields.poolHash) });
    expect(onChain.complete).toBe(true);

    // What is not on chain is pasted: the eligibility list and the cards.
    const result = ok(verifyDraw({ ...b.input, ...patch, onChain }));
    expect(result.checks.map((c) => [c.label, c.matches])).toEqual([
      ["Eligibility root", true],
      ["Total weight", true],
      ["Eligible wallets", true],
      ["Pool hash", true],
      ["Winner 1 recorded on chain", true],
      ["Winner 2 recorded on chain", true],
      ["Winners recorded on chain", true],
    ]);
    expect(result.notes).toEqual([]);

    // Read at finalized, as base64, in one request for the break and one for its spots.
    expect(node.requests.map((r) => r.addresses.length)).toEqual([1, 3]);
    for (const r of node.requests) expect(r.config).toEqual({ encoding: "base64", commitment: "finalized" });
  });

  it("flags a winner the draw does not give, one recorded in the wrong place, and a missing one", async () => {
    const b = consistentBreak();
    const wrongWallet = consistentBreak({ freeWinners: [{ ...b.fields.freeWinners[1]!, }, { ...b.fields.freeWinners[0]! }] });
    const swapped = inputFromBreak(await load(wrongWallet.accounts).promise);
    const r1 = ok(verifyDraw({ ...b.input, ...swapped.patch, onChain: swapped.onChain }));
    expect(r1.checks.filter((c) => !c.matches).map((c) => c.label)).toEqual(["Winner 1 recorded on chain", "Winner 2 recorded on chain"]);

    const shifted = consistentBreak({ freeWinners: b.fields.freeWinners.map((w, i) => (i === 0 ? { ...w, start: w.start + 1n } : w)) });
    const s = inputFromBreak(await load(shifted.accounts).promise);
    expect(ok(verifyDraw({ ...b.input, ...s.patch, onChain: s.onChain })).checks.filter((c) => !c.matches).map((c) => c.label)).toEqual(["Winner 1 recorded on chain"]);

    // The draw is complete (`Drawn`) but only one winner is recorded.
    const missing = consistentBreak({ freeWinnerCount: 1, freeWinners: b.fields.freeWinners.slice(0, 1) });
    const m = inputFromBreak(await load(missing.accounts).promise);
    expect(ok(verifyDraw({ ...b.input, ...m.patch, onChain: m.onChain })).checks.filter((c) => !c.matches).map((c) => c.label)).toEqual(["Winners recorded on chain"]);
  });

  it("flags a pasted list that is not the committed one", async () => {
    const b = consistentBreak();
    const { patch, onChain } = inputFromBreak(await load(b.accounts).promise);
    const lines = b.input.holders.split("\n");
    const tampered = [lines[0], ...lines.slice(1).map((l, i) => (i === 0 ? l.replace(/ \d+$/, " 11") : l))].join("\n");
    const r = ok(verifyDraw({ ...b.input, holders: tampered, ...patch, onChain }));
    expect(r.checks.find((c) => c.label === "Eligibility root")?.matches).toBe(false);
    // A list was pasted, so the "list is empty" hint would be wrong here.
    expect(r.notes).toEqual([]);
  });

  it("flags a winner recorded on chain that the draw does not produce at all", async () => {
    const b = consistentBreak();
    const { patch, onChain } = inputFromBreak(await load(b.accounts).promise);
    // The break has 2 free spots; this draw is told it has 1, while 2 winners are recorded.
    const r = ok(verifyDraw({ ...b.input, ...patch, freeSpots: "1", cards: "", paidOwners: "", onChain }));
    const second = r.checks.find((c) => c.label === "Winner 2 recorded on chain");
    expect(second).toMatchObject({ matches: false, actual: "no such winner in this draw" });
    expect(r.checks.find((c) => c.label === "Winner 1 recorded on chain")?.matches).toBe(true);
    expect(r.checks.find((c) => c.label === "Winners recorded on chain")).toMatchObject({ expected: "2", actual: "1", matches: false });
  });

  it("says when winners are still being claimed rather than calling it a difference", async () => {
    const b = consistentBreak({ status: "Settled", freeWinnerCount: 1, freeWinners: consistentBreak().fields.freeWinners.slice(0, 1) });
    const { patch, onChain } = inputFromBreak(await load(b.accounts).promise);
    expect(onChain.complete).toBe(false);
    const r = ok(verifyDraw({ ...b.input, ...patch, onChain }));
    expect(r.checks.every((c) => c.matches)).toBe(true);
    expect(r.notes).toEqual(["Only 1 of 2 winners are recorded on the break so far; the rest are claimed one at a time."]);
  });
});

describe("a break that is not that far along", () => {
  const status = (s: BreakStatus, over: Partial<BreakFields> = {}) => inputFromBreak(loadedFrom(consistentBreak({ status: s, ...over })));
  function loadedFrom(b: ReturnType<typeof consistentBreak>): Loaded {
    return { number: NUMBER, break: decodeBreak(b.accounts.get(b.key)!.data), paidOwners: b.paidOwners, notes: [] };
  }

  it("fills in only what the chain holds so far, and says what is missing", () => {
    for (const s of ["Open", "Closed"] as const) {
      const r = status(s);
      expect(r.patch.seed).toBe("");
      expect(r.patch.expected).toEqual({ root: "", totalWeight: "", entryCount: "", poolHash: "" });
      expect(r.notes).toEqual(["The eligibility list has not been committed yet, so there is nothing to compare it with.", "The randomness has not been settled yet, so there is no seed: the draw has not happened."]);
    }
    const committed = status("EligibilityCommitted");
    expect(committed.patch.expected.root).not.toBe("");
    expect(committed.patch.expected.poolHash).toBe("");
    expect(committed.patch.seed).toBe("");
    const pool = status("PoolCommitted");
    expect(pool.patch.expected.poolHash).not.toBe("");
    expect(pool.patch.seed).toBe("");
    expect(status("Settled").patch.seed).not.toBe("");
  });

  it("does not compare a cancelled break with anything", async () => {
    const b = consistentBreak({ status: "Cancelled" });
    const r = inputFromBreak(await load(b.accounts).promise);
    expect(r.patch.expected).toEqual({ root: "", totalWeight: "", entryCount: "", poolHash: "" });
    expect(r.patch.seed).toBe("");
    expect(r.notes).toEqual(["This break was cancelled: nothing was drawn."]);
  });

  it("notes a refunded spot", async () => {
    const b = consistentBreak({ status: "Cancelled" });
    b.accounts.set(spotAddress(PROGRAM, b.key, 1), { data: encodeSpot({ breakId: ID, index: 1, owner: b.paidOwners[1]!, paid: 20_000_000n, refunded: true }), owner: PROGRAM });
    const loaded = await load(b.accounts).promise;
    // The loader reports the spots; the verify form's notes add the cancellation in front.
    expect(loaded.notes).toEqual(["Paid spot 2 was refunded."]);
    expect(inputFromBreak(loaded).notes).toEqual(["This break was cancelled: nothing was drawn.", "Paid spot 2 was refunded."]);
  });
});

describe("what can go wrong on the way", () => {
  const fails = async (p: Promise<unknown>, message: RegExp) => {
    const err = await p.then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(LoadError);
    expect((err as Error).message).toMatch(message);
  };

  it("refuses a break number that is not one", async () => {
    const b = consistentBreak();
    for (const n of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) await fails(load(b.accounts, n).promise, /whole number from 1/);
  });

  it("says there is no such break", async () => {
    await fails(load(new Map(), 3).promise, /no break #3 on this program/);
    await fails(load(consistentBreak().accounts, 9).promise, /no break #9/);
  });

  it("refuses accounts that are not the breaks program's, or are another break's", async () => {
    const b = consistentBreak();
    b.accounts.set(b.key, { data: b.accounts.get(b.key)!.data, owner: OTHER_PROGRAM });
    await fails(load(b.accounts).promise, /not owned by the breaks program/);

    const c = consistentBreak();
    c.accounts.set(c.key, { data: encodeBreak({ ...c.fields, id: 3n }), owner: PROGRAM });
    await fails(load(c.accounts).promise, /says it is break id 3/);

    const d = consistentBreak();
    d.accounts.set(d.key, { data: new Uint8Array(100), owner: PROGRAM });
    await fails(load(d.accounts).promise, /Could not read break #8.*(discriminator|short)/);
  });

  it("refuses a missing, foreign or misplaced spot", async () => {
    const missing = consistentBreak();
    missing.accounts.delete(spotAddress(PROGRAM, missing.key, 1));
    await fails(load(missing.accounts).promise, /Paid spot 2 .* missing/);

    const foreign = consistentBreak();
    foreign.accounts.set(spotAddress(PROGRAM, foreign.key, 0), { data: foreign.accounts.get(spotAddress(PROGRAM, foreign.key, 0))!.data, owner: OTHER_PROGRAM });
    await fails(load(foreign.accounts).promise, /Paid spot 1 is not owned/);

    const misplaced = consistentBreak();
    misplaced.accounts.set(spotAddress(PROGRAM, misplaced.key, 2), { data: encodeSpot({ breakId: ID, index: 0, owner: misplaced.paidOwners[0]!, paid: 1n, refunded: false }), owner: PROGRAM });
    await fails(load(misplaced.accounts).promise, /paid spot 3 belongs to another spot/);

    const otherBreak = consistentBreak();
    otherBreak.accounts.set(spotAddress(PROGRAM, otherBreak.key, 2), { data: encodeSpot({ breakId: 99n, index: 2, owner: otherBreak.paidOwners[2]!, paid: 1n, refunded: false }), owner: PROGRAM });
    await fails(load(otherBreak.accounts).promise, /paid spot 3 belongs to another spot/);
  });

  it("reports a node that fails, answers badly or is not there", async () => {
    const go = (fetchFn: typeof fetch) => loadBreak({ rpcUrl: "https://node.example", breaksProgram: PROGRAM, number: NUMBER, fetch: fetchFn });
    const reply = (body: unknown, status = 200) => (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;
    await fails(go(reply("", 500)), /the node answered 500/);
    await fails(go(reply("<html>", 200)), /was not JSON/);
    await fails(go(reply({ jsonrpc: "2.0", id: 1, error: { message: "rate limited" } })), /refused the request: rate limited/);
    await fails(go(reply({ jsonrpc: "2.0", id: 1, result: { value: [] } })), /one entry per account/);
    await fails(go(reply({ jsonrpc: "2.0", id: 1, result: { value: [{ data: "nope", owner: 5 }] } })), /malformed/);
    await fails(go((async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch), /could not reach the node: fetch failed/);
  });

  it("reads any number of accounts in batches the node accepts", async () => {
    const accounts = new Map<Address, Served>();
    const addresses = Array.from({ length: 250 }, (_, i) => spotAddress(PROGRAM, breakAddress(PROGRAM, 0n), i));
    for (const [i, a] of addresses.entries()) if (i % 2 === 0) accounts.set(a, { data: Uint8Array.of(i & 0xff), owner: PROGRAM });
    const node = fakeNode(accounts);
    const got = await getAccounts({ url: "https://node.example", addresses, fetch: node.fetchFn });
    expect(node.requests.map((r) => r.addresses.length)).toEqual([100, 100, 50]);
    expect(got).toHaveLength(250);
    expect(got.map((a) => a !== null)).toEqual(addresses.map((_, i) => i % 2 === 0));
    expect(got[4]?.data).toEqual(Uint8Array.of(4));
  });
});
