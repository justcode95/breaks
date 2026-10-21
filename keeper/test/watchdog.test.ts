import { describe, expect, it } from "vitest";
import type { ActiveBreak } from "../src/pipeline/pipeline.js";
import { type BreakAccount, ORAO_PROGRAM, breakAddress, configAddress, oraoNetworkState } from "../src/solana/breaks.js";
import type { Address } from "../src/solana/pubkey.js";
import { keeperSolNeed } from "../src/solana/rent.js";
import type { AlertMessage, Alerter } from "../src/watch/alerter.js";
import type { Heartbeat } from "../src/watch/heartbeat.js";
import { JobHealth } from "../src/watch/health.js";
import { SqlWatchStore, Watchdog, type WatchStore, watchdogJob } from "../src/watch/watchdog.js";
import { scrubber } from "../src/doctor/report.js";
import { sol } from "../src/setup/run.js";
import { encodeBreak, encodeBreaksConfig, encodeNetworkState } from "./support/accounts.js";
import { addr } from "./support/chain.js";
import { insertBreak, migratedDb } from "./support/db.js";
import { KEEPER, PROGRAMS, logger, world } from "./support/world.js";

const MIN = 60_000;
const T0 = 1_800_100_000_000;
const ORAO_FEE = 1_500_000n;

/** Accounts and SOL balances, and a switch that makes every read fail. */
class PretendChain {
  readonly accounts = new Map<Address, Uint8Array>();
  readonly sol = new Map<Address, bigint>();
  down: string | undefined;
  async getAccountData(a: Address) {
    if (this.down) throw new Error(this.down);
    return this.accounts.get(a);
  }
  async lamports(a: Address) {
    if (this.down) throw new Error(this.down);
    return this.sol.get(a) ?? 0n;
  }
}

class MemoryWatchStore implements WatchStore {
  active: ActiveBreak[] = [];
  delivered = new Map<string, number>();
  down: string | undefined;
  countDown: string | undefined;
  async activeBreaks() {
    if (this.down) throw new Error(this.down);
    return this.active;
  }
  async deliveredCount(id: string) {
    if (this.countDown) throw new Error(this.countDown);
    return this.delivered.get(id) ?? 0;
  }
}

class Recorder implements Alerter {
  readonly sent: AlertMessage[] = [];
  failing: string | undefined;
  constructor(readonly name = "recorder") {}
  async send(m: AlertMessage) {
    if (this.failing) throw new Error(this.failing);
    this.sent.push(m);
  }
  /** Every text sent since the last call. */
  take(): string[] {
    return this.sent.splice(0).map((m) => m.text);
  }
}

function setup(over: { secrets?: string[] } = {}) {
  const w = world();
  const chain = new PretendChain();
  const config = { ...w.config };
  const putConfig = (c: Partial<typeof config> = {}) => chain.accounts.set(configAddress(PROGRAMS), encodeBreaksConfig({ ...config, ...c }));
  putConfig();
  chain.accounts.set(
    oraoNetworkState(ORAO_PROGRAM),
    encodeNetworkState({ authority: addr(0xa0), treasury: addr(0xa2), requestFee: ORAO_FEE, fulfillmentAuthorities: [addr(0xa3)], numReceived: 1n }),
  );
  chain.sol.set(KEEPER, 5_000_000_000n);
  const store = new MemoryWatchStore();
  const putBreak = (id: bigint, b: Partial<BreakAccount>, dbId = String(id + 100n)) => {
    chain.accounts.set(breakAddress(PROGRAMS, id), encodeBreak({ ...w.b, id, ...b }));
    if (!store.active.some((a) => a.onchainId === id)) store.active.push({ id: dbId, onchainId: id, status: "funded" });
  };
  let t = T0;
  const clock = {
    now: () => new Date(t),
    advance: (ms: number) => (t += ms),
  };
  const health = new JobHealth();
  const recorder = new Recorder();
  const { errors, infos } = logger();
  const fields: Record<string, unknown>[] = [];
  const log = {
    info: (m: string) => void infos.push(m),
    error: (m: string, e?: Record<string, unknown>) => {
      errors.push(m);
      if (e) fields.push(e);
    },
  };
  const watchdog = new Watchdog({
    chain,
    wallets: chain,
    keeper: KEEPER,
    programs: PROGRAMS,
    vrfProgram: ORAO_PROGRAM,
    freeSpots: 2,
    store,
    jobs: health,
    limits: { afterMs: 15 * MIN, settleSecs: 120 },
    channels: [recorder],
    title: "BREAKS keeper on devnet",
    repeatMs: 12 * 60 * MIN,
    scrub: scrubber(over.secrets ?? []),
    log,
    now: clock.now,
  });
  return { w, chain, store, putBreak, putConfig, clock, health, recorder, watchdog, errors, infos, fields };
}

