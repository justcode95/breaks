import type { Sql } from "../packs/sql-store.js";
import { dbStatusOf } from "../pipeline/repo.js";
import type { BreakAccount } from "../solana/breaks.js";
import { packMachineLabel } from "./machine.js";

/** What the scheduler needs from the database. */
export interface SchedulerStore {
  /** The highest on-chain break id the database has, or undefined if it has none. */
  highestOnchainId(): Promise<bigint | undefined>;
  /** Copies a break from the chain into the database (nothing happens if it is already there). */
  recordBreak(b: BreakAccount, createTx?: string): Promise<void>;
  /** On-chain ids of the breaks the database still has as not yet closed. */
  openOnchainIds(): Promise<bigint[]>;
}

export class SqlSchedulerStore implements SchedulerStore {
  constructor(private readonly sql: Sql) {}

  async highestOnchainId(): Promise<bigint | undefined> {
    const { rows } = await this.sql.query<{ id: string | null }>("select max(onchain_id)::text as id from breaks");
    const id = rows[0]?.id;
    return id === null || id === undefined ? undefined : BigInt(id);
  }

  async recordBreak(b: BreakAccount, createTx?: string): Promise<void> {
    await this.sql.query(
      `insert into breaks (onchain_id, status, paid_spots, free_spots, spot_price, pack_machine, max_pack_price, opens_at, closes_at, create_tx)
       values ($1::bigint, $2, $3, $4, $5::bigint, $6, $7::bigint, to_timestamp($8::bigint), to_timestamp($9::bigint), $10)
       on conflict (onchain_id) do nothing`,
      [
        b.id.toString(),
        dbStatusOf(b.status),
        b.paidSpots,
        b.freeSpots,
        b.spotPrice.toString(),
        packMachineLabel(b.packMachine),
        b.maxPackPrice.toString(),
        b.opensAt.toString(),
        b.closesAt.toString(),
        createTx ?? null,
      ],
    );
  }

  async openOnchainIds(): Promise<bigint[]> {
    const { rows } = await this.sql.query<{ id: string }>(
      "select onchain_id::text as id from breaks where onchain_id is not null and status in ('scheduled', 'open') order by onchain_id",
    );
    return rows.map((r) => BigInt(r.id));
  }
}
