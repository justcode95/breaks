import { describe, expect, it } from "vitest";
import { poolHash } from "../src/draw/pool.js";
import { assignCards } from "../src/draw/pool.js";
import { PlanError, type PlanErrorCode, buildDeliveryPlan } from "../src/delivery/plan.js";
import { addressToBytes } from "../src/solana/pubkey.js";
import { addr, drawnBreak } from "./support/chain.js";

const plan = (d = drawnBreak()) => buildDeliveryPlan({ breakId: "1", buyer: d.buyer, chain: d.chain, paidSpots: d.paidSpots, cards: d.cards });

function expectPlanError(fn: () => unknown, code: PlanErrorCode) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(PlanError);
    expect((err as PlanError).code).toBe(code);
    return;
  }
  throw new Error(`expected a PlanError (${code})`);
}

describe("buildDeliveryPlan", () => {
  it("hands every card to exactly one spot, as the draw says", () => {
    const d = drawnBreak();
    const p = plan(d);
    expect(p.breakId).toBe("1");
    expect(p.buyer).toBe(d.buyer);
    expect(p.deliveries).toHaveLength(5);
    expect(new Set(p.deliveries.map((x) => x.cardMint)).size).toBe(5);
    expect(p.deliveries.map((x) => x.spot)).toEqual([
      { kind: "paid", idx: 0 },
      { kind: "paid", idx: 1 },
      { kind: "paid", idx: 2 },
      { kind: "free", idx: 0 },
      { kind: "free", idx: 1 },
    ]);
    expect(p.deliveries.map((x) => x.recipient)).toEqual([10, 11, 12, 50, 51].map(addr));

    const expected = assignCards(d.chain.seed, d.cards.map(addressToBytes), d.paidSpots.map((s) => s.owner), [addr(50), addr(51)]);
    expect(p.deliveries.map((x) => addressToBytes(x.cardMint))).toEqual(expected.map((e) => e.card));
  });

  it("does not depend on the order the cards were pulled in", () => {
    const d = drawnBreak();
    const shuffled = [...d.cards].reverse();
    expect(plan({ ...d, cards: shuffled })).toEqual(plan(d));
  });

  it("a different seed deals the cards differently", () => {
    const a = plan(drawnBreak({ seed: 1 }));
    const b = plan(drawnBreak({ seed: 2 }));
    expect(a.deliveries.map((x) => x.cardMint)).not.toEqual(b.deliveries.map((x) => x.cardMint));
  });

  it("works with no free spots, and with one wallet holding several spots", () => {
    const none = drawnBreak({ paid: 2, free: 0 });
    expect(plan(none).deliveries).toHaveLength(2);
    const same = drawnBreak();
    same.paidSpots[1] = { ...same.paidSpots[1]!, owner: same.paidSpots[0]!.owner };
    expect(plan(same).deliveries.filter((x) => x.recipient === addr(10))).toHaveLength(2);
  });

  it("refuses a break that is not Drawn", () => {
    for (const status of ["Open", "Closed", "Funded", "PoolCommitted", "RandomnessRequested", "Settled", "Cancelled"] as const) {
      const d = drawnBreak();
      d.chain.status = status;
      expectPlanError(() => plan(d), "not_drawn");
    }
  });

  it("refuses an empty seed", () => {
    const d = drawnBreak();
    d.chain.seed = new Uint8Array(32);
    expectPlanError(() => plan(d), "bad_seed");
  });

  it("refuses paid spots that do not match what was sold", () => {
    const missing = drawnBreak();
    missing.paidSpots.pop();
    expectPlanError(() => plan(missing), "spots");

    const outOfPlace = drawnBreak();
    outOfPlace.paidSpots.reverse();
    expectPlanError(() => plan(outOfPlace), "spots");

    const otherBreak = drawnBreak();
    otherBreak.paidSpots[0] = { ...otherBreak.paidSpots[0]!, breakId: 8n };
    expectPlanError(() => plan(otherBreak), "spots");

    const refunded = drawnBreak();
    refunded.paidSpots[2] = { ...refunded.paidSpots[2]!, refunded: true };
    expectPlanError(() => plan(refunded), "spots");
  });

  it("refuses free winners that do not match what was drawn", () => {
    const fewer = drawnBreak();
    fewer.chain.freeWinnerCount = 1;
    expectPlanError(() => plan(fewer), "winners");

    const empty = drawnBreak();
    empty.chain.freeWinners[1] = { ...empty.chain.freeWinners[1]!, wallet: addr(0) };
    expectPlanError(() => plan(empty), "winners");

    const tooMany = drawnBreak();
    tooMany.chain.poolSize = 2;
    expectPlanError(() => plan(tooMany), "winners");
  });

  it("refuses cards that are not exactly the committed pool", () => {
    const missing = drawnBreak();
    missing.cards.pop();
    expectPlanError(() => plan(missing), "cards");

    const extra = drawnBreak();
    extra.cards.push(addr(200));
    expectPlanError(() => plan(extra), "cards");

    const duplicate = drawnBreak();
    duplicate.cards[1] = duplicate.cards[0]!;
    expectPlanError(() => plan(duplicate), "cards");

    const swapped = drawnBreak();
    swapped.cards[4] = addr(201); // same number of cards, one of them not the one that was committed
    expectPlanError(() => plan(swapped), "pool_hash");

    const wrongHash = drawnBreak();
    wrongHash.chain.poolHash = poolHash([new Uint8Array(32).fill(1)]);
    expectPlanError(() => plan(wrongHash), "pool_hash");
  });

  it("refuses an address that is not one", () => {
    const badOwner = drawnBreak();
    badOwner.paidSpots[0] = { ...badOwner.paidSpots[0]!, owner: "not-an-address" };
    expectPlanError(() => plan(badOwner), "address");

    const badCard = drawnBreak();
    badCard.cards[0] = "0xabc";
    expectPlanError(() => plan(badCard), "address");

    const badBuyer = drawnBreak();
    expectPlanError(() => buildDeliveryPlan({ breakId: "1", buyer: "nope", chain: badBuyer.chain, paidSpots: badBuyer.paidSpots, cards: badBuyer.cards }), "address");
  });
});
