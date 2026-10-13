// The point of the indexer: from what it stored, the eligibility planner gets exactly the list the real balances give.

import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { inputsHash, buildEligibility, treeOf } from "../src/eligibility/eligibility.js";
import { DbPublisher, SqlEligibilityPlanner } from "../src/eligibility/planner.js";
import { TokenIndexer } from "../src/indexer/indexer.js";
import { SqlIndexStore } from "../src/indexer/store.js";
import type { Sql } from "../src/packs/sql-store.js";
import { insertBreak, migratedDb } from "./support/db.js";
import { TokenLedger } from "./support/token-ledger.js";

const START = 1_800_000_000;
const END = START + 86_400;
const WINDOW = { start: START, end: END };
const POLICY = { minTwab: 100n };
const OPTIONS = { intervalSecs: 600, lagSecs: 120, settleSecs: 120, callsPerRun: 100_000, pageSize: 50 };

let db: PGlite;
let sql: Sql;

/** A break whose window is `WINDOW` and that has closed on-chain: the indexer must have the history ready for it. */
async function closedBreak(): Promise<string> {
  const id = await insertBreak(db);
  await db.query("update breaks set status = 'closed', opens_at = to_timestamp($2), closes_at = to_timestamp($3) where id = $1::bigint", [id, START, END]);
  return id;
}
beforeAll(async () => {
  db = await migratedDb();
  sql = { query: (text, params) => db.query(text, params) as never };
});
beforeEach(async () => {
  await db.exec("truncate indexed_accounts, balance_events, indexer_state, eligibility_lists, twab_snapshots, exclusions, breaks cascade");
});

describe("eligibility from indexed balances", () => {
  it("is the list the real balances give, on a busy pool where several swaps share a slot", async () => {
    const ledger = new TokenLedger(START - 5_000);
    const pool = ledger.holder("pool");
    const alice = ledger.holder("alice");
    const bob = ledger.holder("bob");
    const carol = ledger.holder("carol");
    const dave = ledger.holder("dave");

    ledger.at(START - 4_000).mintTo(pool, 10_000_000n);
    ledger.at(START - 3_000).transfer(pool, alice, 5_000n);
    // Bots and people hit the pool several times in one slot. Their signatures are in the opposite order to the swaps,
    // which is what trips up anything that sorts a slot by signature.
    for (let slot = 0; slot < 30; slot++) {
      const time = START + 100 + slot * 600;
      ledger.at(time).transfer(pool, bob, 300n, { signature: `zz-${slot}-first` });
      ledger.transfer(pool, carol, 200n, { signature: `mm-${slot}-second`, sameSlot: true });
      ledger.transfer(bob, pool, 100n, { signature: `aa-${slot}-third`, sameSlot: true });
    }
    ledger.at(START + 43_200).transfer(alice, dave, 1_500n); // dave only ever gets tokens from a holder, never the pool
    ledger.at(START + 80_000).transfer(carol, pool, 2_000n, { checked: true });

    const store = new SqlIndexStore(sql);
    const indexer = new TokenIndexer({ reader: ledger, store, log: { info() {}, error() {} }, options: { mint: ledger.mint, ...OPTIONS } });
    // The pool wallet is not a person; the project excludes it, like an LP.
    await db.query("insert into exclusions (wallet, reason_code) values ($1, 'lp_pool')", [pool.wallet]);

    const breakId = await closedBreak();
    const planner = new SqlEligibilityPlanner(sql, new DbPublisher(sql), { policy: POLICY, settleSecs: OPTIONS.settleSecs });

    // Before the indexer has run, the planner waits.
    expect((await planner.plan(breakId, WINDOW)).kind).toBe("wait");

    await indexer.run(END + 10_000);
    const plan = await planner.plan(breakId, WINDOW);
    expect(plan.kind).toBe("ready");
    if (plan.kind !== "ready") return;

    // What the books say, computed without the indexer or the database.
    const expected = buildEligibility({ events: ledger.truth, window: WINDOW, policy: POLICY, exclusions: new Map([[pool.wallet, "lp_pool"]]) });
    const tree = treeOf(expected)!;
    expect(plan.values.entryCount).toBe(expected.leaves.length);
    expect(plan.values.totalWeight).toBe(expected.totalWeight);
    expect(Buffer.from(plan.values.root).toString("hex")).toBe(Buffer.from(tree.root.hash).toString("hex"));
    // Same events, byte for byte: the published inputs hash matches the books.
    expect(Buffer.from(plan.values.inputsHash).toString("hex")).toBe(Buffer.from(inputsHash(ledger.truth, WINDOW)).toString("hex"));

    // And the numbers are what they should be for the simple holders: alice 5000 until a half-way hand-over of 1500.
    const weightOf = (wallet: string) => expected.snapshot.find((r) => r.wallet === wallet)?.weight;
    expect(weightOf(alice.wallet)).toBe((5_000n * 43_200n + 3_500n * 43_200n) / 86_400n);
    expect(weightOf(dave.wallet)).toBe((1_500n * 43_200n) / 86_400n);
    expect(expected.leaves.length).toBeGreaterThanOrEqual(4);
  });

  it("waits while the indexer has not read past the window, and does not compute from a partial history", async () => {
    const ledger = new TokenLedger(START - 5_000);
    const pool = ledger.holder("pool");
    const alice = ledger.holder("alice");
    ledger.at(START - 4_000).mintTo(pool, 1_000_000n);
    ledger.at(START - 3_000).transfer(pool, alice, 5_000n);

    const store = new SqlIndexStore(sql);
    const indexer = new TokenIndexer({ reader: ledger, store, log: { info() {}, error() {} }, options: { mint: ledger.mint, ...OPTIONS } });
    const breakId = await closedBreak();
    const planner = new SqlEligibilityPlanner(sql, new DbPublisher(sql), { policy: POLICY, settleSecs: OPTIONS.settleSecs });

    // The window has not ended yet: the claim stops short of END + settle.
    await indexer.run(END - 1_000);
    expect((await planner.plan(breakId, WINDOW)).kind).toBe("wait");
    // Just past: window end + settle + lag.
    await indexer.run(END + OPTIONS.settleSecs + OPTIONS.lagSecs - 1);
    expect((await planner.plan(breakId, WINDOW)).kind).toBe("wait");
    await indexer.run(END + OPTIONS.settleSecs + OPTIONS.lagSecs);
    expect((await planner.plan(breakId, WINDOW)).kind).toBe("ready");
  });
});
