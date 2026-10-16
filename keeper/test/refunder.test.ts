import { describe, expect, it } from "vitest";
import { createRunner } from "../src/job.js";
import type { ActiveBreak } from "../src/pipeline/pipeline.js";
import type { DbBreakStatus } from "../src/pipeline/repo.js";
import { BreakRefunder, type RefundRepo, refundJob } from "../src/refund/refunder.js";
import { breakAddress, refundSpot, spotAddress } from "../src/solana/breaks.js";
import { type Address, associatedTokenAddress } from "../src/solana/pubkey.js";
import { tokenAccountState } from "../src/solana/token.js";
import { encodeTokenAccount } from "./support/accounts.js";
import { addr } from "./support/chain.js";
import { PROGRAMS, logger, world } from "./support/world.js";

const D = 1_000_000n;

/** The database's side: which breaks are cancelled and which are finished. */
class Repo implements RefundRepo {
  public statuses = new Map<string, DbBreakStatus>();
  constructor(public breaks: ActiveBreak[]) {
    for (const b of breaks) this.statuses.set(b.id, "cancelled");
  }
  async cancelledBreaks(): Promise<ActiveBreak[]> {
    return this.breaks.filter((b) => this.statuses.get(b.id) === "cancelled");
  }
  async setStatus(id: string, status: DbBreakStatus): Promise<void> {
    this.statuses.set(id, status);
  }
}

/** A cancelled break (id 7) with three paid spots of $20 held by addr(10), addr(11) and addr(12), who each hold a USDC account. */
function cancelled(over: { paid?: number; usdc?: boolean } = {}) {
  const w = world({ status: "Cancelled", paid: over.paid ?? 3, free: 2 });
  const owners = Array.from({ length: over.paid ?? 3 }, (_, i) => addr(10 + i));
  const accounts = (over.usdc ?? true) ? owners.map((o) => w.chain.giveUsdc(o, 0n)) : [];
  const repo = new Repo([w.active]);
  const refunder = () => new BreakRefunder({ chain: w.chain, programs: PROGRAMS, repo, log: w.log });
  const usdcOf = (owner: Address) => w.chain.usdc.get(associatedTokenAddress(owner, w.config.usdcMint))?.amount;
  return { w, repo, owners, accounts, refunder, usdcOf };
}

describe("the model's refund_spot", () => {
  it("pays the spot's owner from the break's escrow, once, and nobody signs", async () => {
    const { w, owners, usdcOf } = cancelled();
    const ix = refundSpot(PROGRAMS, { breakId: 7n, index: 1, ownerUsdc: associatedTokenAddress(owners[1] as Address, w.config.usdcMint) });
    expect(ix.accounts.some((a) => a.isSigner)).toBe(false);
    expect((await w.chain.sendAndConfirm([ix])).outcome).toBe("confirmed");
    expect(usdcOf(owners[1] as Address)).toBe(20n * D);
    expect(w.chain.escrow.get(7n)).toBe(40n * D);
    expect(w.chain.spots.get(spotAddress(PROGRAMS, breakAddress(PROGRAMS, 7n), 1))?.refunded).toBe(true);
    // Not twice.
    const again = await w.chain.sendAndConfirm([ix]);
    expect(again).toMatchObject({ outcome: "failed", reason: "AlreadyRefunded" });
    expect(usdcOf(owners[1] as Address)).toBe(20n * D);
  });

  it("refuses an account that is not the owner's, and a break that is not cancelled", async () => {
    const { w, owners } = cancelled();
    const strangers = w.chain.giveUsdc(addr(99), 0n);
    const wrong = await w.chain.sendAndConfirm([refundSpot(PROGRAMS, { breakId: 7n, index: 0, ownerUsdc: strangers })]);
    expect(wrong).toMatchObject({ outcome: "failed", reason: "ConstraintTokenOwner" });
    w.chain.breaks.get(7n)!.status = "Funded";
    const ownerUsdc = associatedTokenAddress(owners[0] as Address, w.config.usdcMint);
    expect(await w.chain.sendAndConfirm([refundSpot(PROGRAMS, { breakId: 7n, index: 0, ownerUsdc })])).toMatchObject({ outcome: "failed", reason: "WrongStatus" });
  });

  it("refuses a transaction in which an account signs, as the program has no signer", async () => {
    const { w, owners } = cancelled();
    const ix = refundSpot(PROGRAMS, { breakId: 7n, index: 0, ownerUsdc: associatedTokenAddress(owners[0] as Address, w.config.usdcMint) });
    ix.accounts[3] = { ...(ix.accounts[3] as (typeof ix.accounts)[number]), isSigner: true };
    expect(await w.chain.sendAndConfirm([ix])).toMatchObject({ outcome: "failed", reason: "no account of refund_spot signs" });
  });

  it("undoes a refund when a later instruction of the same transaction fails", async () => {
    const { w, owners, usdcOf } = cancelled();
    const ix = (i: number) => refundSpot(PROGRAMS, { breakId: 7n, index: i, ownerUsdc: associatedTokenAddress(owners[i] as Address, w.config.usdcMint) });
    const r = await w.chain.sendAndConfirm([ix(0), ix(0)]);
    expect(r.outcome).toBe("failed");
    expect(usdcOf(owners[0] as Address)).toBe(0n);
    expect(w.chain.escrow.get(7n)).toBe(60n * D);
    expect(w.chain.spots.get(spotAddress(PROGRAMS, breakAddress(PROGRAMS, 7n), 0))?.refunded).toBe(false);
  });
});

