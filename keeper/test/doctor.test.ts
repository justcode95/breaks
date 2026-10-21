import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exclusionProblem } from "../src/eligibility/exclusions.js";
import { describe, expect, it } from "vitest";
import { amount, clockVerdict, keeperSolNeed } from "../src/doctor/checks.js";
import { main, realPorts } from "../src/doctor/main.js";
import { type Check, render, scrubber, summarize, urlSecrets } from "../src/doctor/report.js";
import { ORAO_PROGRAM, configAddress, oraoNetworkState, treasuryAuthorityAddress } from "../src/solana/breaks.js";
import type { Config } from "../src/config.js";
import { GENESIS_HASHES } from "../src/solana/cluster.js";
import { programDataAddress } from "../src/solana/instruction.js";
import { associatedTokenAddress } from "../src/solana/pubkey.js";
import { RpcClient } from "../src/solana/rpc.js";
import { treasuryAddresses } from "../src/solana/treasury.js";
import { encodeNetworkState, encodeTokenAccount } from "./support/accounts.js";
import { addr } from "./support/chain.js";
import {
  BUYER_WALLET,
  KEEPER_ADDRESS,
  NOW,
  SECRET_DB_PASSWORD,
  SECRET_RPC_PATH,
  SECRET_HEARTBEAT_KEY,
  SECRET_TELEGRAM_TOKEN,
  UPGRADER,
  USDC,
  type World,
  find,
  healthyWorld,
  mintData,
  programDataAccount,
} from "./support/doctor-world.js";
import { MINT, TokenLedger } from "./support/token-ledger.js";
import { PROGRAMS } from "./support/world.js";

const EVERY_CHECK = [
  "the settings load",
  "real packs and cards",
  "the scheduler creates breaks",
  "the key file loads",
  "only this user can read it",
  "it is outside the repository",
  "it answers",
  "it is devnet",
  "its clock agrees with this machine's",
  "it serves the history the indexer reads",
  "the breaks program is deployed",
  "the treasury program is deployed",
  "the randomness program is deployed",
  "the treasury is initialized",
  "the breaks program is initialized",
  "this key is the breaks program's keeper",
  "it uses the configured randomness program",
  "sales are not paused",
  "the treasury takes orders from the breaks program",
  "both programs count in the same USDC",
  "the admins are not the keeper's key",
  "the buyer wallet can receive USDC",
  "the configured break is one the program accepts",
  "the reserve can pay for the next break",
  "ORAO is ready to answer",
  "it holds the SOL to run breaks",
  "the fee sweep has USDC to deposit from",
  "TOKEN_MINT is an initialized mint",
  "MIN_TWAB and WEIGHT_CAP make sense for it",
  "it answers", // the database's
  "every migration is applied",
  "the keeper's role can write",
  "the exclusion list can be published",
  "the published lists have somewhere to go",
  "the X bot",
  "the watchdog's alerts",
  "an outside check",
];

const statusOf = (checks: Check[], title: string) => find(checks, title).status;
const READS = new Set(["getGenesisHash", "getSlot", "getBlockTime", "getAccountInfo", "getBalance"]);
const FILE_NAME_SECRET = "SECRETCONTENT-do-not-print";

async function spoil(w: World, change: () => void): Promise<Check[]> {
  change();
  w.publish();
  return w.run();
}

describe("a healthy setup", () => {
  it("passes every check, warning only that the providers are mocks, and reads nothing but what it needs", async () => {
    const w = await healthyWorld();
    const checks = await w.run();
    expect(checks.map((c) => c.title)).toEqual(EVERY_CHECK);
    expect(checks.filter((c) => c.status !== "ok").map((c) => `${c.status}: ${c.title}`)).toEqual(["warn: real packs and cards"]);
    const report = summarize(checks);
    expect(report).toMatchObject({ ok: 36, warned: 1, failed: 0, skipped: 0, ready: true });
    expect(w.node.sent).toEqual([]);
    expect(w.node.requests.map((r) => r.method).filter((m) => !READS.has(m))).toEqual([]);
  });

  it("only ever issues SELECTs to the database", async () => {
    const w = await healthyWorld();
    await w.run();
    expect(w.statements.length).toBeGreaterThan(10);
    expect(w.statements.filter((s) => !/^\s*select\b/i.test(s))).toEqual([]);
  });

  it("asks the node for the 45 bytes of metadata of a program-data account, not for the program's code", async () => {
    const w = await healthyWorld();
    await w.run();
    const asked = w.node.requests.filter((r) => r.method === "getAccountInfo" && r.params[0] === programDataAddress(PROGRAMS.breaks));
    expect(asked).toHaveLength(1);
    expect(asked[0]?.params[1]).toMatchObject({ dataSlice: { offset: 0, length: 45 } });
  });

  it("lets go of the database connection when it is done, and never opens one it does not need", async () => {
    const w = await healthyWorld();
    await w.run();
    expect(w.closed).toBe(1);
    const noSettings = await healthyWorld({ env: { MIN_TWAB: undefined } });
    await noSettings.run();
    expect(noSettings.closed).toBe(0);
    const down = await healthyWorld();
    down.dbDown = { message: "no route to host" };
    await down.run();
    expect(down.closed).toBe(0);
  });

  it("reports a check that breaks unexpectedly as a failure of that check, and carries on with the rest", async () => {
    const w = await healthyWorld();
    w.ports.now = () => {
      throw new Error("the clock broke");
    };
    const checks = await w.run();
    const check = find(checks, "its clock agrees with this machine's");
    expect(check.status).toBe("fail");
    expect(check.detail).toBe("the check itself failed: the clock broke");
    expect(checks).toHaveLength(EVERY_CHECK.length);
    expect(statusOf(checks, "the breaks program is deployed")).toBe("ok");
  });

  it("says which break the scheduler will make first, counting from 1 like the website", async () => {
    const w = await healthyWorld();
    const checks = await w.run();
    expect(find(checks, "the reserve can pay for the next break").detail).toContain("creates break #3 on its first run");
    expect(find(checks, "the breaks program is initialized").detail).toContain("2 breaks made so far");
  });
});

describe("the settings", () => {
  it("lists every setting that is missing and skips what depends on them, touching neither the node nor the database", async () => {
    const w = await healthyWorld({ env: { MIN_TWAB: undefined, TOKEN_MINT: undefined, BREAK_WINDOW_SECS: "5" } });
    const checks = await w.run();
    const first = find(checks, "the settings load");
    expect(first.status).toBe("fail");
    expect(first.detail).toContain("MIN_TWAB: is not set");
    expect(first.detail).toContain("TOKEN_MINT: is not set");
    expect(first.detail).toContain("BREAK_WINDOW_SECS");
    expect(checks.slice(1).every((c) => c.status === "skip")).toBe(true);
    expect(w.node.requests).toEqual([]);
    expect(w.statements).toEqual([]);
  });

  it("warns that the scheduler is off when BREAK_AUTO_CREATE is false", async () => {
    const off = await (await healthyWorld({ env: { BREAK_AUTO_CREATE: "false" } })).run();
    expect(statusOf(off, "the scheduler creates breaks")).toBe("warn");
    expect(find(off, "the scheduler creates breaks").detail).toContain("never creates one");
  });
});