/** A setup whose greeting has been sent, so tests only see what they are about. */
async function started(over: Parameters<typeof setup>[0] = {}) {
  const s = setup(over);
  await s.watchdog.run();
  expect(s.recorder.take()).toEqual(["BREAKS keeper on devnet started. A problem that lasts is reported here once, and again when it clears."]);
  return s;
}

describe("Watchdog", () => {
  it("says it started, and then nothing while all is well", async () => {
    const s = await started();
    s.putBreak(4n, { status: "Funded" });
    s.clock.advance(14 * MIN);
    await s.watchdog.run();
    expect(s.recorder.take()).toEqual([]);
  });

  it("reports a break stuck in a stage once, and clears it when it moves on (and a new stage that sticks is new)", async () => {
    const s = await started();
    s.putBreak(4n, { status: "Funded" });
    await s.watchdog.run(); // first sighting
    s.clock.advance(15 * MIN);
    await s.watchdog.run();
    expect(s.recorder.sent.at(-1)?.urgent).toBe(true);
    expect(s.recorder.take()).toEqual([
      "BREAKS keeper on devnet: 1 new problem.\nNew:\n• Break #5 has been funded for at least 15 min and its pool is not committed: the packs are not all bought and pulled, or commit_pool has not landed (see the keeper's log).",
    ]);
    s.clock.advance(MIN);
    await s.watchdog.run();
    expect(s.recorder.take()).toEqual([]);

    // It moves on: the old stage clears at once, the new one has its own time.
    s.putBreak(4n, { status: "PoolCommitted" });
    await s.watchdog.run();
    expect(s.recorder.sent.at(-1)?.urgent).toBe(false);
    expect(s.recorder.take()).toEqual([
      "BREAKS keeper on devnet: 1 cleared.\nCleared:\n• Break #5 has been funded for at least 16 min and its pool is not committed: the packs are not all bought and pulled, or commit_pool has not landed (see the keeper's log).",
    ]);
    s.clock.advance(15 * MIN);
    await s.watchdog.run();
    expect(s.recorder.take()).toEqual([
      "BREAKS keeper on devnet: 1 new problem.\nNew:\n• Break #5's pool has been committed for at least 15 min and no randomness has been asked for (see the keeper's log).",
    ]);

    // Done (delivered, cancelled or refunded): the database no longer lists it, and its alert clears.
    s.store.active = [];
    await s.watchdog.run();
    expect(s.recorder.take()[0]).toContain("1 cleared");
  });

  it("uses the chain's times where it has them, so a restart does not delay those alerts", async () => {
    const s = await started();
    const now = BigInt(T0 / 1000);
    s.putBreak(1n, { status: "Open", closesAt: now - 16n * 60n });
    s.putBreak(2n, { status: "Drawn", seededAt: now - 3600n, poolSize: 5 });
    s.store.delivered.set("102", 3);
    await s.watchdog.run();
    expect(s.recorder.take()).toEqual([
      [
        "BREAKS keeper on devnet: 2 new problems.",
        "New:",
        "• Break #2's sale ended 16 min ago and it is still open on chain: close_break has not landed (see the keeper's log).",
        "• Break #3 was drawn 1 h ago and 3 of its 5 cards are delivered (see the keeper's log). Every card was pulled before the draw, so Collector Crypt's sellback window, about 72 hours from the pull (not confirmed yet), ends within 2 days 23 h.",
      ].join("\n"),
    ]);
  });

  it("reports a break the chain does not have", async () => {
    const s = await started();
    s.store.active.push({ id: "100", onchainId: 9n, status: "funded" });
    await s.watchdog.run();
    s.clock.advance(15 * MIN);
    await s.watchdog.run();
    expect(s.recorder.take()[0]).toContain("Break #10 is in the keeper's database but has no account on chain");
  });

  it("reports a pause and a keeper short of SOL at once, and clears them", async () => {
    const s = await started();
    s.putConfig({ paused: true });
    const need = keeperSolNeed(2, ORAO_FEE);
    s.chain.sol.set(KEEPER, need.cycle - 1n);
    await s.watchdog.run();
    const text = s.recorder.take()[0];
    expect(text).toContain("2 new problems");
    expect(text).toContain("The breaks program is paused by its admin");
    expect(text).toContain(`The keeper wallet ${KEEPER} holds ${sol(need.cycle - 1n)}: enough to create a break, not to see one through, which needs about ${sol(need.cycle)}.`);
    s.putConfig({ paused: false });
    s.chain.sol.set(KEEPER, need.cycle);
    await s.watchdog.run();
    expect(s.recorder.take()[0]).toContain("2 cleared");
  });

  it("counts ORAO's fee when its network state can be read, and leaves it out when not", async () => {
    const s = await started();
    const withFee = keeperSolNeed(2, ORAO_FEE).cycle;
    s.chain.sol.set(KEEPER, withFee - 1n);
    s.chain.accounts.delete(oraoNetworkState(ORAO_PROGRAM));
    await s.watchdog.run();
    expect(s.recorder.take()).toEqual([]); // enough without the fee
    s.chain.accounts.set(oraoNetworkState(ORAO_PROGRAM), encodeNetworkState({ authority: addr(0xa0), treasury: addr(0xa2), requestFee: ORAO_FEE, fulfillmentAuthorities: [], numReceived: 0n }));
    await s.watchdog.run();
    expect(s.recorder.take()[0]).toContain("enough to create a break, not to see one through");
  });

  it("does not report a pause of a program that is not set up (the pipeline reports that)", async () => {
    const s = await started();
    s.chain.accounts.delete(configAddress(PROGRAMS));
    await s.watchdog.run();
    expect(s.recorder.take()).toEqual([]);
  });

  it("reports a job that keeps failing and a run that hangs, from the runner's view", async () => {
    const s = await started();
    s.health.finished("indexer", s.clock.now(), "getSignaturesForAddress: 429 Too Many Requests");
    s.clock.advance(15 * MIN);
    s.health.finished("indexer", s.clock.now(), "getSignaturesForAddress: 429 Too Many Requests");
    s.health.started("delivery", new Date(T0));
    await s.watchdog.run();
    expect(s.recorder.take()).toEqual([
      [
        "BREAKS keeper on devnet: 2 new problems.",
        "New:",
        "• The indexer job has failed every run for 15 min (2 runs in a row). Last error: getSignaturesForAddress: 429 Too Many Requests",
        "• A run of the delivery job started 15 min ago and has not finished: something it waits on (the node, the database) does not answer, and until it ends the keeper starts no other job.",
      ].join("\n"),
    ]);
    s.health.finished("indexer", s.clock.now());
    s.health.finished("delivery", s.clock.now());
    await s.watchdog.run();
    expect(s.recorder.take()[0]).toContain("2 cleared");
  });

  it("keeps what it last knew while the node cannot be read, and says so once that lasts", async () => {
    const s = await started();
    s.putBreak(4n, { status: "Funded" });
    s.putConfig({ paused: true });
    await s.watchdog.run();
    s.clock.advance(15 * MIN);
    await s.watchdog.run();
    expect(s.recorder.take().join("\n")).toMatch(/paused by its admin[\s\S]*funded for at least 15 min/);

    s.chain.down = "fetch failed";
    await s.watchdog.run();
    expect(s.recorder.take()).toEqual([]); // nothing clears just because it cannot be seen
    s.clock.advance(15 * MIN - 1);
    await s.watchdog.run();
    expect(s.recorder.take()).toEqual([]);
    s.clock.advance(1);
    await s.watchdog.run();
    expect(s.recorder.take()).toEqual(["BREAKS keeper on devnet: 1 new problem.\nNew:\n• The watchdog has not been able to read the node for 15 min: fetch failed"]);

    s.chain.down = undefined;
    s.putConfig({ paused: false });
    await s.watchdog.run();
    const text = s.recorder.take()[0] ?? "";
    expect(text).toContain("2 cleared");
    expect(text).toContain("The watchdog has not been able to read the node");
    expect(text).toContain("paused");
    expect(text).not.toContain("funded for"); // still stuck: not cleared

    // A new outage is timed from its own start, not from the last one.
    s.clock.advance(20 * MIN);
    s.chain.down = "fetch failed again";
    await s.watchdog.run();
    s.clock.advance(15 * MIN - 1);
    await s.watchdog.run();
    expect(s.recorder.take()).toEqual([]);
    s.clock.advance(1);
    await s.watchdog.run();
    expect(s.recorder.take()).toEqual(["BREAKS keeper on devnet: 1 new problem.\nNew:\n• The watchdog has not been able to read the node for 15 min: fetch failed again"]);
  });

  it("does the same for the database, and still reports a drawn break when only its count cannot be read", async () => {
    const s = await started();
    s.putBreak(4n, { status: "Funded" });
    await s.watchdog.run();
    s.clock.advance(15 * MIN);
    await s.watchdog.run();
    s.recorder.take();
    s.store.down = "connection refused";
    await s.watchdog.run();
    s.clock.advance(15 * MIN);
    await s.watchdog.run();
    // The stuck break stays reported while the database cannot be read; only the read failure is new.
    expect(s.recorder.take()).toEqual(["BREAKS keeper on devnet: 1 new problem.\nNew:\n• The watchdog has not been able to read the database for 15 min: connection refused"]);
    s.store.down = undefined;
    await s.watchdog.run();
    expect(s.recorder.take()[0]).toBe("BREAKS keeper on devnet: 1 cleared.\nCleared:\n• The watchdog has not been able to read the database for 15 min: connection refused");

    s.putBreak(4n, { status: "Drawn", seededAt: BigInt(T0 / 1000) });
    s.store.countDown = "timeout";
    s.clock.advance(15 * MIN);
    await s.watchdog.run();
    const text = s.recorder.take()[0] ?? "";
    expect(text).toContain("its cards are not all delivered");
    // The count that cannot be read is a database that cannot be read.
    s.clock.advance(15 * MIN);
    await s.watchdog.run();
    expect(s.recorder.take()).toEqual(["BREAKS keeper on devnet: 1 new problem.\nNew:\n• The watchdog has not been able to read the database for 15 min: timeout"]);
  });

  it("hides secrets in what it sends", async () => {
    const s = await started({ secrets: ["SECRETPATH0123456789"] });
    s.chain.down = "request to https://rpc.example/SECRETPATH0123456789 failed";
    await s.watchdog.run();
    s.clock.advance(15 * MIN);
    await s.watchdog.run();
    expect(s.recorder.take()).toEqual(["BREAKS keeper on devnet: 1 new problem.\nNew:\n• The watchdog has not been able to read the node for 15 min: request to https://rpc.example/[hidden] failed"]);
  });

  it("tells a channel that failed the same things on the next run, and logs why it failed without the secret", async () => {
    const s = setup({ secrets: ["tok3n-secret"] });
    const second = new Recorder("telegram");
    const both = new Watchdog({
      ...(s.watchdog as unknown as { deps: ConstructorParameters<typeof Watchdog>[0] }).deps,
      channels: [s.recorder, second],
    });
    second.failing = "Telegram did not take the message (401): tok3n-secret is wrong";
    await both.run();
    expect(s.recorder.take()).toHaveLength(1);
    expect(second.take()).toEqual([]);
    expect(s.errors).toEqual(["the watchdog cannot send its messages to telegram; it tries again every run"]);
    expect(s.fields).toEqual([{ error: "Telegram did not take the message (401): [hidden] is wrong" }]);
    // The same failure is not logged again on every run; a new reason is, and so is the same one an hour later.
    s.clock.advance(60 * MIN - 1);
    await both.run();
    expect(s.errors).toHaveLength(1);
    second.failing = "no answer from Telegram: fetch failed";
    await both.run();
    expect(s.fields.at(-1)).toEqual({ error: "no answer from Telegram: fetch failed" });
    s.clock.advance(60 * MIN - 1);
    await both.run();
    expect(s.errors).toHaveLength(2);
    s.clock.advance(1);
    await both.run();
    expect(s.errors).toHaveLength(3);
    s.clock.advance(MIN); // and then not again for another hour
    await both.run();
    expect(s.errors).toHaveLength(3);
    expect(s.infos).not.toContain("the watchdog reaches telegram again");
    second.failing = undefined;
    s.putConfig({ paused: true });
    await both.run();
    expect(s.recorder.take()).toEqual(["BREAKS keeper on devnet: 1 new problem.\nNew:\n• The breaks program is paused by its admin: no new breaks, spot sales or funding until it is unpaused (cancelling and refunds still work)."]);
    expect(s.infos).toContain("the watchdog reaches telegram again");
    expect(second.take()).toEqual([
      "BREAKS keeper on devnet: 1 new problem.\nBREAKS keeper on devnet started. A problem that lasts is reported here once, and again when it clears.\nNew:\n• The breaks program is paused by its admin: no new breaks, spot sales or funding until it is unpaused (cancelling and refunds still work).",
    ]);
  });

  it("is the job named watchdog, on its own interval", async () => {
    const s = setup();
    const job = watchdogJob({ watchdog: s.watchdog, intervalMs: 60_000 });
    expect(job).toMatchObject({ name: "watchdog", intervalMs: 60_000 });
    await job.run({ now: s.clock.now, log: logger().log });
    expect(s.recorder.take()).toHaveLength(1);
  });
});

