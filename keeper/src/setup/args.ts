// The command line of `pnpm --filter keeper setup-devnet`, and the settings it shares with the keeper (from the environment).
//
// Everything is checked here, before any key is opened or any node is asked, and all the problems are reported at once. The
// limits are the programs' own (programs/breaks/src/admin.rs and programs/treasury/src/math.rs), so a value the program would
// refuse is refused with a sentence instead of by a failed transaction.

import { ORAO_PROGRAM, type Programs } from "../solana/breaks.js";
import { type Address, addressToBytes } from "../solana/pubkey.js";

export const USAGE = `usage: pnpm --filter keeper setup-devnet -- [flags]

Takes freshly deployed programs on devnet to a usable state. It looks at the chain first and only does what is missing, so it
can be run again after any interruption:

  1. the treasury's initialize         (signed by the treasury program's upgrade authority)
  2. the breaks program's initialize   (signed by the breaks program's upgrade authority)
  3. the treasury's set_controller     (signed by the treasury's admin; the controller is the breaks program's authority PDA)
  4. the buyer wallet's USDC account   (paid for by the upgrade authority)

It only PRINTS what it would do unless --send is given, and with --send it still sends nothing while anything differs from what
you asked for or cannot be done (fix that first). Devnet only: it refuses any other network.

Reads from the environment (keeper/.env is loaded): SOLANA_RPC_URL, BREAKS_PROGRAM_ID, TREASURY_PROGRAM_ID, VRF_PROGRAM_ID
(default: ORAO), SOLANA_CLUSTER (default devnet).

Required flags
  --authority-keypair <path>   keypair file of the upgrade authority of both programs; it pays for everything
  --keeper <address>           the keeper's wallet (its public address only: this tool never needs the keeper's key)
  --buyer <address>            the buyer wallet that receives the pack budget
  --usdc-mint <address>        the USDC mint on devnet (checked: an initialized 6-decimal mint of the classic token program)
  --max-paid-spots <n>         most paid spots a break may have
  --max-free-spots <n>         most free spots a break may have (the program allows up to 16)
                               (paid + free together are at most 64, one pack each)

Optional flags
  --admin <address>            the admin of both programs (default: the upgrade authority; on mainnet a Squads vault)
  --admin-keypair <path>       keypair file of the admin, so this tool can send set_controller; without it, if the admin is not
                               the upgrade authority, the instruction is printed for the admin to send
  --subsidy-bps <n>            share of new fees for the subsidy bucket, out of 10000 (default 7000)
  --holder-bps <n>             share for the holder bucket (default 3000; the two must add up to 10000)
  --min-window-secs <n>        shortest sale window a break may have (default 3600)
  --max-window-secs <n>        longest sale window (default 21600)
  --randomness-timeout-secs <n>  how long ORAO may take before a request can be repeated (default 600)
  --send                       send the missing steps (without it nothing is sent)
  --help
`;

export interface SetupRequest {
  programs: Programs;
  vrfProgram: Address;
  rpcUrl: string;
  cluster: "devnet" | "localnet";
  usdcMint: Address;
  keeper: Address;
  buyer: Address;
  /** Undefined means "the upgrade authority's address", which is only known once its key is read. */
  admin: Address | undefined;
  subsidyBps: number;
  holderBps: number;
  minWindowSecs: bigint;
  maxWindowSecs: bigint;
  maxPaidSpots: number;
  maxFreeSpots: number;
  randomnessTimeoutSecs: bigint;
  authorityKeypair: string;
  adminKeypair: string | undefined;
  send: boolean;
}

export type ParsedArgs = { kind: "help" } | { kind: "error"; problems: string[] } | { kind: "ok"; request: SetupRequest };

const VALUE_FLAGS = [
  "authority-keypair",
  "admin-keypair",
  "admin",
  "keeper",
  "buyer",
  "usdc-mint",
  "subsidy-bps",
  "holder-bps",
  "min-window-secs",
  "max-window-secs",
  "randomness-timeout-secs",
  "max-paid-spots",
  "max-free-spots",
] as const;

/** The program's limits. */
const MAX_FREE_SPOTS = 16;
const MAX_PACKS = 64;
const BPS = 10_000;

function addressProblem(text: string): string | undefined {
  try {
    addressToBytes(text);
    return undefined;
  } catch {
    return "is not a Solana address";
  }
}

