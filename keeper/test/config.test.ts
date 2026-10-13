import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { ORAO_PROGRAM } from "../src/solana/breaks.js";
import { addr } from "./support/chain.js";

const BREAKS = "8tmJjCG3D4TF7oPiPWNoaCjZ4pN2U4H237BSGVw2B8KU";
const TREASURY = "Bvq3U9fz2MiHkLH8u4zyt6T1bimxnaEuHkZhezNDT5R9";
const base = {
  SOLANA_RPC_URL: "https://api.devnet.solana.com",
  DATABASE_URL: "postgres://x",
  BREAKS_PROGRAM_ID: BREAKS,
  TREASURY_PROGRAM_ID: TREASURY,
  ORAO_TREASURY: addr(0xa2),
  MIN_TWAB: "1000000000000",
  TOKEN_MINT: addr(0xb1),
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
      vrf: { program: ORAO_PROGRAM, treasury: addr(0xa2) },
      eligibility: { minTwab: 1_000_000_000_000n, settleSecs: 120 },
      indexer: { mint: addr(0xb1), intervalSecs: 900, lagSecs: 120, callsPerRun: 60, pageSize: 25, concurrency: 4 },
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

  it("requires an RPC url, a database url, both program ids, ORAO's treasury, the minimum TWAB and the token", () => {
    expect(() => loadConfig({})).toThrow(/SOLANA_RPC_URL.*DATABASE_URL|DATABASE_URL.*SOLANA_RPC_URL/);
    for (const key of ["BREAKS_PROGRAM_ID", "TREASURY_PROGRAM_ID", "ORAO_TREASURY", "MIN_TWAB", "TOKEN_MINT"] as const) {
      const { [key]: _removed, ...rest } = base;
      expect(() => loadConfig(rest)).toThrow(new RegExp(key));
    }
  });

  it("rejects a program id or treasury that is not an address, such as an unedited placeholder", () => {
    expect(() => loadConfig({ ...base, BREAKS_PROGRAM_ID: "REPLACE_ME" })).toThrow(/BREAKS_PROGRAM_ID.*not a Solana address/);
    expect(() => loadConfig({ ...base, ORAO_TREASURY: "REPLACE_WITH_ORAO_TREASURY" })).toThrow(/ORAO_TREASURY/);
    expect(() => loadConfig({ ...base, VRF_PROGRAM_ID: "nope" })).toThrow(/VRF_PROGRAM_ID/);
    expect(() => loadConfig({ ...base, TOKEN_MINT: "REPLACE_WITH_THE_TOKEN_MINT" })).toThrow(/TOKEN_MINT/);
  });

  it("lets the VRF program be changed, as the admin can switch it on-chain", () => {
    expect(loadConfig({ ...base, VRF_PROGRAM_ID: addr(77) }).vrf.program).toBe(addr(77));
  });
});
