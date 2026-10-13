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

/** A spot as the chain has it: a paid spot (with what was paid) or a drawn free winner. */
export interface SpotRecord {
  kind: "paid" | "free";
  idx: number;
  wallet: string;
  /** Micro-USDC paid; only for paid spots. */
  paid?: bigint;
}

/** The breaks that exist on-chain and are not finished, and the database's copy of their status. */
export interface BreakRepo {
  activeBreaks(): Promise<ActiveBreak[]>;
  setStatus(id: string, status: DbBreakStatus): Promise<void>;
  /**
   * Copies a drawn break's spots from the chain into `spots`, which deliveries (and the website) refer to. A spot
   * that is already recorded must say the same thing: the chain is the truth, so a difference is an error.
   */
  recordSpots(breakId: string, spots: readonly SpotRecord[]): Promise<void>;
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

  async recordSpots(breakId: string, spots: readonly SpotRecord[]): Promise<void> {
    for (const s of spots) {
      await this.sql.query(
        `insert into spots (break_id, kind, idx, wallet, paid) values ($1::bigint, $2, $3, $4, $5::bigint)
         on conflict (break_id, kind, idx) do nothing`,
        [breakId, s.kind, s.idx, s.wallet, s.paid === undefined ? null : s.paid.toString()],
      );
      const { rows } = await this.sql.query<{ wallet: string }>(
        "select wallet from spots where break_id = $1::bigint and kind = $2 and idx = $3",
        [breakId, s.kind, s.idx],
      );
      if (rows[0]?.wallet !== s.wallet) {
        throw new Error(`spot ${s.kind} ${s.idx} of break ${breakId} is recorded for ${rows[0]?.wallet} but the chain says ${s.wallet}`);
      }
    }
  }
}
