import { describe, expect, it } from "vitest";
import { drawFreeWinners } from "../src/draw/draw.js";
import { equalBytes } from "../src/draw/bytes.js";
import { MAX_RANDOMNESS_ATTEMPTS, ORAO_PROGRAM, breakAddress, drawSeed, oraoNetworkState, requestAddress, requestId } from "../src/solana/breaks.js";
import { addressFromBytes } from "../src/solana/pubkey.js";
import { associatedTokenAddress } from "../src/solana/pubkey.js";
import { OraoVrf, fixedVrf } from "../src/pipeline/vrf.js";
import { encodeNetworkState } from "./support/accounts.js";
import { addr, BUYER } from "./support/chain.js";
import { ANSWER, PROGRAMS, world } from "./support/world.js";

const steps = (r: { sent: { step: string }[] }) => r.sent.map((s) => s.step);
const requestOf = (w: ReturnType<typeof world>) => requestAddress(ORAO_PROGRAM, w.chain.breaks.get(7n)!.randomnessRequestId);

describe("BreakPipeline: the whole path", () => {
  it("commits the pool, asks ORAO, settles the answer and records every free winner", async () => {
    const w = world();
    await w.pullPacks();
    const pipe = w.pipeline();

    const first = await pipe.advance(w.active);
    expect(steps(first)).toEqual(["commit_pool", "request_randomness"]);
    expect(first.chainStatus).toBe("RandomnessRequested");
    expect(first.waiting).toMatch(/ORAO has not answered/);
    const b = w.chain.breaks.get(7n)!;
    expect(equalBytes(b.poolHash, w.expectedPoolHash())).toBe(true);
    expect(equalBytes(b.randomnessRequestId, requestId(breakAddress(PROGRAMS, 7n), 0, b.eligibilityRoot, b.poolHash))).toBe(true);

    w.chain.fulfill(requestOf(w), ANSWER);
    const second = await pipe.advance(w.active);
    expect(steps(second)).toEqual(["settle_randomness", "claim_free_spot#0", "claim_free_spot#1"]);
    expect(second.chainStatus).toBe("Drawn");
    expect(equalBytes(b.seed, drawSeed(ANSWER))).toBe(true);

    // The recorded winners are exactly who the draw picks, in order, whatever the program accepted.
    const expected = drawFreeWinners(b.seed, w.leaves, 2).map((x) => addressFromBytes(w.leaves[x.leafIndex]!.wallet));
    expect(b.freeWinners.slice(0, 2).map((x) => x.wallet)).toEqual(expected);
    expect(b.freeWinnerCount).toBe(2);
  });

  it("does nothing more once the break is drawn, however often it is called", async () => {
    const w = world();
    await w.pullPacks();
    const pipe = w.pipeline();
    await pipe.advance(w.active);
    w.chain.fulfill(requestOf(w), ANSWER);
    await pipe.advance(w.active);
    const sends = w.chain.sendCalls;
    for (let i = 0; i < 3; i++) {
      const r = await pipe.advance(w.active);
      expect(r.sent).toEqual([]);
      expect(r.chainStatus).toBe("Drawn");
    }
    expect(w.chain.sendCalls).toBe(sends);
    expect(w.chain.applied).toEqual(["commit_pool", "request_randomness", "settle_randomness", "claim_free_spot", "claim_free_spot"]);
  });

  it("a break with no free spots is drawn as soon as the answer is settled", async () => {
    const w = world({ paid: 3, free: 0 });
    await w.pullPacks();
    const pipe = w.pipeline();
    await pipe.advance(w.active);
    w.chain.fulfill(requestOf(w), ANSWER);
    const r = await pipe.advance(w.active);
    expect(steps(r)).toEqual(["settle_randomness"]);
    expect(r.chainStatus).toBe("Drawn");
  });

  it("the pool hash does not depend on the order the packs were pulled in", async () => {
    const a = world();
    const b = world();
    await a.pullPacks();
    await b.pullPacks(5, [4, 3, 2, 1, 0]); // the same cards against different pack indexes
    await a.pipeline().advance(a.active);
    await b.pipeline().advance(b.active);
    expect(equalBytes(a.chain.breaks.get(7n)!.poolHash, b.chain.breaks.get(7n)!.poolHash)).toBe(true);
    expect(equalBytes(a.chain.breaks.get(7n)!.poolHash, a.expectedPoolHash())).toBe(true);
  });

  it("works with a deeper eligibility tree and more free spots", async () => {
    const w = world({ paid: 2, free: 4, wallets: 37 });
    await w.pullPacks();
    const pipe = w.pipeline();
    await pipe.advance(w.active);
    w.chain.fulfill(requestOf(w), ANSWER);
    const r = await pipe.advance(w.active);
    expect(r.chainStatus, r.problem).toBe("Drawn");
    expect(steps(r)).toEqual(["settle_randomness", "claim_free_spot#0", "claim_free_spot#1", "claim_free_spot#2", "claim_free_spot#3"]);
    const b = w.chain.breaks.get(7n)!;
    expect(new Set(b.freeWinners.slice(0, 4).map((x) => x.wallet)).size).toBe(4);
  });
});

