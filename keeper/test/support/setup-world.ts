// A pretend devnet for the setup tool's tests: both programs deployed (upgrade authority a key the test holds), nothing
// initialized, a 6-decimal USDC mint, and a node that EXECUTES what it is sent. Each transaction is decoded with web3.js (an
// independent parser), its signatures are verified, and its instructions run on a small model of the four things setup sends:
// the treasury's `initialize` and `set_controller`, the breaks program's `initialize` and the associated token program's
// `CreateIdempotent`, following programs/treasury/src/lib.rs and programs/breaks/src/admin.rs. A transaction that fails changes
// nothing. Rent and fees are written out as numbers, not computed with the keeper's helper.

import { Transaction } from "@solana/web3.js";
import { RpcChainClient } from "../../src/pipeline/rpc-chain.js";
import type { SetupRequest } from "../../src/setup/args.js";
import type { SetupChain } from "../../src/setup/run.js";
import { Reader } from "../../src/solana/codec.js";
import { ORAO_PROGRAM, configAddress, decodeBreaksConfig } from "../../src/solana/breaks.js";
import { TOKEN_PROGRAM, UPGRADEABLE_LOADER, instructionDiscriminator, programDataAddress } from "../../src/solana/instruction.js";
import { type Signer, signerFromSecretKey } from "../../src/solana/keypair.js";
import { decodeProgramData } from "../../src/solana/loader.js";
import { ASSOCIATED_TOKEN_PROGRAM, type Address, associatedTokenAddress, findProgramAddress } from "../../src/solana/pubkey.js";
import { RpcClient } from "../../src/solana/rpc.js";
import { decodeMint, decodeTokenAccount } from "../../src/solana/token.js";
import { decodeTreasuryConfig, treasuryAddresses } from "../../src/solana/treasury.js";
import { encodeBreaksConfig, encodeTokenAccount, encodeTreasuryConfig } from "./accounts.js";
import { addr } from "./chain.js";
import { mintData, programAccount, programDataAccount } from "./doctor-world.js";
import { FakeNode } from "./fake-node.js";
import { PROGRAMS } from "./world.js";

export const SOL = 1_000_000_000n;
export const USDC = addr(0xc0);
export const KEEPER = addr(0x4b);
export const BUYER = addr(0xb0);
export const SYSTEM = "11111111111111111111111111111111";

/** The two keys a test holds. */
export const AUTHORITY: Signer = signerFromSecretKey(new Uint8Array(32).fill(7));
export const ADMIN_KEY: Signer = signerFromSecretKey(new Uint8Array(32).fill(8));

// Rent and fees as the runtime charges them, written out: (128 + bytes) * 6,960.
const RENT_TREASURY_CONFIG = 1_760_880n; // 125 bytes
const RENT_BREAKS_CONFIG = 2_324_640n; // 206 bytes
const RENT_TOKEN_ACCOUNT = 2_039_280n; // 165 bytes
const RENT_EMPTY = 890_880n;
const FEE = 5_000n;

class Refused extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const startsWith = (data: Uint8Array, prefix: Uint8Array) => prefix.every((b, i) => data[i] === b);

export interface SetupWorld {
  node: FakeNode;
  /** Names of instructions the model refuses (after running them), for a test of a step that fails. */
  refuse: Set<string>;
  /** Instructions the model applied, in order: "treasury.initialize", "breaks.initialize", "treasury.set_controller", "ata.create". */
  applied: string[];
  /** The request the tool would be given: every flag filled in, dry run. */
  request(over?: Partial<SetupRequest>): SetupRequest;
  /** A chain client over the node, signing as the authority: what the real tool uses. */
  chain(): Promise<RpcChainClient & SetupChain>;
  lamports(address: Address): bigint;
}

