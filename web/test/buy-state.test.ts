import { describe, expect, it, vi } from "vitest";
import { type BuyAction, type BuyState, buyReducer, idleBuy } from "../lib/chain/buy-state";
import { waitForSpot } from "../lib/chain/follow";
import type { Loaded } from "../lib/chain/load";
import type { PurchaseResult, PurchaseStep } from "../lib/chain/purchase";
import { runPurchase } from "../lib/chain/run-purchase";
import { fill } from "./support/wallet";

const A = fill(1);
const B = fill(2);
const bought = (signature = "sig-1", index = 3): PurchaseResult => ({ kind: "bought", signature, index, price: 20_000_000n });
const run = (actions: BuyAction[], from: BuyState = idleBuy) => actions.reduce(buyReducer, from);

describe("the state of the buy panel", () => {
  it("goes from idle through the steps to a result, and back to idle when it is closed", () => {
    expect(run([{ type: "start", address: A }])).toEqual({ status: "running", address: A, step: "checking" });
    expect(run([{ type: "start", address: A }, { type: "step", step: "waiting-for-wallet" }])).toEqual({ status: "running", address: A, step: "waiting-for-wallet" });
    const done = run([{ type: "start", address: A }, { type: "finished", result: bought() }]);
    expect(done).toEqual({ status: "finished", address: A, result: bought(), seen: false });
    expect(run([{ type: "dismiss" }], done)).toEqual(idleBuy);
  });

  it("starts again from a result, with the new wallet", () => {
    const done = run([{ type: "start", address: A }, { type: "finished", result: { kind: "refused", reason: "x" } }]);
    expect(run([{ type: "start", address: B }], done)).toEqual({ status: "running", address: B, step: "checking" });
  });

  it("ignores a second start while a purchase is running, so the first is not replaced", () => {
    const running = run([{ type: "start", address: A }, { type: "step", step: "confirming" }]);
    expect(run([{ type: "start", address: B }], running)).toBe(running);
  });

  it("cannot be dismissed while the purchase is running", () => {
    const running = run([{ type: "start", address: A }]);
    expect(run([{ type: "dismiss" }], running)).toBe(running);
    expect(run([{ type: "dismiss" }])).toBe(idleBuy);
  });

  it("ignores steps and results that arrive when nothing is running", () => {
    expect(run([{ type: "step", step: "confirming" }])).toBe(idleBuy);
    expect(run([{ type: "finished", result: bought() }])).toBe(idleBuy);
    const done = run([{ type: "start", address: A }, { type: "finished", result: bought() }]);
    expect(run([{ type: "step", step: "checking" }], done)).toBe(done);
    expect(run([{ type: "finished", result: { kind: "refused", reason: "late" } }], done)).toBe(done);
  });

  it("marks a purchase as seen only for the purchase with that signature", () => {
    const done = run([{ type: "start", address: A }, { type: "finished", result: bought("sig-2") }]);
    expect(run([{ type: "seen", signature: "sig-2" }], done)).toEqual({ ...done, seen: true });
    // A late answer about an earlier purchase does not mark this one.
    expect(run([{ type: "seen", signature: "sig-1" }], done)).toBe(done);
    // Nothing to mark when no purchase went through, or the panel was closed.
    expect(run([{ type: "seen", signature: "sig-2" }])).toBe(idleBuy);
    const refused = run([{ type: "start", address: A }, { type: "finished", result: { kind: "failed", signature: "sig-2", reason: "x" } }]);
    expect(run([{ type: "seen", signature: "sig-2" }], refused)).toBe(refused);
    expect(run([{ type: "seen", signature: "sig-2" }, { type: "dismiss" }], done)).toEqual(idleBuy);
  });
});