describe("the key", () => {
  it("fails without a key path, and skips only what needs the key", async () => {
    const w = await healthyWorld({ env: { KEEPER_KEYPAIR_PATH: undefined } });
    const checks = await w.run();
    expect(find(checks, "the key file loads")).toMatchObject({ status: "fail" });
    expect(find(checks, "the key file loads").detail).toContain("KEEPER_KEYPAIR_PATH is not set");
    for (const title of ["only this user can read it", "it is outside the repository", "this key is the breaks program's keeper", "the admins are not the keeper's key", "it holds the SOL to run breaks"]) {
      expect(statusOf(checks, title), title).toBe("skip");
    }
    expect(statusOf(checks, "the breaks program is deployed")).toBe("ok");
    expect(statusOf(checks, "the treasury is initialized")).toBe("ok");
  });

  it("fails on a file that is not a keypair, naming the file and never what is in it", async () => {
    const w = await healthyWorld();
    writeFileSync(w.keyPath, FILE_NAME_SECRET);
    const checks = await w.run();
    const check = find(checks, "the key file loads");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain(w.keyPath);
    expect(JSON.stringify(checks)).not.toContain(FILE_NAME_SECRET);
    writeFileSync(w.keyPath, JSON.stringify({ not: "an array" }));
    expect(find(await w.run(), "the key file loads").detail).toContain("is not a keypair file");
    writeFileSync(w.keyPath, JSON.stringify([1, 2, 3]));
    expect(find(await w.run(), "the key file loads").detail).toContain("32 or 64 bytes");
  });

  it("fails on a key whose public half does not belong to its secret half", async () => {
    const w = await healthyWorld();
    const bytes = Array.from({ length: 64 }, (_, i) => (i < 32 ? 1 : 9));
    writeFileSync(w.keyPath, JSON.stringify(bytes));
    const check = find(await w.run(), "the key file loads");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("public half");
  });

  it("warns when other users can read the key file, with the command that fixes it", async () => {
    const w = await healthyWorld();
    for (const [mode, text] of [[0o644, "644"], [0o640, "640"], [0o604, "604"]] as const) {
      chmodSync(w.keyPath, mode);
      const check = find(await w.run(), "only this user can read it");
      expect(check.status, text).toBe("warn");
      expect(check.detail).toContain(`mode is ${text}`);
      expect(check.fix).toBe(`chmod 600 ${w.keyPath}`);
    }
    for (const mode of [0o600, 0o400]) {
      chmodSync(w.keyPath, mode);
      expect(statusOf(await w.run(), "only this user can read it")).toBe("ok");
    }
  });

  it("warns when the key file sits inside a git work tree", async () => {
    const w = await healthyWorld();
    const repo = join(w.dir, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "secrets"));
    const inside = join(repo, "secrets", "keeper.json");
    writeFileSync(inside, readFileSync(w.keyPath));
    chmodSync(inside, 0o600);
    w.env.KEEPER_KEYPAIR_PATH = inside;
    const check = find(await w.run(), "it is outside the repository");
    expect(check.status).toBe("warn");
    expect(check.detail).toContain(repo);
  });
});

describe("the node", () => {
  it("fails when it cannot be reached, and reads nothing else from it", async () => {
    const w = await healthyWorld();
    w.nodeDown = () => new Error("connect ECONNREFUSED");
    const checks = await w.run();
    expect(statusOf(checks, "the settings load")).toBe("ok");
    expect(find(checks, "it answers")).toMatchObject({ status: "fail" });
    expect(find(checks, "it answers").detail).toContain("cannot reach the node");
    for (const title of ["it is devnet", "its clock agrees with this machine's", "the breaks program is deployed", "the treasury is initialized", "the reserve can pay for the next break", "TOKEN_MINT is an initialized mint"]) {
      expect(statusOf(checks, title), title).toBe("skip");
    }
    // The checks that need only the settings, the key, the database and the filesystem still run.
    expect(statusOf(checks, "the key file loads")).toBe("ok");
    expect(statusOf(checks, "every migration is applied")).toBe("ok");
    expect(statusOf(checks, "the published lists have somewhere to go")).toBe("ok");
  });

  it.each([
    ["mainnet-beta", GENESIS_HASHES["mainnet-beta"], /mainnet-beta/],
    ["testnet", GENESIS_HASHES.testnet, /testnet/],
  ])("refuses %s, and reads no account from it", async (_name, genesis, pattern) => {
    const w = await healthyWorld();
    w.node.genesis = genesis;
    const checks = await w.run();
    const check = find(checks, "it is devnet");
    expect(check.status).toBe("fail");
    expect(check.detail).toMatch(pattern);
    expect(check.fix).toContain("devnet");
    expect(statusOf(checks, "the breaks program is deployed")).toBe("skip");
    expect(w.node.requests.map((r) => r.method)).toEqual(["getGenesisHash"]);
  });

  it("says, for a node that is neither, that the constant in cluster.ts may be what is wrong", async () => {
    const w = await healthyWorld();
    w.node.genesis = "5".repeat(44);
    const check = find(await w.run(), "it is devnet");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("not devnet");
    expect(check.fix).toContain("src/solana/cluster.ts");
    expect(check.fix).toContain("solana genesis-hash -u devnet");
  });

  it("accepts any node that is not a public network when the cluster is localnet", async () => {
    const w = await healthyWorld({ env: { SOLANA_CLUSTER: "localnet" } });
    w.node.genesis = "5".repeat(44);
    expect(statusOf(await w.run(), "it is devnet")).toBe("ok");
  });

  describe("the clock", () => {
    const skewed = async (secs: number) => {
      const w = await healthyWorld();
      w.node.blockTime = Math.floor(NOW.getTime() / 1000) - secs;
      return find(await w.run(), "its clock agrees with this machine's");
    };

    it("is fine within ten seconds either way, warns up to a minute and fails beyond", async () => {
      expect((await skewed(0)).status).toBe("ok");
      expect((await skewed(10)).status).toBe("ok");
      expect((await skewed(-10)).status).toBe("ok");
      expect((await skewed(11)).status).toBe("warn");
      expect((await skewed(-11)).status).toBe("warn");
      expect((await skewed(60)).status).toBe("warn");
      expect((await skewed(-60)).status).toBe("warn");
      expect((await skewed(61)).status).toBe("fail");
      expect((await skewed(-61)).status).toBe("fail");
    });

    it("says which way it is off, and how to fix it", async () => {
      const ahead = await skewed(30);
      expect(ahead.detail).toContain("30 s ahead of the chain");
      expect(ahead.fix).toContain("NTP");
      expect((await skewed(-45)).detail).toContain("45 s behind the chain");
    });

    it("looks a few slots back when the newest block has no time yet, and warns when none has", async () => {
      const w = await healthyWorld();
      const asked: number[] = [];
      w.node.blockTimeAt = (slot) => {
        asked.push(slot);
        return asked.length < 3 ? "unavailable" : Math.floor(NOW.getTime() / 1000) - 1;
      };
      expect(statusOf(await w.run(), "its clock agrees with this machine's")).toBe("ok");
      expect(asked).toEqual([w.node.slot, w.node.slot - 1, w.node.slot - 2]);

      const none = await healthyWorld();
      none.node.blockTimeAt = () => "unavailable";
      expect(find(await none.run(), "its clock agrees with this machine's").status).toBe("warn");
      const unknown = await healthyWorld();
      unknown.node.blockTime = null;
      expect(find(await unknown.run(), "its clock agrees with this machine's").detail).toContain("no time");
    });
  });

  describe("the history the indexer reads", () => {
    it("warns when the node knows no transaction of a mint that exists", async () => {
      const w = await healthyWorld();
      w.ports.reader = () => new TokenLedger(1_800_000_000);
      const check = find(await w.run(), "it serves the history the indexer reads");
      expect(check.status).toBe("warn");
      expect(check.detail).toContain("may not keep history");
    });

    it("fails when a read fails, saying what the node said", async () => {
      const w = await healthyWorld();
      w.ledger.failOnCall(1);
      const check = find(await w.run(), "it serves the history the indexer reads");
      expect(check.status).toBe("fail");
      expect(check.detail).toContain("node down");
      expect(check.fix).toContain("getSignaturesForAddress");
    });

    it("fails when the node lists a transaction it then cannot give", async () => {
      const w = await healthyWorld();
      w.ports.reader = () => ({ signatures: async () => [{ signature: "s1", slot: 5, failed: false }], transactions: async () => [] });
      const check = find(await w.run(), "it serves the history the indexer reads");
      expect(check.status).toBe("fail");
      expect(check.detail).toContain("no transaction");
    });

    it("fails when the transaction is not in a shape the indexer can read", async () => {
      const w = await healthyWorld();
      const ledger = w.ledger;
      w.ports.reader = () => ({ signatures: (a, q) => ledger.signatures(a, q), transactions: async (s) => (await ledger.transactions(s)).map((t) => ({ ...t, blockTime: null })) });
      const check = find(await w.run(), "it serves the history the indexer reads");
      expect(check.status).toBe("fail");
      expect(check.detail).toContain("reading the mint's history failed");
    });

    it("is skipped when the mint is wrong, which has its own check", async () => {
      const w = await healthyWorld();
      w.node.accounts.delete(MINT);
      const checks = await w.run();
      expect(statusOf(checks, "it serves the history the indexer reads")).toBe("skip");
      expect(statusOf(checks, "TOKEN_MINT is an initialized mint")).toBe("fail");
    });
  });
});

