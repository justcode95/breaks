import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type BreakAccount, decodeBreak } from "../lib/chain/accounts";
import { addressFromBytes, associatedTokenAddress, breakAddress, escrowAddress, spotAddress } from "../lib/chain/address";
import { buySpotInstruction, checkAfford, checkSale, explorerTxUrl } from "../lib/chain/buy";
import { toHex } from "../lib/draw/bytes";
import { type BreakFields, breakFieldsFromVector, encodeBreak } from "./support/accounts";

type Case = { name: string; inputs: Record<string, any>; data?: string; accounts?: { pubkey: string; signer: boolean; writable: boolean }[]; outputs?: Record<string, any> | null };
const vectors: { programs: { breaks: string }; cases: Case[] } = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "programs", "breaks", "instruction-vectors.json"), "utf8"));
const PROGRAM = vectors.programs.breaks;
const named = (name: string): Case => vectors.cases.find((c) => c.name === name) as Case;
const SAMPLE = breakFieldsFromVector(named("breaks.account.Break").outputs as Record<string, any>);
// Sample sale window: 2027-01-15 08:00 to 14:00 UTC, 10 paid spots at $20.
const OPENS = 1_800_000_000;
const CLOSES = 1_800_021_600;
const account = (over: Partial<BreakFields> = {}): BreakAccount => decodeBreak(encodeBreak({ ...SAMPLE, status: "Open", spotsSold: 3, ...over }));

describe("the buy_spot instruction", () => {
  it("is byte for byte the instruction the Rust program's own test builds", () => {
    const v = named("breaks.buy_spot");
    const i = v.inputs;
    const ix = buySpotInstruction({ program: PROGRAM, buyer: i.buyer, buyerUsdc: i.buyerUsdc, breakId: BigInt(i.breakId), index: i.index });
    expect(ix.programId).toBe(PROGRAM);
    expect(toHex(ix.data)).toBe(v.data);
    expect(ix.accounts).toEqual(v.accounts);
  });

  it("asks for the next spot by its index, and for nothing else, in the data", () => {
    const at = (index: number) => toHex(buySpotInstruction({ program: PROGRAM, buyer: "GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq", buyerUsdc: "QWmroo4YnnMqYW3cnxWkFdaTxGD3P7vMSzwMHGbUzwF", breakId: 7n, index }).data);
    // The 8-byte name of the instruction, then the index as a little-endian u16.
    expect(at(0)).toBe("f09879fd5ffb35ee0000");
    expect(at(3)).toBe("f09879fd5ffb35ee0300");
    expect(at(258)).toBe("f09879fd5ffb35ee0201");
    expect(at(65535)).toBe("f09879fd5ffb35eeffff");
  });

  it("refuses an index that is not a whole number from 0 to 65535", () => {
    const build = (index: number) => buySpotInstruction({ program: PROGRAM, buyer: "GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq", buyerUsdc: "QWmroo4YnnMqYW3cnxWkFdaTxGD3P7vMSzwMHGbUzwF", breakId: 7n, index });
    for (const bad of [-1, 65536, 1.5, Number.NaN]) expect(() => build(bad)).toThrow(RangeError);
  });

  it("names the accounts of this break and this spot, and only the buyer signs", () => {
    const ix = buySpotInstruction({ program: PROGRAM, buyer: "GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq", buyerUsdc: "QWmroo4YnnMqYW3cnxWkFdaTxGD3P7vMSzwMHGbUzwF", breakId: 12n, index: 5 });
    const breakKey = breakAddress(PROGRAM, 12n);
    expect(ix.accounts[2]?.pubkey).toBe(breakKey);
    expect(ix.accounts[3]?.pubkey).toBe(escrowAddress(PROGRAM, breakKey));
    expect(ix.accounts[5]?.pubkey).toBe(spotAddress(PROGRAM, breakKey, 5));
    expect(ix.accounts.filter((a) => a.signer).map((a) => a.pubkey)).toEqual(["GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq"]);
    // A different spot or break is a different account, so a spot cannot be bought twice.
    expect(spotAddress(PROGRAM, breakKey, 6)).not.toBe(spotAddress(PROGRAM, breakKey, 5));
    expect(spotAddress(PROGRAM, breakAddress(PROGRAM, 13n), 5)).not.toBe(spotAddress(PROGRAM, breakKey, 5));
  });
});

