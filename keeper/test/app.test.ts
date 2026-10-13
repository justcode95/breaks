import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { type AppConfig, buildJobs, checkSchema, sqlFromPool, verifyKeeperIdentity } from "../src/app.js";
import { assignCards } from "../src/draw/pool.js";
import { createRunner } from "../src/job.js";
import { ORAO_PROGRAM, requestAddress } from "../src/solana/breaks.js";
import { addressToBytes } from "../src/solana/pubkey.js";
import { addr } from "./support/chain.js";
import { insertBreak, migratedDb } from "./support/db.js";
import { ANSWER, KEEPER, PROGRAMS, logger, world } from "./support/world.js";

const config: AppConfig = {
  programs: PROGRAMS,
  vrf: { program: ORAO_PROGRAM, treasury: addr(0xa2) },
  packProvider: "mock",
  cardTransfer: "mock",
  mockPackPrice: 25_000_000n,
  jobIntervalMs: 1000,
};

describe("sqlFromPool", () => {
  it("passes the query and its parameters through and returns the rows", async () => {
    const calls: [string, unknown[] | undefined][] = [];
    const sql = sqlFromPool({
      query: async (text, params) => {
        calls.push([text, params]);
        return { rows: [{ n: "1" }] };
      },
    });
    expect(await sql.query("select $1", [5])).toEqual({ rows: [{ n: "1" }] });
    expect(calls).toEqual([["select $1", [5]]]);
  });
});

// One migrated database for every test that only reads from it.
let shared: PGlite;
beforeAll(async () => {
  shared = await migratedDb();
});

describe("checkSchema", () => {
  it("accepts a database with every migration", async () => {
    expect(await checkSchema(shared)).toEqual([]);
  });

  it("names what an empty database lacks", async () => {
    const problems = await checkSchema(new PGlite());
    expect(problems).toContain("table breaks is missing (migration 0001)");
    expect(problems).toContain("table packs is missing (migration 0001)");
    expect(problems).toContain("deliveries.adopted is missing (migration 0003)");
  });

  it("names the migrations an older database still needs", async () => {
    const dir = join(import.meta.dirname, "..", "..", "db", "migrations");
    const old = new PGlite();
    await old.exec(readFileSync(join(dir, readdirSync(dir).sort()[0] as string), "utf8")); // only 0001
    const problems = await checkSchema(old);
    expect(problems).toEqual([
      "packs.expiry is missing (migration 0002)",
      "pack_attempts.signature is missing (migration 0002)",
      "deliveries.adopted is missing (migration 0003)",
      "delivery_attempts.signature is missing (migration 0003)",
      "breaks.status does not accept 'drawn' (migration 0004)",
    ]);
  });
});

describe("verifyKeeperIdentity", () => {
  it("is true when the key is the program's keeper", async () => {
    const w = world();
    expect(await verifyKeeperIdentity(w.chain, { programs: PROGRAMS }, KEEPER)).toBe(true);
  });

  it("refuses a key the program does not expect", async () => {
    const w = world();
    await expect(verifyKeeperIdentity(w.chain, { programs: PROGRAMS }, addr(99))).rejects.toThrow(/expects .* as its keeper/);
  });

  it("is false, not an error, when the program is not initialized yet", async () => {
    const w = world();
    const other = { programs: { breaks: addr(1), treasury: addr(2) } };
    expect(await verifyKeeperIdentity(w.chain, other, KEEPER)).toBe(false);
  });
});

describe("buildJobs", () => {
  it("refuses a database that is not ready, before any job exists", async () => {
    const w = world();
    await expect(buildJobs(config, { sql: new PGlite(), chain: w.chain, keeper: KEEPER, log: logger().log })).rejects.toThrow(/the database is not ready: table breaks is missing/);
  });

  it("refuses the wrong key", async () => {
    const w = world();
    await expect(buildJobs(config, { sql: shared, chain: w.chain, keeper: addr(99), log: logger().log })).rejects.toThrow(/expects/);
  });

  it("still builds the jobs when the program is not initialized yet, and says so", async () => {
    const w = world();
    const { log, errors } = logger();
    const jobs = await buildJobs({ ...config, programs: { breaks: addr(1), treasury: addr(2) } }, { sql: shared, chain: w.chain, keeper: KEEPER, log });
    expect(jobs.map((j) => j.name)).toEqual(["pipeline", "pack-buyer", "delivery"]);
    expect(errors).toEqual(["the breaks program is not initialized on this cluster; breaks will be reported as problems until it is"]);
  });

  it("says that the providers are mocks", async () => {
    const w = world();
    const { log, infos } = logger();
    await buildJobs(config, { sql: shared, chain: w.chain, keeper: KEEPER, log });
    expect(infos).toContain("MOCK pack provider and MOCK card transfer: no real packs are bought and no real cards move");
  });
});

