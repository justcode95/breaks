import { describe, expect, it } from "vitest";
import { loadConfig, parseConfig } from "../src/config.js";
import { packMachineLabel } from "../src/scheduler/machine.js";
import { oneMachine } from "./support/packs.js";
import { ORAO_PROGRAM } from "../src/solana/breaks.js";
import { addr } from "./support/chain.js";

const BREAKS = "8tmJjCG3D4TF7oPiPWNoaCjZ4pN2U4H237BSGVw2B8KU";
const TREASURY = "Bvq3U9fz2MiHkLH8u4zyt6T1bimxnaEuHkZhezNDT5R9";
const base = {
  SOLANA_RPC_URL: "https://api.devnet.solana.com",
  DATABASE_URL: "postgres://x",
  BREAKS_PROGRAM_ID: BREAKS,
  TREASURY_PROGRAM_ID: TREASURY,
  MIN_TWAB: "1000000000000",
  TOKEN_MINT: addr(0xb1),
  BREAK_PAID_SPOTS: "10",
  BREAK_FREE_SPOTS: "2",
  BREAK_SPOT_PRICE: "20000000",
  BREAK_PACKS: JSON.stringify([{ machine: "pokemon-25", maxPrice: "25000000", count: 12 }]),
  BREAK_WINDOW_SECS: "43200",
};

