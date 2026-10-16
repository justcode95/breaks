import { describe, expect, it } from "vitest";
import { breakAddress, cancelUnfundable, fundPurchases, treasuryAuthorityAddress } from "../src/solana/breaks.js";
import { instructionDiscriminator } from "../src/solana/instruction.js";
import { associatedTokenAddress } from "../src/solana/pubkey.js";
import { treasuryAddresses } from "../src/solana/treasury.js";
import { PROGRAMS, world } from "./support/world.js";

const D = 1_000_000n;
const MACHINE = (n: number) => new Uint8Array(32).fill(n);

describe("cancelUnfundable (the builder)", () => {
  it("is the instruction of that name, with no data and six accounts that nobody signs for", () => {
    const ix = cancelUnfundable(PROGRAMS, { breakId: 7n });
    expect(ix.programId).toBe(PROGRAMS.breaks);
    expect(ix.data).toEqual(instructionDiscriminator("cancel_unfundable"));
    expect(ix.data).toHaveLength(8);
    const t = treasuryAddresses(PROGRAMS.treasury);
    expect(ix.accounts).toEqual([
      { pubkey: breakAddress(PROGRAMS, 7n), isSigner: false, isWritable: true },
      { pubkey: treasuryAuthorityAddress(PROGRAMS), isSigner: false, isWritable: false },
      { pubkey: t.config, isSigner: false, isWritable: true },
      { pubkey: t.subsidyVault, isSigner: false, isWritable: false },
      { pubkey: t.holderVault, isSigner: false, isWritable: false },
      { pubkey: PROGRAMS.treasury, isSigner: false, isWritable: false },
    ]);
  });
});

/** The mixed break of the Rust tests: 6 paid spots at $20 and 2 free, $10 x 4, $25 x 2 and $50 x 2. */
function mixed(over: { status?: "EligibilityCommitted" | "Closed" | "Open" | "Funded"; sold: number; eligible: number }) {
  const w = world({ status: over.status ?? "EligibilityCommitted", paid: 6, free: 2 });
  const b = w.chain.breaks.get(7n)!;
  b.tiers = [
    { machine: MACHINE(1), maxPrice: 10n * D },
    { machine: MACHINE(2), maxPrice: 25n * D },
    { machine: MACHINE(3), maxPrice: 50n * D },
  ];
  b.packs = [0, 0, 0, 0, 1, 1, 2, 2];
  b.spotsSold = over.sold;
  b.eligibilityCount = over.eligible;
  b.lockedSubsidy = 22_500_000n;
  b.lockedHolder = 47_500_000n;
  w.chain.treasury.config.lockedSubsidy = 22_500_000n;
  w.chain.treasury.config.lockedHolder = 47_500_000n;
  return { w, b };
}

const send = (w: ReturnType<typeof mixed>["w"]) => w.chain.sendAndConfirm([cancelUnfundable(PROGRAMS, { breakId: 7n })]);

