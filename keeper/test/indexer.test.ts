import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sortEvents, type BalanceEvent } from "../src/eligibility/twab.js";
import { TokenIndexer, type IndexerOptions } from "../src/indexer/indexer.js";
import type { SignatureInfo, SignaturesQuery, TokenReader } from "../src/indexer/reader.js";
import { RpcTokenReader } from "../src/indexer/reader.js";
import { SqlIndexStore } from "../src/indexer/store.js";
import type { Logger } from "../src/job.js";
import type { Sql } from "../src/packs/sql-store.js";
import { RpcClient } from "../src/solana/rpc.js";
import { migratedDb } from "./support/db.js";
import { TokenLedger } from "./support/token-ledger.js";

const T0 = 1_800_000_000;
const LOG: Logger = { info() {}, error() {} };
const OPTIONS = { intervalSecs: 600, lagSecs: 120, settleSecs: 120, callsPerRun: 10_000, pageSize: 100 };

let db: PGlite;
let sql: Sql;
beforeAll(async () => {
  db = await migratedDb();
  sql = { query: (text, params) => db.query(text, params) as never };
});
beforeEach(async () => {
  await db.exec("truncate indexed_accounts, balance_events, indexer_state, eligibility_lists, twab_snapshots, breaks cascade");
});

function indexerFor(reader: TokenReader, mint: string, over: Partial<IndexerOptions> = {}, store = new SqlIndexStore(sql)) {
  return { store, indexer: new TokenIndexer({ reader, store, log: LOG, options: { mint, ...OPTIONS, ...over } }) };
}

async function stored(): Promise<BalanceEvent[]> {
  const { rows } = await db.query<{ signature: string; slot: string; time: string; owner: string; token_account: string; delta: string; balance_after: string }>(
    `select signature, slot::text as slot, extract(epoch from block_time)::bigint::text as time, owner, token_account, delta::text as delta, balance_after::text as balance_after
       from balance_events`,
  );
  return sortEvents(
    rows.map((r) => ({
      signature: r.signature, slot: BigInt(r.slot), time: Number(r.time), owner: r.owner,
      tokenAccount: r.token_account, delta: BigInt(r.delta), balanceAfter: BigInt(r.balance_after),
    })),
  );
}

const watermark = async () => {
  const { rows } = await db.query<{ until: string }>("select extract(epoch from indexed_until)::bigint::text as until from indexer_state where id = 1");
  return rows[0] ? Number(rows[0].until) : undefined;
};

/** Records which addresses the indexer asked about and which transactions it fetched. */
class Spy implements TokenReader {
  readonly addresses: string[] = [];
  readonly fetched: string[] = [];
  /** How many signatures each page returned, by address. */
  readonly returned = new Map<string, number[]>();
  constructor(private readonly inner: TokenReader) {}
  async signatures(address: string, query: SignaturesQuery): Promise<SignatureInfo[]> {
    this.addresses.push(address);
    const page = await this.inner.signatures(address, query);
    this.returned.set(address, [...(this.returned.get(address) ?? []), page.length]);
    return page;
  }
  transactions(signatures: readonly string[]) {
    this.fetched.push(...signatures);
    return this.inner.transactions(signatures);
  }
  reset() {
    this.addresses.length = 0;
    this.fetched.length = 0;
    this.returned.clear();
  }
}

/** A token with a pool and a few holders, including wallet-to-wallet transfers that never touch the pool. */
function market(ledger: TokenLedger) {
  const pool = ledger.holder("pool");
  const a = ledger.holder("a");
  const b = ledger.holder("b");
  const c = ledger.holder("c");
  ledger.at(T0 + 10);
  ledger.mintTo(pool, 1_000_000n);
  ledger.at(T0 + 100).transfer(pool, a, 5_000n);
  ledger.at(T0 + 200).transfer(pool, b, 7_000n);
  ledger.at(T0 + 300).transfer(a, c, 1_000n); // c is only reachable through a
  ledger.at(T0 + 400).transfer(c, b, 400n);
  ledger.at(T0 + 500).transfer(b, pool, 100n, { checked: true });
  return { pool, a, b, c };
}

