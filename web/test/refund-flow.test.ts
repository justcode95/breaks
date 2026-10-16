import { describe, expect, it, vi } from "vitest";
import { waitForRefund } from "../lib/chain/follow";
import type { Mine, MySpot } from "../lib/chain/mine";
import type { RefundResult } from "../lib/chain/refund";
import { type RefundAction, type RefundState, idleRefund, refundReducer } from "../lib/chain/refund-state";
import { runRefund } from "../lib/chain/run-refund";
import { fill } from "./support/wallet";

const A = fill(1);
const B = fill(2);
const refunded = (signature = "sig-1", amount = 20_000_000n): RefundResult => ({ kind: "refunded", signature, amount });
const start = (over: Partial<{ address: string; breakNumber: number; index: number }> = {}): RefundAction => ({ type: "start", address: A, breakNumber: 3, index: 0, ...over });
const run = (actions: RefundAction[], from: RefundState = idleRefund) => actions.reduce(refundReducer, from);

describe("the state of the refund panel", () => {
  it("goes from idle through the steps to a result, remembering which spot and which wallet, and back to idle when closed", () => {
    expect(run([start()])).toEqual({ status: "running", step: "checking", address: A, breakNumber: 3, index: 0 });
    expect(run([start(), { type: "step", step: "waiting-for-wallet" }])).toMatchObject({ status: "running", step: "waiting-for-wallet" });
    const done = run([start({ breakNumber: 7, index: 4 }), { type: "finished", result: refunded() }]);
    expect(done).toEqual({ status: "finished", result: refunded(), seen: false, address: A, breakNumber: 7, index: 4 });
    expect(run([{ type: "dismiss" }], done)).toEqual(idleRefund);
  });

  it("starts again from a result, with the new spot", () => {
    const done = run([start(), { type: "finished", result: { kind: "refused", reason: "x" } }]);
    expect(run([start({ address: B, index: 2 })], done)).toEqual({ status: "running", step: "checking", address: B, breakNumber: 3, index: 2 });
  });

  it("ignores a second start while a refund is running, so the first is not replaced", () => {
    const running = run([start(), { type: "step", step: "confirming" }]);
    expect(run([start({ index: 9 })], running)).toBe(running);
  });

  it("cannot be dismissed while the refund is running", () => {
    const running = run([start()]);
    expect(run([{ type: "dismiss" }], running)).toBe(running);
    expect(run([{ type: "dismiss" }])).toBe(idleRefund);
  });

  it("ignores steps and results that arrive when nothing is running", () => {
    expect(run([{ type: "step", step: "confirming" }])).toBe(idleRefund);
    expect(run([{ type: "finished", result: refunded() }])).toBe(idleRefund);
    const done = run([start(), { type: "finished", result: refunded() }]);
    expect(run([{ type: "step", step: "checking" }], done)).toBe(done);
    expect(run([{ type: "finished", result: { kind: "refused", reason: "late" } }], done)).toBe(done);
  });

  it("marks a refund as seen only for the refund with that signature", () => {
    const done = run([start(), { type: "finished", result: refunded("sig-2") }]);
    expect(run([{ type: "seen", signature: "sig-2" }], done)).toEqual({ ...done, seen: true });
    expect(run([{ type: "seen", signature: "sig-1" }], done)).toBe(done);
    expect(run([{ type: "seen", signature: "sig-2" }])).toBe(idleRefund);
    const failed = run([start(), { type: "finished", result: { kind: "failed", signature: "sig-2", reason: "x" } }]);
    expect(run([{ type: "seen", signature: "sig-2" }], failed)).toBe(failed);
  });
});