describe("the programs", () => {
  const programs = [
    ["breaks", PROGRAMS.breaks],
    ["treasury", PROGRAMS.treasury],
  ] as const;

  it.each(programs)("fails when the %s program does not exist", async (name, id) => {
    const w = await healthyWorld();
    w.node.accounts.delete(id);
    const check = find(await w.run(), `the ${name} program is deployed`);
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("does not exist");
    expect(check.fix).toContain(`${name.toUpperCase()}_PROGRAM_ID`);
  });

  it.each(programs)("fails when the %s address is a plain account, not a program", async (name, id) => {
    const w = await healthyWorld();
    w.node.executables.delete(id);
    const check = find(await w.run(), `the ${name} program is deployed`);
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("is not a program");
  });

  it.each(programs)("fails when the %s program is not owned by the upgradeable loader", async (name, id) => {
    const w = await healthyWorld();
    w.node.owners.set(id, addr(5));
    const check = find(await w.run(), `the ${name} program is deployed`);
    expect(check.status).toBe("fail");
    expect(check.detail).toContain(`owned by ${addr(5)}`);
  });

  it.each(programs)("fails when the %s program's data is missing or is not a program account", async (name, id) => {
    const missing = await healthyWorld();
    missing.node.accounts.delete(programDataAddress(id));
    expect(find(await missing.run(), `the ${name} program is deployed`).detail).toContain("program-data account");

    const garbage = await healthyWorld();
    garbage.node.accounts.set(id, new Uint8Array(36));
    const check = find(await garbage.run(), `the ${name} program is deployed`);
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("not an upgradeable-loader program account");
  });

  it.each(programs)("names who can upgrade the %s program, and warns when it is the keeper's own key", async (name, id) => {
    const other = await healthyWorld();
    const ok = find(await other.run(), `the ${name} program is deployed`);
    expect(ok.status).toBe("ok");
    expect(ok.detail).toContain(UPGRADER);
    expect(ok.detail).toContain("Squads multisig");

    const hot = await healthyWorld();
    hot.node.accounts.set(programDataAddress(id), programDataAccount(KEEPER_ADDRESS));
    const warned = find(await hot.run(), `the ${name} program is deployed`);
    expect(warned.status).toBe("warn");
    expect(warned.detail).toContain("keeper's own key");
    expect(warned.fix).toContain("Squads multisig");

    const frozen = await healthyWorld();
    frozen.node.accounts.set(programDataAddress(id), programDataAccount(undefined));
    const immutable = find(await frozen.run(), `the ${name} program is deployed`);
    expect(immutable.status).toBe("ok");
    expect(immutable.detail).toContain("can no longer be upgraded");
  });

  it("does not call the key a hot upgrade authority when there is no key to compare", async () => {
    const w = await healthyWorld({ env: { KEEPER_KEYPAIR_PATH: undefined } });
    expect(statusOf(await w.run(), "the breaks program is deployed")).toBe("ok");
  });

  it("fails when the randomness program is missing or not a program", async () => {
    const missing = await healthyWorld();
    missing.node.accounts.delete(ORAO_PROGRAM);
    const gone = find(await missing.run(), "the randomness program is deployed");
    expect(gone.status).toBe("fail");
    expect(gone.detail).toBe(`${ORAO_PROGRAM} does not exist on this cluster`);
    expect(gone.fix).toContain("VRF_PROGRAM_ID");
    const plain = await healthyWorld();
    plain.node.executables.delete(ORAO_PROGRAM);
    const check = find(await plain.run(), "the randomness program is deployed");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("is not a program");
  });
});

