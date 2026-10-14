import type { Sql } from "../packs/sql-store.js";
import type { PreparedSwap } from "./swapper.js";

export type SwapRowStatus = "prepared" | "submitted" | "landed" | "failed" | "expired";

export interface SwapRow extends PreparedSwap {
  id: string;
  status: SwapRowStatus;
}

export interface TreasuryEvent {
  kind: "swap" | "deposit";
  asset: "SOL" | "USDC";
  /** Base units of `asset`. */
  amount: bigint;
  txSig: string;
  note?: string;
}

export interface SweepStore {
  /** The swap that has been prepared or sent and has no outcome yet. */
  inFlight(): Promise<SwapRow | undefined>;
  /** Saves a swap before it is sent. False if another swap is already in flight (nothing is saved then). */
  insertPrepared(p: PreparedSwap): Promise<SwapRow | undefined>;
  markSubmitted(id: string): Promise<void>;
  resolve(id: string, status: "landed" | "failed" | "expired"): Promise<void>;
  /** The public ledger of the treasury (`treasury_events`); writing the same event twice does nothing. */
  recordEvent(e: TreasuryEvent): Promise<void>;
}

interface Row {
  id: string;
  status: SwapRowStatus;
  lamports_in: string;
  min_usdc_out: string;
  signature: string;
  expiry: string;
  payload: string;
}

const COLUMNS = "id::text as id, status, lamports_in::text as lamports_in, min_usdc_out::text as min_usdc_out, signature, expiry, payload";

const toRow = (r: Row): SwapRow => ({
  id: r.id,
  status: r.status,
  lamportsIn: BigInt(r.lamports_in),
  minUsdcOut: BigInt(r.min_usdc_out),
  signature: r.signature,
  expiry: r.expiry,
  payload: r.payload,
});

export class SqlSweepStore implements SweepStore {
  constructor(private readonly sql: Sql) {}

  async inFlight(): Promise<SwapRow | undefined> {
    const { rows } = await this.sql.query<Row>(`select ${COLUMNS} from fee_swaps where status in ('prepared', 'submitted') order by id limit 1`);
    return rows[0] ? toRow(rows[0]) : undefined;
  }

  async insertPrepared(p: PreparedSwap): Promise<SwapRow | undefined> {
    const { rows } = await this.sql.query<Row>(
      `insert into fee_swaps (lamports_in, min_usdc_out, signature, expiry, payload)
       values ($1::bigint, $2::bigint, $3, $4, $5)
       on conflict do nothing
       returning ${COLUMNS}`,
      [p.lamportsIn.toString(), p.minUsdcOut.toString(), p.signature, p.expiry, p.payload],
    );
    return rows[0] ? toRow(rows[0]) : undefined;
  }

  async markSubmitted(id: string): Promise<void> {
    await this.sql.query("update fee_swaps set status = 'submitted', updated_at = now() where id = $1::bigint and status = 'prepared'", [id]);
  }

  async resolve(id: string, status: "landed" | "failed" | "expired"): Promise<void> {
    await this.sql.query("update fee_swaps set status = $2, updated_at = now() where id = $1::bigint and status in ('prepared', 'submitted')", [id, status]);
  }

  async recordEvent(e: TreasuryEvent): Promise<void> {
    await this.sql.query(
      `insert into treasury_events (kind, asset, amount, tx_sig, note) values ($1, $2, $3::bigint, $4, $5)
       on conflict (kind, tx_sig) where tx_sig is not null do nothing`,
      [e.kind, e.asset, e.amount.toString(), e.txSig, e.note ?? null],
    );
  }
}