describe("running one refund", () => {
  function setup(over: { refund?: (onStep: (s: "checking" | "waiting-for-wallet" | "confirming") => void) => Promise<RefundResult>; follow?: () => Promise<"seen" | "not-yet"> } = {}) {
    let state: RefundState = idleRefund;
    const log: string[] = [];
    const guard = { current: false };
    const follow = vi.fn(over.follow ?? (async () => "seen" as const));
    const refund = vi.fn(
      over.refund ??
        (async (onStep) => {
          onStep("checking");
          onStep("waiting-for-wallet");
          onStep("confirming");
          return refunded();
        }),
    );
    const dispatch = (a: RefundAction) => {
      log.push(a.type === "step" ? `step:${a.step}` : a.type);
      state = refundReducer(state, a);
    };
    const go = () => runRefund({ address: A, breakNumber: 3, index: 1, refund, dispatch, follow, guard });
    return { go, log, guard, refund, follow, state: () => state };
  }

  it("starts, passes on each step, finishes, and follows the spot until the chain shows it as refunded", async () => {
    const s = setup();
    await s.go();
    expect(s.log).toEqual(["start", "step:checking", "step:waiting-for-wallet", "step:confirming", "finished", "seen"]);
    expect(s.state()).toEqual({ status: "finished", result: refunded(), seen: true, address: A, breakNumber: 3, index: 1 });
  });

  it("leaves the result as 'still finalizing' when the chain does not show it in time", async () => {
    const s = setup({ follow: async () => "not-yet" });
    await s.go();
    expect(s.log).not.toContain("seen");
    expect(s.state()).toMatchObject({ status: "finished", seen: false });
  });

  it("does not follow after a result that is not a refund", async () => {
    for (const result of [
      { kind: "refused", reason: "x" },
      { kind: "declined", reason: "x" },
      { kind: "failed", signature: "s", reason: "x" },
      { kind: "unconfirmed", signature: "s", reason: "x" },
    ] as const) {
      const s = setup({ refund: async () => result });
      await s.go();
      expect(s.state(), result.kind).toMatchObject({ status: "finished", result });
      expect(s.follow, result.kind).not.toHaveBeenCalled();
    }
  });

  it("refunds once however often the button is clicked before the page has redrawn", async () => {
    let release: (r: RefundResult) => void = () => {};
    const s = setup({ refund: () => new Promise<RefundResult>((resolve) => (release = resolve)) });
    const first = s.go();
    await s.go();
    await s.go();
    expect(s.refund).toHaveBeenCalledTimes(1);
    expect(s.log).toEqual(["start"]);
    release(refunded());
    await first;
    expect(s.refund).toHaveBeenCalledTimes(1);
  });

  it("can refund again once the first has its result, even while the page is still following it", async () => {
    let finishFollow: (v: "seen") => void = () => {};
    const s = setup();
    s.follow.mockImplementationOnce(() => new Promise((resolve) => (finishFollow = resolve)));
    const first = s.go();
    await vi.waitFor(() => expect(s.follow).toHaveBeenCalled());
    expect(s.guard.current).toBe(false);
    finishFollow("seen");
    await first;
    await s.go();
    expect(s.refund).toHaveBeenCalledTimes(2);
  });

  it("tells a failure of the page itself as a failure to confirm, sends the user to the wallet's history and lets them try again", async () => {
    const s = setup({
      refund: async () => {
        throw new Error("boom");
      },
    });
    await s.go();
    const end = s.state() as { result: { kind: string; reason: string } };
    expect(end.result.kind).toBe("declined");
    expect(end.result.reason).toBe("Something went wrong on this page: boom. If you approved a transaction, check your wallet's history before trying again.");
    expect(s.guard.current).toBe(false);
    await s.go();
    expect(s.refund).toHaveBeenCalledTimes(2);
  });
});

describe("following a refund until the chain shows it", () => {
  const spot = (breakNumber: number, index: number, refundedFlag: boolean): MySpot => ({ breakNumber, index, paid: 1n, refunded: refundedFlag, break: {} as MySpot["break"] });
  const mine = (spots: MySpot[]): Mine => ({ spots, truncated: false, freeWins: [], searched: 1, totalBreaks: 1, recent: [] });
  const sleeps: number[] = [];
  const sleep = async (ms: number) => void sleeps.push(ms);

  it("sees the spot once the chain lists it as refunded", async () => {
    sleeps.length = 0;
    const reads = [mine([spot(3, 1, false)]), mine([spot(3, 1, true)])];
    const load = vi.fn(async () => reads[Math.min(load.mock.calls.length - 1, reads.length - 1)] as Mine);
    expect(await waitForRefund({ load, breakNumber: 3, index: 1, sleep, delayMs: 5000 })).toBe("seen");
    expect(load).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([5000]);
  });

  it("is not fooled by another spot of the same break, the same spot number in another break, or the spot not being refunded", async () => {
    const wrong = mine([spot(3, 0, true), spot(4, 1, true), spot(3, 1, false)]);
    expect(await waitForRefund({ load: async () => wrong, breakNumber: 3, index: 1, sleep, attempts: 2 })).toBe("not-yet");
    expect(await waitForRefund({ load: async () => mine([]), breakNumber: 3, index: 1, sleep, attempts: 2 })).toBe("not-yet");
  });

  it("asks again after a failed read, reads at most `attempts` times, and stops when the page is gone", async () => {
    sleeps.length = 0;
    let n = 0;
    const flaky = vi.fn(async () => {
      if (n++ < 2) throw new Error("busy");
      return mine([spot(3, 1, true)]);
    });
    expect(await waitForRefund({ load: flaky, breakNumber: 3, index: 1, sleep })).toBe("seen");
    expect(flaky).toHaveBeenCalledTimes(3);

    const never = vi.fn(async () => mine([]));
    sleeps.length = 0;
    expect(await waitForRefund({ load: never, breakNumber: 3, index: 1, sleep, attempts: 4, delayMs: 7 })).toBe("not-yet");
    expect(never).toHaveBeenCalledTimes(4);
    expect(sleeps).toEqual([7, 7, 7]);

    const gone = vi.fn(async () => mine([]));
    expect(await waitForRefund({ load: gone, breakNumber: 3, index: 1, sleep, stop: () => true })).toBe("not-yet");
    expect(gone).not.toHaveBeenCalled();
  });

  it("by default reads 12 times, 5 seconds apart", async () => {
    sleeps.length = 0;
    const load = vi.fn(async () => mine([]));
    await waitForRefund({ load, breakNumber: 3, index: 1, sleep });
    expect(load).toHaveBeenCalledTimes(12);
    expect(sleeps).toEqual(Array(11).fill(5000));
  });
});