describe("set up on the chain", () => {
  it("fails when the treasury is not initialized, and skips what needs it", async () => {
    const w = await healthyWorld();
    w.node.accounts.delete(treasuryAddresses(PROGRAMS.treasury).config);
    const checks = await w.run();
    const check = find(checks, "the treasury is initialized");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("has not been initialized");
    expect(check.fix).toContain("initialize");
    for (const title of ["the treasury takes orders from the breaks program", "both programs count in the same USDC", "the admins are not the keeper's key", "the reserve can pay for the next break"]) {
      expect(statusOf(checks, title), title).toBe("skip");
    }
    expect(statusOf(checks, "the breaks program is initialized")).toBe("ok");
    expect(statusOf(checks, "this key is the breaks program's keeper")).toBe("ok");
  });

  it("fails when an account at the right address belongs to another program", async () => {
    const w = await healthyWorld();
    w.node.owners.set(treasuryAddresses(PROGRAMS.treasury).config, addr(7));
    expect(find(await w.run(), "the treasury is initialized").detail).toContain(`owned by ${addr(7)}`);
    const b = await healthyWorld();
    b.node.owners.set(configAddress(PROGRAMS), addr(7));
    expect(find(await b.run(), "the breaks program is initialized").detail).toContain(`owned by ${addr(7)}`);
  });

  it("fails when the breaks program is not initialized, and skips what needs it", async () => {
    const w = await healthyWorld();
    w.node.accounts.delete(configAddress(PROGRAMS));
    const checks = await w.run();
    expect(find(checks, "the breaks program is initialized").status).toBe("fail");
    for (const title of [
      "this key is the breaks program's keeper",
      "it uses the configured randomness program",
      "sales are not paused",
      "both programs count in the same USDC",
      "the admins are not the keeper's key",
      "the buyer wallet can receive USDC",
      "the configured break is one the program accepts",
      "the reserve can pay for the next break",
    ]) {
      expect(statusOf(checks, title), title).toBe("skip");
    }
    expect(statusOf(checks, "ORAO is ready to answer")).toBe("ok");
    expect(statusOf(checks, "the treasury is initialized")).toBe("ok");
  });

  it("fails when this key is not the program's keeper, naming both", async () => {
    const w = await healthyWorld();
    const checks = await spoil(w, () => (w.breaks.keeper = addr(9)));
    const check = find(checks, "this key is the breaks program's keeper");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain(KEEPER_ADDRESS);
    expect(check.detail).toContain(addr(9));
    expect(check.fix).toContain("set_keeper");
  });

  it("fails when the program asks another randomness program than VRF_PROGRAM_ID", async () => {
    const w = await healthyWorld();
    const checks = await spoil(w, () => (w.breaks.randomnessProgram = addr(8)));
    const check = find(checks, "it uses the configured randomness program");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain(addr(8));
    expect(check.detail).toContain(ORAO_PROGRAM);
    expect(check.fix).toContain("set_randomness");
  });

  it("warns when the program is paused", async () => {
    const w = await healthyWorld();
    const check = find(await spoil(w, () => (w.breaks.paused = true)), "sales are not paused");
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("paused");
    expect(check.fix).toContain("set_paused");
  });

  it("fails when the treasury's controller is not the breaks program's authority, and gives the address to set", async () => {
    const w = await healthyWorld();
    const check = find(await spoil(w, () => (w.treasury.controller = addr(6))), "the treasury takes orders from the breaks program");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain(addr(6));
    expect(check.fix).toContain(treasuryAuthorityAddress(PROGRAMS));
    expect(check.fix).toContain("set_controller");
  });

  it("fails when the two programs count in different USDC", async () => {
    const w = await healthyWorld();
    const check = find(await spoil(w, () => (w.treasury.usdcMint = addr(0xc1))), "both programs count in the same USDC");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain(USDC);
    expect(check.detail).toContain(addr(0xc1));
  });

  it("fails when the USDC mint does not exist and warns when it does not have 6 decimals", async () => {
    const missing = await healthyWorld();
    missing.node.accounts.delete(USDC);
    const gone = find(await missing.run(), "both programs count in the same USDC");
    expect(gone.status).toBe("fail");
    expect(gone.detail).toBe(`the USDC mint ${USDC} does not exist on this cluster`);
    const odd = await healthyWorld();
    odd.node.accounts.set(USDC, mintData(1n, 9));
    const check = find(await odd.run(), "both programs count in the same USDC");
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("9 decimals");
  });

  it("warns when the keeper's own key holds an admin role, naming which", async () => {
    const both = await healthyWorld();
    let check = find(await spoil(both, () => ((both.breaks.admin = KEEPER_ADDRESS), (both.treasury.admin = KEEPER_ADDRESS))), "the admins are not the keeper's key");
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("the breaks program's admin and the treasury's admin");
    const breaksOnly = await healthyWorld();
    check = find(await spoil(breaksOnly, () => (breaksOnly.breaks.admin = KEEPER_ADDRESS)), "the admins are not the keeper's key");
    expect(check.detail).toContain("is the breaks program's admin");
    expect(check.detail).not.toContain("treasury's admin");
    const treasuryOnly = await healthyWorld();
    check = find(await spoil(treasuryOnly, () => (treasuryOnly.treasury.admin = KEEPER_ADDRESS)), "the admins are not the keeper's key");
    expect(check.detail).toContain("is the treasury's admin");
    expect(check.detail).not.toContain("breaks program's admin");
  });

  describe("the buyer wallet", () => {
    const ata = () => associatedTokenAddress(BUYER_WALLET, USDC);

    it("fails when it has no USDC account, which fund_purchases would need", async () => {
      const w = await healthyWorld();
      w.node.accounts.delete(ata());
      const check = find(await w.run(), "the buyer wallet can receive USDC");
      expect(check.status).toBe("fail");
      expect(check.detail).toContain(BUYER_WALLET);
      expect(check.detail).toContain(ata());
    });

    it("fails when the account is another wallet's, another token's or frozen, and shows the balance otherwise", async () => {
      const wrongOwner = await healthyWorld();
      wrongOwner.node.accounts.set(ata(), encodeTokenAccount({ mint: USDC, owner: addr(4), amount: 0n }));
      expect(find(await wrongOwner.run(), "the buyer wallet can receive USDC").detail).toBe(`${ata()} is not the buyer's USDC account`);
      const wrongMint = await healthyWorld();
      wrongMint.node.accounts.set(ata(), encodeTokenAccount({ mint: addr(4), owner: BUYER_WALLET, amount: 0n }));
      expect(find(await wrongMint.run(), "the buyer wallet can receive USDC").detail).toBe(`${ata()} is not the buyer's USDC account`);
      const frozen = await healthyWorld();
      const data = encodeTokenAccount({ mint: USDC, owner: BUYER_WALLET, amount: 0n });
      data[108] = 2;
      frozen.node.accounts.set(ata(), data);
      expect(find(await frozen.run(), "the buyer wallet can receive USDC").detail).toContain("frozen");
      const funded = await healthyWorld();
      funded.node.accounts.set(ata(), encodeTokenAccount({ mint: USDC, owner: BUYER_WALLET, amount: 12_340_000n }));
      const ok = find(await funded.run(), "the buyer wallet can receive USDC");
      expect(ok.status).toBe("ok");
      expect(ok.detail).toContain("$12.34");
    });
  });

  it("fails when the configured break is one the program would refuse, and then has nothing to say about the reserve", async () => {
    const w = await healthyWorld({ env: { BREAK_PAID_SPOTS: "30", BREAK_PACKS: JSON.stringify([{ machine: "pokemon-25", maxPrice: "25000000", count: 32 }]) } });
    const checks = await w.run();
    const check = find(checks, "the configured break is one the program accepts");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("paid spots 30 is outside 1..20");
    expect(statusOf(checks, "the reserve can pay for the next break")).toBe("skip");
    const window = await healthyWorld({ env: { BREAK_WINDOW_SECS: "120" } });
    expect(find(await window.run(), "the configured break is one the program accepts").detail).toContain("120 s is outside 3600..86400");
    const ok = find(await (await healthyWorld()).run(), "the configured break is one the program accepts");
    expect(ok.detail).toBe("10 paid spots at $20, 2 free, packs 12 × pokemon-25 up to $25, open 43200 s");
  });

  describe("a break of several machines", () => {
    const MIXED = {
      BREAK_PAID_SPOTS: "6",
      BREAK_FREE_SPOTS: "2",
      BREAK_PACKS: JSON.stringify([
        { machine: "top", maxPrice: "50000000", count: 2 },
        { machine: "cheap", maxPrice: "10000000", count: 4 },
        { machine: "mid", maxPrice: "25000000", count: 2 },
      ]),
    };

    it("lists the packs cheapest first", async () => {
      const w = await healthyWorld({ env: MIXED });
      const check = find(await w.run(), "the configured break is one the program accepts");
      expect(check.status).toBe("ok");
      expect(check.detail).toBe("6 paid spots at $20, 2 free, packs 4 × cheap up to $10, 2 × mid up to $25, 2 × top up to $50, open 43200 s");
    });

    it("measures the reserve against what the whole list needs: $22.50 of subsidy and $47.50 for the holders", async () => {
      const exact = await healthyWorld({ env: MIXED });
      exact.fund(22_500_000n, 47_500_000n);
      expect(find(await exact.run(), "the reserve can pay for the next break").status).toBe("ok");
      const short = await healthyWorld({ env: MIXED });
      short.fund(22_499_999n, 47_500_000n);
      const check = find(await short.run(), "the reserve can pay for the next break");
      expect(check.status).toBe("warn");
      expect(check.detail).toContain("99%");
      expect(check.detail).toContain("subsidy bucket has $22.499999 of $22.5 needed, the holder bucket $47.5 of $47.5");
    });

    it("fails a list that does not match the spots, before anything is sent", async () => {
      const w = await healthyWorld({ env: { ...MIXED, BREAK_FREE_SPOTS: "3" } });
      const parsed = find(await w.run(), "the settings load");
      expect(parsed.status).toBe("fail");
      expect(parsed.detail).toContain("BREAK_PACKS");
      expect(parsed.detail).toContain("lists 8 packs but BREAK_PAID_SPOTS + BREAK_FREE_SPOTS is 9");
    });
  });

  describe("the reserve", () => {
    it("is enough at exactly the worst case and a warning one micro-dollar below it, never rounding up to 100%", async () => {
      const exact = await healthyWorld();
      exact.fund(50_000_000n, 50_000_000n);
      expect(find(await exact.run(), "the reserve can pay for the next break").status).toBe("ok");
      const short = await healthyWorld();
      short.fund(49_999_999n, 50_000_000n);
      const check = find(await short.run(), "the reserve can pay for the next break");
      expect(check.status).toBe("warn");
      expect(check.detail).toContain("99%");
      expect(check.detail).toContain("subsidy bucket has $49.999999 of $50 needed");
      expect(check.fix).toContain("SWEEP_ENABLED");
    });

    it("lets the bucket furthest from its target decide", async () => {
      const w = await healthyWorld();
      w.fund(1_000_000_000n, 10_000_000n);
      const check = find(await w.run(), "the reserve can pay for the next break");
      expect(check.status).toBe("warn");
      expect(check.detail).toContain("20%");
      expect(check.detail).toContain("holder bucket $10 of $50");
    });

    it("counts only what is not reserved for a break that exists, and nothing when more is reserved than held", async () => {
      const w = await healthyWorld();
      w.fund(100_000_000n, 100_000_000n);
      let check = find(await spoil(w, () => (w.treasury.lockedSubsidy = 60_000_000n)), "the reserve can pay for the next break");
      expect(check.detail).toContain("80%");
      expect(check.detail).toContain("subsidy bucket has $40 of $50");
      check = find(await spoil(w, () => (w.treasury.lockedHolder = 500_000_000n)), "the reserve can pay for the next break");
      expect(check.detail).toContain("the holder bucket $0 of $50");
      expect(check.detail).toContain("0%:");
    });

    it("fails, rather than skipping, when a vault is missing or holds another token", async () => {
      const t = treasuryAddresses(PROGRAMS.treasury);
      const missing = await healthyWorld();
      missing.node.accounts.delete(t.holderVault);
      let check = find(await missing.run(), "the reserve can pay for the next break");
      expect(check.status).toBe("fail");
      expect(check.detail).toContain("the holder vault does not exist");
      const other = await healthyWorld();
      other.node.accounts.set(t.subsidyVault, encodeTokenAccount({ mint: addr(3), owner: t.config, amount: 5n }));
      check = find(await other.run(), "the reserve can pay for the next break");
      expect(check.status).toBe("fail");
      expect(check.detail).toContain("the subsidy vault holds");
    });
  });

  describe("ORAO", () => {
    it("reports the fee and the oracles", async () => {
      const check = find(await (await healthyWorld()).run(), "ORAO is ready to answer");
      expect(check.detail).toBe(`the fee is 0.0003 SOL to ${addr(0xa2)}, 2 oracles`);
    });

    it("fails with no oracles, and when the network state is missing, pointing at VRF_PROGRAM_ID", async () => {
      const none = await healthyWorld();
      none.node.accounts.set(oraoNetworkState(ORAO_PROGRAM), encodeNetworkState({ authority: addr(1), treasury: addr(2), requestFee: 1n, fulfillmentAuthorities: [], numReceived: 0n }));
      const noOracles = find(await none.run(), "ORAO is ready to answer");
      expect(noOracles.status).toBe("fail");
      expect(noOracles.detail).toContain("lists no oracles");
      const gone = await healthyWorld();
      gone.node.accounts.delete(oraoNetworkState(ORAO_PROGRAM));
      const check = find(await gone.run(), "ORAO is ready to answer");
      expect(check.status).toBe("fail");
      expect(check.detail).toContain("VRF_PROGRAM_ID");
    });
  });
});

