import type { Sql } from "../packs/sql-store.js";
import type { Delivery } from "./plan.js";
import {
  type AttemptOutcome,
  type AttemptRow,
  type DeliveryKey,
  type DeliveryRow,
  type DeliveryStatus,
  type DeliveryStore,
  PlanChangedError,
} from "./store.js";

interface DeliverySqlRow {
  break_id: string;
  kind: "paid" | "free";
  idx: number;
  card_mint: string;
  recipient: string | null;
  status: DeliveryStatus;
  attempt: number;
  tx_sig: string | null;
  expiry: string | null;
  last_error: string | null;
  adopted: boolean;
}

const SELECT = `select d.break_id::text as break_id, s.kind, s.idx, d.card_mint, d.recipient, d.status, d.attempt,
  d.tx_sig, d.expiry, d.last_error, d.adopted
  from deliveries d join spots s on s.id = d.spot_id`;

/** The delivery's spot, from the key: `$1` break id, `$2` kind, `$3` index. */
const SPOT = "(select id from spots where break_id = $1::bigint and kind = $2 and idx = $3)";

function toRow(r: DeliverySqlRow): DeliveryRow {
  const row: DeliveryRow = {
    key: { breakId: r.break_id, spot: { kind: r.kind, idx: r.idx } },
    recipient: r.recipient ?? "",
    cardMint: r.card_mint,
    status: r.status,
    attempt: r.attempt,
    adopted: r.adopted,
  };
  if (r.tx_sig !== null) row.signature = r.tx_sig;
  if (r.expiry !== null) row.expiry = r.expiry;
  if (r.last_error !== null) row.lastError = r.last_error;
  return row;
}

const params = (k: DeliveryKey) => [k.breakId, k.spot.kind, k.spot.idx];

/**
 * `deliveries` and `delivery_attempts` (db/migrations). The spot must already be recorded in `spots`.
 * Each transition is a single statement guarded by the status it expects.
 */
export class SqlDeliveryStore implements DeliveryStore {
  constructor(private readonly sql: Sql) {}

  async ensure(breakId: string, d: Delivery): Promise<DeliveryRow> {
    const key: DeliveryKey = { breakId, spot: d.spot };
    await this.sql.query(
      `insert into deliveries (break_id, spot_id, card_mint, recipient)
       select $1::bigint, s.id, $4, $5 from spots s where s.break_id = $1::bigint and s.kind = $2 and s.idx = $3
       on conflict (spot_id) do nothing`,
      [...params(key), d.cardMint, d.recipient],
    );
    const row = await this.get(key);
    if (!row) throw new Error(`spot ${key.spot.kind} ${key.spot.idx} of break ${breakId} is not recorded in spots`);
    if (row.cardMint !== d.cardMint) throw new PlanChangedError(key, `card ${row.cardMint} → ${d.cardMint}`);
    if (row.recipient !== d.recipient) throw new PlanChangedError(key, `recipient ${row.recipient} → ${d.recipient}`);
    return row;
  }

  async get(key: DeliveryKey): Promise<DeliveryRow | undefined> {
    const { rows } = await this.sql.query<DeliverySqlRow>(
      `${SELECT} where d.break_id = $1::bigint and s.kind = $2 and s.idx = $3`,
      params(key),
    );
    return rows[0] ? toRow(rows[0]) : undefined;
  }

  async listForBreak(breakId: string): Promise<DeliveryRow[]> {
    const { rows } = await this.sql.query<DeliverySqlRow>(
      `${SELECT} where d.break_id = $1::bigint order by case s.kind when 'paid' then 0 else 1 end, s.idx`,
      [breakId],
    );
    return rows.map(toRow);
  }

  async startAttempt(key: DeliveryKey, a: { signature: string; expiry: string }): Promise<boolean> {
    const { rows } = await this.sql.query(
      `with moved as (
         update deliveries
            set status = 'submitted', attempt = attempt + 1, tx_sig = $4, expiry = $5, last_error = null, updated_at = now()
          where spot_id = ${SPOT} and status = 'pending'
          returning id, attempt
       ), logged as (
         insert into delivery_attempts (delivery_id, attempt, signature, expiry)
         select id, attempt, $4, $5 from moved
         on conflict (signature) do nothing
       )
       select attempt from moved`,
      [...params(key), a.signature, a.expiry],
    );
    return rows.length === 1;
  }

  async resolveAttempt(
    key: DeliveryKey,
    signature: string,
    outcome: { to: "confirmed" } | { to: "pending" | "failed"; why: "failed" | "expired"; reason: string },
  ): Promise<boolean> {
    const attemptOutcome: AttemptOutcome = outcome.to === "confirmed" ? "confirmed" : outcome.why;
    const reason = outcome.to === "confirmed" ? null : outcome.reason;
    const { rows } = await this.sql.query(
      `with moved as (
         update deliveries
            set status = $4::text,
                tx_sig = case when $4::text = 'pending' then null else tx_sig end,
                expiry = case when $4::text = 'pending' then null else expiry end,
                last_error = case when $4::text = 'confirmed' then null else coalesce($5::text, last_error) end,
                updated_at = now()
          where spot_id = ${SPOT} and status = 'submitted' and tx_sig = $6
          returning 1
       ), logged as (
         update delivery_attempts set outcome = $7::text, updated_at = now()
          where signature = $6 and exists (select 1 from moved)
       )
       select 1 as ok from moved`,
      [...params(key), outcome.to, reason, signature, attemptOutcome],
    );
    return rows.length === 1;
  }

  async adopt(key: DeliveryKey): Promise<boolean> {
    const { rows } = await this.sql.query(
      `update deliveries set status = 'confirmed', adopted = true, last_error = null, updated_at = now()
        where spot_id = ${SPOT} and status = 'pending' returning 1`,
      params(key),
    );
    return rows.length === 1;
  }

  async fail(key: DeliveryKey, reason: string): Promise<boolean> {
    const { rows } = await this.sql.query(
      `update deliveries set status = 'failed', last_error = $4, updated_at = now()
        where spot_id = ${SPOT} and status = 'pending' returning 1`,
      [...params(key), reason],
    );
    return rows.length === 1;
  }

  async setError(key: DeliveryKey, message: string | null): Promise<void> {
    await this.sql.query(`update deliveries set last_error = $4, updated_at = now() where spot_id = ${SPOT}`, [
      ...params(key),
      message,
    ]);
  }

  async attempts(key: DeliveryKey): Promise<AttemptRow[]> {
    const { rows } = await this.sql.query<{ attempt: number; signature: string; expiry: string; outcome: AttemptOutcome }>(
      `select a.attempt, a.signature, a.expiry, a.outcome from delivery_attempts a
        where a.delivery_id = (select id from deliveries where spot_id = ${SPOT}) order by a.attempt, a.id`,
      params(key),
    );
    return rows;
  }
}