describe("the jobs, run by the real runner", () => {
  
  it("take a funded break to delivered, with every table filled in", async () => {
    const db = shared;
    const w = world();
    const { log, errors } = logger();

    // The database knows the break (created by the scheduler, later) and the eligibility list the pipeline will use.
    const id = await insertBreak(db);
    await db.query("update breaks set onchain_id = 7, status = 'funded' where id = $1::bigint", [id]);
    for (const leaf of w.leaves) {
      await db.query("insert into twab_snapshots (break_id, wallet, twab, weight, eligible) values ($1, $2, $3, $3, true)", [id, addressOf(leaf.wallet), leaf.weight]);
    }

    const jobs = await buildJobs(config, { sql: db, chain: w.chain, keeper: KEEPER, log, now: w.clock.now });
    let clock = 1_800_040_000_000;
    const runner = createRunner(jobs, { now: () => new Date(clock), log });
    const tick = async () => {
      await runner.tick();
      clock += 1000;
    };
    const status = async () => (await db.query<{ status: string }>("select status from breaks where id = $1::bigint", [id])).rows[0]?.status;

    // 1. The pack buyer buys the packs; the pipeline waits for them.
    await tick();
    const packs = await db.query<{ status: string }>("select status from packs where break_id = $1::bigint", [id]);
    expect(packs.rows).toHaveLength(5);
    expect(packs.rows.every((r) => r.status === "pulled")).toBe(true);

    // 2. Next tick: the pool is committed and randomness asked for.
    await tick();
    expect(w.chain.applied).toEqual(["commit_pool", "request_randomness"]);
    expect(await status()).toBe("randomness_requested");

    // 3. ORAO answers; the pipeline settles and records the free winners.
    w.chain.fulfill(requestAddress(ORAO_PROGRAM, w.chain.breaks.get(7n)!.randomnessRequestId), ANSWER);
    await tick();
    expect(await status()).toBe("drawn");

    // 4. The deliverer sends every card; the break is marked delivered.
    await tick();
    await tick();
    expect(await status()).toBe("delivered");
    expect(errors).toEqual([]);

    // Every card went to the wallet the draw assigned it.
    const b = w.chain.breaks.get(7n)!;
    const owners = [10, 11, 12].map((n) => addr(n));
    const winners = b.freeWinners.slice(0, 2).map((x) => x.wallet);
    const cards = (await db.query<{ card_mint: string }>("select card_mint from packs where break_id = $1::bigint", [id])).rows.map((r) => r.card_mint);
    const expected = assignCards(b.seed, cards.map(addressToBytes), owners, winners);
    const delivered = await db.query<{ kind: string; idx: number; recipient: string; card_mint: string; status: string; tx_sig: string | null }>(
      `select s.kind, s.idx, d.recipient, d.card_mint, d.status, d.tx_sig from deliveries d join spots s on s.id = d.spot_id
        where d.break_id = $1::bigint order by case s.kind when 'paid' then 0 else 1 end, s.idx`,
      [id],
    );
    expect(delivered.rows.map((r) => r.recipient)).toEqual([...owners, ...winners]);
    expect(delivered.rows.map((r) => addressToBytes(r.card_mint))).toEqual(expected.map((e) => e.card));
    expect(delivered.rows.every((r) => r.status === "confirmed" && r.tx_sig)).toBe(true);

    // The spots copied from the chain are there for the website to read.
    const spots = await db.query<{ kind: string; idx: number; wallet: string; paid: string | null }>(
      "select kind, idx, wallet, paid::text as paid from spots where break_id = $1::bigint order by case kind when 'paid' then 0 else 1 end, idx",
      [id],
    );
    expect(spots.rows.map((s) => [s.kind, s.idx, s.wallet, s.paid])).toEqual([
      ["paid", 0, addr(10), "20000000"],
      ["paid", 1, addr(11), "20000000"],
      ["paid", 2, addr(12), "20000000"],
      ["free", 0, winners[0], null],
      ["free", 1, winners[1], null],
    ]);

    // And a finished break is left alone.
    const sends = w.chain.sendCalls;
    await tick();
    await tick();
    expect(w.chain.sendCalls).toBe(sends);
  });
});

function addressOf(bytes: Uint8Array): string {
  return addr(bytes[0] as number);
}
