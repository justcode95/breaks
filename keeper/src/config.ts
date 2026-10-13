import { z } from "zod";
import { ORAO_PROGRAM, type Programs } from "./solana/breaks.js";
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

// Devnet only (CLAUDE.md guardrails). Adding "mainnet-beta" here is a rule change that needs the owner's sign-off.
const schema = z.object({
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
  // The deployed programs.
  BREAKS_PROGRAM_ID: address,
  TREASURY_PROGRAM_ID: address,
  // Randomness: the VRF program (must be the one the breaks program is configured with) and ORAO's fee treasury,
  // which is a field of ORAO's network state. Read it from there and copy it in; the keeper does not guess it.
  VRF_PROGRAM_ID: address.default(ORAO_PROGRAM),
  ORAO_TREASURY: address,
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
  };
}
