// A break holds a list of packs: a few tiers (a machine and the most one pack from it may cost) and, for every spot, the
// tier of its pack, cheapest first. These tests check the keeper's side of that against the numbers the Rust program's own
// on-chain tests use (programs/breaks/tests/breaks.rs, "packs of different prices in one break"), through the builders, the
// decoder and the program model, so a rule that changes in one place and not the other shows up here.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fromHex } from "../src/draw/bytes.js";
import {
  type BreakAccount,
  MAX_PACKS,
  MAX_TIERS,
  type PackTier,
  closeBreak,
  commitEligibility,
  createBreak,
  decodeBreak,
  fundPurchases,
  packCost,
  packPrices,
} from "../src/solana/breaks.js";
import { worstCase } from "../src/scheduler/policy.js";
import { associatedTokenAddress } from "../src/solana/pubkey.js";
import { ORAO_PROGRAM } from "../src/solana/breaks.js";
import { addr, BUYER } from "./support/chain.js";
import { MockChain } from "./support/mock-chain.js";
import { KEEPER, PROGRAMS } from "./support/world.js";

const D = 1_000_000n;
const T0 = 1_800_000_000;
const USDC = addr(5);
const tier = (machine: number, dollars: bigint): PackTier => ({ machine: new Uint8Array(32).fill(machine), maxPrice: dollars * D });

/** 6 paid spots at $20 and 2 free ones; four $10 packs, two $25 and two $50: $190, or $23.75 on average. */
const TIERS = [tier(1, 10n), tier(2, 25n), tier(3, 50n)];
const PACKS = [0, 0, 0, 0, 1, 1, 2, 2];

function chainWith(funds: [bigint, bigint] = [700n * D, 300n * D]) {
  const chain = new MockChain(PROGRAMS, {
    admin: addr(2),
    keeper: KEEPER,
    buyer: BUYER,
    usdcMint: USDC,
    randomnessProgram: ORAO_PROGRAM,
    randomnessTimeoutSecs: 3_600n,
    nextBreakId: 0n,
    minWindowSecs: 21_600n,
    maxWindowSecs: 86_400n,
    maxPaidSpots: 20,
    maxFreeSpots: 6,
    paused: false,
    bump: 255,
  });
  chain.unixTime = BigInt(T0);
  chain.solBalances.set(KEEPER, 5_000_000_000n);
  chain.treasury.subsidyVault = funds[0];
  chain.treasury.holderVault = funds[1];
  chain.tokenAccounts.add(associatedTokenAddress(BUYER, USDC));
  return chain;
}

type Over = Partial<Parameters<typeof createBreak>[1]>;
const create = (chain: MockChain, over: Over = {}) =>
  chain.sendAndConfirm([
    createBreak(PROGRAMS, {
      keeper: KEEPER,
      usdcMint: USDC,
      breakId: chain.config.nextBreakId,
      paidSpots: 6,
      freeSpots: 2,
      spotPrice: 20n * D,
      tiers: TIERS,
      packs: PACKS,
      opensAt: BigInt(T0),
      closesAt: BigInt(T0 + 21_600),
      ...over,
    }),
  ]);

/** Sells `sold` spots (the model does not model buying), closes the sale, commits `eligible` holders and funds the packs. */
async function fund(chain: MockChain, sold: number, eligible: number) {
  chain.breaks.get(0n)!.spotsSold = sold;
  chain.unixTime = BigInt(T0 + 21_600);
  expect((await chain.sendAndConfirm([closeBreak(PROGRAMS, { breakId: 0n })])).outcome).toBe("confirmed");
  const committed = await chain.sendAndConfirm([
    commitEligibility(PROGRAMS, {
      keeper: KEEPER,
      breakId: 0n,
      root: new Uint8Array(32).fill(1),
      totalWeight: eligible > 0 ? 1_000n : 0n,
      entryCount: eligible,
      inputsHash: new Uint8Array(32).fill(2),
    }),
  ]);
  expect(committed.outcome).toBe("confirmed");
  return chain.sendAndConfirm([fundPurchases(PROGRAMS, { keeper: KEEPER, breakId: 0n, buyerUsdc: associatedTokenAddress(BUYER, USDC) })]);
}