export function parseArgs(argv: readonly string[], env: Record<string, string | undefined>): ParsedArgs {
  const flags = new Map<string, string>();
  const problems: string[] = [];
  let send = false;
  const args = argv.filter((a) => a !== "--");
  if (args.includes("--help") || args.includes("-h")) return { kind: "help" };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--send") {
      send = true;
      continue;
    }
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!m || !(VALUE_FLAGS as readonly string[]).includes(m[1] as string)) {
      problems.push(`unknown argument ${arg}`);
      continue;
    }
    const name = m[1] as string;
    let value = m[2];
    if (value === undefined) {
      value = args[++i];
      if (value === undefined || value.startsWith("--")) {
        problems.push(`--${name} needs a value`);
        continue;
      }
    }
    if (flags.has(name)) problems.push(`--${name} is given twice`);
    flags.set(name, value);
  }

  const required = (name: string): string => {
    const v = flags.get(name);
    if (v === undefined || v.trim() === "") {
      problems.push(`--${name} is required`);
      return "";
    }
    return v.trim();
  };
  const address = (name: string, value: string): Address => {
    if (value !== "") {
      const p = addressProblem(value);
      if (p) problems.push(`--${name} ${p}`);
    }
    return value;
  };
  const integer = (name: string, fallback: string | undefined, min: number, max: number): number => {
    const text = (flags.get(name) ?? fallback ?? "").trim();
    if (text === "") {
      problems.push(`--${name} is required`);
      return 0;
    }
    if (!/^\d+$/.test(text)) {
      problems.push(`--${name} is not a whole number`);
      return 0;
    }
    const n = Number(text);
    if (!Number.isSafeInteger(n) || n < min || n > max) {
      problems.push(`--${name} must be from ${min} to ${max}`);
      return 0;
    }
    return n;
  };

  const authorityKeypair = required("authority-keypair");
  const keeper = address("keeper", required("keeper"));
  const buyer = address("buyer", required("buyer"));
  const usdcMint = address("usdc-mint", required("usdc-mint"));
  const adminText = flags.get("admin")?.trim();
  if (adminText) address("admin", adminText);
  const adminKeypair = flags.get("admin-keypair")?.trim() || undefined;

  const maxPaidSpots = integer("max-paid-spots", undefined, 1, 65_535);
  const maxFreeSpots = integer("max-free-spots", undefined, 0, MAX_FREE_SPOTS);
  if (maxPaidSpots + maxFreeSpots > MAX_PACKS) problems.push(`--max-paid-spots + --max-free-spots is ${maxPaidSpots + maxFreeSpots}; a break has at most ${MAX_PACKS} spots (one pack each)`);

  const subsidyBps = integer("subsidy-bps", "7000", 0, BPS);
  const holderBps = integer("holder-bps", "3000", 0, BPS);
  if (subsidyBps + holderBps !== BPS && !problems.some((p) => p.startsWith("--subsidy-bps") || p.startsWith("--holder-bps"))) {
    problems.push(`--subsidy-bps + --holder-bps is ${subsidyBps + holderBps}; the two must add up to ${BPS}`);
  }

  const minWindow = integer("min-window-secs", "3600", 1, 2 ** 31);
  const maxWindow = integer("max-window-secs", "21600", 1, 2 ** 31);
  if (minWindow > maxWindow) problems.push("--min-window-secs must not be above --max-window-secs");
  const timeout = integer("randomness-timeout-secs", "600", 1, 2 ** 31);

  // The settings shared with the keeper.
  const programs: Programs = { breaks: "", treasury: "" };
  for (const [key, field] of [["BREAKS_PROGRAM_ID", "breaks"], ["TREASURY_PROGRAM_ID", "treasury"]] as const) {
    const v = env[key]?.trim();
    if (!v) problems.push(`${key} is not set`);
    else if (addressProblem(v)) problems.push(`${key} ${addressProblem(v)}`);
    else programs[field] = v;
  }
  const vrf = env.VRF_PROGRAM_ID?.trim() || ORAO_PROGRAM;
  if (addressProblem(vrf)) problems.push(`VRF_PROGRAM_ID ${addressProblem(vrf)}`);
  const rpcUrl = env.SOLANA_RPC_URL?.trim() ?? "";
  if (!rpcUrl) problems.push("SOLANA_RPC_URL is not set");
  const cluster = env.SOLANA_CLUSTER?.trim() || "devnet";
  if (cluster !== "devnet" && cluster !== "localnet") problems.push(`SOLANA_CLUSTER is ${cluster}: this tool runs on devnet only`);

  if (problems.length > 0) return { kind: "error", problems };
  return {
    kind: "ok",
    request: {
      programs,
      vrfProgram: vrf,
      rpcUrl,
      cluster: cluster as "devnet" | "localnet",
      usdcMint,
      keeper,
      buyer,
      admin: adminText || undefined,
      subsidyBps,
      holderBps,
      minWindowSecs: BigInt(minWindow),
      maxWindowSecs: BigInt(maxWindow),
      maxPaidSpots,
      maxFreeSpots,
      randomnessTimeoutSecs: BigInt(timeout),
      authorityKeypair,
      adminKeypair,
      send,
    },
  };
}