describe("a wallet's associated token account", () => {
  // Reference values computed with the real Solana derivation (web3.js `PublicKey.findProgramAddressSync`).
  const fill = (n: number) => addressFromBytes(new Uint8Array(32).fill(n));
  const REFERENCE: [number, string][] = [
    [1, "CsYkfSfTUTWwnoeRkGchtai5kkYz2SC33kKJwA99wVr3"],
    [7, "BKwy7yDVUWfFVHSE2GrEJeNhxbt3Fe4Q9Hb4hj2UDk5F"],
    [200, "8MvZF6vGqCiUiYoPKcfSFU9SLqnQryiVNCTZ5Amuuddg"],
  ];

  it("is the address the real derivation gives for the same owner and mint", () => {
    for (const [n, expected] of REFERENCE) expect(associatedTokenAddress(fill(n), fill(n + 1))).toBe(expected);
    // The buyer and the USDC mint of the Rust program's sample accounts.
    const config = named("breaks.account.BreaksConfig").outputs as Record<string, string>;
    expect(associatedTokenAddress(named("breaks.buy_spot").inputs.buyer, config.usdcMint as string)).toBe("GjRFn2khnu4Z8UgJB1nftknurmBxMcER5qVFZYsNCDzz");
    // The real USDC mint.
    expect(associatedTokenAddress("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe("FGETo8T8wMcN2wCjav8VK6eh3dLk63evNDPxzLSJra8B");
  });

  it("differs by owner and by mint", () => {
    expect(associatedTokenAddress(fill(1), fill(2))).not.toBe(associatedTokenAddress(fill(2), fill(1)));
    expect(associatedTokenAddress(fill(1), fill(2))).not.toBe(associatedTokenAddress(fill(1), fill(1)));
  });
});

describe("whether a spot can be bought now", () => {
  const open = { paused: false };
  const sale = (over: Partial<BreakFields> = {}, now = OPENS + 3600, config = open) => checkSale({ config, break: account(over), now });

  it("names the spot the next buyer gets, what it costs and how many are left", () => {
    expect(sale()).toEqual({ ok: true, index: 3, price: 20_000_000n, spotsLeft: 7 });
    expect(sale({ spotsSold: 0 })).toMatchObject({ ok: true, index: 0, spotsLeft: 10 });
    expect(sale({ spotsSold: 9 })).toMatchObject({ ok: true, index: 9, spotsLeft: 1 });
  });

  it("takes the last spot, and says when none is left", () => {
    expect(sale({ spotsSold: 10 })).toEqual({ ok: false, reason: "All paid spots are taken." });
  });

  it("stops while the program is paused, whatever else is true", () => {
    const paused = { paused: true };
    expect(sale({}, OPENS + 3600, paused)).toEqual({ ok: false, reason: "Sales are paused by the program's admin." });
    expect(sale({ status: "Cancelled" }, OPENS + 3600, paused)).toMatchObject({ reason: "Sales are paused by the program's admin." });
    expect(sale({}, CLOSES + 10, paused)).toMatchObject({ reason: "Sales are paused by the program's admin." });
  });

  it("says a cancelled break was cancelled and any other break past its sale is over", () => {
    expect(sale({ status: "Cancelled" })).toEqual({ ok: false, reason: "This break was cancelled." });
    for (const status of ["Closed", "EligibilityCommitted", "Funded", "PoolCommitted", "RandomnessRequested", "Settled", "Drawn"] as const) {
      expect(sale({ status }), status).toEqual({ ok: false, reason: "The sale of this break is over." });
    }
    // The status is judged before the clock, as the program does.
    expect(sale({ status: "Closed" }, CLOSES - 60)).toMatchObject({ reason: "The sale of this break is over." });
  });

  it("keeps to the sale window: open from its first second, closed from its last", () => {
    expect(sale({}, OPENS - 1)).toEqual({ ok: false, reason: "The sale opens 2027-01-15 08:00 UTC." });
    expect(sale({}, OPENS)).toMatchObject({ ok: true });
    expect(sale({}, CLOSES - 1)).toMatchObject({ ok: true });
    expect(sale({}, CLOSES)).toEqual({ ok: false, reason: "The sale has ended." });
    expect(sale({}, CLOSES + 3600)).toEqual({ ok: false, reason: "The sale has ended." });
  });

  it("judges the window before the spots, as the program does", () => {
    expect(sale({ spotsSold: 10 }, CLOSES + 1)).toMatchObject({ reason: "The sale has ended." });
  });
});

describe("whether a wallet can pay", () => {
  it("accepts a balance that covers the price, down to the last micro-dollar", () => {
    expect(checkAfford(20_000_000n, 20_000_000n)).toEqual({ ok: true });
    expect(checkAfford(20_000_000n, 1_000_000_000n)).toEqual({ ok: true });
  });

  it("says how much is missing in dollars, and when there is no USDC account", () => {
    expect(checkAfford(20_000_000n, 19_999_999n)).toEqual({ ok: false, reason: "A spot costs $20 USDC and this wallet has $19.999999." });
    expect(checkAfford(20_500_000n, 0n)).toEqual({ ok: false, reason: "A spot costs $20.50 USDC and this wallet has $0." });
    expect(checkAfford(20_000_000n, null)).toEqual({ ok: false, reason: "This wallet has no USDC account yet, so it has no USDC to pay with." });
  });
});

describe("the link to a transaction", () => {
  it("is the devnet explorer's page for a plausible signature", () => {
    const sig = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
    expect(explorerTxUrl(sig)).toBe(`https://explorer.solana.com/tx/${sig}?cluster=devnet`);
    expect(explorerTxUrl("5".repeat(64))).toBeDefined();
    expect(explorerTxUrl("5".repeat(88))).toBeDefined();
  });

  it("is nothing for text that is not a signature, since it came from a wallet", () => {
    for (const bad of ["", "5".repeat(63), "5".repeat(89), `${"5".repeat(70)}/../x`, `${"5".repeat(70)}?x=1`, `${"5".repeat(70)} `, "0".repeat(70), "O".repeat(70), "l".repeat(70), "I".repeat(70), "https://evil.example"]) {
      expect(explorerTxUrl(bad), bad).toBeUndefined();
    }
  });
});