describe("SqlIndexStore", () => {
  const event = (i: number, over: Partial<BalanceEvent> = {}): BalanceEvent => ({
    signature: `s${i}`, slot: BigInt(i), time: T0 + i, owner: "w", tokenAccount: "t", delta: 1n, balanceAfter: BigInt(i + 1), ...over,
  });

  it("stores the same events twice without duplicating them", async () => {
    const store = new SqlIndexStore(sql);
    await store.addEvents([event(1), event(2)]);
    await store.addEvents([event(1), event(2), event(3)]);
    expect((await stored()).map((e) => e.signature)).toEqual(["s1", "s2", "s3"]);
  });

  it("stores a large batch, in several statements, without splitting a transaction's events", async () => {
    const events: BalanceEvent[] = [];
    for (let i = 0; i < 700; i++) {
      events.push(event(i, { tokenAccount: `a${i}`, delta: -1n, balanceAfter: 0n }));
      events.push(event(i, { tokenAccount: `b${i}`, delta: 1n, balanceAfter: 1n }));
    }
    const statements: string[] = [];
    const counting: Sql = { query: (text, params) => (statements.push(text), sql.query(text, params)) };
    await new SqlIndexStore(counting).addEvents(events);
    expect(statements.length).toBeGreaterThan(1);
    const rows = await stored();
    expect(rows).toHaveLength(1400);
  });

  it("keeps the same signature and token account for two owners (a change of owner)", async () => {
    const store = new SqlIndexStore(sql);
    await store.addEvents([event(1, { owner: "old", delta: -5n, balanceAfter: 0n }), event(1, { owner: "new", delta: 5n, balanceAfter: 5n })]);
    expect((await stored()).map((e) => e.owner)).toEqual(["new", "old"]);
  });
});

