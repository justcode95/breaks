import { z } from "zod";
import { ORAO_PROGRAM, type Programs } from "./solana/breaks.js";
import { type BreakTemplate } from "./scheduler/policy.js";
import { packMachineBytes } from "./scheduler/machine.js";
import { type Address, addressToBytes } from "./solana/pubkey.js";

const isAddress = (s: string) => {
  try {
    addressToBytes(s);
    return true;
  } catch {
    return false;
  }
};
const address = z.string().refine(isAddress, "not a Solana address (32 bytes, base58)");

const isMachine = (s: string) => {
  try {
    packMachineBytes(s);
    return true;
  } catch {
    return false;
  }
};

// Devnet only (CLAUDE.md guardrails). Adding "mainnet-beta" here is a rule change that needs the owner's sign-off.
const shape = z.object({
  SOLANA_CLUSTER: z.enum(["devnet", "localnet"]).default("devnet"),
  SOLANA_RPC_URL: z.string().url(),
  DATABASE_URL: z.string().min(1),
  // Only "mock" exists until Phase 0 shows how Collector Crypt purchases and card transfers work.
  PACK_PROVIDER: z.enum(["mock"]).default("mock"),
  CARD_TRANSFER: z.enum(["mock"]).default("mock"),
  // What the mock pack provider charges per pack, in micro-USDC. A pack above a break's cap is not "bought".
  MOCK_PACK_PRICE: z.coerce.bigint().positive().default(25_000_000n),
  // How often the runner wakes up, and how often each job runs when it does.
  JOB_TICK_MS: z.coerce.number().int().min(100).default(5000),
  JOB_INTERVAL_MS: z.coerce.number().int().min(1000).default(10_000),
  // Path to the keeper's Solana CLI keypair file (a JSON array of bytes). Never put the key itself in the environment.
  KEEPER_KEYPAIR_PATH: z.string().min(1).optional(),
  // What counts as landed, for sends and reads. `finalized` is slower and safer.
  SOLANA_COMMITMENT: z.enum(["confirmed", "finalized"]).default("confirmed"),
  // Who is eligible for a free spot (CLAUDE.md, "No staking"). Both are in token base units. The minimum is an open
  // decision, so it has no default. WEIGHT_CAP is pending decision A2: a cap rewards splitting a balance over wallets.
  MIN_TWAB: z.coerce.bigint().positive(),
  WEIGHT_CAP: z.coerce.bigint().positive().optional(),
  // The balance indexer must have read this far past the end of a window before the list is computed.
  INDEXER_SETTLE_SECS: z.coerce.number().int().min(0).default(120),
  // The token whose holders get free spots. Required: with the wrong mint every list would be empty. The keeper checks
  // at startup that it is an initialized mint on this cluster.
  TOKEN_MINT: address,
  // The balance indexer reads every holder again at least this often (seconds); a break whose window ended is read at once.
  INDEXER_INTERVAL_SECS: z.coerce.number().int().min(60).default(900),
  // A pass only claims what happened this long before it started (finalization takes seconds, a stalled cluster longer).
  INDEXER_LAG_SECS: z.coerce.number().int().min(30).default(120),
  // Node calls per run of the indexer (a page of signatures or a transaction each), signatures per page, and transactions
  // fetched at the same time. A page is read whole, so a run is a few pages: the defaults are about 6 calls a second with
  // bursts of 4. Lower them on a node with tight rate limits, raise them to catch up faster on a busy token.
  INDEXER_CALLS_PER_RUN: z.coerce.number().int().min(1).default(60),
  INDEXER_PAGE_SIZE: z.coerce.number().int().min(1).max(1000).default(25),
  INDEXER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  // The deployed programs.
  BREAKS_PROGRAM_ID: address,
  TREASURY_PROGRAM_ID: address,
  // Randomness: the VRF program (must be the one the breaks program is configured with) and ORAO's fee treasury,
  // which is a field of ORAO's network state. Read it from there and copy it in; the keeper does not guess it.
  VRF_PROGRAM_ID: address.default(ORAO_PROGRAM),
  ORAO_TREASURY: address,
  // The break the scheduler creates when the treasury can pay for its worst case. The numbers are open decisions
  // (CLAUDE.md), so none has a default. Prices are micro-USDC. The program checks them against its own limits too.
  BREAK_AUTO_CREATE: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  BREAK_PAID_SPOTS: z.coerce.number().int().min(1).max(65_535),
  BREAK_FREE_SPOTS: z.coerce.number().int().min(0).max(16),
  BREAK_SPOT_PRICE: z.coerce.bigint().positive(),
  BREAK_MAX_PACK_PRICE: z.coerce.bigint().positive(),
  // Text of up to 32 bytes, or 0x and 64 hex digits for a raw 32-byte id. Committed on-chain for the whole break.
  BREAK_PACK_MACHINE: z.string().refine(isMachine, "not a machine label (1 to 32 plain text bytes, or 0x and 64 hex digits)"),
  // How long the sale and the TWAB window last.
  BREAK_WINDOW_SECS: z.coerce.number().int().min(60),
});

