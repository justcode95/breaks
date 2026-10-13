import type { PackKey } from "./provider.js";
import type { AttemptOutcome, AttemptRow, NewAttempt, PackRow, PackStatus, PackStore, Reveal } from "./store.js";

/** The one thing the store needs from a Postgres client; `pg` pools and PGlite both fit. */
export interface Sql {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

interface PackSqlRow {
  break_id: string;
  pack_index: number;
  status: PackStatus;
  attempt: number;
  purchase_sig: string | null;
  expiry: string | null;
  price: string | null;
  card_mint: string | null;
  proof_ref: string | null;
  last_error: string | null;
}

const COLUMNS = `break_id::text as break_id, pack_index, status, attempt, purchase_sig, expiry,
  price::text as price, card_mint, proof_ref, last_error`;

function toRow(r: PackSqlRow): PackRow {
  const row: PackRow = { key: { breakId: r.break_id, index: r.pack_index }, status: r.status, attempt: r.attempt };
  if (r.purchase_sig !== null) row.signature = r.purchase_sig;
  if (r.expiry !== null) row.expiry = r.expiry;
  if (r.price !== null) row.price = BigInt(r.price);
  if (r.card_mint !== null) row.cardMint = r.card_mint;
  if (r.proof_ref !== null) row.proofRef = r.proof_ref;
  if (r.last_error !== null) row.lastError = r.last_error;
  return row;
}

const bigintParam = (n: bigint | undefined): string | null => (n === undefined ? null : n.toString());

/**
 * `packs` and `pack_attempts` (db/migrations). Each transition is a single statement guarded by the status it
 * expects, so concurrent workers cannot both win.
 */
export class SqlPackStore implements PackStore {
  constructor(private readonly sql: Sql) {}

  async ensure(key: PackKey): Promise<PackRow> {
    await this.sql.query(
      "insert into packs (break_id, pack_index) values ($1::bigint, $2) on conflict (break_id, pack_index) do nothing",
      [key.breakId, key.index],
    );
    const row = await this.get(key);
    if (!row) throw new Error(`pack ${key.breakId}:${key.index} vanished after insert`);
    return row;
  }

  async get(key: PackKey): Promise<PackRow | undefined> {
    const { rows } = await this.sql.query<PackSqlRow>(
      `select ${COLUMNS} from packs where break_id = $1::bigint and pack_index = $2`,
      [key.breakId, key.index],
    );
    return rows[0] ? toRow(rows[0]) : undefined;
  }

  async listForBreak(breakId: string): Promise<PackRow[]> {
    const { rows } = await this.sql.query<PackSqlRow>(
      `select ${COLUMNS} from packs where break_id = $1::bigint order by pack_index`,
      [breakId],
    );
    return rows.map(toRow);
  }

  async startAttempt(key: PackKey, a: NewAttempt): Promise<boolean> {
    const { rows } = await this.sql.query(
      `with moved as (
         update packs
            set status = 'submitted', attempt = attempt + 1, purchase_sig = $3, expiry = $4, price = $5::bigint,
                last_error = null, updated_at = now()
          where break_id = $1::bigint and pack_index = $2 and status = 'planned'
          returning attempt
       ), logged as (
         insert into pack_attempts (break_id, pack_index, attempt, signature, expiry, price)
         select $1::bigint, $2, attempt, $3, $4, $5::bigint from moved
         on conflict (signature) do nothing
       )
       select attempt from moved`,
      [key.breakId, key.index, a.signature, a.expiry, bigintParam(a.price)],
    );
    return rows.length === 1;
  }

  async resolveAttempt(
    key: PackKey,
    signature: string,
    outcome: { to: "confirmed" } | { to: "planned" | "failed"; why: "failed" | "expired"; reason: string },
  ): Promise<boolean> {
    const to = outcome.to;
    const attemptOutcome: AttemptOutcome = outcome.to === "confirmed" ? "confirmed" : outcome.why;
    const reason = outcome.to === "confirmed" ? null : outcome.reason;
    const { rows } = await this.sql.query(
      `with moved as (
         update packs
            set status = $4::text,
                purchase_sig = case when $4::text = 'planned' then null else purchase_sig end,
                expiry = case when $4::text = 'planned' then null else expiry end,
                price = case when $4::text = 'planned' then null else price end,
                last_error = case when $4::text = 'confirmed' then null else coalesce($5::text, last_error) end,
                updated_at = now()
          where break_id = $1::bigint and pack_index = $2 and status = 'submitted' and purchase_sig = $3
          returning 1
       ), logged as (
         update pack_attempts set outcome = $6::text, updated_at = now()
          where signature = $3 and exists (select 1 from moved)
       )
       select 1 as ok from moved`,
      [key.breakId, key.index, signature, to, reason, attemptOutcome],
    );
    return rows.length === 1;
  }

  async complete(key: PackKey, reveal: Reveal): Promise<boolean> {
    const { rows } = await this.sql.query(
      `update packs
          set status = 'pulled', card_mint = $3, proof_ref = $4, price = coalesce($5::bigint, price), updated_at = now()
        where break_id = $1::bigint and pack_index = $2 and status = 'confirmed'
        returning 1`,
      [key.breakId, key.index, reveal.cardMint, reveal.proofRef ?? null, bigintParam(reveal.price)],
    );
    return rows.length === 1;
  }

  async setError(key: PackKey, message: string | null): Promise<void> {
    await this.sql.query(
      "update packs set last_error = $3, updated_at = now() where break_id = $1::bigint and pack_index = $2",
      [key.breakId, key.index, message],
    );
  }

  async attempts(key: PackKey): Promise<AttemptRow[]> {
    const { rows } = await this.sql.query<{
      attempt: number;
      signature: string;
      expiry: string;
      price: string | null;
      outcome: AttemptOutcome;
    }>(
      `select attempt, signature, expiry, price::text as price, outcome from pack_attempts
        where break_id = $1::bigint and pack_index = $2 order by attempt, id`,
      [key.breakId, key.index],
    );
    return rows.map((r) => {
      const a: AttemptRow = { attempt: r.attempt, signature: r.signature, expiry: r.expiry, outcome: r.outcome };
      if (r.price !== null) a.price = BigInt(r.price);
      return a;
    });
  }
}
