import { z } from "zod";
import { ORAO_PROGRAM, type Programs } from "./solana/breaks.js";
import { type BreakTemplate } from "./scheduler/policy.js";
import type { SweepPolicy } from "./sweep/policy.js";
import type { BotLimits } from "./bot/bot.js";
import type { BotSettings } from "./bot/policy.js";
import type { XCredentials } from "./bot/x-poster.js";
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

/** "25,50,75" as numbers; empty items are ignored. */
const list = (s: string): number[] =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x !== "")
    .map(Number);
const httpsUrl = z.string().url().refine((u) => u.startsWith("https://"), "must be an https:// address");

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
  // Randomness: the VRF program, which must be the one the breaks program is configured with. ORAO's fee treasury is
  // read from the program's network state when a request is made, so there is nothing to copy in.
  VRF_PROGRAM_ID: address.default(ORAO_PROGRAM),
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
  // The fee sweep moves money (USDC in the keeper's wallet into the treasury), so it is off until it is turned on.
  SWEEP_ENABLED: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  // Only "none" exists: a swap from SOL to USDC needs Jupiter, which is a mainnet service. Without one, the sweep only
  // deposits USDC that is already in the wallet.
  SWEEP_SWAP_PROVIDER: z.enum(["none"]).default("none"),
  // USDC (base units) below which nothing is deposited.
  SWEEP_MIN_DEPOSIT: z.coerce.bigint().positive().default(1_000_000n),
  // For a swap provider: the SOL (lamports) the wallet always keeps, the smallest and the largest swap, the slippage
  // allowed in basis points, and an optional floor price (base units of USDC for one whole SOL) below which nothing is swapped.
  SWEEP_KEEP_LAMPORTS: z.coerce.bigint().nonnegative().default(1_000_000_000n),
  SWEEP_MIN_LAMPORTS: z.coerce.bigint().positive().default(100_000_000n),
  SWEEP_MAX_LAMPORTS: z.coerce.bigint().positive().default(10_000_000_000n),
  SWEEP_SLIPPAGE_BPS: z.coerce.number().int().min(0).max(1_000).default(50),
  SWEEP_MIN_USDC_PER_SOL: z.coerce.bigint().positive().optional(),
  // The X bot. Off until it is turned on. `log` only writes what it would post to the log (a dry run, no account
  // needed); `x` posts to X as the account the four X_* credentials belong to.
  BOT_ENABLED: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  BOT_POSTER: z.enum(["log", "x"]).default("log"),
  X_API_BASE: httpsUrl.optional(),
  X_CONSUMER_KEY: z.string().min(1).optional(),
  X_CONSUMER_SECRET: z.string().min(1).optional(),
  X_ACCESS_TOKEN: z.string().min(1).optional(),
  X_ACCESS_TOKEN_SECRET: z.string().min(1).optional(),
  // How often the bot looks, the least time between two posts, and the most posts in 24 hours (a pay-per-post budget).
  BOT_INTERVAL_SECS: z.coerce.number().int().min(10).default(60),
  BOT_MIN_GAP_SECS: z.coerce.number().int().min(0).default(60),
  BOT_MAX_POSTS_PER_DAY: z.coerce.number().int().min(1).default(20),
  // A post that gets no verdict is sent again with the same text after attempts x this many seconds, up to this many sends.
  BOT_RETRY_STEP_SECS: z.coerce.number().int().min(1).default(120),
  BOT_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  // The progress of the next break is announced at these percentages, and spots left this many hours before the end.
  BOT_MILESTONES: z.string().default("25,50,75"),
  BOT_REMINDER_HOURS: z.string().default("3,1"),
  // How many of the latest breaks are looked at, and how long a delivery must be old before the results are posted.
  BOT_LOOKBACK_BREAKS: z.coerce.number().int().min(1).max(50).default(5),
  BOT_FINALITY_MARGIN_SECS: z.coerce.number().int().min(0).default(120),
  // Where the results page will be: the results post links to <BOT_SITE_URL>/breaks/<number>. No link without it.
  BOT_SITE_URL: httpsUrl.optional(),
});