describe("creating a break with a pack list", () => {
  it("locks the free spots at the average pack price and the rest of what the buyers do not pay from the subsidy bucket", async () => {
    const chain = chainWith();
    expect((await create(chain)).outcome).toBe("confirmed");
    // $190 over 8 spots is $23.75 each: 2 free spots are $47.50, the 6 paid spots bring in $120, and $22.50 is left.
    expect(chain.treasury.config).toMatchObject({ lockedSubsidy: 22_500_000n, lockedHolder: 47_500_000n });
    const b = chain.breaks.get(0n)!;
    expect(b).toMatchObject({ lockedSubsidy: 22_500_000n, lockedHolder: 47_500_000n, tiers: TIERS, packs: PACKS });
  });

  it("is written and read back as the program stores it", async () => {
    const chain = chainWith();
    await create(chain);
    const b = decodeBreak((await chain.getAccountData((await import("../src/solana/breaks.js")).breakAddress(PROGRAMS, 0n)))!);
    expect(b.tiers).toEqual(TIERS);
    expect(b.packs).toEqual(PACKS);
    expect(packPrices(b)).toEqual([10n, 10n, 10n, 10n, 25n, 25n, 50n, 50n].map((d) => d * D));
  });

  const refused: [string, Over, string][] = [
    ["no tiers", { tiers: [] }, "InvalidPackList"],
    ["nine tiers", { tiers: Array.from({ length: 9 }, (_, i) => tier(i + 1, BigInt(21 + i))), packs: [0, 1, 2, 3, 4, 5, 6, 7, 8, 8, 8, 8], paidSpots: 10 }, "InvalidPackList"],
    ["one pack too few", { packs: PACKS.slice(0, 7) }, "InvalidPackList"],
    ["one pack too many", { packs: [...PACKS, 2] }, "InvalidPackList"],
    ["a pack that names a tier that is not listed", { packs: [0, 0, 0, 0, 1, 1, 2, 3] }, "InvalidPackList"],
    ["a tier nobody uses", { tiers: [...TIERS, tier(4, 60n)] }, "InvalidPackList"],
    ["expensive packs first", { packs: [2, 0, 0, 0, 0, 1, 1, 2] }, "InvalidPackList"],
    ["a pack that costs nothing", { tiers: [tier(1, 0n), ...TIERS.slice(1)] }, "InvalidPrice"],
    ["a spot price above the average pack", { spotPrice: 23_750_001n }, "SpotPriceAboveAveragePack"],
  ];
  it.each(refused)("refuses %s, like the program", async (_, over, reason) => {
    const chain = chainWith();
    expect(await create(chain, over)).toMatchObject({ outcome: "failed", reason });
    expect(chain.treasury.config).toMatchObject({ lockedSubsidy: 0n, lockedHolder: 0n });
    expect(chain.breaks.size).toBe(0);
  });

  it("accepts a spot price at exactly the average", async () => {
    const chain = chainWith();
    expect((await create(chain, { spotPrice: 23_750_000n })).outcome).toBe("confirmed");
    // Nothing is left for the subsidy bucket to pay: the buyers cover everything but the free spots.
    expect(chain.treasury.config).toMatchObject({ lockedSubsidy: 0n, lockedHolder: 47_500_000n });
  });

  it("refuses a 65th pack, even if the config would allow the spots", async () => {
    const chain = chainWith([1_000_000n * D, 1_000_000n * D]);
    chain.config.maxPaidSpots = 70;
    chain.config.maxFreeSpots = 6;
    const tiers = Array.from({ length: MAX_TIERS }, (_, i) => tier(i + 1, BigInt(10 + i)));
    const packs = Array.from({ length: MAX_PACKS + 1 }, (_, i) => Math.min(Math.floor(i / 8), MAX_TIERS - 1));
    expect(await create(chain, { tiers, packs, paidSpots: 60, freeSpots: 5, spotPrice: 10n * D })).toMatchObject({ outcome: "failed", reason: "InvalidPackList" });
  });

  it("accepts as many as 8 tiers and 64 packs", async () => {
    const chain = chainWith([1_000_000n * D, 1_000_000n * D]);
    chain.config.maxPaidSpots = 60;
    chain.config.maxFreeSpots = 4;
    const tiers = Array.from({ length: MAX_TIERS }, (_, i) => tier(i + 1, BigInt(10 + i)));
    const packs = Array.from({ length: MAX_PACKS }, (_, i) => Math.floor(i / 8));
    expect((await create(chain, { tiers, packs, paidSpots: 60, freeSpots: 4, spotPrice: 10n * D })).outcome).toBe("confirmed");
  });
});