describe("loadConfig", () => {
  it("applies defaults", () => {
    expect(loadConfig(base)).toEqual({
      cluster: "devnet",
      rpcUrl: "https://api.devnet.solana.com",
      databaseUrl: "postgres://x",
      packProvider: "mock",
      cardTransfer: "mock",
      mockPackPrice: 25_000_000n,
      jobTickMs: 5000,
      jobIntervalMs: 10_000,
      commitment: "confirmed",
      programs: { breaks: BREAKS, treasury: TREASURY },
      vrf: { program: ORAO_PROGRAM },
      eligibility: { minTwab: 1_000_000_000_000n, settleSecs: 120 },
      indexer: { mint: addr(0xb1), intervalSecs: 900, lagSecs: 120, callsPerRun: 60, pageSize: 25, concurrency: 4 },
      scheduler: {
        enabled: true,
        template: { paidSpots: 10, freeSpots: 2, spotPrice: 20_000_000n, packs: oneMachine("pokemon-25", 25_000_000n, 12), windowSecs: 43_200n },
      },
      sweep: {
        enabled: false,
        swapProvider: "none",
        policy: { keepLamports: 1_000_000_000n, minLamports: 100_000_000n, maxLamports: 10_000_000_000n, slippageBps: 50, minDeposit: 1_000_000n },
      },
      publish: { intervalSecs: 60 },
      bot: {
        enabled: false,
        poster: "log",
        intervalSecs: 60,
        settings: { milestones: [25, 50, 75], reminderHours: [3, 1], finalityMarginSecs: 120 },
        limits: { minGapSecs: 60, maxPerDay: 20, maxAttempts: 5, retryStepSecs: 120 },
        lookback: 5,
      },
    });
  });

  it("publishes the lists only when told where, and refuses an interval that would hammer the node", () => {
    expect(loadConfig(base).publish).toEqual({ intervalSecs: 60 });
    expect(loadConfig({ ...base, PUBLISH_DIR: "/srv/published", PUBLISH_INTERVAL_SECS: "30" }).publish).toEqual({ dir: "/srv/published", intervalSecs: 30 });
    expect(() => loadConfig({ ...base, PUBLISH_INTERVAL_SECS: "9" })).toThrow(/PUBLISH_INTERVAL_SECS/);
    expect(() => loadConfig({ ...base, PUBLISH_DIR: "" })).toThrow(/PUBLISH_DIR/);
  });

  it("keeps the X bot off, as a dry run, until it is turned on; real posting needs the four credentials", () => {
    expect(loadConfig(base).bot).toMatchObject({ enabled: false, poster: "log" });
    // A dry run needs no account.
    expect(loadConfig({ ...base, BOT_ENABLED: "true" }).bot).toMatchObject({ enabled: true, poster: "log" });

    const creds = { X_CONSUMER_KEY: "ck", X_CONSUMER_SECRET: "cs", X_ACCESS_TOKEN: "at", X_ACCESS_TOKEN_SECRET: "as" };
    expect(() => loadConfig({ ...base, BOT_ENABLED: "true", BOT_POSTER: "x" })).toThrow(/X_CONSUMER_KEY.*required/);
    expect(() => loadConfig({ ...base, BOT_ENABLED: "true", BOT_POSTER: "x", ...creds, X_ACCESS_TOKEN_SECRET: undefined })).toThrow(/X_ACCESS_TOKEN_SECRET/);
    const c = loadConfig({
      ...base,
      ...creds,
      BOT_ENABLED: "true",
      BOT_POSTER: "x",
      X_API_BASE: "https://api.x.com",
      BOT_INTERVAL_SECS: "30",
      BOT_MIN_GAP_SECS: "120",
      BOT_MAX_POSTS_PER_DAY: "10",
      BOT_MILESTONES: "10, 50",
      BOT_REMINDER_HOURS: "6,2,1",
      BOT_LOOKBACK_BREAKS: "3",
      BOT_SITE_URL: "https://example.org",
    });
    expect(c.bot).toEqual({
      enabled: true,
      poster: "x",
      x: { baseUrl: "https://api.x.com", credentials: { consumerKey: "ck", consumerSecret: "cs", accessToken: "at", accessTokenSecret: "as" } },
      intervalSecs: 30,
      settings: { milestones: [10, 50], reminderHours: [6, 2, 1], finalityMarginSecs: 120, siteUrl: "https://example.org" },
      limits: { minGapSecs: 120, maxPerDay: 10, maxAttempts: 5, retryStepSecs: 120 },
      lookback: 3,
    });
  });

  it("refuses X bot settings that make no sense", () => {
    for (const bad of [
      { BOT_MILESTONES: "50,25" },
      { BOT_MILESTONES: "0,50" },
      { BOT_MILESTONES: "50,100" },
      { BOT_MILESTONES: "25,x" },
      { BOT_REMINDER_HOURS: "0" },
      { BOT_REMINDER_HOURS: "1.5" },
      { BOT_REMINDER_HOURS: "500" },
      { X_API_BASE: "http://api.x.com" },
      { BOT_SITE_URL: "http://example.org" },
      { BOT_SITE_URL: "not a url" },
      { BOT_POSTER: "telegram" },
      { BOT_MAX_POSTS_PER_DAY: "0" },
      { BOT_INTERVAL_SECS: "1" },
    ]) {
      expect(() => loadConfig({ ...base, ...bad }), JSON.stringify(bad)).toThrow(/Invalid keeper config/);
    }
  });

  it("keeps the fee sweep off until it is turned on, and reads its limits", () => {
    expect(loadConfig(base).sweep.enabled).toBe(false);
    const c = loadConfig({
      ...base,
      SWEEP_ENABLED: "true",
      SWEEP_MIN_DEPOSIT: "5000000",
      SWEEP_KEEP_LAMPORTS: "0",
      SWEEP_MIN_LAMPORTS: "50000000",
      SWEEP_MAX_LAMPORTS: "2000000000",
      SWEEP_SLIPPAGE_BPS: "100",
      SWEEP_MIN_USDC_PER_SOL: "100000000",
    });
    expect(c.sweep).toEqual({
      enabled: true,
      swapProvider: "none",
      policy: { keepLamports: 0n, minLamports: 50_000_000n, maxLamports: 2_000_000_000n, slippageBps: 100, minUsdcPerSol: 100_000_000n, minDeposit: 5_000_000n },
    });
    expect(() => loadConfig({ ...base, SWEEP_ENABLED: "maybe" })).toThrow(/SWEEP_ENABLED/);
    expect(() => loadConfig({ ...base, SWEEP_SWAP_PROVIDER: "jupiter" })).toThrow(/SWEEP_SWAP_PROVIDER/);
    expect(() => loadConfig({ ...base, SWEEP_SLIPPAGE_BPS: "5000" })).toThrow(/SWEEP_SLIPPAGE_BPS/);
    expect(() => loadConfig({ ...base, SWEEP_MIN_DEPOSIT: "0" })).toThrow(/SWEEP_MIN_DEPOSIT/);
    expect(() => loadConfig({ ...base, SWEEP_MIN_LAMPORTS: "3000000000", SWEEP_MAX_LAMPORTS: "2000000000" })).toThrow(/SWEEP_MIN_LAMPORTS.*SWEEP_MAX_LAMPORTS/);
  });

  it("reads the break the scheduler creates and can be told not to create any", () => {
    const c = loadConfig({ ...base, BREAK_AUTO_CREATE: "false", BREAK_PACKS: JSON.stringify([{ machine: `0x${"ab".repeat(32)}`, maxPrice: "25000000", count: 10 }]), BREAK_FREE_SPOTS: "0" });
    expect(c.scheduler.enabled).toBe(false);
    expect(c.scheduler.template.packs).toEqual([{ machine: new Uint8Array(32).fill(0xab), maxPrice: 25_000_000n, count: 10 }]);
    expect(c.scheduler.template.freeSpots).toBe(0);
    expect(loadConfig({ ...base, BREAK_AUTO_CREATE: "true" }).scheduler.enabled).toBe(true);
    expect(() => loadConfig({ ...base, BREAK_AUTO_CREATE: "yes" })).toThrow(/BREAK_AUTO_CREATE/);
  });

  it("refuses a break the program could never accept", () => {
    expect(() => loadConfig({ ...base, BREAK_PAID_SPOTS: "0" })).toThrow(/BREAK_PAID_SPOTS/);
    expect(() => loadConfig({ ...base, BREAK_FREE_SPOTS: "17" })).toThrow(/BREAK_FREE_SPOTS/);
    expect(() => loadConfig({ ...base, BREAK_SPOT_PRICE: "0" })).toThrow(/BREAK_SPOT_PRICE/);
    expect(() => loadConfig({ ...base, BREAK_SPOT_PRICE: "25000001" })).toThrow(/BREAK_SPOT_PRICE.*average pack price/);
    expect(loadConfig({ ...base, BREAK_SPOT_PRICE: "25000000" }).scheduler.template.spotPrice).toBe(25_000_000n);
    expect(() => loadConfig({ ...base, BREAK_WINDOW_SECS: "10" })).toThrow(/BREAK_WINDOW_SECS/);
  });

  describe("the pack list", () => {
    const packs = (...groups: object[]) => ({ ...base, BREAK_PACKS: JSON.stringify(groups) });
    const MIXED = { ...base, BREAK_PAID_SPOTS: "6", BREAK_FREE_SPOTS: "2" };
    const mixed = JSON.stringify([
      { machine: "top", maxPrice: "50000000", count: 2 },
      { machine: "cheap", maxPrice: "10000000", count: 4 },
      { machine: "mid", maxPrice: "25000000", count: 2 },
    ]);

    it("reads a mix of machines and puts it cheapest first, whatever order it is written in", () => {
      const t = loadConfig({ ...MIXED, BREAK_PACKS: mixed }).scheduler.template;
      expect(t.packs.map((g) => [packMachineLabel(g.machine), g.maxPrice, g.count])).toEqual([["cheap", 10_000_000n, 4], ["mid", 25_000_000n, 2], ["top", 50_000_000n, 2]]);
      expect(t.paidSpots + t.freeSpots).toBe(8);
    });

    it("refuses a list that does not match the spots: one pack per spot", () => {
      expect(() => loadConfig({ ...base, BREAK_PACKS: mixed })).toThrow(/BREAK_PACKS.*lists 8 packs but BREAK_PAID_SPOTS \+ BREAK_FREE_SPOTS is 12/);
      expect(() => loadConfig({ ...MIXED, BREAK_FREE_SPOTS: "3" })).toThrow(/BREAK_PACKS.*lists 12 packs but .* is 9/);
    });

    it("refuses a spot price above the average pack price of the list, and takes one at exactly the average", () => {
      // $190 over 8 spots: $23.75.
      expect(() => loadConfig({ ...MIXED, BREAK_PACKS: mixed, BREAK_SPOT_PRICE: "23750001" })).toThrow(/BREAK_SPOT_PRICE.*average pack price/);
      expect(loadConfig({ ...MIXED, BREAK_PACKS: mixed, BREAK_SPOT_PRICE: "23750000" }).scheduler.template.spotPrice).toBe(23_750_000n);
    });

    it("refuses more machines than a break can list, and more spots than it can have packs", () => {
      const nine = Array.from({ length: 9 }, (_, i) => ({ machine: `m${i}`, maxPrice: String(30_000_000 + i), count: 1 }));
      expect(() => loadConfig({ ...base, BREAK_PAID_SPOTS: "7", BREAK_FREE_SPOTS: "2", BREAK_PACKS: JSON.stringify(nine) })).toThrow(/BREAK_PACKS.*9 groups; a break lists at most 8/);
      expect(() => loadConfig({ ...packs({ machine: "x", maxPrice: "25000000", count: 65 }), BREAK_PAID_SPOTS: "60", BREAK_FREE_SPOTS: "5" })).toThrow(/at most 64 spots/);
    });

    it("says what is wrong with the setting itself", () => {
      for (const [value, words] of [
        ["not json", /BREAK_PACKS.*not valid JSON/],
        ["{}", /BREAK_PACKS.*at least one group/],
        ["[]", /BREAK_PACKS.*at least one group/],
        [JSON.stringify([{ machine: "", maxPrice: "25000000", count: 12 }]), /BREAK_PACKS.*group 1.*empty/],
        [JSON.stringify([{ machine: "x".repeat(33), maxPrice: "25000000", count: 12 }]), /BREAK_PACKS.*at most 32/],
        [JSON.stringify([{ machine: "0x1234", maxPrice: "25000000", count: 12 }]), /BREAK_PACKS.*looks like a hex id/],
        [JSON.stringify([{ machine: "x", maxPrice: "-5", count: 12 }]), /BREAK_PACKS.*maxPrice must be a whole number/],
        [JSON.stringify([{ machine: "x", maxPrice: "0", count: 12 }]), /BREAK_PACKS.*maxPrice must be above zero/],
        [JSON.stringify([{ machine: "x", maxPrice: "25000000", count: 0 }]), /BREAK_PACKS.*count must be a whole number, at least 1/],
        [JSON.stringify([{ machine: "x", maxPrice: "25000000", count: 1.5 }]), /BREAK_PACKS.*count must be a whole number/],
        [JSON.stringify([{ machine: "x", price: "25000000", count: 12 }]), /BREAK_PACKS.*"price".*not one of/],
        [JSON.stringify(["x"]), /BREAK_PACKS.*group 1 must be an object/],
      ] as const) {
        expect(() => loadConfig({ ...base, BREAK_PACKS: value }), value).toThrow(words);
      }
    });
  });

  it("reads the indexer settings and refuses values that would make it unsafe or useless", () => {
    const c = loadConfig({ ...base, INDEXER_INTERVAL_SECS: "300", INDEXER_LAG_SECS: "60", INDEXER_CALLS_PER_RUN: "10", INDEXER_PAGE_SIZE: "50", INDEXER_CONCURRENCY: "2" });
    expect(c.indexer).toEqual({ mint: addr(0xb1), intervalSecs: 300, lagSecs: 60, callsPerRun: 10, pageSize: 50, concurrency: 2 });
    // A lag of a few seconds could claim transactions that have not finalized yet.
    expect(() => loadConfig({ ...base, INDEXER_LAG_SECS: "5" })).toThrow(/INDEXER_LAG_SECS/);
    expect(() => loadConfig({ ...base, INDEXER_INTERVAL_SECS: "1" })).toThrow(/INDEXER_INTERVAL_SECS/);
    expect(() => loadConfig({ ...base, INDEXER_CALLS_PER_RUN: "0" })).toThrow(/INDEXER_CALLS_PER_RUN/);
    expect(() => loadConfig({ ...base, INDEXER_PAGE_SIZE: "5000" })).toThrow(/INDEXER_PAGE_SIZE/);
    expect(() => loadConfig({ ...base, INDEXER_CONCURRENCY: "0" })).toThrow(/INDEXER_CONCURRENCY/);
  });

  it("reads the eligibility policy", () => {
    const c = loadConfig({ ...base, WEIGHT_CAP: "5000000000000", INDEXER_SETTLE_SECS: "30" });
    expect(c.eligibility).toEqual({ minTwab: 1_000_000_000_000n, capPerWallet: 5_000_000_000_000n, settleSecs: 30 });
    expect(() => loadConfig({ ...base, MIN_TWAB: "0" })).toThrow(/MIN_TWAB/);
    expect(() => loadConfig({ ...base, MIN_TWAB: "a lot" })).toThrow(/MIN_TWAB/);
    expect(() => loadConfig({ ...base, WEIGHT_CAP: "0" })).toThrow(/WEIGHT_CAP/);
    expect(() => loadConfig({ ...base, INDEXER_SETTLE_SECS: "-1" })).toThrow(/INDEXER_SETTLE_SECS/);
  });

  it("reads the keeper key path, the commitment and the job timings", () => {
    const c = loadConfig({ ...base, KEEPER_KEYPAIR_PATH: "/secrets/keeper.json", SOLANA_COMMITMENT: "finalized", JOB_INTERVAL_MS: "2000", MOCK_PACK_PRICE: "30000000" });
    expect(c.keeperKeypairPath).toBe("/secrets/keeper.json");
    expect(c.commitment).toBe("finalized");
    expect(c.jobIntervalMs).toBe(2000);
    expect(c.mockPackPrice).toBe(30_000_000n);
    expect(() => loadConfig({ ...base, SOLANA_COMMITMENT: "processed" })).toThrow(/SOLANA_COMMITMENT/);
    expect(() => loadConfig({ ...base, JOB_INTERVAL_MS: "10" })).toThrow(/JOB_INTERVAL_MS/);
    expect(() => loadConfig({ ...base, MOCK_PACK_PRICE: "0" })).toThrow(/MOCK_PACK_PRICE/);
  });

  it("rejects mainnet until the project rules change", () => {
    expect(() => loadConfig({ ...base, SOLANA_CLUSTER: "mainnet-beta" })).toThrow(/SOLANA_CLUSTER/);
  });

  it("rejects a pack provider or card transfer that does not exist yet", () => {
    expect(() => loadConfig({ ...base, PACK_PROVIDER: "collector-crypt" })).toThrow(/PACK_PROVIDER/);
    expect(() => loadConfig({ ...base, CARD_TRANSFER: "collector-crypt" })).toThrow(/CARD_TRANSFER/);
  });

  it("requires an RPC url, a database url, both program ids, the minimum TWAB, the token and the break to create", () => {
    expect(() => loadConfig({})).toThrow(/SOLANA_RPC_URL.*DATABASE_URL|DATABASE_URL.*SOLANA_RPC_URL/);
    for (const key of ["BREAKS_PROGRAM_ID", "TREASURY_PROGRAM_ID", "MIN_TWAB", "TOKEN_MINT", "BREAK_PAID_SPOTS", "BREAK_FREE_SPOTS", "BREAK_SPOT_PRICE", "BREAK_PACKS", "BREAK_WINDOW_SECS"] as const) {
      const { [key]: _removed, ...rest } = base;
      expect(() => loadConfig(rest)).toThrow(new RegExp(key));
    }
  });

  it("rejects a program id or treasury that is not an address, such as an unedited placeholder", () => {
    expect(() => loadConfig({ ...base, BREAKS_PROGRAM_ID: "REPLACE_ME" })).toThrow(/BREAKS_PROGRAM_ID.*not a Solana address/);
    expect(() => loadConfig({ ...base, VRF_PROGRAM_ID: "nope" })).toThrow(/VRF_PROGRAM_ID/);
    expect(() => loadConfig({ ...base, TOKEN_MINT: "REPLACE_WITH_THE_TOKEN_MINT" })).toThrow(/TOKEN_MINT/);
  });

  it("lets the VRF program be changed, as the admin can switch it on-chain", () => {
    expect(loadConfig({ ...base, VRF_PROGRAM_ID: addr(77) }).vrf.program).toBe(addr(77));
  });
});