const schema = shape.superRefine((e, ctx) => {
  if (e.SWEEP_MIN_LAMPORTS > e.SWEEP_MAX_LAMPORTS) {
    ctx.addIssue({ code: "custom", path: ["SWEEP_MIN_LAMPORTS"], message: "must not be above SWEEP_MAX_LAMPORTS" });
  }
  const milestones = list(e.BOT_MILESTONES);
  if (!milestones.every((m, i) => Number.isInteger(m) && m >= 1 && m <= 99 && (i === 0 || m > (milestones[i - 1] as number)))) {
    ctx.addIssue({ code: "custom", path: ["BOT_MILESTONES"], message: "must be whole percentages from 1 to 99, rising, like 25,50,75" });
  }
  if (!list(e.BOT_REMINDER_HOURS).every((h) => Number.isInteger(h) && h >= 1 && h <= 168)) {
    ctx.addIssue({ code: "custom", path: ["BOT_REMINDER_HOURS"], message: "must be whole hours from 1 to 168, like 3,1" });
  }
  if (e.BOT_ENABLED && e.BOT_POSTER === "x") {
    for (const name of ["X_CONSUMER_KEY", "X_CONSUMER_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"] as const) {
      if (e[name] === undefined) ctx.addIssue({ code: "custom", path: [name], message: "is required when BOT_POSTER=x" });
    }
  }
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
  vrf: { program: Address };
  eligibility: { minTwab: bigint; capPerWallet?: bigint; settleSecs: number };
  indexer: { mint: Address; intervalSecs: number; lagSecs: number; callsPerRun: number; pageSize: number; concurrency: number };
  scheduler: { enabled: boolean; template: BreakTemplate };
  sweep: { enabled: boolean; swapProvider: "none"; policy: SweepPolicy };
  bot: {
    enabled: boolean;
    poster: "log" | "x";
    /** Only with poster "x". */
    x?: { baseUrl?: string; credentials: XCredentials };
    intervalSecs: number;
    settings: BotSettings;
    limits: BotLimits;
    lookback: number;
  };
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
    vrf: { program: e.VRF_PROGRAM_ID },
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
    sweep: {
      enabled: e.SWEEP_ENABLED,
      swapProvider: e.SWEEP_SWAP_PROVIDER,
      policy: {
        keepLamports: e.SWEEP_KEEP_LAMPORTS,
        minLamports: e.SWEEP_MIN_LAMPORTS,
        maxLamports: e.SWEEP_MAX_LAMPORTS,
        slippageBps: e.SWEEP_SLIPPAGE_BPS,
        ...(e.SWEEP_MIN_USDC_PER_SOL !== undefined ? { minUsdcPerSol: e.SWEEP_MIN_USDC_PER_SOL } : {}),
        minDeposit: e.SWEEP_MIN_DEPOSIT,
      },
    },
    bot: {
      enabled: e.BOT_ENABLED,
      poster: e.BOT_POSTER,
      ...(e.BOT_POSTER === "x" && e.X_CONSUMER_KEY && e.X_CONSUMER_SECRET && e.X_ACCESS_TOKEN && e.X_ACCESS_TOKEN_SECRET
        ? {
            x: {
              ...(e.X_API_BASE !== undefined ? { baseUrl: e.X_API_BASE } : {}),
              credentials: {
                consumerKey: e.X_CONSUMER_KEY,
                consumerSecret: e.X_CONSUMER_SECRET,
                accessToken: e.X_ACCESS_TOKEN,
                accessTokenSecret: e.X_ACCESS_TOKEN_SECRET,
              },
            },
          }
        : {}),
      intervalSecs: e.BOT_INTERVAL_SECS,
      settings: {
        milestones: list(e.BOT_MILESTONES),
        reminderHours: list(e.BOT_REMINDER_HOURS),
        finalityMarginSecs: e.BOT_FINALITY_MARGIN_SECS,
        ...(e.BOT_SITE_URL !== undefined ? { siteUrl: e.BOT_SITE_URL } : {}),
      },
      limits: { minGapSecs: e.BOT_MIN_GAP_SECS, maxPerDay: e.BOT_MAX_POSTS_PER_DAY, maxAttempts: e.BOT_MAX_ATTEMPTS, retryStepSecs: e.BOT_RETRY_STEP_SECS },
      lookback: e.BOT_LOOKBACK_BREAKS,
    },
  };
}
