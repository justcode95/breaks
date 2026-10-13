import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const base = { SOLANA_RPC_URL: "https://api.devnet.solana.com", DATABASE_URL: "postgres://x" };

describe("loadConfig", () => {
  it("applies defaults", () => {
    expect(loadConfig(base)).toEqual({
      cluster: "devnet",
      rpcUrl: "https://api.devnet.solana.com",
      databaseUrl: "postgres://x",
      packProvider: "mock",
      jobTickMs: 5000,
      commitment: "confirmed",
    });
  });

  it("reads the keeper key path and the commitment", () => {
    const c = loadConfig({ ...base, KEEPER_KEYPAIR_PATH: "/secrets/keeper.json", SOLANA_COMMITMENT: "finalized" });
    expect(c.keeperKeypairPath).toBe("/secrets/keeper.json");
    expect(c.commitment).toBe("finalized");
    expect(() => loadConfig({ ...base, SOLANA_COMMITMENT: "processed" })).toThrow(/SOLANA_COMMITMENT/);
  });

  it("rejects mainnet until the project rules change", () => {
    expect(() => loadConfig({ ...base, SOLANA_CLUSTER: "mainnet-beta" })).toThrow(/SOLANA_CLUSTER/);
  });

  it("rejects a pack provider that does not exist yet", () => {
    expect(() => loadConfig({ ...base, PACK_PROVIDER: "collector-crypt" })).toThrow(/PACK_PROVIDER/);
  });

  it("requires an RPC url and a database url", () => {
    expect(() => loadConfig({})).toThrow(/SOLANA_RPC_URL.*DATABASE_URL|DATABASE_URL.*SOLANA_RPC_URL/);
  });
});
