import type { Sql } from "../packs/sql-store.js";
import type { BreakAccount } from "../solana/breaks.js";
import type { ActiveBreak } from "./pipeline.js";

/** `breaks.status` values the database knows (migrations 0001 and 0004). */
export type DbBreakStatus =
  | "scheduled"
  | "open"
  | "closed"
  | "eligibility_committed"
  | "funded"
  | "pool_committed"
  | "randomness_requested"
  | "settled"
  | "drawn"
  | "delivered"
  | "cancelled";

const FROM_CHAIN: Record<BreakAccount["status"], DbBreakStatus> = {
  Open: "open",
  Closed: "closed",
  EligibilityCommitted: "eligibility_committed",
  Funded: "funded",
  PoolCommitted: "pool_committed",
  RandomnessRequested: "randomness_requested",
  Settled: "settled",
  Drawn: "drawn",
  Cancelled: "cancelled",
};

export const dbStatusOf = (status: BreakAccount["status"]): DbBreakStatus => FROM_CHAIN[status];

/** The breaks that exist on-chain and are not finished, and the database's copy of their status. */
export interface BreakRepo {
  activeBreaks(): Promise<ActiveBreak[]>;
  setStatus(id: string, status: DbBreakStatus): Promise<void>;
}

export class SqlBreakRepo implements BreakRepo {
  constructor(private readonly sql: Sql) {}

  async activeBreaks(): Promise<ActiveBreak[]> {
    const { rows } = await this.sql.query<{ id: string; onchain_id: string; pack_machine: string; status: string }>(
      `select id::text as id, onchain_id::text as onchain_id, pack_machine, status from breaks
        where onchain_id is not null and status not in ('delivered', 'cancelled') order by id`,
    );
    return rows.map((r) => ({ id: r.id, onchainId: BigInt(r.onchain_id), machine: r.pack_machine, status: r.status }));
  }

  async setStatus(id: string, status: DbBreakStatus): Promise<void> {
    await this.sql.query("update breaks set status = $2 where id = $1::bigint", [id, status]);
  }
}