describe("TokenIndexer", () => {
  it("stores every transfer of the token, including the ones between holders that never touch the pool", async () => {
    const ledger = new TokenLedger(T0);
    market(ledger);
    const { indexer } = indexerFor(ledger, ledger.mint);
    await indexer.run(T0 + 10_000);
    expect(await stored()).toEqual(sortEvents(ledger.truth));
    expect(ledger.truth.length).toBeGreaterThanOrEqual(11);
  });

  it("claims only what is safely final: its start time minus the lag", async () => {
    const ledger = new TokenLedger(T0);
    market(ledger);
    const { indexer } = indexerFor(ledger, ledger.mint);
    const report = await indexer.run(T0 + 10_000);
    expect(report.indexedUntil).toBe(T0 + 10_000 - OPTIONS.lagSecs);
    expect(await watermark()).toBe(T0 + 10_000 - OPTIONS.lagSecs);
  });

  it("reads long histories page by page", async () => {
    const ledger = new TokenLedger(T0);
    const pool = ledger.holder("pool");
    const alice = ledger.holder("alice");
    ledger.mintTo(pool, 1_000_000n);
    for (let i = 0; i < 25; i++) ledger.at(T0 + 10 * i).transfer(pool, alice, 10n);
    const spy = new Spy(ledger);
    const { indexer } = indexerFor(spy, ledger.mint, { pageSize: 4 });
    await indexer.run(T0 + 10_000);
    expect(await stored()).toEqual(sortEvents(ledger.truth));
    expect(spy.addresses.filter((a) => a === pool.account).length).toBeGreaterThanOrEqual(7);
  });

  it("fetches a transaction two accounts share only once, and never a failed one", async () => {
    const ledger = new TokenLedger(T0);
    const { pool, a } = market(ledger);
    const failed = ledger.at(T0 + 600).fail(pool, a);
    const spy = new Spy(ledger);
    const { indexer } = indexerFor(spy, ledger.mint);
    await indexer.run(T0 + 10_000);
    expect(new Set(spy.fetched).size).toBe(spy.fetched.length);
    expect(spy.fetched).not.toContain(failed);
  });

  it("reads a version 0 transaction whose accounts come from a lookup table", async () => {
    const ledger = new TokenLedger(T0);
    const pool = ledger.holder("pool");
    const alice = ledger.holder("alice");
    ledger.mintTo(pool, 100n);
    ledger.at(T0 + 50).transfer(pool, alice, 30n, { v0: true });
    const { indexer } = indexerFor(ledger, ledger.mint);
    await indexer.run(T0 + 10_000);
    expect(await stored()).toEqual(sortEvents(ledger.truth));
  });

  it("keeps a change of owner as two rows on the same token account", async () => {
    const ledger = new TokenLedger(T0);
    const pool = ledger.holder("pool");
    const alice = ledger.holder("alice");
    const bob = ledger.holder("bob");
    ledger.mintTo(pool, 100n);
    ledger.at(T0 + 50).transfer(pool, alice, 30n);
    ledger.at(T0 + 60).setOwner(alice, bob.wallet);
    const { indexer } = indexerFor(ledger, ledger.mint);
    await indexer.run(T0 + 10_000);
    const rows = await stored();
    expect(rows).toEqual(sortEvents(ledger.truth));
    expect(rows.filter((e) => e.tokenAccount === alice.account && e.delta < 0n).map((e) => e.owner)).toEqual([alice.wallet]);
  });

  it("stores events of several transactions on one token account in one slot, whatever their signatures", async () => {
    const ledger = new TokenLedger(T0);
    const pool = ledger.holder("pool");
    const alice = ledger.holder("alice");
    ledger.mintTo(pool, 1_000n);
    // Real order: z first, then a; sorted by signature they would be the other way round.
    ledger.at(T0 + 50).transfer(pool, alice, 100n, { signature: "z-first" });
    ledger.transfer(pool, alice, 50n, { signature: "a-second", sameSlot: true });
    const { indexer } = indexerFor(ledger, ledger.mint);
    await indexer.run(T0 + 10_000);
    expect(await stored()).toEqual(sortEvents(ledger.truth));
  });

  it("ends in the same state however a run is cut short: the node failing at any call", async () => {
    // Count the calls of a clean run first.
    const clean = new TokenLedger(T0);
    market(clean);
    await indexerFor(clean, clean.mint).indexer.run(T0 + 10_000);
    const total = clean.calls.signatures + clean.calls.transactions;
    expect(total).toBeGreaterThan(8);

    for (let failAt = 1; failAt <= total; failAt++) {
      await db.exec("truncate indexed_accounts, balance_events, indexer_state");
      const ledger = new TokenLedger(T0);
      market(ledger);
      const { indexer } = indexerFor(ledger, ledger.mint);
      ledger.failOnCall(failAt);
      await expect(indexer.run(T0 + 10_000), `failing at call ${failAt}`).rejects.toThrow("node down");
      await indexer.run(T0 + 10_000);
      expect(await stored(), `failing at call ${failAt}`).toEqual(sortEvents(ledger.truth));
      expect(await watermark()).toBe(T0 + 10_000 - OPTIONS.lagSecs);
    }
  });

  it("loses nothing when the database fails after the accounts are noted but before the events are stored", async () => {
    const ledger = new TokenLedger(T0);
    market(ledger);
    class Flaky extends SqlIndexStore {
      failures = 1;
      override async addEvents(events: readonly BalanceEvent[]) {
        if (events.length > 0 && this.failures-- > 0) throw new Error("database down");
        return super.addEvents(events);
      }
    }
    const { indexer } = indexerFor(ledger, ledger.mint, {}, new Flaky(sql));
    await expect(indexer.run(T0 + 10_000)).rejects.toThrow("database down");
    await indexer.run(T0 + 10_000);
    expect(await stored()).toEqual(sortEvents(ledger.truth));
  });

  it("loses no account when the database fails while the accounts are being noted", async () => {
    // d is only ever named together with c, so it is found only if c is read, and c is only named in one transaction
    // together with a. If that transaction's events were stored before c was noted, a rerun would skip it and c, then d, would never be read.
    const ledger = new TokenLedger(T0);
    const pool = ledger.holder("pool");
    const a = ledger.holder("a");
    const c = ledger.holder("c");
    const d = ledger.holder("d");
    ledger.at(T0 + 10).mintTo(pool, 1_000n);
    ledger.at(T0 + 20).transfer(pool, a, 100n);
    ledger.at(T0 + 30).transfer(a, c, 60n);
    ledger.at(T0 + 40).transfer(c, d, 25n);
    class Flaky extends SqlIndexStore {
      failures = 2;
      override async addAccounts(addresses: readonly string[]) {
        if (addresses.includes(c.account) && this.failures-- > 0) throw new Error("database down");
        return super.addAccounts(addresses);
      }
    }
    const { indexer } = indexerFor(ledger, ledger.mint, {}, new Flaky(sql));
    await expect(indexer.run(T0 + 10_000)).rejects.toThrow("database down");
    await expect(indexer.run(T0 + 10_000)).rejects.toThrow("database down");
    await indexer.run(T0 + 10_000);
    expect(await stored()).toEqual(sortEvents(ledger.truth));
    expect(ledger.truth.some((e) => e.tokenAccount === d.account)).toBe(true);
  });

  it("spreads the work over runs when the call budget is small, and claims nothing until everything has been read", async () => {
    const ledger = new TokenLedger(T0);
    market(ledger);
    const { indexer } = indexerFor(ledger, ledger.mint, { callsPerRun: 3 });
    const first = await indexer.run(T0 + 10_000);
    expect(first.steps).toBeGreaterThan(0);
    expect(first.indexedUntil).toBeUndefined();
    expect(await watermark()).toBeUndefined();

    let runs = 1;
    let last = first;
    while (last.indexedUntil === undefined && runs < 100) {
      last = await indexer.run(T0 + 10_000);
      runs += 1;
    }
    expect(runs).toBeGreaterThan(2);
    expect(last.indexedUntil).toBe(T0 + 10_000 - OPTIONS.lagSecs);
    expect(await stored()).toEqual(sortEvents(ledger.truth));
  });

  describe("later passes", () => {
    it("do nothing before the interval has passed", async () => {
      const ledger = new TokenLedger(T0);
      market(ledger);
      const spy = new Spy(ledger);
      const { indexer } = indexerFor(spy, ledger.mint);
      await indexer.run(T0 + 10_000);
      spy.reset();
      const again = await indexer.run(T0 + 10_000 + OPTIONS.intervalSecs - 1);
      expect(again.steps).toBe(0);
      expect(spy.addresses).toEqual([]);
    });

    it("read only what is new, and move the watermark on", async () => {
      const ledger = new TokenLedger(T0);
      const { pool, a } = market(ledger);
      const spy = new Spy(ledger);
      const { indexer } = indexerFor(spy, ledger.mint);
      await indexer.run(T0 + 10_000);
      spy.reset();

      const fresh = ledger.at(T0 + 10_100).transfer(pool, a, 77n);
      await indexer.run(T0 + 10_000 + OPTIONS.intervalSecs + 1);
      expect(spy.fetched).toEqual([fresh]);
      // The pool's page holds only the new transaction: the pass stops where the last one ended.
      expect(spy.returned.get(pool.account)).toEqual([1]);
      expect(await stored()).toEqual(sortEvents(ledger.truth));
      expect(await watermark()).toBe(T0 + 10_000 + OPTIONS.intervalSecs + 1 - OPTIONS.lagSecs);
    });

    it("leave an account that holds nothing alone until a transaction gives it tokens again", async () => {
      const ledger = new TokenLedger(T0);
      const pool = ledger.holder("pool");
      const alice = ledger.holder("alice");
      ledger.at(T0 + 1).mintTo(pool, 1_000n);
      ledger.at(T0 + 2).transfer(pool, alice, 100n);
      ledger.at(T0 + 3).transfer(alice, pool, 100n); // alice is empty now
      const spy = new Spy(ledger);
      const { indexer } = indexerFor(spy, ledger.mint);
      let now = T0 + 10_000;
      await indexer.run(now);
      expect(spy.addresses).toContain(alice.account);

      spy.reset();
      now += OPTIONS.intervalSecs + 1;
      ledger.at(now - 50).transfer(pool, ledger.holder("carol"), 1n);
      await indexer.run(now);
      expect(spy.addresses).not.toContain(alice.account);

      // She gets tokens again: the pool's pass finds it, and then she is read as well.
      spy.reset();
      now += OPTIONS.intervalSecs + 1;
      ledger.at(now - 50).transfer(pool, alice, 5n);
      await indexer.run(now);
      expect(spy.addresses).toContain(alice.account);
      const sends = ledger.at(now - 40).transfer(alice, pool, 5n);
      spy.reset();
      now += OPTIONS.intervalSecs + 1;
      await indexer.run(now);
      expect(spy.fetched).toContain(sends);
      expect(await stored()).toEqual(sortEvents(ledger.truth));
    });

    it("hold the watermark while an account that was just found has not been read yet", async () => {
      const ledger = new TokenLedger(T0);
      const { pool } = market(ledger);
      const { indexer } = indexerFor(ledger, ledger.mint, { callsPerRun: 2 });
      // Read everything first, with a bigger budget.
      const big = indexerFor(ledger, ledger.mint, { callsPerRun: 10_000 }).indexer;
      await big.run(T0 + 10_000);
      const before = await watermark();
      expect(before).toBe(T0 + 10_000 - OPTIONS.lagSecs);

      // A transfer to a brand-new account, then a run that only has the budget to read the pool.
      const newcomer = ledger.holder("newcomer");
      ledger.at(T0 + 10_100).transfer(pool, newcomer, 9n);
      const later = T0 + 10_000 + OPTIONS.intervalSecs + 1;
      const partial = await indexer.run(later);
      expect(partial.indexedUntil).toBe(before);

      let last = partial;
      for (let i = 0; i < 50 && last.indexedUntil === before; i++) last = await indexer.run(later);
      expect(last.indexedUntil).toBe(later - OPTIONS.lagSecs);
      expect(await stored()).toEqual(sortEvents(ledger.truth));
    });

    it("never move the watermark back", async () => {
      const ledger = new TokenLedger(T0);
      market(ledger);
      await db.query("insert into indexer_state (id, indexed_until) values (1, to_timestamp($1))", [T0 + 999_999]);
      const { indexer } = indexerFor(ledger, ledger.mint);
      await indexer.run(T0 + 10_000);
      expect(await watermark()).toBe(T0 + 999_999);
    });
  });

  describe("a break waiting for its eligibility list", () => {
    const insertBreak = (closesAt: number, status = "closed") =>
      db.query<{ id: string }>(
        `insert into breaks (status, paid_spots, free_spots, spot_price, pack_machine, max_pack_price, opens_at, closes_at)
         values ($1, 10, 2, 20000000, 'm', 25000000, to_timestamp($2), to_timestamp($3)) returning id::text as id`,
        [status, closesAt - 43_200, closesAt],
      );

    it("makes the indexer read at once, as soon as the window end plus the settle time is safely past", async () => {
      const ledger = new TokenLedger(T0);
      const { pool, a } = market(ledger);
      const spy = new Spy(ledger);
      const { indexer } = indexerFor(spy, ledger.mint);
      await indexer.run(T0 + 10_000);

      const closesAt = T0 + 10_300;
      await insertBreak(closesAt);
      ledger.at(T0 + 10_310).transfer(pool, a, 5n);
      spy.reset();

      // Not yet: the window end + settle (120 s) + lag (120 s) is not past.
      expect((await indexer.run(closesAt + OPTIONS.settleSecs + OPTIONS.lagSecs - 1)).steps).toBe(0);
      // Now it is, though far less than `intervalSecs` after the last pass.
      const now = closesAt + OPTIONS.settleSecs + OPTIONS.lagSecs;
      expect(now - (T0 + 10_000)).toBeLessThan(OPTIONS.intervalSecs);
      const report = await indexer.run(now);
      expect(report.steps).toBeGreaterThan(0);
      expect(report.indexedUntil).toBeGreaterThanOrEqual(closesAt + OPTIONS.settleSecs);
      expect(await stored()).toEqual(sortEvents(ledger.truth));
    });

    it("is not hurried by a break that already has its list or that is not on chain yet", async () => {
      const ledger = new TokenLedger(T0);
      market(ledger);
      const { indexer } = indexerFor(ledger, ledger.mint);
      await indexer.run(T0 + 10_000);

      await insertBreak(T0 + 10_300, "scheduled");
      const done = await insertBreak(T0 + 10_300, "closed");
      await db.query("insert into eligibility_lists (break_id, root, total_weight, entry_count, inputs_hash, list_uri, inputs_uri) values ($1, $2, 0, 0, $2, 'u', 'u')", [
        done.rows[0]!.id,
        new Uint8Array(32),
      ]);
      const now = T0 + 10_300 + OPTIONS.settleSecs + OPTIONS.lagSecs + 5;
      expect((await indexer.run(now)).steps).toBe(0);
    });
  });

  it("refuses to store anything from a transaction it cannot read exactly", async () => {
    const ledger = new TokenLedger(T0);
    market(ledger);
    const noTime: TokenReader = {
      signatures: (a, q) => ledger.signatures(a, q),
      transactions: async (s) => (await ledger.transactions(s)).map((t) => ({ ...t, blockTime: null })),
    };
    const { indexer } = indexerFor(noTime, ledger.mint);
    await expect(indexer.run(T0 + 10_000)).rejects.toThrow(/no block time/);
    expect(await stored()).toEqual([]);
    expect(await watermark()).toBeUndefined();
  });

  it("gives the same result through the JSON-RPC reader as directly", async () => {
    const ledger = new TokenLedger(T0);
    market(ledger);
    const reader = new RpcTokenReader(new RpcClient({ url: "http://node", fetch: ledger.node() }));
    const { indexer } = indexerFor(reader, ledger.mint);
    await indexer.run(T0 + 10_000);
    expect(await stored()).toEqual(sortEvents(ledger.truth));
    expect(ledger.requests.every((r) => (r.params[1] as { commitment: string }).commitment === "finalized")).toBe(true);
  });

  it("does not claim transactions that are not final yet", async () => {
    const ledger = new TokenLedger(T0);
    const { pool, a } = market(ledger);
    const { indexer } = indexerFor(ledger, ledger.mint);
    await indexer.run(T0 + 10_000);

    // A transaction older than the claim but finalized late would be missed: the lag must be longer than finalization.
    // Here the node has not finalized the newest slots; they are simply read on the pass after they finalize.
    ledger.at(T0 + 10_100).transfer(pool, a, 11n);
    ledger.finalizedSlot = 0;
    const now = T0 + 10_000 + OPTIONS.intervalSecs + 1;
    await indexer.run(now);
    expect((await stored()).some((e) => e.time === T0 + 10_100)).toBe(false);

    ledger.finalizedSlot = Number.POSITIVE_INFINITY;
    await indexer.run(now + OPTIONS.intervalSecs + 1);
    expect(await stored()).toEqual(sortEvents(ledger.truth));
  });
});