describe("a list of one tier", () => {
  // The scheduler still makes breaks of one machine at one price. For those the program's rule is the old one, so the
  // worst case it reserves is what `worstCase` (and the reserve bar of the website) work out.
  const shapes: [number, number, bigint, bigint][] = [
    [10, 2, 20n, 25n],
    [10, 2, 25n, 25n],
    [20, 0, 10n, 50n],
    [1, 1, 1n, 7n],
    [13, 2, 300n, 350n],
  ];
  it.each(shapes)("reserves paid × (pack − spot) and free × pack for %i paid and %i free spots at $%d with $%d packs", async (paid, free, spot, pack) => {
    const chain = chainWith([1_000_000n * D, 1_000_000n * D]);
    const created = await create(chain, {
      paidSpots: paid,
      freeSpots: free,
      spotPrice: spot * D,
      tiers: [tier(1, pack)],
      packs: Array<number>(paid + free).fill(0),
    });
    expect(created.outcome).toBe("confirmed");
    const { subsidy, holder } = worstCase({ paidSpots: paid, freeSpots: free, spotPrice: spot * D, maxPackPrice: pack * D });
    expect(chain.treasury.config).toMatchObject({ lockedSubsidy: subsidy, lockedHolder: holder });
  });
});

describe("paying for a break with a pack list", () => {
  const vaults = (c: MockChain) => [c.treasury.subsidyVault, c.treasury.holderVault];

  it("buys every pack of a full break", async () => {
    const chain = chainWith();
    await create(chain);
    expect((await fund(chain, 6, 5)).outcome).toBe("confirmed");
    // $190 of packs: the buyers' $120, $22.50 from the subsidy bucket and $47.50 from the holder bucket.
    expect(vaults(chain)).toEqual([700n * D - 22_500_000n, 300n * D - 47_500_000n]);
    expect(chain.treasury.config).toMatchObject({ lockedSubsidy: 0n, lockedHolder: 0n });
    expect(chain.breaks.get(0n)).toMatchObject({ status: "Funded", poolSize: 8, packBudget: 190n * D });
  });

  it("drops the most expensive packs of a break that does not fill", async () => {
    const chain = chainWith();
    await create(chain);
    // All 6 spots sold but one holder for 2 free spots: 7 packs. $10 × 4 + $25 × 2 + $50 = $140, exactly $20 each.
    expect((await fund(chain, 6, 1)).outcome).toBe("confirmed");
    expect(chain.breaks.get(0n)).toMatchObject({ poolSize: 7, packBudget: 140n * D });
    expect(packCost(chain.breaks.get(0n)!, 7)).toBe(140n * D);
    // $120 from the buyers and $20 from the holder bucket; the subsidy bucket is not needed.
    expect(vaults(chain)).toEqual([700n * D, 280n * D]);
    expect(chain.treasury.config).toMatchObject({ lockedSubsidy: 0n, lockedHolder: 0n });
  });

  it("does not fund a break whose bought packs are worth less than its spots, and leaves the locks alone", async () => {
    const chain = chainWith();
    await create(chain);
    // 4 spots and 2 free winners: the six cheapest packs are $90, or $15 each, for spots that cost $20.
    expect(await fund(chain, 4, 5)).toMatchObject({ outcome: "failed", reason: "PacksWorthLessThanSpots" });
    expect(chain.breaks.get(0n)).toMatchObject({ status: "EligibilityCommitted", lockedSubsidy: 22_500_000n, lockedHolder: 47_500_000n });
    expect(vaults(chain)).toEqual([700n * D, 300n * D]);
  });

  it("funds a break nobody paid for, whatever the spot price, from the holder bucket", async () => {
    const chain = chainWith();
    await create(chain);
    // Two holders, no paid spots: the two cheapest packs ($10 each).
    expect((await fund(chain, 0, 5)).outcome).toBe("confirmed");
    expect(chain.breaks.get(0n)).toMatchObject({ poolSize: 2, packBudget: 20n * D });
    expect(vaults(chain)).toEqual([700n * D, 280n * D]);
  });

  it("covers rounding dust from the holder lock, like the program", async () => {
    // Prices of 10, 11 (nine times) and 12 micro-dollars, 5 paid and 6 free spots, a spot price of 10 micro-dollars.
    const chain = chainWith([1_000n, 1_000n]);
    chain.config.maxPaidSpots = 20;
    const tiers: PackTier[] = [
      { machine: new Uint8Array(32).fill(1), maxPrice: 10n },
      { machine: new Uint8Array(32).fill(2), maxPrice: 11n },
      { machine: new Uint8Array(32).fill(3), maxPrice: 12n },
    ];
    const packs = [0, ...Array<number>(9).fill(1), 2];
    expect((await create(chain, { tiers, packs, paidSpots: 5, freeSpots: 6, spotPrice: 10n })).outcome).toBe("confirmed");
    expect(chain.treasury.config).toMatchObject({ lockedSubsidy: 5n, lockedHolder: 66n });
    expect((await fund(chain, 5, 5)).outcome).toBe("confirmed");
    // Budget 109; the buyers' 50; the holders at the average of 10 would be 50, leaving 9 for the subsidy bucket, which locked 5.
    expect(chain.breaks.get(0n)!.packBudget).toBe(109n);
    expect([chain.treasury.subsidyVault, chain.treasury.holderVault]).toEqual([1_000n - 5n, 1_000n - 54n]);
    expect(chain.treasury.config).toMatchObject({ lockedSubsidy: 0n, lockedHolder: 0n });
  });
});