const schema = shape.superRefine((e, ctx) => {
  if (e.BREAK_SPOT_PRICE > e.BREAK_MAX_PACK_PRICE) {
    ctx.addIssue({ code: "custom", path: ["BREAK_SPOT_PRICE"], message: "must not be above BREAK_MAX_PACK_PRICE (a markup is not supported)" });
  }
});

export type Config = {
  cluster: "devnet" | "localnet";
  rpcUrl: string;
  databaseUrl: string;
  packProvider: "mock";
  cardTransfer: "mock";
  mockPackPrice: bigint;
  jobTickMs: number;
  jobIntervalMs: number;
  keeperKeypairPath?: string;
  commitment: "confirmed" | "finalized";
  programs: Programs;
  vrf: { program: Address; treasury: Address };
  eligibility: { minTwab: bigint; capPerWallet?: bigint; settleSecs: number };
  indexer: { mint: Address; intervalSecs: number; lagSecs: number; callsPerRun: number; pageSize: number; concurrency: number };
  scheduler: { enabled: boolean; template: BreakTemplate };
};

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid keeper config: ${problems}`);
  }
  const e = parsed.data;
  return {
    cluster: e.SOLANA_CLUSTER,
    rpcUrl: e.SOLANA_RPC_URL,
    databaseUrl: e.DATABASE_URL,
    packProvider: e.PACK_PROVIDER,
    cardTransfer: e.CARD_TRANSFER,
    mockPackPrice: e.MOCK_PACK_PRICE,
    jobTickMs: e.JOB_TICK_MS,
    jobIntervalMs: e.JOB_INTERVAL_MS,
    ...(e.KEEPER_KEYPAIR_PATH !== undefined ? { keeperKeypairPath: e.KEEPER_KEYPAIR_PATH } : {}),
    commitment: e.SOLANA_COMMITMENT,
    programs: { breaks: e.BREAKS_PROGRAM_ID, treasury: e.TREASURY_PROGRAM_ID },
    vrf: { program: e.VRF_PROGRAM_ID, treasury: e.ORAO_TREASURY },
    eligibility: {
      minTwab: e.MIN_TWAB,
      ...(e.WEIGHT_CAP !== undefined ? { capPerWallet: e.WEIGHT_CAP } : {}),
      settleSecs: e.INDEXER_SETTLE_SECS,
    },
    indexer: {
      mint: e.TOKEN_MINT,
      intervalSecs: e.INDEXER_INTERVAL_SECS,
      lagSecs: e.INDEXER_LAG_SECS,
      callsPerRun: e.INDEXER_CALLS_PER_RUN,
      pageSize: e.INDEXER_PAGE_SIZE,
      concurrency: e.INDEXER_CONCURRENCY,
    },
    scheduler: {
      enabled: e.BREAK_AUTO_CREATE,
      template: {
        paidSpots: e.BREAK_PAID_SPOTS,
        freeSpots: e.BREAK_FREE_SPOTS,
        spotPrice: e.BREAK_SPOT_PRICE,
        maxPackPrice: e.BREAK_MAX_PACK_PRICE,
        packMachine: packMachineBytes(e.BREAK_PACK_MACHINE),
        windowSecs: BigInt(e.BREAK_WINDOW_SECS),
      },
    },
  };
}