describe("running one purchase", () => {
  function setup(over: { buy?: (onStep: (s: PurchaseStep) => void) => Promise<PurchaseResult>; follow?: (index: number) => Promise<"seen" | "not-yet"> } = {}) {
    let state: BuyState = idleBuy;
    const log: string[] = [];
    const guard = { current: false };
    const afterBought = vi.fn(() => void log.push("afterBought"));
    const follow = vi.fn(over.follow ?? (async () => "seen" as const));
    const buy = vi.fn(
      over.buy ??
        (async (onStep: (s: PurchaseStep) => void) => {
          onStep("checking");
          onStep("waiting-for-wallet");
          onStep("confirming");
          return bought();
        }),
    );
    const dispatch = (a: BuyAction) => {
      log.push(a.type === "step" ? `step:${a.step}` : a.type);
      state = buyReducer(state, a);
    };
    const go = () => runPurchase({ address: A, buy, dispatch, follow, afterBought, guard });
    return { go, log, guard, buy, follow, afterBought, state: () => state };
  }

  it("starts, passes on each step, finishes, tells the page what was bought and follows the spot until the chain shows it", async () => {
    const s = setup();
    await s.go();
    expect(s.log).toEqual(["start", "step:checking", "step:waiting-for-wallet", "step:confirming", "finished", "afterBought", "seen"]);
    expect(s.follow).toHaveBeenCalledExactlyOnceWith(3);
    expect(s.state()).toEqual({ status: "finished", address: A, result: bought(), seen: true });
  });

  it("leaves the result as 'still finalizing' when the chain does not show the spot in time", async () => {
    const s = setup({ follow: async () => "not-yet" });
    await s.go();
    expect(s.log).not.toContain("seen");
    expect(s.state()).toMatchObject({ status: "finished", seen: false });
  });

  it("does nothing more after a result that is not a purchase: no balance read, no following", async () => {
    for (const result of [
      { kind: "refused", reason: "x" },
      { kind: "declined", reason: "x" },
      { kind: "failed", signature: "s", reason: "x" },
      { kind: "unconfirmed", signature: "s", reason: "x" },
    ] as const) {
      const s = setup({ buy: async () => result });
      await s.go();
      expect(s.state(), result.kind).toMatchObject({ status: "finished", result });
      expect(s.afterBought, result.kind).not.toHaveBeenCalled();
      expect(s.follow, result.kind).not.toHaveBeenCalled();
    }
  });

  it("buys once however often the button is clicked before the page has redrawn", async () => {
    let release: (r: PurchaseResult) => void = () => {};
    const s = setup({ buy: () => new Promise<PurchaseResult>((resolve) => (release = resolve)) });
    const first = s.go();
    await s.go();
    await s.go();
    expect(s.buy).toHaveBeenCalledTimes(1);
    expect(s.log).toEqual(["start"]);
    release(bought());
    await first;
    expect(s.buy).toHaveBeenCalledTimes(1);
  });

  it("can buy again once the first has its result, even while the page is still following the spot", async () => {
    let finishFollow: (v: "seen") => void = () => {};
    const s = setup();
    // Only the first purchase's follow-up is slow.
    s.follow.mockImplementationOnce(() => new Promise((resolve) => (finishFollow = resolve)));
    const first = s.go();
    await vi.waitFor(() => expect(s.follow).toHaveBeenCalled());
    expect(s.guard.current).toBe(false);
    finishFollow("seen");
    await first;
    await s.go();
    expect(s.buy).toHaveBeenCalledTimes(2);
  });

  it("tells a failure of the page itself as a failure to confirm, sends the buyer to the wallet's history and lets them try again", async () => {
    const s = setup({
      buy: async () => {
        throw new Error("boom");
      },
    });
    await s.go();
    const end = s.state();
    expect(end).toMatchObject({ status: "finished", result: { kind: "declined" } });
    expect((end as { result: { reason: string } }).result.reason).toBe("Something went wrong on this page: boom. If you approved a transaction, check your wallet's history before trying again.");
    expect(s.guard.current).toBe(false);
    expect(s.afterBought).not.toHaveBeenCalled();
    await s.go();
    expect(s.buy).toHaveBeenCalledTimes(2);
  });
});

describe("following a purchase until the chain shows it", () => {
  const loaded = (owners: string[]): Loaded => ({ number: 1, break: {} as Loaded["break"], paidOwners: owners, notes: [] });
  const sleeps: number[] = [];
  const sleep = async (ms: number) => void sleeps.push(ms);

  it("sees the spot as soon as the chain lists the buyer at that place", async () => {
    sleeps.length = 0;
    const reads = [loaded([B, B, B]), loaded([B, B, B, A])];
    const load = vi.fn(async () => reads[Math.min(load.mock.calls.length - 1, reads.length - 1)] as Loaded);
    expect(await waitForSpot({ load, index: 3, owner: A, sleep, delayMs: 5000 })).toBe("seen");
    expect(load).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([5000]);
  });

  it("is not fooled by the same wallet at another place, or another wallet at this one", async () => {
    sleeps.length = 0;
    expect(await waitForSpot({ load: async () => loaded([A, B, B, B]), index: 3, owner: A, sleep, attempts: 3 })).toBe("not-yet");
    expect(await waitForSpot({ load: async () => loaded([B, B, B, B]), index: 3, owner: A, sleep, attempts: 3 })).toBe("not-yet");
  });

  it("reads at most `attempts` times, pausing between reads and not after the last", async () => {
    sleeps.length = 0;
    const load = vi.fn(async () => loaded([]));
    expect(await waitForSpot({ load, index: 0, owner: A, sleep, attempts: 4, delayMs: 7 })).toBe("not-yet");
    expect(load).toHaveBeenCalledTimes(4);
    expect(sleeps).toEqual([7, 7, 7]);
  });

  it("asks again after a failed read", async () => {
    sleeps.length = 0;
    let n = 0;
    const load = vi.fn(async () => {
      if (n++ < 2) throw new Error("busy");
      return loaded([A]);
    });
    expect(await waitForSpot({ load, index: 0, owner: A, sleep })).toBe("seen");
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("gives up for good when told the page is gone, before reading again", async () => {
    sleeps.length = 0;
    let gone = false;
    const load = vi.fn(async () => {
      gone = true;
      return loaded([]);
    });
    expect(await waitForSpot({ load, index: 0, owner: A, sleep, stop: () => gone })).toBe("not-yet");
    expect(load).toHaveBeenCalledTimes(1);
    expect(await waitForSpot({ load, index: 0, owner: A, sleep, stop: () => true })).toBe("not-yet");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("by default reads 12 times, 5 seconds apart", async () => {
    sleeps.length = 0;
    const load = vi.fn(async () => loaded([]));
    await waitForSpot({ load, index: 0, owner: A, sleep });
    expect(load).toHaveBeenCalledTimes(12);
    expect(sleeps).toEqual(Array(11).fill(5000));
  });
});