export function setupWorld(over: { upgradeAuthority?: Address | null; authorityLamports?: bigint } = {}): SetupWorld {
  const node = new FakeNode();
  // Two transactions that differ only in time would otherwise be the same bytes, and the same signature.
  node.uniqueBlockhashes = true;
  const applied: string[] = [];
  const refuse = new Set<string>();
  const upgradeAuthority = over.upgradeAuthority === undefined ? AUTHORITY.address : over.upgradeAuthority;

  const put = (address: Address, data: Uint8Array, owner: Address, lamports: bigint) => {
    node.accounts.set(address, data);
    node.owners.set(address, owner);
    node.lamports.set(address, lamports);
  };

  for (const program of [PROGRAMS.breaks, PROGRAMS.treasury]) {
    const programData = programDataAddress(program);
    put(program, programAccount(programData), UPGRADEABLE_LOADER, 1_141_440n);
    node.executables.add(program);
    put(programData, programDataAccount(upgradeAuthority ?? undefined), UPGRADEABLE_LOADER, 5n * SOL);
  }
  put(ORAO_PROGRAM, new Uint8Array(36), UPGRADEABLE_LOADER, 1n);
  node.executables.add(ORAO_PROGRAM);
  put(USDC, mintData(1_000_000_000_000_000n, 6), TOKEN_PROGRAM, 1_461_600n);
  // A wallet is an account with no data, owned by the system program; a node that has none answers null.
  put(AUTHORITY.address, new Uint8Array(0), SYSTEM, over.authorityLamports ?? 5n * SOL);

  const lamports = (a: Address) => node.lamports.get(a) ?? 0n;
  const pay = (from: Address, amount: bigint) => {
    const left = lamports(from) - amount;
    if (left < 0n) throw new Refused("InsufficientFunds");
    if (left !== 0n && left < RENT_EMPTY) throw new Refused("InsufficientFundsForRent");
    node.lamports.set(from, left);
  };
  /** Makes an account at an address that must not exist yet, paid by `payer`. */
  const create = (payer: Address, address: Address, data: Uint8Array, owner: Address, rent: bigint) => {
    if (node.accounts.has(address) && (node.owners.get(address) ?? SYSTEM) !== SYSTEM) throw new Refused("AccountAlreadyInUse");
    pay(payer, rent);
    put(address, data, owner, rent);
  };
  const bumpOf = (seeds: Uint8Array[], program: Address) => findProgramAddress(seeds, program).bump;

  type Key = { pubkey: Address; isSigner: boolean; isWritable: boolean };
  const signerOf = (keys: Key[], i: number): Address => {
    const k = keys[i];
    if (!k?.isSigner) throw new Refused("AccountNotSigner");
    return k.pubkey;
  };
  const upgradeAuthorityOf = (program: Address, programData: Address): Address | undefined => {
    if (programData !== programDataAddress(program)) throw new Refused("InvalidProgramData");
    return decodeProgramData(node.accounts.get(programData) as Uint8Array).upgradeAuthority;
  };
  const expectMint = (address: Address) => {
    const data = node.accounts.get(address);
    if (!data || node.owners.get(address) !== TOKEN_PROGRAM) throw new Refused("AccountNotInitialized");
    return decodeMint(data);
  };

  /** Records an applied instruction, or refuses it if the test asked for that (the whole transaction is then rolled back). */
  function finish(name: string) {
    if (refuse.has(name)) throw new Refused("Injected");
    applied.push(name);
  }

  function apply(program: Address, keys: Key[], data: Uint8Array) {
    if (program === PROGRAMS.treasury && startsWith(data, instructionDiscriminator("initialize"))) {
      const k = (i: number) => keys[i]?.pubkey as Address;
      const [authority, programData, config, mint, subsidyVault, holderVault] = [k(0), k(2), k(3), k(4), k(5), k(6)] as [Address, Address, Address, Address, Address, Address];
      const signer = signerOf(keys, 0);
      if (upgradeAuthorityOf(PROGRAMS.treasury, programData) !== signer) throw new Refused("Unauthorized");
      const t = treasuryAddresses(PROGRAMS.treasury);
      if (config !== t.config || subsidyVault !== t.subsidyVault || holderVault !== t.holderVault) throw new Refused("ConstraintSeeds");
      const r = new Reader(data.subarray(8));
      const admin = r.address();
      const subsidyBps = r.u16();
      const holderBps = r.u16();
      expectMint(mint);
      if (subsidyBps + holderBps !== 10_000) throw new Refused("InvalidSplit");
      create(authority, config, encodeTreasuryConfig({ admin, usdcMint: mint, controller: SYSTEM, subsidyBps, holderBps, lockedSubsidy: 0n, lockedHolder: 0n, bump: bumpOf([new TextEncoder().encode("config")], PROGRAMS.treasury) }), PROGRAMS.treasury, RENT_TREASURY_CONFIG);
      create(authority, subsidyVault, encodeTokenAccount({ mint: mint, owner: config, amount: 0n }), TOKEN_PROGRAM, RENT_TOKEN_ACCOUNT);
      create(authority, holderVault, encodeTokenAccount({ mint: mint, owner: config, amount: 0n }), TOKEN_PROGRAM, RENT_TOKEN_ACCOUNT);
      finish("treasury.initialize");
    } else if (program === PROGRAMS.breaks && startsWith(data, instructionDiscriminator("initialize"))) {
      const k = (i: number) => keys[i]?.pubkey as Address;
      const [authority, programData, config, treasuryConfig, mint] = [k(0), k(2), k(3), k(4), k(5)] as [Address, Address, Address, Address, Address];
      const signer = signerOf(keys, 0);
      if (upgradeAuthorityOf(PROGRAMS.breaks, programData) !== signer) throw new Refused("Unauthorized");
      if (config !== configAddress(PROGRAMS)) throw new Refused("ConstraintSeeds");
      const r = new Reader(data.subarray(8));
      const admin = r.address();
      const keeper = r.address();
      const buyer = r.address();
      const minWindowSecs = r.i64();
      const maxWindowSecs = r.i64();
      const maxPaidSpots = r.u16();
      const maxFreeSpots = r.u16();
      const randomnessProgram = r.address();
      const randomnessTimeoutSecs = r.i64();
      // The treasury this program locks funds in: it must exist, and its mint becomes ours.
      if (treasuryConfig !== treasuryAddresses(PROGRAMS.treasury).config) throw new Refused("ConstraintSeeds");
      const tdata = node.accounts.get(treasuryConfig);
      if (!tdata || node.owners.get(treasuryConfig) !== PROGRAMS.treasury) throw new Refused("AccountNotInitialized");
      if (decodeTreasuryConfig(tdata).usdcMint !== mint) throw new Refused("ConstraintAddress");
      expectMint(mint);
      if (!(minWindowSecs > 0n && minWindowSecs <= maxWindowSecs)) throw new Refused("InvalidLimits");
      if (!(maxPaidSpots >= 1)) throw new Refused("InvalidLimits");
      if (maxFreeSpots > 16) throw new Refused("InvalidLimits");
      if (maxPaidSpots + maxFreeSpots > 64) throw new Refused("InvalidLimits");
      if (!(randomnessTimeoutSecs > 0n)) throw new Refused("InvalidRandomnessConfig");
      create(authority, config, encodeBreaksConfig({ admin, keeper, buyer, usdcMint: mint, randomnessProgram, randomnessTimeoutSecs, nextBreakId: 0n, minWindowSecs, maxWindowSecs, maxPaidSpots, maxFreeSpots, paused: false, bump: bumpOf([new TextEncoder().encode("config")], PROGRAMS.breaks) }), PROGRAMS.breaks, RENT_BREAKS_CONFIG);
      finish("breaks.initialize");
    } else if (program === PROGRAMS.treasury && startsWith(data, instructionDiscriminator("set_controller"))) {
      const admin = signerOf(keys, 0);
      const configKey = keys[1]?.pubkey as Address;
      if (configKey !== treasuryAddresses(PROGRAMS.treasury).config) throw new Refused("ConstraintSeeds");
      const raw = node.accounts.get(configKey);
      if (!raw || node.owners.get(configKey) !== PROGRAMS.treasury) throw new Refused("AccountNotInitialized");
      const config = decodeTreasuryConfig(raw);
      if (config.admin !== admin) throw new Refused("Unauthorized");
      const controller = new Reader(data.subarray(8)).address();
      node.accounts.set(configKey, encodeTreasuryConfig({ ...config, controller }));
      finish("treasury.set_controller");
    } else if (program === ASSOCIATED_TOKEN_PROGRAM && data.length === 1 && data[0] === 1) {
      const k = (i: number) => keys[i]?.pubkey as Address;
      const [payer, ata, owner, mint, system, token] = [k(0), k(1), k(2), k(3), k(4), k(5)] as [Address, Address, Address, Address, Address, Address];
      signerOf(keys, 0);
      if (system !== SYSTEM || token !== TOKEN_PROGRAM) throw new Refused("IncorrectProgramId");
      if (ata !== associatedTokenAddress(owner, mint)) throw new Refused("InvalidSeeds");
      expectMint(mint);
      const have = node.accounts.get(ata);
      if (have && node.owners.get(ata) === TOKEN_PROGRAM) {
        const t = decodeTokenAccount(have);
        if (t.owner !== owner || t.mint !== mint) throw new Refused("IllegalOwner");
      } else {
        create(payer, ata, encodeTokenAccount({ mint: mint, owner: owner, amount: 0n }), TOKEN_PROGRAM, RENT_TOKEN_ACCOUNT);
      }
      finish("ata.create");
    } else {
      throw new Refused(`UnknownInstruction(${program})`);
    }
  }

  node.execute = async (bytes) => {
    const tx = Transaction.from(bytes);
    if (!tx.verifySignatures()) return { ok: false, err: "SignatureFailure" };
    const snapshot = {
      accounts: new Map(node.accounts),
      owners: new Map(node.owners),
      lamports: new Map(node.lamports),
      applied: [...applied],
    };
    try {
      const payer = tx.feePayer?.toBase58() as Address;
      pay(payer, FEE * BigInt(tx.signatures.length));
      for (const ix of tx.instructions) {
        apply(
          ix.programId.toBase58(),
          ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
          new Uint8Array(ix.data),
        );
      }
      return { ok: true };
    } catch (err) {
      node.accounts.clear();
      node.owners.clear();
      node.lamports.clear();
      for (const [k, v] of snapshot.accounts) node.accounts.set(k, v);
      for (const [k, v] of snapshot.owners) node.owners.set(k, v);
      for (const [k, v] of snapshot.lamports) node.lamports.set(k, v);
      applied.length = 0;
      applied.push(...snapshot.applied);
      if (err instanceof Refused) return { ok: false, err: err.code };
      throw err;
    }
  };

  return {
    node,
    applied,
    refuse,
    lamports,
    request: (extra = {}) => ({
      programs: PROGRAMS,
      vrfProgram: ORAO_PROGRAM,
      rpcUrl: "https://rpc.example/SECRETPATH0123456789",
      cluster: "devnet",
      usdcMint: USDC,
      keeper: KEEPER,
      buyer: BUYER,
      admin: undefined,
      subsidyBps: 7_000,
      holderBps: 3_000,
      minWindowSecs: 3_600n,
      maxWindowSecs: 21_600n,
      maxPaidSpots: 48,
      maxFreeSpots: 16,
      randomnessTimeoutSecs: 600n,
      authorityKeypair: "authority.json",
      adminKeypair: undefined,
      send: false,
      ...extra,
    }),
    chain: async () => {
      const rpc = new RpcClient({ url: "http://fake", fetch: node.fetch, sleep: node.sleep, retries: 0 });
      return (await RpcChainClient.connect({ rpc, signer: AUTHORITY, cluster: "devnet", now: node.now, sleep: node.sleep })) as RpcChainClient & SetupChain;
    },
  };
}

/** Reads what the model holds, for assertions. */
export const decoded = {
  treasury: (w: SetupWorld) => decodeTreasuryConfig(w.node.accounts.get(treasuryAddresses(PROGRAMS.treasury).config) as Uint8Array),
  breaks: (w: SetupWorld) => decodeBreaksConfig(w.node.accounts.get(configAddress(PROGRAMS)) as Uint8Array),
};