describe("BreakPipeline: the pool is only committed when it is real", () => {
  it("waits while packs are still being pulled", async () => {
    const w = world();
    await w.pullPacks(3);
    const r = await w.pipeline().advance(w.active);
    expect(r.waiting).toBe("packs: 3/5 pulled");
    expect(r.sent).toEqual([]);
    expect(w.chain.sendCalls).toBe(0);

    await w.pullPacks(5);
    expect(steps(await w.pipeline().advance(w.active))).toEqual(["commit_pool", "request_randomness"]);
  });

  it("stops on a pack that failed for good", async () => {
    const w = world();
    await w.pullPacks(4);
    const key = { breakId: w.active.id, index: 4 };
    await w.packs.ensure(key);
    await w.packs.startAttempt(key, { signature: "dead", expiry: "9" });
    await w.packs.resolveAttempt(key, "dead", { to: "failed", why: "failed", reason: "gave up" });
    const r = await w.pipeline().advance(w.active);
    expect(r.problem).toMatch(/failed for good/);
    expect(w.chain.sendCalls).toBe(0);
  });

  it("refuses more packs than the pool, and two packs with the same card", async () => {
    const extra = world();
    await extra.pullPacks();
    const key = { breakId: extra.active.id, index: 5 };
    await extra.packs.ensure(key);
    await extra.packs.startAttempt(key, { signature: "x", expiry: "9" });
    await extra.packs.resolveAttempt(key, "x", { to: "confirmed" });
    await extra.packs.complete(key, { cardMint: addr(199) });
    expect((await extra.pipeline().advance(extra.active)).problem).toMatch(/6 packs recorded but the pool has 5/);
    expect(extra.chain.sendCalls).toBe(0);
  });

  it("does not commit a card the buyer wallet does not hold", async () => {
    const w = world();
    await w.pullPacks();
    w.transfer.give(w.cards[2]!, addr(222));
    const r = await w.pipeline().advance(w.active);
    expect(r.problem).toMatch(/is held by .* not by the buyer wallet/);
    expect(w.chain.sendCalls).toBe(0);
    w.transfer.give(w.cards[2]!, BUYER);
    expect(steps(await w.pipeline().advance(w.active))).toContain("commit_pool");
  });

  it("does not commit a card nobody can find", async () => {
    const w = world();
    await w.pullPacks();
    const gone = w.pipeline({ cards: { ownerOf: async () => undefined } });
    expect((await gone.advance(w.active)).problem).toMatch(/nobody found/);
    expect(w.chain.sendCalls).toBe(0);
  });
});

describe("BreakPipeline: other states", () => {
  it("leaves a cancelled break alone, and reports a break that does not exist", async () => {
    const w = world();
    w.chain.breaks.get(7n)!.status = "Cancelled";
    expect((await w.pipeline().advance(w.active)).waiting).toMatch(/cancelled/);
    expect((await w.pipeline().advance({ ...w.active, onchainId: 99n })).problem).toMatch(/does not exist/);
    expect(w.chain.sendCalls).toBe(0);
  });
});

