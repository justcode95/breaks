// The doctor's checks: everything that can be looked at before the keeper runs, so the first run on devnet does not find out
// by failing. Every check only READS (the node, the database, the filesystem); none sends a transaction or writes a row.
//
// A check that needs something that did not work (no node, no key) is skipped, not failed: the check that owns the missing
// thing says what is wrong, once. Facts (the configuration, the node's answer, an account) are read once and shared.

import { accessSync, constants, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { checkSchema, verifyKeeperIdentity, verifyMint } from "../app.js";
import { type Config, parseConfig } from "../config.js";
import type { TokenReader } from "../indexer/reader.js";
import { readTransaction } from "../indexer/parse.js";
import type { AccountReader } from "../pipeline/chain.js";
import { OraoVrf } from "../pipeline/vrf.js";
import { packMachineLabel } from "../scheduler/machine.js";
import { type PackGroup, reserveProgress, templateProblem, unlocked } from "../scheduler/policy.js";
import { configAddress, decodeBreaksConfig, treasuryAuthorityAddress } from "../solana/breaks.js";
import { assertCluster } from "../solana/cluster.js";
import { UPGRADEABLE_LOADER } from "../solana/instruction.js";
import { type Signer, loadSignerFromFile } from "../solana/keypair.js";
import { decodeProgramAccount, decodeProgramData } from "../solana/loader.js";
import { type Address, associatedTokenAddress } from "../solana/pubkey.js";
import { RANDOMNESS_REQUEST_ACCOUNT_BYTES, SIGNATURE_FEE, createBreakCost, rentExempt } from "../solana/rent.js";
import type { RpcClient } from "../solana/rpc.js";
import { decodeMint, decodeTokenAccount } from "../solana/token.js";
import { decodeTreasuryConfig, treasuryAddresses } from "../solana/treasury.js";
import type { Sql } from "../packs/sql-store.js";
import type { Check } from "./report.js";

/** What the doctor needs from the outside. The real ones are in main.ts; tests give pretend ones. */
export interface DoctorPorts {
  /** The client for the node. The doctor only reads through it. */
  rpc(config: Config): RpcClient;
  /** What the indexer reads history with, to try it on this node. */
  reader(rpc: RpcClient, config: Config): TokenReader;
  /** A database connection that cannot write. Rejects if the database cannot be reached. */
  connectDb(config: Config): Promise<{ sql: Sql; close(): Promise<void> }>;
  now(): Date;
}

// ---------------------------------------------------------------------------------------------- outcomes

type Outcome =
  | { status: "ok"; detail: string }
  | { status: "warn" | "fail"; detail: string; fix?: string }
  | { status: "skip"; detail: string };

const ok = (detail: string): Outcome => ({ status: "ok", detail });
const warn = (detail: string, fix?: string): Outcome => ({ status: "warn", detail, ...(fix ? { fix } : {}) });
const fail = (detail: string, fix?: string): Outcome => ({ status: "fail", detail, ...(fix ? { fix } : {}) });

/** Thrown by a check that needs something that is not there. The runner turns it into a skipped check. */
class Skip extends Error {}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

type Result<T> = { ok: true; value: T } | { ok: false; skipped: boolean; reason: string };

/** Something read once and shared. A dependency that failed makes this one skipped (`Skip`), not failed. */
class Fact<T> {
  private promise: Promise<Result<T>> | undefined;
  constructor(
    readonly label: string,
    private readonly load: () => Promise<T>,
  ) {}

  result(): Promise<Result<T>> {
    this.promise ??= this.load().then(
      (value): Result<T> => ({ ok: true, value }),
      (err): Result<T> => ({ ok: false, skipped: err instanceof Skip, reason: message(err) }),
    );
    return this.promise;
  }

  /** The value, or a skip of the check that asked for it. */
  async need(): Promise<T> {
    const r = await this.result();
    if (r.ok) return r.value;
    throw new Skip(`needs ${this.label}`);
  }

  /** For the check that owns this fact: what was found, or why it is wrong. A skipped dependency stays a skip. */
  async judge(good: (value: T) => Outcome | Promise<Outcome>, bad: (reason: string) => Outcome): Promise<Outcome> {
    const r = await this.result();
    if (r.ok) return good(r.value);
    if (r.skipped) throw new Skip(r.reason);
    return bad(r.reason);
  }
}

// ---------------------------------------------------------------------------------------------- formatting

const group = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** A whole amount in base units as a decimal number, exactly, with no trailing zeros: 1500000 at 6 decimals is "1.5". */
export function amount(value: bigint, decimals: number): string {
  const digits = value.toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const frac = decimals > 0 ? digits.slice(-decimals).replace(/0+$/, "") : "";
  return `${group(whole)}${frac ? `.${frac}` : ""}`;
}
const usd = (micro: bigint) => `$${amount(micro, 6)}`;
/** "4 × pokemon-10 up to $10, 2 × grail-50 up to $50": the packs of the configured break, cheapest first. */
const describePacks = (groups: readonly PackGroup[]) => groups.map((g) => `${g.count} × ${packMachineLabel(g.machine)} up to ${usd(g.maxPrice)}`).join(", ");
const sol = (lamports: bigint) => `${amount(lamports, 9)} SOL`;

// ---------------------------------------------------------------------------------------------- rules

/**
 * What the keeper's wallet needs in SOL: to create a break (rent of two accounts, a fee, and the least a wallet may be left
 * with) and to see one all the way through: the other keeper transactions of its life (close, commit the list, fund, commit
 * the pool, ask for randomness, settle it, one claim per free spot) and ORAO's fee and the rent of its request account.
 */
export function keeperSolNeed(freeSpots: number, oraoRequestFee: bigint): { create: bigint; cycle: bigint } {
  const create = createBreakCost().total;
  const others = BigInt(6 + freeSpots) * SIGNATURE_FEE;
  return { create, cycle: create + others + oraoRequestFee + rentExempt(RANDOMNESS_REQUEST_ACCOUNT_BYTES) };
}

/** How far this machine's clock is from the chain's, in seconds, and what that means for a keeper that sets sale windows by its own clock. */
export function clockVerdict(skewSecs: number): { status: "ok" | "warn" | "fail"; text: string } {
  const abs = Math.abs(skewSecs);
  const how = `this machine is ${abs} s ${skewSecs >= 0 ? "ahead of" : "behind"} the chain`;
  // Block times are whole seconds and the newest block is a second or two old, so a few seconds either way is normal.
  if (abs <= 10) return { status: "ok", text: `${how}, which is normal` };
  if (abs <= 60) return { status: "warn", text: `${how}: sales open or close that much early or late, and a close_break sent ahead of the chain's clock is refused` };
  return { status: "fail", text: `${how}: the sale windows the keeper sets would be wrong by that much` };
}

// ---------------------------------------------------------------------------------------------- the context

class Ctx {
  readonly config = new Fact("a valid configuration", async () => {
    const parsed = parseConfig(this.env);
    if ("problems" in parsed) throw new Error(parsed.problems.join("\n"));
    return parsed.config;
  });

  readonly signer = new Fact<Signer>("the keeper's key", async () => {
    const config = await this.config.need();
    if (!config.keeperKeypairPath) throw new Error("KEEPER_KEYPAIR_PATH is not set");
    return loadSignerFromFile(config.keeperKeypairPath);
  });

  readonly rpc = new Fact("a node client", async () => this.ports.rpc(await this.config.need()));

  readonly genesis = new Fact("a node that answers", async () => (await this.rpc.need()).getGenesisHash());

  readonly devnet = new Fact("a devnet node", async () => {
    const config = await this.config.need();
    const genesis = await this.genesis.need();
    await assertCluster({ getGenesisHash: async () => genesis }, config.cluster);
    return genesis;
  });

  private readonly accounts = new Map<string, Promise<{ data: Uint8Array; owner: Address; executable: boolean; lamports: bigint } | undefined>>();

  constructor(
    readonly env: Record<string, string | undefined>,
    readonly ports: DoctorPorts,
  ) {}

  /** An account at the keeper's commitment, or undefined if it does not exist. Only asked of a node known to be devnet. */
  async account(address: Address, dataSlice?: { offset: number; length: number }) {
    const config = await this.config.need();
    await this.devnet.need();
    const rpc = await this.rpc.need();
    const key = `${address}:${dataSlice?.offset ?? ""}:${dataSlice?.length ?? ""}`;
    let found = this.accounts.get(key);
    if (!found) {
      found = rpc.getAccountInfo(address, { commitment: config.commitment, ...(dataSlice ? { dataSlice } : {}) });
      this.accounts.set(key, found);
    }
    return found;
  }

  /** What the keeper's own verifiers read accounts through. */
  readonly reader: AccountReader = { getAccountData: async (address) => (await this.account(address))?.data };

  // The accounts the setup checks look at. Each fails with the reason an operator needs and is shared by the checks that use it.

  readonly breaksConfig = new Fact("the breaks program's configuration", async () => {
    const config = await this.config.need();
    const info = await this.account(configAddress(config.programs));
    if (!info) throw new Error("the account does not exist: the breaks program has not been initialized");
    if (info.owner !== config.programs.breaks) throw new Error(`the account is owned by ${info.owner}, not by the breaks program`);
    return decodeBreaksConfig(info.data);
  });

  readonly treasuryConfig = new Fact("the treasury's configuration", async () => {
    const config = await this.config.need();
    const info = await this.account(treasuryAddresses(config.programs.treasury).config);
    if (!info) throw new Error("the account does not exist: the treasury program has not been initialized");
    if (info.owner !== config.programs.treasury) throw new Error(`the account is owned by ${info.owner}, not by the treasury program`);
    return decodeTreasuryConfig(info.data);
  });

  readonly vaults = new Fact("the treasury's vaults", async () => {
    const config = await this.config.need();
    const treasury = await this.treasuryConfig.need();
    const addresses = treasuryAddresses(config.programs.treasury);
    const read = async (name: string, address: Address) => {
      const info = await this.account(address);
      if (!info) throw new Error(`the ${name} vault does not exist`);
      const token = decodeTokenAccount(info.data);
      if (token.mint !== treasury.usdcMint) throw new Error(`the ${name} vault holds ${token.mint}, not the treasury's USDC`);
      return token.amount;
    };
    return { subsidy: await read("subsidy", addresses.subsidyVault), holder: await read("holder", addresses.holderVault) };
  });

  readonly orao = new Fact("ORAO's network state", async () => {
    const config = await this.config.need();
    return new OraoVrf(this.reader, config.vrf.program).state();
  });

  readonly mint = new Fact("the token mint", async () => {
    const config = await this.config.need();
    await verifyMint(this.reader, config.indexer.mint);
    const info = await this.account(config.indexer.mint);
    return decodeMint((info as { data: Uint8Array }).data);
  });

  readonly keeperLamports = new Fact("the keeper's SOL balance", async () => {
    const config = await this.config.need();
    const signer = await this.signer.need();
    await this.devnet.need();
    return (await this.rpc.need()).getBalance(signer.address, config.commitment);
  });

  private database: Promise<{ sql: Sql; close(): Promise<void> }> | undefined;
  readonly db = new Fact("a database", async () => {
    const config = await this.config.need();
    this.database ??= this.ports.connectDb(config);
    const connection = await this.database;
    await connection.sql.query("select 1");
    return connection.sql;
  });

  async close(): Promise<void> {
    if (this.database) await (await this.database.catch(() => undefined))?.close();
  }
}

// ---------------------------------------------------------------------------------------------- the checks

interface Def {
  section: string;
  title: string;
  run(ctx: Ctx): Promise<Outcome>;
}

/** Walks up from a file to the first directory that is a git work tree, if any. */
function gitRoot(path: string): string | undefined {
  for (let dir = dirname(resolve(path)); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

/** A directory that can be written into: the folder itself, or, if it will be created, the nearest folder that exists. */
function writableDirProblem(path: string): string | undefined {
  let dir = resolve(path);
  while (!existsSync(dir)) {
    if (dirname(dir) === dir) return "no part of the path exists";
    dir = dirname(dir);
  }
  if (!statSync(dir).isDirectory()) return `${dir} is not a folder`;
  try {
    accessSync(dir, constants.W_OK);
  } catch {
    return `${dir} cannot be written to by this user`;
  }
  return undefined;
}

const TABLES_THE_KEEPER_WRITES = ["breaks", "spots", "packs", "deliveries", "balance_events", "eligibility_lists", "twab_snapshots", "indexer_state", "indexed_accounts", "published_documents"];

const DEFS: Def[] = [
  // ------------------------------------------------------------------ configuration
  {
    section: "Configuration",
    title: "the settings load",
    run: (c) =>
      c.config.judge(
        (cfg) => ok(`cluster ${cfg.cluster}, commitment ${cfg.commitment}`),
        (reason) => fail(reason, "fix the settings named above; keeper/.env.example lists every one"),
      ),
  },
  {
    section: "Configuration",
    title: "real packs and cards",
    run: async (c) => {
      const cfg = await c.config.need();
      if (cfg.packProvider === "mock" || cfg.cardTransfer === "mock") {
        return warn(
          `PACK_PROVIDER=${cfg.packProvider}, CARD_TRANSFER=${cfg.cardTransfer}: no real pack is bought and no real card moves, so a run only proves the plumbing`,
          "the real providers wait for the Phase 0 results (docs/PHASE0.md)",
        );
      }
      return ok("the real providers are configured");
    },
  },
  {
    section: "Configuration",
    title: "the scheduler creates breaks",
    run: async (c) => {
      const cfg = await c.config.need();
      return cfg.scheduler.enabled
        ? ok("BREAK_AUTO_CREATE is on: a break is created when the reserve can pay for it")
        : warn("BREAK_AUTO_CREATE=false: the keeper copies breaks from the chain but never creates one", "set BREAK_AUTO_CREATE=true to let it create breaks");
    },
  },

  // ------------------------------------------------------------------ the keeper's key
  {
    section: "The keeper's key",
    title: "the key file loads",
    run: (c) =>
      c.signer.judge(
        (signer) => ok(`the keeper is ${signer.address}`),
        (reason) => fail(reason, "create a key with `solana-keygen new --outfile <path>` outside the repository and set KEEPER_KEYPAIR_PATH"),
      ),
  },
  {
    section: "The keeper's key",
    title: "only this user can read it",
    run: async (c) => {
      await c.signer.need();
      const path = (await c.config.need()).keeperKeypairPath as string;
      if (process.platform === "win32") return ok("not checked on Windows");
      const mode = statSync(path).mode & 0o777;
      return (mode & 0o077) === 0
        ? ok(`the file's mode is ${mode.toString(8)}`)
        : warn(`the file's mode is ${mode.toString(8)}: other users on this machine can read the key`, `chmod 600 ${path}`);
    },
  },
  {
    section: "The keeper's key",
    title: "it is outside the repository",
    run: async (c) => {
      await c.signer.need();
      const path = (await c.config.need()).keeperKeypairPath as string;
      const root = gitRoot(path);
      return root === undefined
        ? ok("the key file is not inside a git work tree")
        : warn(`the key file is inside the git work tree ${root}, where a key can be committed by accident`, "move the key file outside the repository and update KEEPER_KEYPAIR_PATH");
    },
  },

  // ------------------------------------------------------------------ the node
  {
    section: "The node",
    title: "it answers",
    run: (c) =>
      c.genesis.judge(
        (genesis) => ok(`genesis hash ${genesis}`),
        (reason) => fail(`cannot reach the node: ${reason}`, "check SOLANA_RPC_URL and this machine's network"),
      ),
  },
  {
    section: "The node",
    title: "it is devnet",
    run: (c) =>
      c.devnet.judge(
        () => ok("the genesis hash is devnet's"),
        (reason) =>
          fail(
            reason,
            reason.includes("not devnet")
              ? "if this really is devnet, the genesis hash in src/solana/cluster.ts is wrong: compare it with `solana genesis-hash -u devnet`"
              : "point SOLANA_RPC_URL at a devnet node; this project runs on devnet only",
          ),
      ),
  },
  {
    section: "The node",
    title: "its clock agrees with this machine's",
    run: async (c) => {
      const cfg = await c.config.need();
      await c.devnet.need();
      const rpc = await c.rpc.need();
      const slot = await rpc.call<number>("getSlot", [{ commitment: cfg.commitment }]);
      let blockTime: number | null = null;
      // The newest slot may not have its block yet; a few slots back it does.
      for (let back = 0; back < 4 && blockTime === null; back++) {
        try {
          blockTime = await rpc.call<number | null>("getBlockTime", [slot - back]);
        } catch {
          blockTime = null;
        }
      }
      if (blockTime === null) return warn("the node gave no time for its latest blocks, so the clocks were not compared", "try another node, or compare `date` with a time server by hand");
      const verdict = clockVerdict(Math.floor(c.ports.now().getTime() / 1000) - blockTime);
      return verdict.status === "ok" ? ok(verdict.text) : { status: verdict.status, detail: verdict.text, fix: "set this machine's clock with NTP (for example `timedatectl set-ntp true`)" };
    },
  },
  {
    section: "The node",
    title: "it serves the history the indexer reads",
    run: async (c) => {
      const cfg = await c.config.need();
      await c.devnet.need();
      await c.mint.need();
      const reader = c.ports.reader(await c.rpc.need(), cfg);
      const mint = cfg.indexer.mint;
      const advice = "the indexer needs getSignaturesForAddress and getTransaction (jsonParsed) with full history: use an RPC provider that keeps it";
      try {
        const [newest] = await reader.signatures(mint, { limit: 1 });
        if (!newest) return warn("the node lists no transactions for the mint, though the mint exists: it may not keep history", advice);
        const [tx] = await reader.transactions([newest.signature]);
        if (!tx) return fail("the node returned no transaction for a signature it just listed", advice);
        readTransaction(tx, mint, newest.signature);
        return ok(`read the mint's newest transaction (slot ${newest.slot}) the way the indexer does`);
      } catch (err) {
        return fail(`reading the mint's history failed: ${message(err)}`, advice);
      }
    },
  },

  // ------------------------------------------------------------------ the programs
  ...(["breaks", "treasury"] as const).map<Def>((which) => ({
    section: "The programs",
    title: `the ${which} program is deployed`,
    run: async (c) => {
      const cfg = await c.config.need();
      const id = cfg.programs[which];
      const info = await c.account(id);
      if (!info) return fail(`${id} does not exist on this cluster`, `deploy the ${which} program and set ${which.toUpperCase()}_PROGRAM_ID to its address`);
      if (!info.executable) return fail(`${id} exists but is not a program`, `set ${which.toUpperCase()}_PROGRAM_ID to the deployed program`);
      if (info.owner !== UPGRADEABLE_LOADER) return fail(`${id} is owned by ${info.owner}, not by the upgradeable loader`, "deploy it with `solana program deploy`");
      let programData: Address;
      try {
        programData = decodeProgramAccount(info.data).programData;
      } catch (err) {
        return fail(`${id}: ${message(err)}`);
      }
      const data = await c.account(programData, { offset: 0, length: 45 });
      if (!data) return fail(`${id}: its program-data account ${programData} does not exist`);
      const { upgradeAuthority } = decodeProgramData(data.data);
      if (upgradeAuthority === undefined) return ok(`${id}; it can no longer be upgraded`);
      const signer = await c.signer.result();
      if (signer.ok && signer.value.address === upgradeAuthority) {
        return warn(
          `${id}; the keeper's own key (${upgradeAuthority}) can replace it`,
          "move the upgrade authority to the Squads multisig before the programs hold real money (`solana program set-upgrade-authority`)",
        );
      }
      return ok(`${id}; upgrade authority ${upgradeAuthority} (should be the Squads multisig)`);
    },
  })),
  {
    section: "The programs",
    title: "the randomness program is deployed",
    run: async (c) => {
      const cfg = await c.config.need();
      const id = cfg.vrf.program;
      const info = await c.account(id);
      if (!info) return fail(`${id} does not exist on this cluster`, "set VRF_PROGRAM_ID to ORAO's address (the default)");
      if (!info.executable) return fail(`${id} exists but is not a program`, "set VRF_PROGRAM_ID to ORAO's address (the default)");
      return ok(id);
    },
  },

  // ------------------------------------------------------------------ set up on chain
  {
    section: "Set up on the chain",
    title: "the treasury is initialized",
    run: (c) =>
      c.treasuryConfig.judge(
        (t) => ok(`admin ${t.admin}, split ${t.subsidyBps / 100}% subsidy and ${t.holderBps / 100}% holder, ${usd(t.lockedSubsidy + t.lockedHolder)} reserved for breaks`),
        (reason) => fail(reason, "send the treasury's initialize instruction from its upgrade authority (the builder is initialize in src/solana/treasury.ts)"),
      ),
  },
  {
    section: "Set up on the chain",
    title: "the breaks program is initialized",
    run: (c) =>
      c.breaksConfig.judge(
        (b) => ok(`admin ${b.admin}, ${b.nextBreakId} break${b.nextBreakId === 1n ? "" : "s"} made so far`),
        (reason) => fail(reason, "send the breaks program's initialize instruction from its upgrade authority, after the treasury's (the builder is initialize in src/solana/breaks.ts)"),
      ),
  },
  {
    section: "Set up on the chain",
    title: "this key is the breaks program's keeper",
    run: async (c) => {
      const cfg = await c.config.need();
      const signer = await c.signer.need();
      await c.breaksConfig.need();
      try {
        await verifyKeeperIdentity(c.reader, cfg, signer.address);
        return ok(`${signer.address} is the keeper the program expects`);
      } catch (err) {
        return fail(message(err), "the admin calls set_keeper with this key, or KEEPER_KEYPAIR_PATH points at the right key");
      }
    },
  },
  {
    section: "Set up on the chain",
    title: "it uses the configured randomness program",
    run: async (c) => {
      const cfg = await c.config.need();
      const b = await c.breaksConfig.need();
      return b.randomnessProgram === cfg.vrf.program
        ? ok(`${b.randomnessProgram}, repeated after ${b.randomnessTimeoutSecs} s without an answer`)
        : fail(`the program is set to ask ${b.randomnessProgram}, but VRF_PROGRAM_ID is ${cfg.vrf.program}: the keeper refuses to ask another program`, "set VRF_PROGRAM_ID to match, or the admin calls set_randomness");
    },
  },
  {
    section: "Set up on the chain",
    title: "sales are not paused",
    run: async (c) => {
      const b = await c.breaksConfig.need();
      return b.paused ? warn("the admin has paused the program: no new break, no spot sold, no packs funded (refunds still work)", "the admin calls set_paused with false") : ok("not paused");
    },
  },
  {
    section: "Set up on the chain",
    title: "the treasury takes orders from the breaks program",
    run: async (c) => {
      const cfg = await c.config.need();
      const t = await c.treasuryConfig.need();
      const authority = treasuryAuthorityAddress(cfg.programs);
      return t.controller === authority
        ? ok(`the controller is the breaks program's authority ${authority}`)
        : fail(`the controller is ${t.controller}, not the breaks program's authority ${authority}: create_break cannot reserve money`, `the treasury's admin calls set_controller with ${authority}`);
    },
  },
  {
    section: "Set up on the chain",
    title: "both programs count in the same USDC",
    run: async (c) => {
      const b = await c.breaksConfig.need();
      const t = await c.treasuryConfig.need();
      if (b.usdcMint !== t.usdcMint) return fail(`the breaks program uses ${b.usdcMint} and the treasury ${t.usdcMint}`, "both are set at initialization and cannot be changed: initialize them again on new accounts, or redeploy");
      const info = await c.account(b.usdcMint);
      if (!info) return fail(`the USDC mint ${b.usdcMint} does not exist on this cluster`);
      const mint = decodeMint(info.data);
      return mint.decimals === 6
        ? ok(`${b.usdcMint}, 6 decimals`)
        : warn(`${b.usdcMint} has ${mint.decimals} decimals; the keeper and the website count USDC in 6`, "use a mint with 6 decimals (devnet USDC has 6)");
    },
  },
  {
    section: "Set up on the chain",
    title: "the admins are not the keeper's key",
    run: async (c) => {
      const signer = await c.signer.need();
      const b = await c.breaksConfig.need();
      const t = await c.treasuryConfig.need();
      const hot = [b.admin === signer.address ? "the breaks program's admin" : "", t.admin === signer.address ? "the treasury's admin" : ""].filter(Boolean);
      return hot.length === 0
        ? ok(`breaks admin ${b.admin}, treasury admin ${t.admin} (both should be the Squads multisig)`)
        : warn(`the keeper's own key is ${hot.join(" and ")}: a hot key could pause the program, change the split or cancel breaks`, "move the admin roles to the Squads multisig before real money");
    },
  },
  {
    section: "Set up on the chain",
    title: "the buyer wallet can receive USDC",
    run: async (c) => {
      const b = await c.breaksConfig.need();
      const ata = associatedTokenAddress(b.buyer, b.usdcMint);
      const info = await c.account(ata);
      if (!info) return fail(`the buyer wallet ${b.buyer} has no USDC account (${ata}), so fund_purchases cannot pay it`, "send the buyer wallet any USDC, or create its account with `spl-token create-account`");
      const token = decodeTokenAccount(info.data);
      if (token.mint !== b.usdcMint || token.owner !== b.buyer) return fail(`${ata} is not the buyer's USDC account`);
      if (info.data[108] === 2) return fail(`${ata} is frozen`);
      return ok(`${ata} holds ${usd(token.amount)}`);
    },
  },
  {
    section: "Set up on the chain",
    title: "the configured break is one the program accepts",
    run: async (c) => {
      const cfg = await c.config.need();
      const b = await c.breaksConfig.need();
      const problem = templateProblem(cfg.scheduler.template, b);
      const t = cfg.scheduler.template;
      return problem
        ? fail(problem, "change the BREAK_* settings, or the admin's limits")
        : ok(`${t.paidSpots} paid spots at ${usd(t.spotPrice)}, ${t.freeSpots} free, packs ${describePacks(t.packs)}, open ${t.windowSecs} s`);
    },
  },
  {
    section: "Set up on the chain",
    title: "the reserve can pay for the next break",
    run: async (c) => {
      const cfg = await c.config.need();
      const treasury = await c.treasuryConfig.need();
      const b = await c.breaksConfig.need();
      return c.vaults.judge(
        (vaults) => {
          if (templateProblem(cfg.scheduler.template, b)) throw new Skip("needs a break the program accepts");
          const p = reserveProgress(cfg.scheduler.template, { subsidy: unlocked(vaults.subsidy, treasury.lockedSubsidy), holder: unlocked(vaults.holder, treasury.lockedHolder) });
          const wants = `the subsidy bucket has ${usd(p.availableSubsidy)} of ${usd(p.requiredSubsidy)} needed, the holder bucket ${usd(p.availableHolder)} of ${usd(p.requiredHolder)}`;
          return p.enough
            ? ok(`${wants}: the scheduler creates break #${b.nextBreakId + 1n} on its first run, if the keeper has the SOL`)
            : warn(`${p.percent}%: ${wants}`, "deposit USDC into the treasury: the fee sweep does it for USDC in the keeper's wallet (SWEEP_ENABLED=true), or call deposit_fees yourself");
        },
        (reason) => fail(reason, "the treasury's initialize creates both vaults; check TREASURY_PROGRAM_ID"),
      );
    },
  },
  {
    section: "Set up on the chain",
    title: "ORAO is ready to answer",
    run: (c) =>
      c.orao.judge(
        (state) =>
          state.fulfillmentAuthorities.length === 0
            ? fail("ORAO's network state lists no oracles, so nobody could answer a request", "ORAO's own state is wrong or VRF_PROGRAM_ID is not ORAO")
            : ok(`the fee is ${sol(state.requestFee)} to ${state.treasury}, ${state.fulfillmentAuthorities.length} oracle${state.fulfillmentAuthorities.length === 1 ? "" : "s"}`),
        (reason) => fail(reason, "set VRF_PROGRAM_ID to ORAO's address (the default)"),
      ),
  },

  // ------------------------------------------------------------------ wallets
  {
    section: "The keeper's wallet",
    title: "it holds the SOL to run breaks",
    run: async (c) => {
      const cfg = await c.config.need();
      const signer = await c.signer.need();
      const orao = await c.orao.result();
      return c.keeperLamports.judge(
        (lamports) => {
          const need = keeperSolNeed(cfg.scheduler.template.freeSpots, orao.ok ? orao.value.requestFee : 0n);
          const note = orao.ok ? "" : " (ORAO's fee is not counted: its network state could not be read)";
          const have = `${signer.address} holds ${sol(lamports)}`;
          const topUp = `send it SOL with \`solana transfer ${signer.address} <amount> --allow-unfunded-recipient\`, or from the devnet faucet`;
          if (lamports < need.create) {
            const detail = `${have}; creating a break needs ${sol(need.create)}`;
            return cfg.scheduler.enabled ? fail(detail, topUp) : warn(detail, topUp);
          }
          if (lamports < need.cycle) return warn(`${have}: enough to create a break, not to see one through, which needs about ${sol(need.cycle)}${note}`, topUp);
          return ok(`${have}; creating a break needs ${sol(need.create)} and seeing one through about ${sol(need.cycle)}${note}`);
        },
        (reason) => fail(`cannot read the keeper's balance: ${reason}`, "check the node"),
      );
    },
  },
  {
    section: "The keeper's wallet",
    title: "the fee sweep has USDC to deposit from",
    run: async (c) => {
      const cfg = await c.config.need();
      if (!cfg.sweep.enabled) return ok("the fee sweep is off (SWEEP_ENABLED is not true)");
      const signer = await c.signer.need();
      const treasury = await c.treasuryConfig.need();
      const ata = associatedTokenAddress(signer.address, treasury.usdcMint);
      const info = await c.account(ata);
      return info
        ? ok(`${ata} holds ${usd(decodeTokenAccount(info.data).amount)}; at least ${usd(cfg.sweep.policy.minDeposit)} is deposited`)
        : fail(`the keeper has no USDC account (${ata}), and the sweep does not create one`, "send the keeper wallet any USDC, or create its account with `spl-token create-account`");
    },
  },

  // ------------------------------------------------------------------ the token
  {
    section: "The token",
    title: "TOKEN_MINT is an initialized mint",
    run: async (c) => {
      const cfg = await c.config.need();
      return c.mint.judge(
        (m) => ok(`${cfg.indexer.mint}: ${m.decimals} decimals, supply ${amount(m.supply, m.decimals)}`),
        (reason) => fail(reason, "set TOKEN_MINT to the token whose holders get free spots"),
      );
    },
  },
  {
    section: "The token",
    title: "MIN_TWAB and WEIGHT_CAP make sense for it",
    run: async (c) => {
      const cfg = await c.config.need();
      const m = await c.mint.need();
      const { minTwab, capPerWallet } = cfg.eligibility;
      const tokens = (v: bigint) => `${amount(v, m.decimals)} tokens`;
      const share = m.supply > 0n ? `${amount((minTwab * 10_000n) / m.supply, 2)}% of the supply` : "the supply is zero";
      const text = `MIN_TWAB is ${tokens(minTwab)} (${group(minTwab.toString())} base units, ${share})${capPerWallet !== undefined ? `, WEIGHT_CAP ${tokens(capPerWallet)}` : ", no WEIGHT_CAP"}`;
      if (minTwab > m.supply) return fail(`${text}: more than exists, so nobody could ever be eligible`, "MIN_TWAB is in base units: multiply tokens by 10^decimals");
      if (capPerWallet !== undefined && capPerWallet < minTwab) return warn(`${text}: the cap is below the minimum, so every eligible wallet gets the same weight`, "set WEIGHT_CAP at or above MIN_TWAB, or leave it out (pending decision A2)");
      return ok(text);
    },
  },

  // ------------------------------------------------------------------ the database
  {
    section: "The database",
    title: "it answers",
    run: (c) =>
      c.db.judge(
        () => ok("connected (read-only for this check)"),
        (reason) => fail(`cannot reach the database: ${reason}`, "check DATABASE_URL and that Postgres is running and accepts this machine"),
      ),
  },
  {
    section: "The database",
    title: "every migration is applied",
    run: async (c) => {
      const sql = await c.db.need();
      const problems = await checkSchema(sql);
      return problems.length === 0
        ? ok("every table and column the jobs use is there")
        : fail(problems.join("\n"), 'apply db/migrations in order: psql "$DATABASE_URL" -f db/migrations/0001_init.sql, then 0002 and so on');
    },
  },
  {
    section: "The database",
    title: "the keeper's role can write",
    run: async (c) => {
      const sql = await c.db.need();
      const missing: string[] = [];
      for (const table of TABLES_THE_KEEPER_WRITES) {
        const exists = (await sql.query<{ n: string }>("select count(*)::text as n from information_schema.tables where table_schema = 'public' and table_name = $1", [table])).rows[0]?.n !== "0";
        if (!exists) continue; // the migration check already says so
        const { rows } = await sql.query<{ i: boolean; u: boolean }>("select has_table_privilege(current_user, $1, 'INSERT') as i, has_table_privilege(current_user, $1, 'UPDATE') as u", [`public.${table}`]);
        const [row] = rows;
        if (!row?.i || !row.u) missing.push(`${table} (${[!row?.i ? "insert" : "", !row?.u ? "update" : ""].filter(Boolean).join(" and ")})`);
      }
      return missing.length === 0
        ? ok("the role in DATABASE_URL can insert and update every table the keeper writes")
        : fail(`the role in DATABASE_URL cannot write: ${missing.join(", ")}`, "grant it: GRANT INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO <role>");
    },
  },

  // ------------------------------------------------------------------ outputs
  {
    section: "Outputs",
    title: "the published lists have somewhere to go",
    run: async (c) => {
      const cfg = await c.config.need();
      if (!cfg.publish.dir) {
        return warn("PUBLISH_DIR is not set: the eligibility lists and card pools are not written out, so the website cannot show them", "set PUBLISH_DIR to a folder that is served over https (docs/PUBLISHED.md)");
      }
      const problem = writableDirProblem(cfg.publish.dir);
      return problem ? fail(`PUBLISH_DIR ${cfg.publish.dir}: ${problem}`, "create the folder, or fix its permissions") : ok(`${cfg.publish.dir} can be written to`);
    },
  },
  {
    section: "Outputs",
    title: "the X bot",
    run: async (c) => {
      const cfg = await c.config.need();
      if (!cfg.bot.enabled) return ok("off (BOT_ENABLED is not true)");
      return cfg.bot.poster === "x"
        ? ok(`posts to X as the account of the four X_* credentials, at most ${cfg.bot.limits.maxPerDay} a day`)
        : ok("on as a dry run: posts are only written to the log (BOT_POSTER=log)");
    },
  },
];

/** Runs every check and returns the results in order. Never throws: a check that breaks is reported as a failure of the doctor. */
export async function runChecks(env: Record<string, string | undefined>, ports: DoctorPorts): Promise<Check[]> {
  const ctx = new Ctx(env, ports);
  const checks: Check[] = [];
  try {
    for (const def of DEFS) {
      let outcome: Outcome;
      try {
        outcome = await def.run(ctx);
      } catch (err) {
        outcome = err instanceof Skip ? { status: "skip", detail: err.message } : fail(`the check itself failed: ${message(err)}`);
      }
      checks.push({ section: def.section, title: def.title, status: outcome.status, detail: outcome.detail, ...("fix" in outcome && outcome.fix ? { fix: outcome.fix } : {}) });
    }
  } finally {
    await ctx.close();
  }
  return checks;
}