describe("the keeper's wallet", () => {
  // creating a break: 10,760,160 + 2,039,280 rent, 5,000 fee, 890,880 kept = 13,695,320.
  // one whole break with 2 free spots: + 8 more transactions at 5,000, ORAO's fee 300,000 and its request account's rent 6,103,920.
  const create = 13_695_320n;
  const cycle = 20_139_240n;
  const holding = async (lamports: bigint, env: Record<string, string> = {}) => {
    const w = await healthyWorld({ env });
    w.node.lamports.set(KEEPER_ADDRESS, lamports);
    return find(await w.run(), "it holds the SOL to run breaks");
  };

  it("fails below what creating a break needs, to the lamport", async () => {
    const short = await holding(create - 1n);
    expect(short.status).toBe("fail");
    expect(short.detail).toContain("creating a break needs 0.01369532 SOL");
    expect(short.fix).toContain(`solana transfer ${KEEPER_ADDRESS}`);
    expect((await holding(create)).status).toBe("warn");
  });

  it("only warns when the scheduler is off, since nothing needs to be created", async () => {
    expect((await holding(create - 1n, { BREAK_AUTO_CREATE: "false" })).status).toBe("warn");
  });

  it("warns below what one break needs all the way through, to the lamport, and is fine at it", async () => {
    const enough = await holding(cycle - 1n);
    expect(enough.status).toBe("warn");
    expect(enough.detail).toContain("enough to create a break, not to see one through, which needs about 0.02013924 SOL");
    const ok = await holding(cycle);
    expect(ok.status).toBe("ok");
    expect(ok.detail).toContain("seeing one through about 0.02013924 SOL");
  });

  it("counts ORAO's fee and a claim for every free spot", async () => {
    const four = { BREAK_FREE_SPOTS: "4", BREAK_PACKS: JSON.stringify([{ machine: "pokemon-25", maxPrice: "25000000", count: 14 }]) };
    const more = await holding(cycle + 5_000n * 2n - 1n, four);
    expect(more.status).toBe("warn");
    expect((await holding(cycle + 5_000n * 2n, four)).status).toBe("ok");
  });

  it("says when ORAO's fee could not be counted", async () => {
    const w = await healthyWorld();
    w.node.accounts.delete(oraoNetworkState(ORAO_PROGRAM));
    const check = find(await w.run(), "it holds the SOL to run breaks");
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("ORAO's fee is not counted");
  });

  it("fails, with the node's words, when the balance cannot be read", async () => {
    const w = await healthyWorld();
    w.failing.add("getBalance");
    const check = find(await w.run(), "it holds the SOL to run breaks");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("the node refused getBalance");
  });

  describe("the fee sweep's USDC", () => {
    const sweep = { SWEEP_ENABLED: "true" };
    it("says it is off when it is off", async () => {
      expect(find(await (await healthyWorld()).run(), "the fee sweep has USDC to deposit from").detail).toContain("is off");
    });

    it("fails when the sweep is on and the keeper has no USDC account, and shows the balance when it has", async () => {
      const w = await healthyWorld({ env: sweep });
      const check = find(await w.run(), "the fee sweep has USDC to deposit from");
      expect(check.status).toBe("fail");
      expect(check.detail).toContain("no USDC account");
      const account = associatedTokenAddress(KEEPER_ADDRESS, USDC);
      w.node.accounts.set(account, encodeTokenAccount({ mint: USDC, owner: KEEPER_ADDRESS, amount: 7_500_000n }));
      const ok = find(await w.run(), "the fee sweep has USDC to deposit from");
      expect(ok.status).toBe("ok");
      expect(ok.detail).toContain("holds $7.5");
      expect(ok.detail).toContain("at least $1 is deposited");
    });
  });
});