describe("BreakPipeline: randomness", () => {
  async function requested() {
    const w = world();
    await w.pullPacks();
    const pipe = w.pipeline();
    await pipe.advance(w.active);
    return { w, pipe };
  }

  it("does not ask again before the timeout", async () => {
    const { w, pipe } = await requested();
    const sends = w.chain.sendCalls;
    w.chain.unixTime += 3_599n;
    const r = await pipe.advance(w.active);
    expect(r.waiting).toMatch(/repeat possible in 1s/);
    expect(w.chain.sendCalls).toBe(sends);
  });

  it("repeats an unanswered request after the timeout, with a new seed, until the attempts run out", async () => {
    const { w, pipe } = await requested();
    const b = w.chain.breaks.get(7n)!;
    const seeds = [b.randomnessRequestId];
    for (let attempt = 1; attempt < MAX_RANDOMNESS_ATTEMPTS; attempt++) {
      w.chain.unixTime += 3_601n;
      const r = await pipe.advance(w.active);
      expect(steps(r)).toEqual([`request_randomness#${attempt}`]);
      expect(b.randomnessAttempt).toBe(attempt);
      seeds.push(b.randomnessRequestId);
    }
    expect(new Set(seeds.map((s) => Buffer.from(s).toString("hex"))).size).toBe(MAX_RANDOMNESS_ATTEMPTS);

    w.chain.unixTime += 3_601n;
    const sends = w.chain.sendCalls;
    const r = await pipe.advance(w.active);
    expect(r.problem).toMatch(/never answered 5 requests/);
    expect(w.chain.sendCalls).toBe(sends);
  });

  it("never replaces a request that was answered: it settles it, even after the timeout", async () => {
    const { w, pipe } = await requested();
    w.chain.fulfill(requestOf(w), ANSWER);
    w.chain.unixTime += 10_000n;
    const r = await pipe.advance(w.active);
    expect(steps(r)[0]).toBe("settle_randomness");
    expect(w.chain.breaks.get(7n)!.randomnessAttempt).toBe(0);
  });

  it("settles the answer of a repeated request", async () => {
    const { w, pipe } = await requested();
    w.chain.unixTime += 3_601n;
    await pipe.advance(w.active);
    w.chain.fulfill(requestOf(w), ANSWER);
    const r = await pipe.advance(w.active);
    expect(r.chainStatus).toBe("Drawn");
    expect(equalBytes(w.chain.breaks.get(7n)!.seed, drawSeed(ANSWER))).toBe(true);
  });

  it("does not use a randomness program the keeper is not configured for", async () => {
    const w = world();
    await w.pullPacks();
    const wrong = w.pipeline({ vrf: fixedVrf(addr(77), { networkState: addr(0xa1), treasury: addr(0xa2) }) });
    // The pool is committed (that does not involve ORAO); asking for randomness is refused before anything is sent.
    const r = await wrong.advance(w.active);
    expect(steps(r)).toEqual(["commit_pool"]);
    expect(r.problem).toMatch(/set to use .* for randomness but the keeper is configured for/);
    expect(w.chain.applied).toEqual(["commit_pool"]);
  });

  describe("the accounts for ORAO's fee", () => {
    const orao = (w: ReturnType<typeof world>) => new OraoVrf(w.chain, ORAO_PROGRAM);

    it("come from ORAO's network state: the request goes to the treasury it names", async () => {
      const w = world();
      await w.pullPacks();
      const r = await w.pipeline({ vrf: orao(w) }).advance(w.active);
      expect(steps(r)).toEqual(["commit_pool", "request_randomness"]);
      expect(r.problem).toBeUndefined();
    });

    it("follow a treasury that ORAO changes between two requests", async () => {
      const w = world();
      await w.pullPacks();
      const pipe = w.pipeline({ vrf: orao(w) });
      w.chain.accounts.set(
        oraoNetworkState(ORAO_PROGRAM),
        encodeNetworkState({ authority: addr(0xa0), treasury: addr(0x99), requestFee: 1_500_000n, fulfillmentAuthorities: [], numReceived: 43n }),
      );
      // The program model, like ORAO, only accepts the treasury the network state names.
      const r = await pipe.advance(w.active);
      expect(steps(r)).toEqual(["commit_pool", "request_randomness"]);
      expect(r.problem).toBeUndefined();
    });

    it("are refused by ORAO when they are not its treasury (what a copy in the configuration could get wrong)", async () => {
      const w = world();
      await w.pullPacks();
      const stale = fixedVrf(ORAO_PROGRAM, { networkState: oraoNetworkState(ORAO_PROGRAM), treasury: addr(0x55) });
      const r = await w.pipeline({ vrf: stale }).advance(w.active);
      expect(r.problem).toMatch(/request_randomness failed: UnknownTreasuryGiven/);
      expect(w.chain.applied).toEqual(["commit_pool"]);
    });

    it("are not guessed: with no network state nothing is requested, and the reason says so", async () => {
      const w = world();
      await w.pullPacks();
      w.chain.accounts.delete(oraoNetworkState(ORAO_PROGRAM));
      const r = await w.pipeline({ vrf: orao(w) }).advance(w.active);
      expect(steps(r)).toEqual(["commit_pool"]);
      expect(r.problem).toMatch(/network state .* does not exist on this cluster/);
      expect(w.chain.applied).toEqual(["commit_pool"]);
      // It is an expected, explainable condition, reported once as a problem; not an unexpected failure logged as such.
      expect(w.errors).toEqual([]);
      // and once ORAO's state is there, the request goes out
      w.chain.accounts.set(oraoNetworkState(ORAO_PROGRAM), encodeNetworkState({ authority: addr(0xa0), treasury: addr(0xa2), requestFee: 1n, fulfillmentAuthorities: [], numReceived: 0n }));
      expect(steps(await w.pipeline({ vrf: orao(w) }).advance(w.active))).toEqual(["request_randomness"]);
    });
  });

  it("reports a request account that is missing", async () => {
    const { w, pipe } = await requested();
    (w.chain as unknown as { requests: Map<string, unknown> }).requests.clear();
    expect((await pipe.advance(w.active)).problem).toMatch(/request account .* does not exist/);
  });
});