describe("reading the list", () => {
  const rust = JSON.parse(readFileSync(new URL("../../programs/breaks/instruction-vectors.json", import.meta.url), "utf8")) as {
    cases: { name: string; inputs: { data: string } }[];
  };
  const sample = (): Uint8Array => fromHex(rust.cases.find((c) => c.name === "breaks.account.Break")!.inputs.data);
  const decoded = (): BreakAccount => decodeBreak(sample());

  it("reads the Rust program's own Break: the tiers it lists, and a tier for every spot", () => {
    const b = decoded();
    expect(b.tiers).toHaveLength(3);
    expect(b.packs).toEqual([0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2]);
    expect(packPrices(b)).toEqual([10, 10, 10, 10, 10, 25, 25, 25, 25, 50, 50, 50].map((d) => BigInt(d) * D));
  });

  it("adds up the first count packs, which is what the program pays for a pool of that size", () => {
    const b = decoded();
    expect(packCost(b, 0)).toBe(0n);
    expect(packCost(b, 5)).toBe(50n * D);
    expect(packCost(b, 10)).toBe(200n * D); // the sample break's pack budget
    expect(packCost(b, 12)).toBe(300n * D);
    expect(() => packCost(b, 13)).toThrow(/no 13 packs in a list of 12/);
    expect(() => packCost(b, -1)).toThrow(RangeError);
  });

  it("refuses a pack that names a tier the break does not list", () => {
    expect(() => packPrices({ tiers: TIERS, packs: [0, 3] })).toThrow(/names tier 3/);
  });

  it("refuses an account that lists more tiers or more spots than a break can hold", () => {
    const data = sample();
    const tierCount = 8 + 8 + 1 + 2 + 2 + 8; // discriminator, id, status, paid, free, spot price
    expect(data[tierCount]).toBe(3);
    data[tierCount] = 9;
    expect(() => decodeBreak(data)).toThrow(/9 tiers/);

    const spots = sample();
    new DataView(spots.buffer).setUint16(8 + 8 + 1, 63, true); // 63 paid + 2 free
    expect(() => decodeBreak(spots)).toThrow(/65 spots/);
  });
});