describe("cancel_unfundable in the program model", () => {
  it("cancels a break whose bought packs are worth less than the spots cost, releases the reservation and pays nothing out", async () => {
    // 4 sold at $20 and 2 free: the 6 cheapest packs cost $90, $15 each.
    const { w, b } = mixed({ sold: 4, eligible: 5 });
    const r = await send(w);
    expect(r.outcome).toBe("confirmed");
    expect(b).toMatchObject({ status: "Cancelled", lockedSubsidy: 0n, lockedHolder: 0n });
    expect(w.chain.treasury.config).toMatchObject({ lockedSubsidy: 0n, lockedHolder: 0n });
    expect(w.chain.applied).toEqual(["cancel_unfundable"]);
  });

  it("cancels a break nobody joined", async () => {
    const { w, b } = mixed({ sold: 0, eligible: 0 });
    expect((await send(w)).outcome).toBe("confirmed");
    expect(b.status).toBe("Cancelled");
  });

  it("refuses a break that can be funded, with the program's error, and changes nothing", async () => {
    const { w, b } = mixed({ sold: 6, eligible: 5 });
    const r = await send(w);
    expect(r).toMatchObject({ outcome: "failed", reason: expect.stringContaining("BreakIsFundable") });
    expect(b).toMatchObject({ status: "EligibilityCommitted", lockedSubsidy: 22_500_000n, lockedHolder: 47_500_000n });
    expect(w.chain.treasury.config).toMatchObject({ lockedSubsidy: 22_500_000n, lockedHolder: 47_500_000n });
  });

  it("is only for a break whose eligibility list is committed", async () => {
    for (const status of ["Open", "Closed", "Funded"] as const) {
      const { w, b } = mixed({ status, sold: 0, eligible: 0 });
      const r = await send(w);
      expect(r, status).toMatchObject({ outcome: "failed", reason: expect.stringContaining("WrongStatus") });
      expect(b.status).toBe(status);
    }
  });

  it("works while the program is paused, which stops funding but never a cancel", async () => {
    const { w, b } = mixed({ sold: 4, eligible: 5 });
    w.chain.config = { ...w.chain.config, paused: true };
    expect((await send(w)).outcome).toBe("confirmed");
    expect(b.status).toBe("Cancelled");
  });

  it("cannot be sent twice", async () => {
    const { w } = mixed({ sold: 0, eligible: 0 });
    expect((await send(w)).outcome).toBe("confirmed");
    expect(await send(w)).toMatchObject({ outcome: "failed", reason: expect.stringContaining("WrongStatus") });
  });

  it("refuses a transaction in which an account signs, as the program has no signer", async () => {
    const { w } = mixed({ sold: 0, eligible: 0 });
    const ix = cancelUnfundable(PROGRAMS, { breakId: 7n });
    ix.accounts[0] = { ...(ix.accounts[0] as (typeof ix.accounts)[number]), isSigner: true };
    expect(await w.chain.sendAndConfirm([ix])).toMatchObject({ outcome: "failed" });
  });

  // The same table as the Rust test `cancel_unfundable_agrees_with_fund_purchases_for_every_closed_shape`, worked out by hand
  // there too: the model and the program must give the same answer for every number of spots sold and holders eligible.
  it("agrees with fund_purchases for every number of spots sold and holders eligible, and with the program's own table", async () => {
    const prices = [10n, 10n, 10n, 10n, 25n, 25n, 50n, 50n];
    const byTheBook = (sold: number, eligible: number) => {
      const pool = sold + Math.min(2, eligible);
      return pool === 0 || (sold > 0 && 20n > prices.slice(0, pool).reduce((a, b) => a + b, 0n) / BigInt(pool));
    };
    let cancelled = 0;
    let fundable = 0;
    for (let sold = 0; sold <= 6; sold++) {
      for (let eligible = 0; eligible <= 3; eligible++) {
        const { w } = mixed({ sold, eligible });
        const cancel = await send(w);
        if (byTheBook(sold, eligible)) {
          expect(cancel.outcome, `${sold} sold, ${eligible} eligible`).toBe("confirmed");
          cancelled++;
        } else {
          expect(cancel, `${sold} sold, ${eligible} eligible`).toMatchObject({ outcome: "failed", reason: expect.stringContaining("BreakIsFundable") });
          // And funding it, on a fresh copy, goes through.
          const again = mixed({ sold, eligible });
          const { keeper, buyer, usdcMint } = again.w.chain.config;
          const fund = await again.w.chain.sendAndConfirm([fundPurchases(PROGRAMS, { keeper, breakId: 7n, buyerUsdc: associatedTokenAddress(buyer, usdcMint) })]);
          expect(fund.outcome, `${sold} sold, ${eligible} eligible`).toBe("confirmed");
          fundable++;
        }
      }
    }
    expect(cancelled).toBeGreaterThan(10);
    expect(fundable).toBeGreaterThanOrEqual(4);
  });
});