describe("parseConfig", () => {
  it("returns the configuration when it is valid, the same one loadConfig returns", () => {
    expect(parseConfig(base)).toEqual({ config: loadConfig(base) });
  });

  it("returns every problem, one per setting, instead of throwing", () => {
    const parsed = parseConfig({ ...base, MIN_TWAB: "a lot", BREAK_FREE_SPOTS: "17", TOKEN_MINT: undefined });
    expect("problems" in parsed).toBe(true);
    const problems = (parsed as { problems: string[] }).problems;
    expect(problems.filter((p) => p.startsWith("MIN_TWAB:"))).toHaveLength(1);
    expect(problems.some((p) => p.startsWith("BREAK_FREE_SPOTS:"))).toBe(true);
    expect(problems).toContain("TOKEN_MINT: is not set");
    expect(problems).toHaveLength(3);
  });

  it("says that a setting is not set only when it is not set at all, and keeps the parser's words for a bad value", () => {
    const missing = parseConfig({ ...base, MIN_TWAB: undefined, BREAK_PAID_SPOTS: undefined, BREAK_SPOT_PRICE: undefined }) as { problems: string[] };
    expect(missing.problems).toEqual(expect.arrayContaining(["MIN_TWAB: is not set", "BREAK_PAID_SPOTS: is not set", "BREAK_SPOT_PRICE: is not set"]));
    const bad = parseConfig({ ...base, MIN_TWAB: "a lot", BREAK_PAID_SPOTS: "0" }) as { problems: string[] };
    expect(bad.problems.join("\n")).not.toContain("is not set");
    expect(bad.problems.some((p) => p.startsWith("MIN_TWAB: "))).toBe(true);
    // A number that is not one comes out of the parser as NaN, the same as a missing one: it is not "not set".
    const words = parseConfig({ ...base, BREAK_FREE_SPOTS: "many" }) as { problems: string[] };
    expect(words.problems).toHaveLength(1);
    expect(words.problems[0]).toMatch(/^BREAK_FREE_SPOTS: /);
    expect(words.problems[0]).not.toContain("is not set");
    const empty = parseConfig({ ...base, BREAK_PACKS: JSON.stringify([{ machine: "", maxPrice: "25000000", count: 12 }]) }) as { problems: string[] };
    expect(empty.problems.join("\n")).toContain("BREAK_PACKS");
    expect(empty.problems.join("\n")).not.toContain("is not set");
  });

  it("does not replace a rule's own message with 'is not set' (a setting another setting requires)", () => {
    const parsed = parseConfig({ ...base, BOT_ENABLED: "true", BOT_POSTER: "x" }) as { problems: string[] };
    expect(parsed.problems).toContain("X_CONSUMER_KEY: is required when BOT_POSTER=x");
  });

  it("is what loadConfig reports, joined", () => {
    const env = { ...base, MIN_TWAB: undefined, TOKEN_MINT: "nope" };
    const problems = (parseConfig(env) as { problems: string[] }).problems;
    expect(() => loadConfig(env)).toThrow(`Invalid keeper config: ${problems.join("; ")}`);
  });
});
