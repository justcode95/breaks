// A pretend devnet, set up the way the doctor expects to find it, for the doctor's tests: both programs deployed and
// initialized, the treasury funded, ORAO's network state, a keeper key on disk with some SOL, a token with a history, a
// migrated database. A test spoils one thing and looks at what the doctor says about it.

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { ed25519 } from "@noble/curves/ed25519.js";
import { runChecks, type DoctorPorts } from "../../src/doctor/checks.js";
import type { Check } from "../../src/doctor/report.js";
import { ORAO_PROGRAM, configAddress, oraoNetworkState, treasuryAuthorityAddress, type BreaksConfigAccount } from "../../src/solana/breaks.js";
import { UPGRADEABLE_LOADER, programDataAddress } from "../../src/solana/instruction.js";
import { type Address, addressFromBytes, addressToBytes, associatedTokenAddress } from "../../src/solana/pubkey.js";
import { type Fetch, RpcClient } from "../../src/solana/rpc.js";
import { type TreasuryConfig, treasuryAddresses } from "../../src/solana/treasury.js";
import { encodeBreaksConfig, encodeNetworkState, encodeTokenAccount, encodeTreasuryConfig } from "./accounts.js";
import { addr } from "./chain.js";
import { migratedDb } from "./db.js";
import { FakeNode } from "./fake-node.js";
import { MINT, TokenLedger } from "./token-ledger.js";
import { PROGRAMS } from "./world.js";

export const NOW = new Date("2027-01-15T12:00:00Z");
export const SECRET_RPC_PATH = "SECRETPATH0123456789";
export const SECRET_DB_PASSWORD = "pa55w0rd-very-secret";

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const USDC = addr(0xc0);
export const ADMIN = addr(0xad);
export const BUYER_WALLET = addr(0xb0);
export const UPGRADER = addr(0xee);
export const SOL = 1_000_000_000n;

const keeperSecret = new Uint8Array(32).fill(1);
export const KEEPER_ADDRESS = addressFromBytes(ed25519.getPublicKey(keeperSecret));

/** The loader's program account: a u32 tag 2 and the address of the program-data account. */
export function programAccount(programData: Address): Uint8Array {
  const data = new Uint8Array(36);
  new DataView(data.buffer).setUint32(0, 2, true);
  data.set(addressToBytes(programData), 4);
  return data;
}

/** The loader's program-data account: a u32 tag 3, the slot, who may upgrade (one byte, then 32), then the code. */
export function programDataAccount(authority: Address | undefined, slot = 7n): Uint8Array {
  const data = new Uint8Array(45 + 100);
  const view = new DataView(data.buffer);
  view.setUint32(0, 3, true);
  view.setBigUint64(4, slot, true);
  if (authority) {
    data[12] = 1;
    data.set(addressToBytes(authority), 13);
  }
  return data;
}

/** A token mint: supply at 36, decimals at 44, initialized at 45. */
export function mintData(supply: bigint, decimals: number): Uint8Array {
  const data = new Uint8Array(82);
  new DataView(data.buffer).setBigUint64(36, supply, true);
  data[44] = decimals;
  data[45] = 1;
  return data;
}

let shared: Promise<PGlite> | undefined;
/** One migrated database for every test that only reads it (the doctor does): migrating costs seconds. */
const sharedDb = () => (shared ??= migratedDb());

export interface World {
  node: FakeNode;
  ledger: TokenLedger;
  db: PGlite;
  env: Record<string, string | undefined>;
  keyPath: string;
  dir: string;
  breaks: BreaksConfigAccount;
  treasury: TreasuryConfig;
  /** Statements the doctor sent to the database. */
  statements: string[];
  /** How many times the doctor let go of the database connection. */
  closed: number;
  /** Makes opening the database fail with this message. */
  dbDown: { message: string } | undefined;
  /** Node methods that answer with an error. */
  failing: Set<string>;
  /** Makes every request to the node fail at the network level, with this error for the url. */
  nodeDown: ((url: string) => Error) | undefined;
  ports: DoctorPorts;
  /** Puts the two configuration accounts (which a test may have changed) on the node. */
  publish(): void;
  /** Sets the token balance of the two treasury vaults. */
  fund(subsidy: bigint, holder: bigint): void;
  run(): Promise<Check[]>;
}