describe("the token", () => {
  it("shows the mint's decimals and supply", async () => {
    const check = find(await (await healthyWorld()).run(), "TOKEN_MINT is an initialized mint");
    expect(check.detail).toBe(`${MINT}: 6 decimals, supply 1,000,000,000`);
  });

  it("fails when TOKEN_MINT is missing, not a mint, or not initialized", async () => {
    const missing = await healthyWorld();
    missing.node.accounts.delete(MINT);
    const gone = find(await missing.run(), "TOKEN_MINT is an initialized mint");
    expect(gone.status).toBe("fail");
    expect(gone.detail).toContain("does not exist");
    const wrong = await healthyWorld();
    wrong.node.accounts.set(MINT, new Uint8Array(10));
    const short = find(await wrong.run(), "TOKEN_MINT is an initialized mint");
    expect(short.status).toBe("fail");
    expect(short.detail).toBe(`TOKEN_MINT ${MINT} is not an initialized token mint`);
    const blank = await healthyWorld();
    blank.node.accounts.set(MINT, new Uint8Array(82));
    expect(find(await blank.run(), "TOKEN_MINT is an initialized mint").detail).toContain("not an initialized token mint");
  });

  it("explains MIN_TWAB in whole tokens and as a share of the supply", async () => {
    const check = find(await (await healthyWorld()).run(), "MIN_TWAB and WEIGHT_CAP make sense for it");
    expect(check.status).toBe("ok");
    expect(check.detail).toBe("MIN_TWAB is 1,000,000 tokens (1,000,000,000,000 base units, 0.1% of the supply), no WEIGHT_CAP");
    const nine = await healthyWorld();
    nine.node.accounts.set(MINT, mintData(5_000_000_000_000n, 9));
    expect(find(await nine.run(), "MIN_TWAB and WEIGHT_CAP make sense for it").detail).toContain("MIN_TWAB is 1,000 tokens");
  });

  it("fails, without dividing by it, when the token has no supply at all", async () => {
    const w = await healthyWorld();
    w.node.accounts.set(MINT, mintData(0n, 6));
    const check = find(await w.run(), "MIN_TWAB and WEIGHT_CAP make sense for it");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("the supply is zero");
    expect(check.detail).toContain("more than exists");
  });

  it("fails when MIN_TWAB is more than exists (the usual mistake: tokens where base units are meant)", async () => {
    const over = await healthyWorld({ env: { MIN_TWAB: "1000000000000001" } });
    const check = find(await over.run(), "MIN_TWAB and WEIGHT_CAP make sense for it");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("more than exists");
    expect(check.fix).toContain("10^decimals");
    const exact = await healthyWorld({ env: { MIN_TWAB: "1000000000000000" } });
    expect(find(await exact.run(), "MIN_TWAB and WEIGHT_CAP make sense for it").status).toBe("ok");
  });

  it("warns when the cap is below the minimum, and not when it is equal or above", async () => {
    const below = await healthyWorld({ env: { WEIGHT_CAP: "999999999999" } });
    const check = find(await below.run(), "MIN_TWAB and WEIGHT_CAP make sense for it");
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("every eligible wallet gets the same weight");
    for (const cap of ["1000000000000", "5000000000000"]) {
      const w = await healthyWorld({ env: { WEIGHT_CAP: cap } });
      expect(find(await w.run(), "MIN_TWAB and WEIGHT_CAP make sense for it").status).toBe("ok");
    }
  });
});

describe("the database", () => {
  it("fails when it cannot be reached, and skips what needs it", async () => {
    const w = await healthyWorld();
    w.dbDown = { message: "connect ECONNREFUSED db.example:5432" };
    const checks = await w.run();
    const check = find(checks.filter((c) => c.section === "The database"), "it answers");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("ECONNREFUSED");
    expect(statusOf(checks, "every migration is applied")).toBe("skip");
    expect(statusOf(checks, "the keeper's role can write")).toBe("skip");
    expect(statusOf(checks, "the breaks program is deployed")).toBe("ok");
  });

  it("fails and names each missing migration when the schema is not there", async () => {
    const w = await healthyWorld({ skipDb: true });
    const dir = join(import.meta.dirname, "..", "..", "db", "migrations");
    await w.db.exec(readFileSync(join(dir, readdirSync(dir).sort()[0] as string), "utf8"));
    const check = find(await w.run(), "every migration is applied");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("(migration 0002)");
    expect(check.detail).toContain("(migration 0008)");
    expect(check.fix).toContain("db/migrations");
  });

  it("checks that every active exclusion can go out in the public exclusion list, as the planner will", async () => {
    const w = await healthyWorld({ ownDb: true });
    expect(find(await w.run(), "the exclusion list can be published")).toMatchObject({ status: "ok", detail: "no wallet is excluded" });
    await w.db.query("insert into exclusions (wallet, reason_code, note) values ($1, 'team', 'private'), ($2, 'removed code', 'gone')", [addr(41), addr(42)]);
    await w.db.query("update exclusions set removed_at = now() where wallet = $1", [addr(42)]);
    expect(find(await w.run(), "the exclusion list can be published")).toMatchObject({ status: "ok", detail: "1 wallet is excluded, each with a code the public exclusion list can carry" });
    await w.db.query("insert into exclusions (wallet, reason_code) values ('not-a-wallet', 'team'), ($1, 'lp pool')", [addr(43)]);
    const check = find(await w.run(), "the exclusion list can be published");
    expect(check.status).toBe("fail");
    expect(check.detail).toBe(`2 of the 3 active exclusions cannot go out in the public exclusion list: ${exclusionProblem(addr(43), "lp pool")}; ${exclusionProblem("not-a-wallet", "team")}`);
    expect(check.fix).toContain("until then the keeper makes no eligibility list");
    for (let i = 0; i < 5; i++) await w.db.query("insert into exclusions (wallet, reason_code) values ($1, '')", [addr(50 + i)]);
    expect(find(await w.run(), "the exclusion list can be published").detail).toMatch(/^7 of the 8 active exclusions .*; and 2 more$/);
    await w.db.query("delete from exclusions");
    expect(find(await w.run(), "the exclusion list can be published").status).toBe("ok");
  });

  it("skips the exclusion check when there is no exclusions table", async () => {
    const w = await healthyWorld({ skipDb: true });
    expect(find(await w.run(), "the exclusion list can be published")).toMatchObject({ status: "skip", detail: "there is no exclusions table (the migration check says why)" });
  });

  it("fails when the role it connects as cannot insert or update", async () => {
    const w = await healthyWorld({ ownDb: true });
    await w.db.exec("create role reader; grant select on all tables in schema public to reader; set role reader;");
    const check = find(await w.run(), "the keeper's role can write");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("breaks (insert and update)");
    expect(check.detail).toContain("balance_events");
    expect(check.fix).toContain("GRANT");
    await w.db.exec("reset role; create role writer; grant select, insert on all tables in schema public to writer; set role writer;");
    expect(find(await w.run(), "the keeper's role can write").detail).toContain("breaks (update)");
    await w.db.exec("reset role; grant update on all tables in schema public to writer;");
    expect(find(await w.run(), "the keeper's role can write").status).toBe("ok");
  });

  it("does not repeat a missing table as a privilege problem", async () => {
    const w = await healthyWorld({ skipDb: true });
    const check = find(await w.run(), "the keeper's role can write");
    expect(check.status).toBe("ok");
  });
});

