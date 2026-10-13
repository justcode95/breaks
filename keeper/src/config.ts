import { z } from "zod";

// Devnet only (CLAUDE.md guardrails). Adding "mainnet-beta" here is a rule change that needs the owner's sign-off.
const schema = z.object({
  SOLANA_CLUSTER: z.enum(["devnet", "localnet"]).default("devnet"),
  SOLANA_RPC_URL: z.string().url(),
  DATABASE_URL: z.string().min(1),
  PACK_PROVIDER: z.enum(["mock"]).default("mock"),
  JOB_TICK_MS: z.coerce.number().int().min(100).default(5000),
});

export type Config = {
  cluster: "devnet" | "localnet";
  rpcUrl: string;
  databaseUrl: string;
  packProvider: "mock";
  jobTickMs: number;
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
    jobTickMs: e.JOB_TICK_MS,
  };
}
