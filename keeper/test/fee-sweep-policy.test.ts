import { describe, expect, it } from "vitest";
import { minUsdcOut, swapAmount, type SweepPolicy } from "../src/sweep/policy.js";

const SOL = 1_000_000_000n;
const policy: SweepPolicy = { keepLamports: SOL, minLamports: SOL / 10n, maxLamports: 10n * SOL, slippageBps: 50, minDeposit: 1_000_000n };

describe("swapAmount", () => {
  it("swaps what is above what the wallet keeps", () => {
    expect(swapAmount(3n * SOL + SOL / 2n, policy)).toBe(5n * SOL / 2n);
  });

  it("caps one swap", () => {
    expect(swapAmount(50n * SOL, policy)).toBe(10n * SOL);
    expect(swapAmount(11n * SOL, policy)).toBe(10n * SOL);
    expect(swapAmount(10n * SOL, policy)).toBe(9n * SOL);
  });

  it("swaps nothing at or under the part it keeps, or under the minimum", () => {
    expect(swapAmount(0n, policy)).toBeUndefined();
    expect(swapAmount(SOL, policy)).toBeUndefined();
    expect(swapAmount(SOL - 1n, policy)).toBeUndefined();
    expect(swapAmount(SOL + SOL / 10n - 1n, policy)).toBeUndefined();
    expect(swapAmount(SOL + SOL / 10n, policy)).toBe(SOL / 10n);
  });

  it("can keep nothing", () => {
    expect(swapAmount(SOL, { ...policy, keepLamports: 0n })).toBe(SOL);
  });
});

describe("minUsdcOut", () => {
  it("is the quote less the slippage, rounded down", () => {
    expect(minUsdcOut(600_000_000n, 4n * SOL, policy)).toEqual({ ok: true, minUsdcOut: 597_000_000n });
    expect(minUsdcOut(1_000_001n, SOL, { ...policy, slippageBps: 100 })).toEqual({ ok: true, minUsdcOut: 990_000n });
    expect(minUsdcOut(1_000n, SOL, { ...policy, slippageBps: 0 })).toEqual({ ok: true, minUsdcOut: 1_000n });
  });

  it("never goes below the floor price, and refuses a quote under it", () => {
    const floored = { ...policy, minUsdcPerSol: 140_000_000n };
    // 2 SOL at a floor of $140: at least $280, even though the quote less slippage would allow $298.5 ... which is above, so the slippage rule wins
    expect(minUsdcOut(300_000_000n, 2n * SOL, floored)).toEqual({ ok: true, minUsdcOut: 298_500_000n });
    // A loose slippage cannot push the minimum below the floor.
    expect(minUsdcOut(300_000_000n, 2n * SOL, { ...floored, slippageBps: 1_000 })).toEqual({ ok: true, minUsdcOut: 280_000_000n });
    // The quote itself is under the floor: no swap.
    const r = minUsdcOut(279_999_999n, 2n * SOL, floored);
    expect(r.ok).toBe(false);
    expect(minUsdcOut(280_000_000n, 2n * SOL, floored).ok).toBe(true);
  });

  it("refuses a swap that would give back nothing", () => {
    expect(minUsdcOut(0n, SOL, policy).ok).toBe(false);
    expect(minUsdcOut(1n, SOL, policy).ok).toBe(false); // 1 less 0.5% rounds to 0
  });
});