describe("the outputs", () => {
  it("warns when nothing is published, and fails when the folder cannot be created", async () => {
    const off = await healthyWorld({ env: { PUBLISH_DIR: undefined } });
    const check = find(await off.run(), "the published lists have somewhere to go");
    expect(check.status).toBe("warn");
    expect(check.fix).toContain("docs/PUBLISHED.md");

    const w = await healthyWorld();
    w.env.PUBLISH_DIR = join(w.keyPath, "lists"); // under a file
    const bad = find(await w.run(), "the published lists have somewhere to go");
    expect(bad.status).toBe("fail");
    expect(bad.detail).toContain("is not a folder");
    const file = await healthyWorld();
    file.env.PUBLISH_DIR = file.keyPath;
    expect(find(await file.run(), "the published lists have somewhere to go").detail).toContain("is not a folder");
  });

  it("is happy with a folder that does not exist yet when the nearest one that does can be written to", async () => {
    const w = await healthyWorld();
    w.env.PUBLISH_DIR = join(w.dir, "new", "deeper", "lists");
    expect(find(await w.run(), "the published lists have somewhere to go").status).toBe("ok");
  });

  it.skipIf(process.getuid?.() === 0)("fails when the folder is not writable by this user", async () => {
    const w = await healthyWorld();
    const locked = join(w.dir, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o500);
    w.env.PUBLISH_DIR = join(locked, "lists");
    const check = find(await w.run(), "the published lists have somewhere to go");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("cannot be written to");
    chmodSync(locked, 0o700);
  });

  it("says what the X bot will do", async () => {
    expect(find(await (await healthyWorld()).run(), "the X bot").detail).toContain("off");
    const dry = await healthyWorld({ env: { BOT_ENABLED: "true" } });
    expect(find(await dry.run(), "the X bot").detail).toContain("dry run");
    const live = await healthyWorld({
      env: { BOT_ENABLED: "true", BOT_POSTER: "x", BOT_MAX_POSTS_PER_DAY: "7", X_CONSUMER_KEY: "ck", X_CONSUMER_SECRET: "cs", X_ACCESS_TOKEN: "at", X_ACCESS_TOKEN_SECRET: "ats" },
    });
    const check = find(await live.run(), "the X bot");
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("posts to X");
    expect(check.detail).toContain("at most 7 a day");
  });

  it("says where the watchdog's alerts go, and warns when only the log hears them", async () => {
    const telegram = find(await (await healthyWorld()).run(), "the watchdog's alerts");
    expect(telegram.status).toBe("ok");
    expect(telegram.detail).toBe(
      "a problem that lasts 15 min is reported once, and again when it clears, in the keeper's log and in the Telegram chat -1001234567890; not checked here: the keeper sends a message there when it starts, which shows the token and the chat work",
    );
    const logOnly = find(await (await healthyWorld({ env: { ALERTS: undefined, ALERT_AFTER_MINS: "5" } })).run(), "the watchdog's alerts");
    expect(logOnly.status).toBe("warn");
    expect(logOnly.detail).toBe("a problem that lasts 5 min is reported once, and again when it clears, only in the keeper's log: nobody is told when a break gets stuck");
    expect(logOnly.fix).toContain("ALERTS=telegram");
    expect(logOnly.fix).toContain("pnpm --filter keeper send-test-alert");
  });

  it("says whether an outside check is told the keeper is alive, without its address", async () => {
    const set = find(await (await healthyWorld({ env: { WATCH_INTERVAL_SECS: "30" } })).run(), "an outside check");
    expect(set.status).toBe("ok");
    expect(set.detail).toBe("the watchdog pings ALERT_HEARTBEAT_URL every 30 s while its alerts get through; give the check that period and some grace. Not pinged here: a ping says the keeper is running");
    const unset = find(await (await healthyWorld({ env: { ALERT_HEARTBEAT_URL: undefined } })).run(), "an outside check");
    expect(unset.status).toBe("warn");
    expect(unset.detail).toContain("nobody is told if the keeper itself stops");
    expect(unset.fix).toContain("ALERT_HEARTBEAT_URL");
    const bad = await healthyWorld({ env: { ALERT_HEARTBEAT_URL: "http://hc.example/ping/x" } });
    expect(find(await bad.run(), "the settings load").detail).toContain("ALERT_HEARTBEAT_URL: must be an https:// address (or http:// to this machine)");
  });
});

describe("secrets", () => {
  const url = `https://rpc.example/${SECRET_RPC_PATH}`;

  it("never prints the node's url, the database password or a key's contents, even when an error repeats them", async () => {
    const w = await healthyWorld({ env: { X_ACCESS_TOKEN: "x-token-0123456789" } });
    w.nodeDown = (u) => new Error(`request to ${u} failed`);
    w.dbDown = { message: `could not connect to postgres://keeper:${SECRET_DB_PASSWORD}@db.example:5432/breaks` };
    const result = await main([], { env: w.env, ports: w.ports });
    expect(result.code).toBe(1);
    expect(result.out).toContain("cannot reach the node");
    expect(result.out).toContain("cannot reach the database");
    expect(result.out).toContain("[hidden]");
    for (const secret of [url, SECRET_RPC_PATH, SECRET_DB_PASSWORD, "postgres://keeper"]) expect(result.out, secret).not.toContain(secret);
  });

  it("never prints the Telegram bot token, also when it is malformed or pasted where the chat goes", async () => {
    const healthy = await main([], { env: (await healthyWorld()).env, ports: (await healthyWorld()).ports });
    expect(healthy.out).not.toContain(SECRET_TELEGRAM_TOKEN);
    const bad = await healthyWorld({ env: { ALERT_TELEGRAM_BOT_TOKEN: "not-a-token-but-a-secret-0123456789" } });
    const refused = await main([], { env: bad.env, ports: bad.ports });
    expect(refused.out).toContain("ALERT_TELEGRAM_BOT_TOKEN: is not a bot token");
    expect(refused.out).not.toContain("not-a-token-but-a-secret-0123456789");
    const swapped = await healthyWorld({ env: { ALERT_TELEGRAM_CHAT_ID: SECRET_TELEGRAM_TOKEN } });
    const out = await main([], { env: swapped.env, ports: swapped.ports });
    expect(out.out).toContain("ALERT_TELEGRAM_CHAT_ID: must be a chat's number");
    expect(out.out).not.toContain(SECRET_TELEGRAM_TOKEN);
    // The outside check's address is a secret too, wherever it turns up.
    const beat = await healthyWorld({ env: { PUBLISH_DIR: `/srv/${SECRET_HEARTBEAT_KEY}` } });
    const beatOut = await main([], { env: beat.env, ports: beat.ports });
    expect(beatOut.out).not.toContain(SECRET_HEARTBEAT_KEY);
    expect(beatOut.out).not.toContain("hc.example/ping");
    // Pasted into a setting the report does print, it is still hidden.
    const pasted = await healthyWorld({ env: { PUBLISH_DIR: `/srv/${SECRET_TELEGRAM_TOKEN}` } });
    const printed = await main([], { env: pasted.env, ports: pasted.ports });
    expect(printed.out).toContain("/srv/[hidden]"); // writable or not (CI does not run as root), the path is printed, hidden
    expect(printed.out).not.toContain(SECRET_TELEGRAM_TOKEN);
  });

  it("hides a secret in what it tells the operator to do, not only in what it found", async () => {
    const w = await healthyWorld();
    const folder = join(w.dir, SECRET_RPC_PATH);
    mkdirSync(folder);
    const inside = join(folder, "keeper.json");
    writeFileSync(inside, readFileSync(w.keyPath));
    chmodSync(inside, 0o644);
    w.env.KEEPER_KEYPAIR_PATH = inside;
    const result = await main([], { env: w.env, ports: w.ports });
    expect(result.out).toContain("to fix: chmod 600");
    expect(result.out).toContain("[hidden]");
    expect(result.out).not.toContain(SECRET_RPC_PATH);
  });

  it("hides what a node's error says about the history it was asked for", async () => {
    const w = await healthyWorld({ env: { X_ACCESS_TOKEN: "x-token-0123456789", BOT_ENABLED: "true" } });
    w.ports.reader = () => ({
      signatures: async () => {
        throw new Error(`${url} said no; token x-token-0123456789`);
      },
      transactions: async () => [],
    });
    const result = await main([], { env: w.env, ports: w.ports });
    expect(result.out).toContain("reading the mint's history failed");
    expect(result.out).not.toContain(SECRET_RPC_PATH);
    expect(result.out).not.toContain("x-token-0123456789");
  });

  it("hides the pieces of a url that can be a secret, and nothing that is only a name", () => {
    expect(urlSecrets("https://user:p%40ss-word@rpc.example/v2/ABCDEF123456?api-key=KEY0123456", "rpc")).toEqual(
      expect.arrayContaining(["p@ss-word", "p%40ss-word", "user", "v2/ABCDEF123456?api-key=KEY0123456", "KEY0123456", "ABCDEF123456"]),
    );
    // A part of the path of at least 12 characters can be a key on its own; a shorter one is a name.
    expect(urlSecrets("https://hc.example/ping/0123456789a", "rpc")).not.toContain("0123456789a");
    expect(urlSecrets("https://hc.example/ping/0123456789ab", "rpc")).toContain("0123456789ab");
    expect(urlSecrets("https://hc.example/ping/0123456789ab", "rpc")).not.toContain("ping");
    expect(urlSecrets("https://hc.example/a%20key%20with%20spaces", "rpc")).toEqual(expect.arrayContaining(["a key with spaces", "a%20key%20with%20spaces"]));
    expect(urlSecrets("https://api.devnet.solana.com", "rpc")).toEqual(["https://api.devnet.solana.com"]);
    const db = urlSecrets("postgres://keeper:hunter2hunter2@db.example:5432/breaks", "db");
    expect(db).toContain("hunter2hunter2");
    expect(db).not.toContain("breaks");
    expect(db).not.toContain("keeper");
    expect(urlSecrets("not a url", "rpc")).toEqual(["not a url"]);
    expect(urlSecrets(undefined, "db")).toEqual([]);
  });

  it("hides longest first and ignores anything too short to be a secret", () => {
    const hide = scrubber(["abc", "https://rpc.example/KEY12345", "KEY12345", "password"]);
    expect(hide("see https://rpc.example/KEY12345 and KEY12345 and password and abc")).toBe("see [hidden] and [hidden] and [hidden] and abc");
  });
});