describe("the refund job", () => {
  it("refunds every spot of a cancelled break to its owner's USDC account, and finishes the break on the next run", async () => {
    const { w, repo, owners, usdcOf, refunder } = cancelled();
    const [first] = await refunder().run();
    expect(first).toMatchObject({ breakId: "7", spots: 3, refunded: 0, sent: 3, done: false });
    expect(first?.details.map((d) => [d.index, d.result])).toEqual([[0, "sent"], [1, "sent"], [2, "sent"]]);
    for (const o of owners) expect(usdcOf(o)).toBe(20n * D);
    expect(w.chain.escrow.get(7n)).toBe(0n);
    expect(w.chain.applied).toEqual(["refund_spot", "refund_spot", "refund_spot"]);
    // Finished only once the chain has been read again and shows every spot refunded.
    expect(repo.statuses.get("7")).toBe("cancelled");

    const [second] = await refunder().run();
    expect(second).toMatchObject({ spots: 3, refunded: 3, sent: 0, done: true });
    expect(repo.statuses.get("7")).toBe("refunded");
    expect(w.chain.applied).toHaveLength(3);
    expect(w.errors).toEqual([]);

    // A finished break is not looked at again.
    expect(await refunder().run()).toEqual([]);
  });

  it("does not send a refund the owner already took, and finishes at once when every spot was refunded", async () => {
    const { w, repo, owners, usdcOf, refunder } = cancelled();
    for (const s of w.chain.spots.values()) s.refunded = true;
    const [r] = await refunder().run();
    expect(r).toMatchObject({ refunded: 3, sent: 0, done: true });
    expect(w.chain.applied).toEqual([]);
    expect(repo.statuses.get("7")).toBe("refunded");
    expect(usdcOf(owners[0] as Address)).toBe(0n);
  });

  it("refunds only the spots that are left", async () => {
    const { w, repo, owners, usdcOf, refunder } = cancelled();
    w.chain.spots.get(spotAddress(PROGRAMS, breakAddress(PROGRAMS, 7n), 1))!.refunded = true;
    const [r] = await refunder().run();
    expect(r?.details.map((d) => [d.index, d.result])).toEqual([[0, "sent"], [1, "already-refunded"], [2, "sent"]]);
    expect(usdcOf(owners[1] as Address)).toBe(0n);
    expect(usdcOf(owners[0] as Address)).toBe(20n * D);
    expect(repo.statuses.get("7")).toBe("cancelled");
  });

  it("finishes a break nobody joined without sending anything", async () => {
    const { w, repo, refunder } = cancelled({ paid: 0 });
    w.chain.breaks.get(7n)!.spotsSold = 0;
    const [r] = await refunder().run();
    expect(r).toMatchObject({ spots: 0, sent: 0, done: true });
    expect(repo.statuses.get("7")).toBe("refunded");
    expect(w.chain.applied).toEqual([]);
  });

  it("works while the program is paused: refunds always work", async () => {
    const { w, refunder } = cancelled();
    w.chain.config.paused = true;
    const [r] = await refunder().run();
    expect(r?.sent).toBe(3);
  });

  describe("an owner whose USDC account cannot take the money", () => {
    it("is left alone when the account does not exist (the keeper does not open it), the others are refunded, and the break stays open for the job", async () => {
      const { w, repo, owners, usdcOf, refunder } = cancelled();
      w.chain.usdc.delete(associatedTokenAddress(owners[1] as Address, w.config.usdcMint));
      const [r] = await refunder().run();
      expect(r?.sent).toBe(2);
      expect(r?.details[1]).toMatchObject({ index: 1, result: "not-sent" });
      expect(r?.details[1]?.problem).toMatch(/has no USDC account/);
      expect(w.errors).toEqual(["refunds: a spot cannot be refunded yet"]);
      expect(w.chain.escrow.get(7n)).toBe(20n * D);

      // Nothing more happens while it stays that way, and the break is not finished.
      const [again] = await refunder().run();
      expect(again).toMatchObject({ refunded: 2, sent: 0, done: false });
      expect(repo.statuses.get("7")).toBe("cancelled");

      // Once the owner has the account, the next run pays it and the one after finishes the break.
      w.chain.giveUsdc(owners[1] as Address, 0n);
      expect((await refunder().run())[0]).toMatchObject({ sent: 1, done: false });
      expect(usdcOf(owners[1] as Address)).toBe(20n * D);
      expect((await refunder().run())[0]).toMatchObject({ done: true });
      expect(repo.statuses.get("7")).toBe("refunded");
    });

    const odd = (state: number, mint?: Address, owner?: Address) => {
      const c = cancelled();
      const ata = associatedTokenAddress(c.owners[0] as Address, c.w.config.usdcMint);
      c.w.chain.usdc.delete(ata);
      const data = encodeTokenAccount({ mint: mint ?? c.w.config.usdcMint, owner: owner ?? (c.owners[0] as Address), amount: 0n });
      data[108] = state;
      c.w.chain.accounts.set(ata, data);
      return c;
    };

    it("is left alone when the account is frozen", async () => {
      const { w, refunder } = odd(2);
      const [r] = await refunder().run();
      expect(r?.details[0]).toMatchObject({ result: "not-sent" });
      expect(r?.details[0]?.problem).toMatch(/frozen/);
      expect(r?.sent).toBe(2);
      expect(w.chain.escrow.get(7n)).toBe(20n * D);
    });

    it("is left alone when the account is not initialized", async () => {
      const { refunder } = odd(0);
      expect((await refunder().run())[0]?.details[0]?.problem).toMatch(/not initialized/);
    });

    it("is left alone when the account holds another token or belongs to someone else", async () => {
      expect((await odd(1, addr(77)).refunder().run())[0]?.details[0]?.problem).toMatch(/another token/);
      expect((await odd(1, undefined, addr(78)).refunder().run())[0]?.details[0]?.problem).toMatch(/belongs to/);
    });

    it("is left alone when the address holds something that is not a token account", async () => {
      const c = cancelled();
      const ata = associatedTokenAddress(c.owners[0] as Address, c.w.config.usdcMint);
      c.w.chain.usdc.delete(ata);
      c.w.chain.accounts.set(ata, new Uint8Array(10));
      expect((await c.refunder().run())[0]?.details[0]?.problem).toMatch(/not a token account/);
    });
  });

  describe("a send that does not land", () => {
    it("is reported and tried again on the next run, and the other spots are still refunded", async () => {
      const { w, repo, owners, usdcOf, refunder } = cancelled();
      w.chain.queueSend("fail");
      const [r] = await refunder().run();
      expect(r).toMatchObject({ sent: 2, done: false });
      expect(r?.details[0]).toMatchObject({ index: 0, result: "not-sent" });
      expect(r?.details[0]?.problem).toMatch(/^failed: /);
      expect(w.errors).toEqual(["refunds: a refund did not go through"]);
      expect(usdcOf(owners[0] as Address)).toBe(0n);

      expect((await refunder().run())[0]).toMatchObject({ refunded: 2, sent: 1 });
      expect(usdcOf(owners[0] as Address)).toBe(20n * D);
      expect((await refunder().run())[0]).toMatchObject({ done: true });
      expect(repo.statuses.get("7")).toBe("refunded");
    });

    it("that was dropped is sent again, and one that landed but was not confirmed is not sent twice", async () => {
      const { w, owners, usdcOf, refunder } = cancelled();
      w.chain.queueSend("drop", "applied-unknown");
      const [r] = await refunder().run();
      expect(r?.details.map((d) => d.result)).toEqual(["not-sent", "not-sent", "sent"]);
      expect(r?.details[0]?.problem).toMatch(/^unknown: /);
      expect(usdcOf(owners[0] as Address)).toBe(0n);
      expect(usdcOf(owners[1] as Address)).toBe(20n * D);

      // The run after that reads the chain: spot 1 is refunded and is not sent again; only spot 0 is.
      const sentBefore = w.chain.sendCalls;
      const [again] = await refunder().run();
      expect(again?.details.map((d) => d.result)).toEqual(["sent", "already-refunded", "already-refunded"]);
      expect(w.chain.sendCalls - sentBefore).toBe(1);
      expect(usdcOf(owners[1] as Address)).toBe(20n * D);
    });
  });

  describe("what it refuses to act on", () => {
    it("does nothing for a break the database calls cancelled but the chain does not", async () => {
      const { w, repo, refunder } = cancelled();
      w.chain.breaks.get(7n)!.status = "Funded";
      const [r] = await refunder().run();
      expect(r?.problem).toBe("the database says cancelled but the chain says Funded");
      expect(w.chain.applied).toEqual([]);
      expect(repo.statuses.get("7")).toBe("cancelled");
      expect(w.errors).toEqual(["refunds: needs attention"]);
    });

    it("reports a break that does not exist on chain, and one with a spot that is missing, without sending anything", async () => {
      const gone = cancelled();
      gone.w.chain.breaks.clear();
      expect((await gone.refunder().run())[0]?.problem).toMatch(/does not exist on chain/);

      const hole = cancelled();
      hole.w.chain.spots.delete(spotAddress(PROGRAMS, breakAddress(PROGRAMS, 7n), 1));
      const [r] = await hole.refunder().run();
      expect(r?.problem).toBe("spot 1 of break 7 does not exist on chain");
      expect(hole.w.chain.applied).toEqual([]);
      expect(hole.repo.statuses.get("7")).toBe("cancelled");
    });

    it("reports a program that is not initialized", async () => {
      const c = cancelled();
      const lost = new BreakRefunder({ chain: { getAccountData: async (a) => (a === breakAddress(PROGRAMS, 7n) ? c.w.chain.getAccountData(a) : undefined), sendAndConfirm: c.w.chain.sendAndConfirm.bind(c.w.chain) }, programs: PROGRAMS, repo: c.repo, log: c.w.log });
      expect((await lost.run())[0]?.problem).toBe("the breaks program is not initialized");
    });
  });

  it("goes on with the next break when one fails, and only looks at breaks the database lists", async () => {
    const a = cancelled();
    const second = world({ status: "Cancelled", paid: 2, free: 2, id: 9n });
    // Both breaks live on one chain; the first one's read throws.
    const chain = a.w.chain;
    chain.breaks.set(9n, second.chain.breaks.get(9n)!);
    for (const [k, v] of second.chain.spots) chain.spots.set(k, v);
    chain.escrow.set(9n, 40n * D);
    chain.giveUsdc(addr(10), 0n);
    chain.giveUsdc(addr(11), 0n);
    const repo = new Repo([a.w.active, second.active, { id: "11", onchainId: 11n, status: "open" }]);
    repo.statuses.set("11", "open");
    const flaky = {
      getAccountData: async (x: Address) => {
        if (x === breakAddress(PROGRAMS, 7n)) throw new Error("node down");
        return chain.getAccountData(x);
      },
      sendAndConfirm: chain.sendAndConfirm.bind(chain),
    };
    const { log, errors } = logger();
    const reports = await new BreakRefunder({ chain: flaky, programs: PROGRAMS, repo, log }).run();
    expect(reports.map((r) => [r.breakId, r.problem ?? "ok", r.sent])).toEqual([["7", "node down", 0], ["9", "ok", 2]]);
    expect(errors).toEqual(["refunds: break failed"]);
  });

  it("runs as a job, and a failing refund never stops the runner", async () => {
    const { w, repo, refunder } = cancelled();
    const job = refundJob({ refunder: refunder(), intervalMs: 5_000 });
    expect(job.name).toBe("refunds");
    expect(job.intervalMs).toBe(5_000);
    const runner = createRunner([job], { now: () => new Date(1_800_000_000_000), log: w.log });
    await runner.tick();
    expect(w.chain.applied).toEqual(["refund_spot", "refund_spot", "refund_spot"]);
    expect(repo.statuses.get("7")).toBe("cancelled");
  });
});

describe("tokenAccountState", () => {
  const withState = (state: number) => {
    const data = encodeTokenAccount({ mint: addr(1), owner: addr(2), amount: 1n });
    data[108] = state;
    return data;
  };

  it("reads the state byte of a token account", () => {
    expect(tokenAccountState(withState(0))).toBe("uninitialized");
    expect(tokenAccountState(withState(1))).toBe("initialized");
    expect(tokenAccountState(withState(2))).toBe("frozen");
  });

  it("refuses a state it does not know and data that is too short", () => {
    expect(() => tokenAccountState(withState(3))).toThrow(/unknown token account state 3/);
    expect(() => tokenAccountState(new Uint8Array(164))).toThrow(/at least 165 bytes/);
  });
});