describe("BreakPipeline: free-spot claims", () => {
  /** Pool committed, randomness answered and settled, no free winner recorded yet. */
  async function settledButUnclaimed() {
    const w = world();
    await w.pullPacks();
    const pipe = w.pipeline();
    await pipe.advance(w.active);
    w.chain.fulfill(requestOf(w), ANSWER);
    // With no list stored the pipeline settles and then stops, which leaves the break exactly where we want it.
    w.eligibility.list = [];
    await pipe.advance(w.active);
    w.eligibility.list = w.leaves;
    expect(w.chain.breaks.get(7n)!.status).toBe("Settled");
    return { w, pipe };
  }

  it("refuses an eligibility list that is not the committed one", async () => {
    const { w, pipe } = await settledButUnclaimed();
    w.eligibility.list = w.leaves.slice(1); // one wallet missing
    const r = await pipe.advance(w.active);
    expect(r.problem).toMatch(/not the one that was committed/);
    expect(r.sent).toEqual([]);
    expect(w.chain.breaks.get(7n)!.freeWinnerCount).toBe(0);
  });

  it("refuses a list with a changed weight", async () => {
    const { w, pipe } = await settledButUnclaimed();
    w.eligibility.list = w.leaves.map((l, i) => (i === 3 ? { ...l, weight: l.weight + 1n } : l));
    expect((await pipe.advance(w.active)).problem).toMatch(/not the one that was committed/);
    expect(w.chain.applied).not.toContain("claim_free_spot");
  });

  it("reports a missing list", async () => {
    const { w, pipe } = await settledButUnclaimed();
    w.eligibility.list = [];
    expect((await pipe.advance(w.active)).problem).toMatch(/not stored/);
  });

  it("stops if a recorded winner is not who the draw says", async () => {
    const { w, pipe } = await settledButUnclaimed();
    const b = w.chain.breaks.get(7n)!;
    b.freeWinnerCount = 1;
    b.freeWinners[0] = { wallet: addr(222), start: 0n, weight: 1n };
    const r = await pipe.advance(w.active);
    expect(r.problem).toMatch(/recorded free winner 0 is .* but the draw says/);
    expect(w.chain.applied).not.toContain("claim_free_spot");
  });

  it("claims in order and finishes the draw", async () => {
    const { w, pipe } = await settledButUnclaimed();
    const r = await pipe.advance(w.active);
    expect(steps(r)).toEqual(["claim_free_spot#0", "claim_free_spot#1"]);
    expect(r.chainStatus).toBe("Drawn");
  });

  it("sends proofs the program accepts for many different draws", async () => {
    // Different answers pick different winners; the model checks each proof like the program does.
    for (let n = 1; n <= 12; n++) {
      const w = world({ wallets: n % 2 === 0 ? 6 : 37 });
      await w.pullPacks();
      const pipe = w.pipeline();
      await pipe.advance(w.active);
      w.chain.fulfill(requestOf(w), Uint8Array.from({ length: 64 }, (_, i) => ((i * n + n) & 0xff) || 1));
      const r = await pipe.advance(w.active);
      expect(r.chainStatus, `answer ${n}: ${r.problem}`).toBe("Drawn");
      const b = w.chain.breaks.get(7n)!;
      expect(new Set(b.freeWinners.slice(0, 2).map((x) => x.wallet)).size).toBe(2);
    }
  });
});

