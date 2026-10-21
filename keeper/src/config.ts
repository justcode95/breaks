import { z } from "zod";
import { MAX_PACKS, MAX_TIERS, ORAO_PROGRAM, type Programs } from "./solana/breaks.js";
import { type BreakTemplate } from "./scheduler/policy.js";
import type { SweepPolicy } from "./sweep/policy.js";
import type { BotLimits } from "./bot/bot.js";
import type { BotSettings } from "./bot/policy.js";
import type { XCredentials } from "./bot/x-poster.js";
import { parsePackGroups } from "./scheduler/packs-config.js";
import { type Address, addressToBytes } from "./solana/pubkey.js";
import { TELEGRAM_CHAT, TELEGRAM_TOKEN } from "./watch/alerter.js";

const isAddress = (s: string) => {
  try {
    addressToBytes(s);
    return true;
  } catch {
    return false;
  }
};
const address = z.string().refine(isAddress, "not a Solana address (32 bytes, base58)");

/** "25,50,75" as numbers; empty items are ignored. */
const list = (s: string): number[] =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x !== "")
    .map(Number);
const httpsUrl = z.string().url().refine((u) => u.startsWith("https://"), "must be an https:// address");

/** https, or http to this machine only (a check service run on the same host, or a test). */
const localOrHttps = z
  .string()
  .url()
  .refine((u) => {
    // The check runs even when `url()` already refused the text.
    if (!URL.canParse(u)) return false;
    const url = new URL(u);
    return url.protocol === "https:" || (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1"));
  }, "must be an https:// address (or http:// to this machine)");

// The watchdog, always on: a problem that lasts ALERT_AFTER_MINS (a job that keeps failing, a break stuck in a stage, too
// little SOL, the program paused) is reported once, and again when it clears; what stays open is listed again every
// ALERT_REPEAT_HOURS (0: never). Messages always go to the log. ALERTS=telegram also sends them to one Telegram chat,
// through the bot whose token BotFather gave (the token is a secret: never in a log or a commit). ALERT_HEARTBEAT_URL is
// an outside check that is told every run that the keeper is alive and its alerts get through (a dead-man's switch such
// as healthchecks.io: it raises the alarm when the pings stop); its address usually holds a secret key too.
const watchFields = {
  SOLANA_CLUSTER: z.enum(["devnet", "localnet"]).default("devnet"),
  ALERTS: z.enum(["log", "telegram"]).default("log"),
  ALERT_TELEGRAM_BOT_TOKEN: z.string().regex(TELEGRAM_TOKEN, "is not a bot token as BotFather gives it (digits, a colon, then the secret)").optional(),
  ALERT_TELEGRAM_CHAT_ID: z.string().regex(TELEGRAM_CHAT, "must be a chat's number (a group's is negative) or a public channel's @name").optional(),
  ALERT_HEARTBEAT_URL: localOrHttps.optional(),
  ALERT_AFTER_MINS: z.coerce.number().int().min(1).max(1440).default(15),
  ALERT_REPEAT_HOURS: z.coerce.number().int().min(0).max(168).default(12),
  WATCH_INTERVAL_SECS: z.coerce.number().int().min(10).max(3600).default(60),
};

type WatchEnv = z.infer<z.ZodObject<typeof watchFields>>;

function watchRules(e: WatchEnv, ctx: z.RefinementCtx): void {
  if (e.ALERTS === "telegram") {
    for (const name of ["ALERT_TELEGRAM_BOT_TOKEN", "ALERT_TELEGRAM_CHAT_ID"] as const) {
      if (e[name] === undefined) ctx.addIssue({ code: "custom", path: [name], message: "is required when ALERTS=telegram" });
    }
  }
}

// Devnet only (CLAUDE.md guardrails). Adding "mainnet-beta" here is a rule change that needs the owner's sign-off.
const shape = z.object({
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
  // The packs of the break: a JSON list of groups, each a machine (text of up to 32 bytes, or 0x and 64 hex digits for a
  // raw 32-byte id), the most one pack from it may cost, and how many of the break's packs come from it. One pack per spot,
  // so the counts add up to BREAK_PAID_SPOTS + BREAK_FREE_SPOTS. See scheduler/packs-config.ts.
  BREAK_PACKS: z.string().transform((text, ctx) => {
    const r = parsePackGroups(text);
    if (!r.ok) {
      ctx.addIssue({ code: "custom", message: r.error });
      return z.NEVER;
    }
    return r.groups;
  }),
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
  // Where the public lists (each break's eligible wallets and its cards) are written, as files named by the hashes the
  // chain committed (docs/PUBLISHED.md). Serve the directory over https. Off without it.
  PUBLISH_DIR: z.string().min(1).optional(),
  PUBLISH_INTERVAL_SECS: z.coerce.number().int().min(10).default(60),
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
  ...watchFields,
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
  watchRules(e, ctx);
  if (e.BOT_ENABLED && e.BOT_POSTER === "x") {
    for (const name of ["X_CONSUMER_KEY", "X_CONSUMER_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"] as const) {
      if (e[name] === undefined) ctx.addIssue({ code: "custom", path: [name], message: "is required when BOT_POSTER=x" });
    }
  }
  const spots = e.BREAK_PAID_SPOTS + e.BREAK_FREE_SPOTS;
  const packs = e.BREAK_PACKS.reduce((n, g) => n + g.count, 0);
  if (e.BREAK_PACKS.length > MAX_TIERS) {
    ctx.addIssue({ code: "custom", path: ["BREAK_PACKS"], message: `has ${e.BREAK_PACKS.length} groups; a break lists at most ${MAX_TIERS} machines` });
  } else if (spots > MAX_PACKS) {
    ctx.addIssue({ code: "custom", path: ["BREAK_PAID_SPOTS"], message: `BREAK_PAID_SPOTS + BREAK_FREE_SPOTS is ${spots}; a break has at most ${MAX_PACKS} spots (one pack each)` });
  } else if (packs !== spots) {
    ctx.addIssue({ code: "custom", path: ["BREAK_PACKS"], message: `lists ${packs} packs but BREAK_PAID_SPOTS + BREAK_FREE_SPOTS is ${spots}: one pack per spot` });
  } else if (e.BREAK_SPOT_PRICE > e.BREAK_PACKS.reduce((sum, g) => sum + g.maxPrice * BigInt(g.count), 0n) / BigInt(spots)) {
    ctx.addIssue({ code: "custom", path: ["BREAK_SPOT_PRICE"], message: "must not be above the average pack price in BREAK_PACKS (a markup is not supported)" });
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
  /** Where the public lists are written; the job is only built when `dir` is set. */
  publish: { dir?: string; intervalSecs: number };
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
  /** The watchdog. Telegram only with alerts "telegram". */
  watch: WatchSettings;
};

export interface WatchSettings {
  alerts: "log" | "telegram";
  telegram?: { token: string; chatId: string };
  /** The outside check the watchdog pings every run. */
  heartbeatUrl?: string;
  afterMins: number;
  repeatHours: number;
  intervalSecs: number;
}

/** The configuration, or every problem with it, one line each (`NAME: what is wrong`). */
export function parseConfig(env: Record<string, string | undefined>): { config: Config } | { problems: string[] } {
  const parsed = schema.safeParse(env);
  if (!parsed.success) return { problems: problemsOf(parsed.error, env) };
  return { config: build(parsed.data) };
}

/** Every problem, one line each. A setting that is not there at all is said so, instead of with the parser's "expected string, received undefined". */
function problemsOf(error: z.ZodError, env: Record<string, string | undefined>): string[] {
  return error.issues.map((i) => {
    const name = i.path.join(".");
    return `${name}: ${env[name] === undefined && /received (undefined|NaN)/.test(i.message) ? "is not set" : i.message}`;
  });
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = parseConfig(env);
  if ("problems" in parsed) throw new Error(`Invalid keeper config: ${parsed.problems.join("; ")}`);
  return parsed.config;
}

function build(e: z.infer<typeof schema>): Config {
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
        packs: e.BREAK_PACKS,
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
    publish: { ...(e.PUBLISH_DIR !== undefined ? { dir: e.PUBLISH_DIR } : {}), intervalSecs: e.PUBLISH_INTERVAL_SECS },
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
    watch: buildWatch(e),
  };
}

function buildWatch(e: WatchEnv): WatchSettings {
  return {
    alerts: e.ALERTS,
    ...(e.ALERTS === "telegram" && e.ALERT_TELEGRAM_BOT_TOKEN && e.ALERT_TELEGRAM_CHAT_ID
      ? { telegram: { token: e.ALERT_TELEGRAM_BOT_TOKEN, chatId: e.ALERT_TELEGRAM_CHAT_ID } }
      : {}),
    ...(e.ALERT_HEARTBEAT_URL !== undefined ? { heartbeatUrl: e.ALERT_HEARTBEAT_URL } : {}),
    afterMins: e.ALERT_AFTER_MINS,
    repeatHours: e.ALERT_REPEAT_HOURS,
    intervalSecs: e.WATCH_INTERVAL_SECS,
  };
}

/** Only the watchdog's settings and the cluster, for a command that needs nothing else (`send-test-alert`). */
export function parseWatchConfig(env: Record<string, string | undefined>): { cluster: Config["cluster"]; watch: WatchSettings } | { problems: string[] } {
  const parsed = z.object(watchFields).superRefine(watchRules).safeParse(env);
  if (!parsed.success) return { problems: problemsOf(parsed.error, env) };
  return { cluster: parsed.data.SOLANA_CLUSTER, watch: buildWatch(parsed.data) };
}
