import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { USAGE } from "../src/setup/args.js";
import { main } from "../src/setup/main.js";
import { GENESIS_HASHES } from "../src/solana/cluster.js";
import { ADMIN_KEY, AUTHORITY, BUYER, KEEPER, USDC, setupWorld } from "./support/setup-world.js";
import { PROGRAMS } from "./support/world.js";

const SECRET_PATH = "SECRETPATH0123456789";
const ENV = {
  SOLANA_RPC_URL: `https://rpc.example/${SECRET_PATH}`,
  BREAKS_PROGRAM_ID: PROGRAMS.breaks,
  TREASURY_PROGRAM_ID: PROGRAMS.treasury,
};

function keyFile(dir: string, name: string, seedByte: number, mode = 0o600): string {
  const seed = new Uint8Array(32).fill(seedByte);
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify([...seed, ...ed25519.getPublicKey(seed)]));
  chmodSync(path, mode);
  return path;
}

function flags(authorityKeypair: string, more: string[] = []): string[] {
  return ["--authority-keypair", authorityKeypair, "--keeper", KEEPER, "--buyer", BUYER, "--usdc-mint", USDC, "--max-paid-spots", "48", "--max-free-spots", "16", ...more];
}

describe("setup-devnet: the command", () => {
  it("prints the usage for --help, without needing a key or a node", async () => {
    const r = await main(["--help"], { env: {} });
    expect(r).toEqual({ code: 0, out: USAGE });
  });

  it("exits 2 with every problem and the usage for a bad command line, without touching the node", async () => {
    let connected = false;
    const r = await main(["--keeper", "x"], { env: ENV, connect: async () => ((connected = true), (await setupWorld().chain())) });
    expect(r.code).toBe(2);
    expect(r.out).toContain("error: --authority-keypair is required");
    expect(r.out).toContain("error: --keeper is not a Solana address");
    expect(r.out).toContain("usage: pnpm --filter keeper setup-devnet");
    expect(connected).toBe(false);
  });

  it("exits 2 for a key file that cannot be read, naming the file and never what is in it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "setup-"));
    const path = join(dir, "authority.json");
    writeFileSync(path, "not json, and SUPERSECRETTEXT inside");
    const r = await main(flags(path), { env: ENV });
    expect(r.code).toBe(2);
    expect(r.out).toBe(`error: could not read a keypair from ${path}`);
    expect(r.out).not.toContain("SUPERSECRETTEXT");
    const missing = await main(flags(join(dir, "nope.json")), { env: ENV });
    expect(missing.code).toBe(2);
    expect(missing.out).toContain("could not read a keypair from");
  });

  it("does not repeat the node's address when it was pasted where a key file belongs", async () => {
    const r = await main(flags(ENV.SOLANA_RPC_URL), { env: ENV });
    expect(r.code).toBe(2);
    expect(r.out).toBe("error: could not read a keypair from [hidden]");
    expect(r.out).not.toContain(SECRET_PATH);
  });

  it("does a dry run, then the whole setup with --send, from key files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "setup-"));
    const key = keyFile(dir, "authority.json", 7);
    const w = setupWorld();
    const connect = async () => w.chain();

    const dry = await main(flags(key), { env: ENV, connect });
    expect(dry.code).toBe(0);
    expect(w.applied).toEqual([]);
    expect(dry.out).toContain(`Authority (pays for everything): ${AUTHORITY.address}`);

    const sent = await main(flags(key, ["--send"]), { env: ENV, connect });
    expect(sent.code).toBe(0);
    expect(w.applied).toEqual(["treasury.initialize", "breaks.initialize", "treasury.set_controller", "ata.create"]);
    expect(sent.out).toContain("DONE.");
  });

  it("uses the admin's key file for set_controller, so one run does it all", async () => {
    const dir = mkdtempSync(join(tmpdir(), "setup-"));
    const authority = keyFile(dir, "authority.json", 7);
    const admin = keyFile(dir, "admin.json", 8);
    const w = setupWorld();
    const r = await main(flags(authority, ["--admin-keypair", admin, "--send"]), { env: ENV, connect: async () => w.chain() });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Admin: ${ADMIN_KEY.address} (this run holds its key)`);
    expect(w.applied).toEqual(["treasury.initialize", "breaks.initialize", "treasury.set_controller", "ata.create"]);
  });

  it("exits 3 when only the admin can finish", async () => {
    const dir = mkdtempSync(join(tmpdir(), "setup-"));
    const key = keyFile(dir, "authority.json", 7);
    const w = setupWorld();
    const r = await main(flags(key, ["--admin", ADMIN_KEY.address, "--send"]), { env: ENV, connect: async () => w.chain() });
    expect(r.code).toBe(3);
    expect(r.out).toContain("WAITING FOR THE ADMIN.");
  });

  it("warns about a key file that other users can read, and one inside a git work tree, and still runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "setup-"));
    mkdirSync(join(dir, ".git"));
    const key = keyFile(dir, "authority.json", 7, 0o644);
    const w = setupWorld();
    const r = await main(flags(key), { env: ENV, connect: async () => w.chain() });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Warning: the authority key file's mode is 644: other users on this machine can read it (chmod 600)");
    expect(r.out).toContain(`Warning: the authority key file is inside the git work tree ${dir}`);

    const clean = await main(flags(keyFile(mkdtempSync(join(tmpdir(), "setup-")), "authority.json", 7)), { env: ENV, connect: async () => w.chain() });
    expect(clean.out).not.toContain("Warning:");
  });

  it("refuses a node that is not devnet before it sends anything, naming the network", async () => {
    const dir = mkdtempSync(join(tmpdir(), "setup-"));
    const key = keyFile(dir, "authority.json", 7);
    for (const [name, genesis] of [["mainnet-beta", GENESIS_HASHES["mainnet-beta"]], ["testnet", GENESIS_HASHES.testnet]] as const) {
      const w = setupWorld();
      w.node.genesis = genesis;
      const r = await main(flags(key, ["--send"]), { env: ENV, connect: async () => w.chain() });
      expect(r.code, name).toBe(1);
      expect(r.out).toBe(`error: the RPC node is ${name}; this project runs on devnet only`);
      expect(w.node.sent).toHaveLength(0);
      expect(w.applied).toEqual([]);
    }
  });

  it("never prints the node's address, even when an error repeats it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "setup-"));
    const key = keyFile(dir, "authority.json", 7);
    const r = await main(flags(key), {
      env: ENV,
      connect: async () => {
        throw new Error(`getGenesisHash: fetch failed for https://rpc.example/${SECRET_PATH}`);
      },
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("[hidden]");
    expect(r.out).not.toContain(SECRET_PATH);
    expect(r.out).not.toContain("rpc.example");
  });

  it("never prints the node's address in a report either", async () => {
    const dir = mkdtempSync(join(tmpdir(), "setup-"));
    const key = keyFile(dir, "authority.json", 7);
    const w = setupWorld();
    // A node that keeps answering with a message that repeats its own address: the report says why the send is not confirmed.
    const busy = { error: { code: -32005, message: `node https://rpc.example/${SECRET_PATH} is busy` } };
    w.node.sendScript.push(...Array.from({ length: 200 }, () => busy));
    const r = await main(flags(key, ["--send"]), { env: ENV, connect: async () => w.chain() });
    expect(r.code).toBe(1);
    expect(r.out).toContain("the result is not known");
    expect(r.out).toContain("[hidden]");
    expect(r.out).not.toContain(SECRET_PATH);
    expect(r.out).not.toContain("rpc.example");
  });
});