/** Everything healthy, with a funded treasury, a keeper holding 1 SOL and the settings in `env`. Override a setting with `env`. */
export async function healthyWorld(over: { env?: Record<string, string | undefined>; skipDb?: boolean; ownDb?: boolean } = {}): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), "doctor-"));
  const keyPath = join(dir, "keeper.json");
  writeFileSync(keyPath, JSON.stringify([...keeperSecret, ...ed25519.getPublicKey(keeperSecret)]));
  chmodSync(keyPath, 0o600);
  const publishDir = join(dir, "lists");
  mkdirSync(publishDir);

  const node = new FakeNode();
  node.blockTime = Math.floor(NOW.getTime() / 1000) - 2;
  const ledger = new TokenLedger(1_800_000_000);
  ledger.mintTo(ledger.holder("alice"), 1_000n);
  // `skipDb` gives an empty database, for a test that applies some migrations itself, `ownDb` a migrated one that is not shared
  // (for a test that changes it: a role, a table).
  const db = over.skipDb ? new PGlite() : over.ownDb ? await migratedDb() : await sharedDb();
  const statements: string[] = [];

  const world: World = {
    node,
    ledger,
    db,
    keyPath,
    dir,
    statements,
    closed: 0,
    dbDown: undefined,
    failing: new Set(),
    nodeDown: undefined,
    env: {
      SOLANA_RPC_URL: `https://rpc.example/${SECRET_RPC_PATH}`,
      DATABASE_URL: `postgres://keeper:${SECRET_DB_PASSWORD}@db.example:5432/breaks`,
      KEEPER_KEYPAIR_PATH: keyPath,
      BREAKS_PROGRAM_ID: PROGRAMS.breaks,
      TREASURY_PROGRAM_ID: PROGRAMS.treasury,
      TOKEN_MINT: MINT,
      MIN_TWAB: "1000000000000",
      BREAK_PAID_SPOTS: "10",
      BREAK_FREE_SPOTS: "2",
      BREAK_SPOT_PRICE: "20000000",
      BREAK_MAX_PACK_PRICE: "25000000",
      BREAK_PACK_MACHINE: "pokemon-25",
      BREAK_WINDOW_SECS: "43200",
      PUBLISH_DIR: publishDir,
      ...over.env,
    },
    breaks: {
      admin: ADMIN,
      keeper: KEEPER_ADDRESS,
      buyer: BUYER_WALLET,
      usdcMint: USDC,
      randomnessProgram: ORAO_PROGRAM,
      randomnessTimeoutSecs: 600n,
      nextBreakId: 2n,
      minWindowSecs: 3_600n,
      maxWindowSecs: 86_400n,
      maxPaidSpots: 20,
      maxFreeSpots: 16,
      paused: false,
      bump: 255,
    },
    treasury: { admin: ADMIN, usdcMint: USDC, controller: treasuryAuthorityAddress(PROGRAMS), subsidyBps: 7_000, holderBps: 3_000, lockedSubsidy: 0n, lockedHolder: 0n, bump: 255 },
    ports: undefined as unknown as DoctorPorts,
    publish() {
      node.accounts.set(configAddress(PROGRAMS), encodeBreaksConfig(world.breaks));
      node.owners.set(configAddress(PROGRAMS), PROGRAMS.breaks);
      node.accounts.set(treasuryAddresses(PROGRAMS.treasury).config, encodeTreasuryConfig(world.treasury));
      node.owners.set(treasuryAddresses(PROGRAMS.treasury).config, PROGRAMS.treasury);
    },
    fund(subsidy, holder) {
      const t = treasuryAddresses(PROGRAMS.treasury);
      node.accounts.set(t.subsidyVault, encodeTokenAccount({ mint: USDC, owner: t.config, amount: subsidy }));
      node.owners.set(t.subsidyVault, TOKEN_PROGRAM);
      node.accounts.set(t.holderVault, encodeTokenAccount({ mint: USDC, owner: t.config, amount: holder }));
      node.owners.set(t.holderVault, TOKEN_PROGRAM);
    },
    async run() {
      return runChecks(world.env, world.ports);
    },
  };

  // The programs: deployed with the upgradeable loader, upgrade authority somebody else.
  for (const program of [PROGRAMS.breaks, PROGRAMS.treasury]) {
    const programData = programDataAddress(program);
    node.accounts.set(program, programAccount(programData));
    node.owners.set(program, UPGRADEABLE_LOADER);
    node.executables.add(program);
    node.accounts.set(programData, programDataAccount(UPGRADER));
    node.owners.set(programData, UPGRADEABLE_LOADER);
  }
  node.accounts.set(ORAO_PROGRAM, new Uint8Array(36));
  node.owners.set(ORAO_PROGRAM, UPGRADEABLE_LOADER);
  node.executables.add(ORAO_PROGRAM);

  world.publish();
  // Plenty in both buckets: $50 in each is the worst case of the settings above.
  world.fund(1_000_000_000n, 500_000_000n);

  node.accounts.set(USDC, mintData(1_000_000_000_000_000n, 6));
  node.owners.set(USDC, TOKEN_PROGRAM);
  node.accounts.set(MINT, mintData(1_000_000_000_000_000n, 6));
  node.owners.set(MINT, TOKEN_PROGRAM);
  const buyerUsdc = associatedTokenAddress(BUYER_WALLET, USDC);
  node.accounts.set(buyerUsdc, encodeTokenAccount({ mint: USDC, owner: BUYER_WALLET, amount: 0n }));
  node.owners.set(buyerUsdc, TOKEN_PROGRAM);
  node.accounts.set(
    oraoNetworkState(ORAO_PROGRAM),
    encodeNetworkState({ authority: addr(0xa1), treasury: addr(0xa2), requestFee: 300_000n, fulfillmentAuthorities: [addr(0xa3), addr(0xa4)], numReceived: 12n }),
  );
  node.owners.set(oraoNetworkState(ORAO_PROGRAM), ORAO_PROGRAM);
  node.lamports.set(KEEPER_ADDRESS, SOL);

  world.ports = {
    rpc: (config) => {
      // The doctor must work out the url from the settings, not have it handed over.
      if (config.rpcUrl !== world.env.SOLANA_RPC_URL) throw new Error("the doctor built its client from another url");
      const fetch: Fetch = async (url, init) => {
        if (world.nodeDown) throw world.nodeDown(url);
        const { method } = JSON.parse(init.body) as { method: string };
        if (world.failing.has(method)) {
          return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: `the node refused ${method}` } }) };
        }
        return node.fetch(url, init);
      };
      return new RpcClient({ url: config.rpcUrl, fetch, sleep: node.sleep, retries: 0 });
    },
    reader: () => ledger,
    connectDb: async () => {
      if (world.dbDown) throw new Error(world.dbDown.message);
      return {
        sql: {
          query: async <T>(text: string, params?: unknown[]) => {
            statements.push(text);
            const result = await db.query<T>(text, params);
            return { rows: result.rows };
          },
        },
        close: async () => {
          world.closed++;
        },
      };
    },
    now: () => NOW,
  };
  return world;
}

/** The one check with this title. */
export function find(checks: Check[], title: string): Check {
  const check = checks.find((c) => c.title === title);
  if (!check) throw new Error(`no check called "${title}"; there are: ${checks.map((c) => c.title).join(" | ")}`);
  return check;
}