describe("BreakPipeline: sends whose result is not known", () => {
  it("does not send again at once, and does after the wait", async () => {
    const w = world();
    await w.pullPacks();
    const pipe = w.pipeline({ resendAfterMs: 30_000 });
    w.chain.queueSend("drop");
    const first = await pipe.advance(w.active);
    expect(first.waiting).toMatch(/commit_pool: result unknown/);
    expect(w.chain.sendCalls).toBe(1);

    const soon = await pipe.advance(w.active);
    expect(soon.waiting).toMatch(/sent, result unknown; waiting before sending again/);
    expect(w.chain.sendCalls).toBe(1);

    w.chain.unixTime += 31n;
    const later = await pipe.advance(w.active);
    expect(steps(later)).toContain("commit_pool");
    expect(w.chain.applied.filter((n) => n === "commit_pool")).toHaveLength(1);
  });

  it("a send that did land but timed out is not repeated: the chain moved on", async () => {
    const w = world();
    await w.pullPacks();
    const pipe = w.pipeline();
    w.chain.queueSend("applied-unknown");
    const first = await pipe.advance(w.active);
    expect(first.waiting).toMatch(/commit_pool: result unknown/);
    const second = await pipe.advance(w.active);
    expect(steps(second)).toEqual(["request_randomness"]);
    expect(w.chain.applied.filter((n) => n === "commit_pool")).toHaveLength(1);
  });

  it("a refused send is reported and tried again next time", async () => {
    const w = world();
    await w.pullPacks();
    const pipe = w.pipeline();
    w.chain.queueSend("fail");
    const first = await pipe.advance(w.active);
    expect(first.problem).toMatch(/commit_pool failed: mock: refused/);
    expect(w.errors).toContain("pipeline step failed on-chain");
    const second = await pipe.advance(w.active);
    expect(steps(second)).toContain("commit_pool");
  });

  it("a chain that rejects a step out of order changes nothing", async () => {
    const w = world();
    await w.pullPacks();
    // Another keeper instance committed the pool first; ours reads the new state and goes on from there.
    const other = w.pipeline();
    await other.advance(w.active);
    const mine = w.pipeline();
    const r = await mine.advance(w.active);
    expect(r.sent).toEqual([]);
    expect(r.chainStatus).toBe("RandomnessRequested");
    expect(w.chain.applied.filter((n) => n === "commit_pool")).toHaveLength(1);
  });

  it("an unexpected error is reported, not thrown", async () => {
    const w = world();
    const broken = w.pipeline({
      chain: {
        getAccountData: async () => {
          throw new Error("rpc: 503");
        },
        sendAndConfirm: async () => ({ outcome: "failed", reason: "x" }),
      },
    });
    const r = await broken.advance(w.active);
    expect(r.problem).toBe("rpc: 503");
    expect(w.errors).toContain("pipeline step failed");
  });
});

