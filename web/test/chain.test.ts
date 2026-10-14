import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeBreak, decodeConfig, decodeSpot } from "../lib/chain/accounts";
import { breakAddress, configAddress, findProgramAddress, isAddress, spotAddress } from "../lib/chain/address";
import { fromHex, toHex } from "../lib/draw/bytes";

interface Vector {
  name: string;
  inputs: Record<string, string>;
  outputs: Record<string, unknown> | null;
  accounts?: { pubkey: string }[];
}

// Made by the Rust programs' tests (`cargo test -p breaks --test instruction_vectors`): sample account bytes with the
// fields they hold, and the addresses of accounts the program derives. This decoder shares no code with the keeper's.
const vectors: { programs: { breaks: string }; cases: Vector[] } = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "programs", "breaks", "instruction-vectors.json"), "utf8"),
);
const BREAKS = vectors.programs.breaks;
const named = (name: string) => vectors.cases.find((c) => c.name === name) as Vector;

describe("the addresses the program derives", () => {
  // `buy_spot`: [buyer, config, break, escrow, buyer usdc, spot, token program, system program]
  const buy = named("breaks.buy_spot");
  const close = named("breaks.close_break");

  it("derives the break, spot and config addresses the Rust program uses", () => {
    expect(breakAddress(BREAKS, 7n)).toBe((close.accounts as { pubkey: string }[])[0]?.pubkey);
    expect(breakAddress(BREAKS, 7n)).toBe((buy.accounts as { pubkey: string }[])[2]?.pubkey);
    expect(configAddress(BREAKS)).toBe((buy.accounts as { pubkey: string }[])[1]?.pubkey);
    expect(spotAddress(BREAKS, breakAddress(BREAKS, 7n), 3)).toBe((buy.accounts as { pubkey: string }[])[5]?.pubkey);
  });

  it("gives different addresses for different breaks, spots and programs", () => {
    expect(breakAddress(BREAKS, 8n)).not.toBe(breakAddress(BREAKS, 7n));
    const key = breakAddress(BREAKS, 7n);
    expect(spotAddress(BREAKS, key, 4)).not.toBe(spotAddress(BREAKS, key, 3));
    expect(breakAddress("Bvq3U9fz2MiHkLH8u4zyt6T1bimxnaEuHkZhezNDT5R9", 7n)).not.toBe(key);
  });

  it("refuses a seed that is too long, and tells addresses from other text", () => {
    expect(() => findProgramAddress([new Uint8Array(33)], BREAKS)).toThrow(/at most 32 bytes/);
    expect(isAddress(BREAKS)).toBe(true);
    for (const bad of ["", "nope", "11111", BREAKS + "1", "0OIl"]) expect(isAddress(bad), bad).toBe(false);
  });
});

describe("the accounts, as the Rust program writes them", () => {
  it("reads a Break", () => {
    const v = named("breaks.account.Break");
    const b = decodeBreak(fromHex(v.inputs.data as string));
    const o = v.outputs as Record<string, unknown>;
    expect(b.id.toString()).toBe(o.id);
    expect(b.status).toBe(o.status);
    expect([b.paidSpots, b.freeSpots, b.spotsSold, b.eligibilityCount, b.poolSize, b.freeWinnerCount]).toEqual([o.paidSpots, o.freeSpots, o.spotsSold, o.eligibilityCount, o.poolSize, o.freeWinnerCount]);
    expect([b.spotPrice, b.opensAt, b.closesAt, b.eligibilityTotalWeight, b.seededAt].map(String)).toEqual([o.spotPrice, o.opensAt, o.closesAt, o.eligibilityTotalWeight, o.seededAt]);
    expect([toHex(b.eligibilityRoot), toHex(b.poolHash), toHex(b.seed)]).toEqual([o.eligibilityRoot, o.poolHash, o.seed]);
    expect(b.maxPackPrice.toString()).toBe(o.maxPackPrice);
    expect(toHex(b.packMachine)).toBe(o.packMachine);
    // Only the recorded winners are kept, not the empty slots.
    const winners = (o.freeWinners as { wallet: string; start: string; weight: string }[]).slice(0, o.freeWinnerCount as number);
    expect(b.freeWinners.map((w) => ({ wallet: w.wallet, start: w.start.toString(), weight: w.weight.toString() }))).toEqual(winners);
    expect(b.freeWinners).toHaveLength(2);
  });

  it("reads a Spot", () => {
    const v = named("breaks.account.Spot");
    const s = decodeSpot(fromHex(v.inputs.data as string));
    const o = v.outputs as Record<string, unknown>;
    expect({ breakId: s.breakId.toString(), index: s.index, owner: s.owner, paid: s.paid.toString(), refunded: s.refunded }).toEqual({ breakId: o.breakId, index: o.index, owner: o.owner, paid: o.paid, refunded: o.refunded });
  });

  it("reads the id the next break will get from the config", () => {
    const v = named("breaks.account.BreaksConfig");
    expect(decodeConfig(fromHex(v.inputs.data as string)).nextBreakId.toString()).toBe((v.outputs as Record<string, unknown>).nextBreakId);
  });

  it("refuses data that is not the account asked for, or is cut short", () => {
    const breakData = fromHex(named("breaks.account.Break").inputs.data as string);
    const spotData = fromHex(named("breaks.account.Spot").inputs.data as string);
    expect(() => decodeBreak(spotData)).toThrow(/not a Break account/);
    expect(() => decodeSpot(breakData)).toThrow(/not a Spot account/);
    expect(() => decodeBreak(new Uint8Array(0))).toThrow(/not a Break account/);
    expect(() => decodeBreak(breakData.slice(0, 200))).toThrow(/too short/);
    const badStatus = new Uint8Array(breakData);
    badStatus[16] = 99;
    expect(() => decodeBreak(badStatus)).toThrow(/unknown break status 99/);
    const badBool = new Uint8Array(spotData);
    badBool[8 + 8 + 2 + 32 + 8] = 7;
    expect(() => decodeSpot(badBool)).toThrow(/not a bool/);
  });

  it("refuses an account that claims more winners than a break can hold", () => {
    const data = new Uint8Array(fromHex(named("breaks.account.Break").inputs.data as string));
    // freeWinnerCount sits right before the 16 winner slots (48 bytes each) and the two bumps.
    data[data.length - 2 - 16 * 48 - 1] = 17;
    expect(() => decodeBreak(data)).toThrow(/at most 16/);
  });
});
