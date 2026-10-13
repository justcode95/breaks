import { describe, expect, it } from "vitest";
import { compareBytes, toHex } from "../src/draw/bytes.js";
import { Tree } from "../src/draw/tree.js";
import {
  buildEligibility,
  inputsHash,
  serializeInputs,
  treeOf,
  weightOf,
  type EligibilityInput,
} from "../src/eligibility/eligibility.js";
import type { BalanceEvent } from "../src/eligibility/twab.js";
import { addressToBytes } from "../src/solana/pubkey.js";

// Ordinary keys (on the curve) and one program-derived address.
const ALICE = "Bvq3U9fz2MiHkLH8u4zyt6T1bimxnaEuHkZhezNDT5R9";
const BOB = "8tmJjCG3D4TF7oPiPWNoaCjZ4pN2U4H237BSGVw2B8KU";
const CAROL = "VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y";
const DAVE = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const POOL_PDA = "HFqEtztrDn86NRFDEeLxta9Mqc7bRL9CzFUbm4MPwJge"; // off the curve: no key controls it

const W = { start: 1000, end: 2000 };
let n = 0;
const ev = (owner: string, account: string, time: number, delta: bigint, after: bigint): BalanceEvent => ({
  signature: `sig${n++}`,
  slot: BigInt(time),
  time,
  owner,
  tokenAccount: account,
  delta,
  balanceAfter: after,
});

const base = (): EligibilityInput => ({
  events: [
    ev(ALICE, "a", 0, 1_000n, 1_000n), // full window: 1000
    ev(BOB, "b", 1500, 400n, 400n), // half: 200
    ev(CAROL, "c", 0, 5n, 5n), // 5
    ev(POOL_PDA, "p", 0, 9_000_000n, 9_000_000n), // a liquidity pool
    ev(DAVE, "d", 0, 700n, 700n), // 700, but excluded below
  ],
  window: W,
  policy: { minTwab: 100n },
  exclusions: new Map([[DAVE, "team"]]),
});

describe("buildEligibility", () => {
  const result = buildEligibility(base());
  const row = (w: string) => result.snapshot.find((r) => r.wallet === w);

  it("makes eligible the wallets that held enough and are not excluded", () => {
    expect(row(ALICE)).toMatchObject({ twab: 1000n, weight: 1000n, eligible: true, reason: null });
    expect(row(BOB)).toMatchObject({ twab: 200n, weight: 200n, eligible: true, reason: null });
    expect(result.totalWeight).toBe(1200n);
  });

  it("says why everyone else is out", () => {
    expect(row(CAROL)).toMatchObject({ twab: 5n, weight: 0n, eligible: false, reason: "below_min_twab" });
    expect(row(DAVE)).toMatchObject({ twab: 700n, eligible: false, reason: "excluded:team" });
    expect(row(POOL_PDA)).toMatchObject({ eligible: false, reason: "off_curve" });
  });

  it("lists every wallet of the history, sorted by address", () => {
    expect(result.snapshot).toHaveLength(5);
    const keys = result.snapshot.map((r) => addressToBytes(r.wallet));
    for (let i = 1; i < keys.length; i++) expect(compareBytes(keys[i - 1] as Uint8Array, keys[i] as Uint8Array)).toBeLessThan(0);
  });

  it("gives the tree builder sorted leaves that build", () => {
    expect(result.leaves).toHaveLength(2);
    const tree = treeOf(result) as Tree;
    expect(tree.root.sum).toBe(result.totalWeight);
    expect(treeOf({ leaves: [], totalWeight: 0n, snapshot: [] })).toBeUndefined();
  });

  it("an exclusion beats a big balance, and off-curve exclusion can be switched off", () => {
    const keepPools = buildEligibility({ ...base(), excludeOffCurve: false });
    expect(keepPools.snapshot.find((r) => r.wallet === POOL_PDA)?.eligible).toBe(true);
  });

  it("nobody eligible gives no leaves", () => {
    const none = buildEligibility({ ...base(), policy: { minTwab: 10n ** 12n } });
    expect(none.leaves).toEqual([]);
    expect(none.totalWeight).toBe(0n);
  });
});

describe("weightOf", () => {
  it("is the TWAB above the minimum, capped when a cap is set", () => {
    expect(weightOf(99n, { minTwab: 100n })).toBe(0n);
    expect(weightOf(100n, { minTwab: 100n })).toBe(100n);
    expect(weightOf(5_000n, { minTwab: 100n })).toBe(5_000n);
    expect(weightOf(5_000n, { minTwab: 100n, capPerWallet: 1_000n })).toBe(1_000n);
    expect(weightOf(0n, { minTwab: 0n })).toBe(0n);
  });

  it("documents pending decision A2: with a cap, splitting a balance over wallets wins more weight", () => {
    const policy = { minTwab: 100n, capPerWallet: 1_000n };
    const oneWallet = weightOf(10_000n, policy);
    const tenWallets = 10n * weightOf(1_000n, policy);
    expect(tenWallets).toBeGreaterThan(oneWallet);
    // Without a cap splitting changes nothing.
    expect(weightOf(10_000n, { minTwab: 100n })).toBe(10n * weightOf(1_000n, { minTwab: 100n }));
  });
});

describe("inputsHash", () => {
  const events = base().events;

  it("starts with the window and lists the events in chronological order", () => {
    const text = serializeInputs(events, W);
    const lines = text.trimEnd().split("\n");
    expect(lines[0]).toBe("breaks:inputs:v1,1000,2000");
    expect(lines).toHaveLength(events.length + 1);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("does not depend on the order of the input, and changes with anything that matters", () => {
    const h = toHex(inputsHash(events, W));
    expect(toHex(inputsHash([...events].reverse(), W))).toBe(h);
    expect(toHex(inputsHash(events, { start: 1000, end: 2001 }))).not.toBe(h);
    expect(toHex(inputsHash(events.slice(1), W))).not.toBe(h);
    const tweaked = events.map((e, i) => (i === 0 ? { ...e, balanceAfter: e.balanceAfter + 1n } : e));
    expect(toHex(inputsHash(tweaked, W))).not.toBe(h);
  });
});