describe("BreakPipeline: before funding", () => {
  const closesAt = (w: ReturnType<typeof world>) => w.chain.breaks.get(7n)!.closesAt;

  it("waits while the sale is open, closes it a few seconds after the deadline", async () => {
    const w = world({ status: "Open" });
    const pipe = w.pipeline();
    w.chain.unixTime = closesAt(w) - 100n;
    const early = await pipe.advance(w.active);
    expect(early.waiting).toMatch(/^open until /);
    expect(early.sent).toEqual([]);

    w.chain.unixTime = closesAt(w) + 4n; // past the deadline but inside the margin
    expect((await pipe.advance(w.active)).sent).toEqual([]);
    expect(w.chain.sendCalls).toBe(0);

    w.chain.unixTime = closesAt(w) + 5n;
    const r = await pipe.advance(w.active);
    expect(steps(r)[0]).toBe("close_break");
  });

  it("closes, commits the planned eligibility list and funds the purchases, then waits for the packs", async () => {
    const w = world({ status: "Open" });
    const r = await w.pipeline().advance(w.active);
    expect(steps(r)).toEqual(["close_break", "commit_eligibility", "fund_purchases"]);
    expect(r.chainStatus).toBe("Funded");
    expect(r.waiting).toBe("packs: 0/5 pulled");

    const b = w.chain.breaks.get(7n)!;
    // What went on-chain is exactly what the planner produced.
    expect(equalBytes(b.eligibilityRoot, w.planner.values.root)).toBe(true);
    expect(b.eligibilityTotalWeight).toBe(w.planner.values.totalWeight);
    expect(b.eligibilityCount).toBe(w.planner.values.entryCount);
    expect(equalBytes(b.eligibilityInputsHash, w.planner.values.inputsHash)).toBe(true);
    expect(b.poolSize).toBe(5);
    expect(b.packBudget).toBe(125_000_000n);
  });

  it("goes all the way from an open break to a recorded draw", async () => {
    const w = world({ status: "Open" });
    const pipe = w.pipeline();
    expect(steps(await pipe.advance(w.active))).toEqual(["close_break", "commit_eligibility", "fund_purchases"]);
    await w.pullPacks();
    expect(steps(await pipe.advance(w.active))).toEqual(["commit_pool", "request_randomness"]);
    w.chain.fulfill(requestOf(w), ANSWER);
    const done = await pipe.advance(w.active);
    expect(done.chainStatus).toBe("Drawn");
    expect(w.chain.applied).toEqual([
      "close_break",
      "commit_eligibility",
      "fund_purchases",
      "commit_pool",
      "request_randomness",
      "settle_randomness",
      "claim_free_spot",
      "claim_free_spot",
    ]);
  });

  it("waits for the eligibility list while the indexer is behind, and commits nothing", async () => {
    const w = world({ status: "Closed" });
    w.planner.waitReason = "the balance indexer has read up to 5 but needs 9";
    const r = await w.pipeline().advance(w.active);
    expect(r.waiting).toBe("eligibility: the balance indexer has read up to 5 but needs 9");
    expect(r.sent).toEqual([]);
    expect(w.chain.sendCalls).toBe(0);
  });

  it("reports a planner that needs a person as a problem, not as waiting, and commits nothing", async () => {
    const w = world({ status: "Closed" });
    w.planner.problemReason = "the exclusions table has a row the public exclusion list cannot carry: x; fix or remove it";
    const r = await w.pipeline().advance(w.active);
    expect(r.problem).toBe("eligibility: the exclusions table has a row the public exclusion list cannot carry: x; fix or remove it");
    expect(r.waiting).toBeUndefined();
    expect(w.chain.sendCalls).toBe(0);
  });

  it("refuses a list whose weight and entry count disagree about being empty", async () => {
    const w = world({ status: "Closed" });
    w.planner.values = { ...w.planner.values, totalWeight: 0n };
    expect((await w.pipeline().advance(w.active)).problem).toMatch(/disagree about being empty/);
    expect(w.chain.sendCalls).toBe(0);
  });

  it("commits an empty list when nobody is eligible, and funds the paid spots alone", async () => {
    const w = world({ status: "Closed" });
    w.planner.values = { root: new Uint8Array(32), totalWeight: 0n, entryCount: 0, inputsHash: new Uint8Array(32).fill(0x22) };
    const r = await w.pipeline().advance(w.active);
    expect(steps(r)).toEqual(["commit_eligibility", "fund_purchases"]);
    expect(w.chain.breaks.get(7n)!.poolSize).toBe(3); // the three paid spots; no free winners
  });

  it("draws fewer free winners than free spots when too few holders are eligible", async () => {
    const w = world({ status: "Closed" });
    w.planner.values = { ...w.planner.values, entryCount: 1 }; // one eligible holder for two free spots
    await w.pipeline().advance(w.active);
    expect(w.chain.breaks.get(7n)!.poolSize).toBe(4);
  });

  it("does not fund a break with nothing in it: it cancels it, which anyone may do, and the reservation is released", async () => {
    const w = world({ paid: 0, free: 2, status: "Closed" });
    w.planner.values = { root: new Uint8Array(32), totalWeight: 0n, entryCount: 0, inputsHash: new Uint8Array(32).fill(0x22) };
    w.chain.treasury.config.lockedSubsidy = 7n;
    w.chain.treasury.config.lockedHolder = 9n;
    const b = w.chain.breaks.get(7n)!;
    b.lockedSubsidy = 7n;
    b.lockedHolder = 9n;
    const r = await w.pipeline().advance(w.active);
    expect(steps(r)).toEqual(["commit_eligibility", "cancel_unfundable"]);
    expect(r.problem).toBeUndefined();
    expect(r.waiting).toBe("break was cancelled");
    expect(w.chain.applied).toEqual(["commit_eligibility", "cancel_unfundable"]);
    expect(w.chain.breaks.get(7n)).toMatchObject({ status: "Cancelled", lockedSubsidy: 0n, lockedHolder: 0n });
    expect(w.chain.treasury.config).toMatchObject({ lockedSubsidy: 0n, lockedHolder: 0n });
    expect(w.chain.applied).not.toContain("fund_purchases");
    // The next call finds it cancelled and sends nothing more.
    const again = await w.pipeline().advance(w.active);
    expect(again.sent).toEqual([]);
    expect(again.waiting).toBe("break was cancelled");
  });

  describe("a break whose packs are worth less than its spots", () => {
    const tiers = (dollars: bigint) => [{ machine: new Uint8Array(32).fill(0x77), maxPrice: dollars * 1_000_000n }];

    it("is not funded: the program would refuse it, so the pipeline cancels it and says why", async () => {
      const logs: { msg: string; extra?: Record<string, unknown> }[] = [];
      const w = world({ status: "EligibilityCommitted" });
      // The three paid spots cost $20 each; the five packs that would be bought are $15 each at most.
      w.chain.breaks.get(7n)!.tiers = tiers(15n);
      const r = await w.pipeline({ log: { info: (msg, extra) => void logs.push({ msg, ...(extra ? { extra } : {}) }), error: () => {} } }).advance(w.active);
      expect(steps(r)).toEqual(["cancel_unfundable"]);
      expect(r.problem).toBeUndefined();
      expect(w.chain.applied).toEqual(["cancel_unfundable"]);
      expect(w.chain.breaks.get(7n)!.status).toBe("Cancelled");
      expect(logs.find((l) => l.msg === "cancelling a break that cannot be funded")?.extra?.reason).toMatch(
        /cost at most 75000000 in all, less than the 3 spot\(s\) paid at 20000000 each on average/,
      );
    });

    it("is cancelled while the program is paused too: cancelling always works, funding does not", async () => {
      const w = world({ status: "EligibilityCommitted" });
      w.chain.config = { ...w.chain.config, paused: true };
      w.chain.breaks.get(7n)!.tiers = tiers(15n);
      const r = await w.pipeline().advance(w.active);
      expect(w.chain.applied).toEqual(["cancel_unfundable"]);
      expect(r.waiting).toBe("break was cancelled");
    });

    it("is not cancelled just because the program is paused: a break that can be funded waits", async () => {
      const w = world({ status: "EligibilityCommitted" });
      w.chain.config = { ...w.chain.config, paused: true };
      const r = await w.pipeline().advance(w.active);
      expect(r.waiting).toMatch(/paused/);
      expect(w.chain.sendCalls).toBe(0);
    });

    it("reports a cancel the program refuses instead of pretending, and sends it again next time", async () => {
      const w = world({ status: "EligibilityCommitted" });
      w.chain.breaks.get(7n)!.tiers = tiers(15n);
      w.chain.queueSend("fail");
      const first = await w.pipeline().advance(w.active);
      expect(first.problem).toMatch(/cancel_unfundable failed/);
      expect(w.chain.breaks.get(7n)!.status).toBe("EligibilityCommitted");
      const second = await w.pipeline().advance(w.active);
      expect(second.problem).toBeUndefined();
      expect(w.chain.breaks.get(7n)!.status).toBe("Cancelled");
    });

    it("is funded when nobody paid for a spot, whatever the packs cost: only the holder bucket pays", async () => {
      const w = world({ paid: 0, free: 2, status: "Closed" });
      w.chain.breaks.get(7n)!.tiers = tiers(15n);
      const r = await w.pipeline().advance(w.active);
      expect(r.problem).toBeUndefined();
      expect(w.chain.breaks.get(7n)).toMatchObject({ status: "Funded", poolSize: 2, packBudget: 30_000_000n });
    });

    it("is funded when the packs are worth exactly what the spots cost", async () => {
      const w = world({ status: "EligibilityCommitted" });
      w.chain.breaks.get(7n)!.tiers = tiers(20n);
      const r = await w.pipeline().advance(w.active);
      expect(r.problem).toBeUndefined();
      expect(w.chain.applied).toContain("fund_purchases");
      expect(w.chain.breaks.get(7n)!.packBudget).toBe(100_000_000n);
    });

    it("judges the packs that would be bought, not the whole list: a break that did not fill may have lost its expensive ones", async () => {
      const w = world({ status: "Closed" });
      const b = w.chain.breaks.get(7n)!;
      // 3 paid + 2 free spots, $10 packs first and $50 packs last: the whole list averages $26, but with one holder for the two
      // free spots the pool is 4 packs ($10, $10, $10, $50) and those average $20, the spot price.
      b.tiers = [{ machine: new Uint8Array(32).fill(1), maxPrice: 10_000_000n }, { machine: new Uint8Array(32).fill(2), maxPrice: 50_000_000n }];
      b.packs = [0, 0, 0, 1, 1];
      w.planner.values = { ...w.planner.values, entryCount: 1 };
      expect((await w.pipeline().advance(w.active)).problem).toBeUndefined();
      expect(b.poolSize).toBe(4);
      expect(b.packBudget).toBe(80_000_000n);
    });

    it("is cancelled when the pool is cut to the cheap packs: three sold spots and one holder, all packs $10 but the last two", async () => {
      const w = world({ status: "Closed" });
      const b = w.chain.breaks.get(7n)!;
      b.tiers = [{ machine: new Uint8Array(32).fill(1), maxPrice: 10_000_000n }, { machine: new Uint8Array(32).fill(2), maxPrice: 50_000_000n }];
      b.packs = [0, 0, 0, 0, 1];
      w.planner.values = { ...w.planner.values, entryCount: 1 }; // 4 packs: $40 for spots that cost $20 each, $10 a pack
      const r = await w.pipeline().advance(w.active);
      expect(r.problem).toBeUndefined();
      expect(w.chain.applied).toEqual(["commit_eligibility", "cancel_unfundable"]);
      expect(w.chain.breaks.get(7n)!.status).toBe("Cancelled");
    });
  });

  describe("fund_purchases is only sent when everything it depends on is in order", () => {
    it("not while the program is paused", async () => {
      const w = world({ status: "EligibilityCommitted" });
      w.chain.config = { ...w.chain.config, paused: true };
      const r = await w.pipeline().advance(w.active);
      expect(r.waiting).toMatch(/paused/);
      expect(w.chain.sendCalls).toBe(0);
    });

    it("not without the stored eligibility list, which the free winners are claimed from", async () => {
      const w = world({ status: "EligibilityCommitted" });
      w.planner.stored = false;
      const r = await w.pipeline().advance(w.active);
      expect(r.problem).toMatch(/not stored.*not funding/);
      expect(w.chain.sendCalls).toBe(0);
    });

    it("not if the stored list is not the one that was committed", async () => {
      for (const change of [
        { root: new Uint8Array(32).fill(1) },
        { totalWeight: 1n },
        { entryCount: 99 },
        { inputsHash: new Uint8Array(32).fill(7) },
      ]) {
        const w = world({ status: "EligibilityCommitted" });
        w.planner.values = { ...w.planner.values, ...change };
        expect((await w.pipeline().advance(w.active)).problem, JSON.stringify(Object.keys(change))).toMatch(/not the one that was committed/);
        expect(w.chain.sendCalls).toBe(0);
      }
    });

    it("not when the buyer wallet has no USDC account", async () => {
      const w = world({ status: "EligibilityCommitted" });
      w.chain.tokenAccounts.clear();
      const r = await w.pipeline().advance(w.active);
      expect(r.problem).toMatch(/buyer wallet has no USDC account at /);
      expect(r.problem).toContain(associatedTokenAddress(BUYER, w.chain.config.usdcMint));
      expect(w.chain.sendCalls).toBe(0);
    });

    it("and then it is sent", async () => {
      const w = world({ status: "EligibilityCommitted" });
      const r = await w.pipeline().advance(w.active);
      expect(steps(r)).toEqual(["fund_purchases"]);
      expect(r.chainStatus).toBe("Funded");
    });
  });

  it("reports a refusal by the program, for example a keeper that is not the configured one", async () => {
    const w = world({ status: "Closed" });
    w.chain.config = { ...w.chain.config, keeper: addr(99) };
    const r = await w.pipeline().advance(w.active);
    expect(r.problem).toMatch(/commit_eligibility failed: Unauthorized/);
  });
});