class PretendCheck implements Heartbeat {
  attempts = 0;
  pings = 0;
  failing: string | undefined;
  async ping() {
    this.attempts++;
    if (this.failing) throw new Error(this.failing);
    this.pings++;
  }
}

describe("the outside check", () => {
  function withCheck(over: Parameters<typeof setup>[0] = {}) {
    const s = setup(over);
    const telegram = new Recorder("telegram");
    const check = new PretendCheck();
    const deps = (s.watchdog as unknown as { deps: ConstructorParameters<typeof Watchdog>[0] }).deps;
    const watchdog = new Watchdog({ ...deps, channels: [s.recorder, telegram], heartbeat: check });
    return { ...s, telegram, check, watchdog };
  }

  it("is pinged once every run, after the messages, whatever the alerts say", async () => {
    const s = withCheck();
    s.putConfig({ paused: true });
    await s.watchdog.run();
    expect(s.check.pings).toBe(1);
    s.chain.down = "fetch failed"; // problems are the channels' to tell; the ping says the keeper runs and is heard
    for (let i = 0; i < 3; i++) {
      s.clock.advance(20 * MIN);
      await s.watchdog.run();
    }
    expect(s.check.pings).toBe(4);
    expect(s.telegram.take().join("\n")).toContain("has not been able to read the node");
  });

  it("is held back once a channel has not taken its messages for the limit, and pinged again when it does", async () => {
    const s = withCheck();
    s.telegram.failing = "no answer from Telegram: fetch failed";
    await s.watchdog.run();
    s.clock.advance(15 * MIN - 1);
    await s.watchdog.run();
    expect(s.check.pings).toBe(2);
    s.clock.advance(1);
    await s.watchdog.run();
    expect(s.check.attempts).toBe(2);
    expect(s.errors.filter((e) => e.startsWith("the watchdog stops pinging"))).toEqual([
      "the watchdog stops pinging the outside check: telegram has not taken its messages for 15 min, so the check will report the keeper as down",
    ]);
    // Said once, and held back for as long as it lasts.
    for (let i = 0; i < 3; i++) {
      s.clock.advance(10 * MIN);
      await s.watchdog.run();
    }
    expect(s.check.attempts).toBe(2);
    expect(s.errors.filter((e) => e.startsWith("the watchdog stops pinging"))).toHaveLength(1);

    s.telegram.failing = undefined;
    await s.watchdog.run();
    expect(s.telegram.take()).toHaveLength(1); // the greeting, at last
    expect(s.check.pings).toBe(3);
    expect(s.infos).toEqual(expect.arrayContaining(["the watchdog reaches telegram again", "the watchdog pings the outside check again: every channel takes its messages"]));
    s.clock.advance(MIN);
    await s.watchdog.run();
    expect(s.check.pings).toBe(4);
    expect(s.infos.filter((i) => i.startsWith("the watchdog pings the outside check again"))).toHaveLength(1);
  });

  it("is not held back by its own failures", async () => {
    const s = withCheck();
    s.check.failing = "the outside check did not take the ping (503)";
    for (let i = 0; i < 4; i++) {
      await s.watchdog.run();
      s.clock.advance(15 * MIN);
    }
    expect(s.check.attempts).toBe(4);
    expect(s.errors.filter((e) => e.startsWith("the watchdog stops pinging"))).toEqual([]);
  });

  it("logs a check it cannot reach when that starts, when the reason changes and once an hour, without secrets, and when it is reached again", async () => {
    const s = withCheck({ secrets: ["ping/KEY0123456789"] });
    s.check.failing = "no answer from the outside check: request to https://hc.example/ping/KEY0123456789 failed";
    await s.watchdog.run();
    expect(s.errors).toEqual(["the watchdog cannot ping the outside check (ALERT_HEARTBEAT_URL); it tries again every run"]);
    expect(s.fields).toEqual([{ error: "no answer from the outside check: request to https://hc.example/[hidden] failed" }]);
    s.clock.advance(60 * MIN - 1);
    await s.watchdog.run();
    expect(s.errors).toHaveLength(1);
    s.check.failing = "the outside check did not take the ping (503)";
    await s.watchdog.run();
    expect(s.errors).toHaveLength(2);
    s.clock.advance(60 * MIN);
    await s.watchdog.run();
    expect(s.errors).toHaveLength(3);
    s.check.failing = undefined;
    await s.watchdog.run();
    expect(s.infos).toContain("the watchdog reaches the outside check again");
    expect(s.check.pings).toBe(1);
  });

  it("is only pinged when there is one", async () => {
    const s = setup();
    await s.watchdog.run();
    expect(s.errors).toEqual([]);
  });
});