describe("main", () => {
  it("prints the usage for --help and refuses an argument it does not know", async () => {
    const help = await main(["--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("usage: pnpm --filter keeper check-setup");
    const bad = await main(["--fix"]);
    expect(bad.code).toBe(2);
    expect(bad.out).toContain("unknown argument --fix");
    expect(bad.out).toContain("usage: pnpm --filter keeper check-setup");
  });

  it("ignores the bare -- that pnpm passes, exits 0 when nothing failed and 1 when something did", async () => {
    const w = await healthyWorld();
    const ready = await main(["--"], { env: w.env, ports: w.ports });
    expect(ready.code).toBe(0);
    expect(ready.out).toContain("READY. 36 checks passed, 1 warning, 0 failures, 0 skipped.");
    const broken = await healthyWorld({ env: { MIN_TWAB: undefined } });
    const failed = await main([], { env: broken.env, ports: broken.ports });
    expect(failed.code).toBe(1);
    expect(failed.out).toContain("NOT READY.");
  });

  it("builds the real client from the settings and refuses an unreachable database quickly, with the reason", async () => {
    const config = { rpcUrl: "https://rpc.example/key", databaseUrl: "postgres://user:pw@127.0.0.1:1/breaks" } as Config;
    expect(realPorts.rpc(config)).toBeInstanceOf(RpcClient);
    await expect(realPorts.connectDb(config)).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe("the report", () => {
  const check = (over: Partial<Check>): Check => ({ section: "S", title: "t", status: "ok", detail: "d", ...over });

  it("counts by status and is ready only when nothing failed", () => {
    const r = summarize([check({}), check({ status: "warn" }), check({ status: "warn" }), check({ status: "skip" }), check({ status: "fail" })]);
    expect(r).toMatchObject({ ok: 1, warned: 2, failed: 1, skipped: 1, ready: false });
    expect(summarize([check({ status: "warn" })]).ready).toBe(true);
    expect(summarize([]).ready).toBe(true);
  });

  it("shows a fix for warnings and failures only, and the details indented", () => {
    const text = render(
      summarize([
        check({ title: "fine", fix: "never shown" }),
        check({ title: "meh", status: "warn", detail: "line one\nline two", fix: "do this" }),
        check({ title: "bad", status: "fail", fix: "do that" }),
      ]),
    );
    expect(text).toContain("[ ok ] fine");
    expect(text).not.toContain("never shown");
    expect(text).toContain("[warn] meh\n         line one\n         line two\n         to fix: do this");
    expect(text).toContain("[FAIL] bad\n         d\n         to fix: do that");
    expect(text).toContain("NOT READY. 1 check passed, 1 warning, 1 failure, 0 skipped.");
  });

  it("puts a skipped check on one line, and a section where everything is skipped once", () => {
    const text = render(
      summarize([
        check({ section: "A", title: "x", status: "fail" }),
        check({ section: "A", title: "y", status: "skip", detail: "needs x" }),
        check({ section: "B", title: "p", status: "skip", detail: "needs x" }),
        check({ section: "B", title: "q", status: "skip", detail: "needs x" }),
        check({ section: "B", title: "r", status: "skip", detail: "needs z" }),
      ]),
    );
    expect(text).toContain("  [skip] y: needs x");
    expect(text).toContain("B\n  [skip] all 3 checks: needs x; needs z");
    expect(text).toContain("Skipped checks depend on one that failed");
  });

  it("keeps a skipped check in a section of its own on its line, with its title", () => {
    const text = render(summarize([check({ section: "A", title: "x", status: "fail" }), check({ section: "B", title: "only one", status: "skip", detail: "needs x" })]));
    expect(text).toContain("B\n  [skip] only one: needs x");
    expect(text).not.toContain("all 1 checks");
  });

  it("says READY, and reminds to read the warnings when there are some", () => {
    expect(render(summarize([check({})]))).toContain("READY. 1 check passed, 0 warnings, 0 failures, 0 skipped.");
    expect(render(summarize([check({})]))).not.toContain("read the warnings");
    expect(render(summarize([check({ status: "warn" })]))).toContain("The keeper will start; read the warnings first.");
  });
});

describe("the rules", () => {
  it("writes an amount in base units exactly, without trailing zeros", () => {
    expect(amount(1_500_000n, 6)).toBe("1.5");
    expect(amount(1_000_000n, 6)).toBe("1");
    expect(amount(0n, 6)).toBe("0");
    expect(amount(1n, 6)).toBe("0.000001");
    expect(amount(1_234_567_890_123n, 6)).toBe("1,234,567.890123");
    expect(amount(13_695_320n, 9)).toBe("0.01369532");
    expect(amount(5n, 0)).toBe("5");
    expect(amount(1_000n, 0)).toBe("1,000");
  });

  it("works out what the keeper's wallet needs in SOL, from numbers written out", () => {
    // 13,695,320 to create a break; with 2 free spots 8 more transactions at 5,000, ORAO's fee, and its request account's rent.
    expect(keeperSolNeed(2, 300_000n)).toEqual({ create: 13_695_320n, cycle: 20_139_240n });
    expect(keeperSolNeed(0, 0n)).toEqual({ create: 13_695_320n, cycle: 13_695_320n + 30_000n + 6_103_920n });
    expect(keeperSolNeed(16, 0n).cycle - keeperSolNeed(0, 0n).cycle).toBe(80_000n);
  });

  it("judges a clock from its skew", () => {
    expect(clockVerdict(0).status).toBe("ok");
    expect(clockVerdict(10).status).toBe("ok");
    expect(clockVerdict(-10).status).toBe("ok");
    expect(clockVerdict(11).status).toBe("warn");
    expect(clockVerdict(60).status).toBe("warn");
    expect(clockVerdict(-60).status).toBe("warn");
    expect(clockVerdict(61).status).toBe("fail");
    expect(clockVerdict(-61).status).toBe("fail");
    expect(clockVerdict(3).text).toBe("this machine is 3 s ahead of the chain, which is normal");
    expect(clockVerdict(-3).text).toContain("3 s behind the chain");
  });
});