describe("SqlWatchStore", () => {
  it("lists the breaks the keeper still works on, and counts a break's delivered cards (sent or found at the wallet)", async () => {
    const db = await migratedDb();
    const store = new SqlWatchStore(db);
    const a = await insertBreak(db);
    const b = await insertBreak(db);
    const c = await insertBreak(db);
    await db.query("update breaks set onchain_id = 0, status = 'drawn' where id = $1::bigint", [a]);
    await db.query("update breaks set onchain_id = 1, status = 'delivered' where id = $1::bigint", [b]);
    await db.query("update breaks set onchain_id = 2, status = 'cancelled' where id = $1::bigint", [c]);
    await insertBreak(db); // not on chain yet
    expect(await store.activeBreaks()).toEqual([{ id: a, onchainId: 0n, status: "drawn" }]);

    for (let i = 0; i < 4; i++) await db.query("insert into spots (break_id, kind, idx, wallet, paid) values ($1, 'paid', $2, $3, 1)", [a, i, `w${i}`]);
    const spots = (await db.query<{ id: string }>("select id::text as id from spots order by idx")).rows.map((r) => r.id);
    await db.query("insert into deliveries (break_id, spot_id, card_mint, status, tx_sig) values ($1, $2, 'card0', 'confirmed', 'sig0')", [a, spots[0]]);
    await db.query("insert into deliveries (break_id, spot_id, card_mint, status, adopted) values ($1, $2, 'card1', 'confirmed', true)", [a, spots[1]]);
    await db.query("insert into deliveries (break_id, spot_id, card_mint, status) values ($1, $2, 'card2', 'pending')", [a, spots[2]]);
    await db.query("insert into deliveries (break_id, spot_id, card_mint, status, last_error) values ($1, $2, 'card3', 'failed', 'x')", [a, spots[3]]);
    expect(await store.deliveredCount(a)).toBe(2);
    expect(await store.deliveredCount(b)).toBe(0);
  });
});
