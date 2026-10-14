// The bot's memory in Postgres: `bot_posts` (what it decided to say, frozen before it is sent), the wallets that
// agreed to be tagged (`x_links`) and the deliveries of finished breaks.

import type { Sql } from "../packs/sql-store.js";
import type { Address } from "../solana/pubkey.js";
import type { DeliveredFacts, Draft } from "./policy.js";
import { isHandle } from "./templates.js";

export interface QueuedPost {
  id: string;
  kind: string;
  dedupeKey: string;
  body: string;
  /** Sends so far that ended without a verdict. */
  attempts: number;
}

export interface BotStore {
  /** Dedupe keys that start with `prefix` (with it removed) of every post (queued, posted, failed or dropped) made since `since`. */
  keysSince(since: Date, prefix: string): Promise<Set<string>>;
  /** Saves the post before anything is sent. False if the same dedupe key is already there. */
  enqueue(draft: Draft, now: Date): Promise<boolean>;
  /** Drops queued posts that are stale. Returns how many. */
  expireStale(now: Date): Promise<number>;
  /** The oldest queued post (dedupe key starting with `prefix`) that is not stale and whose wait after a failed send is over. */
  due(now: Date, retryStepSecs: number, prefix: string): Promise<QueuedPost | undefined>;
  lastPostedAt(): Promise<Date | undefined>;
  postedSince(since: Date): Promise<number>;
  markPosted(id: string, xPostId: string | undefined, now: Date, note?: string): Promise<void>;
  markFailed(id: string, reason: string, now: Date): Promise<void>;
  /** Notes a send without a verdict. Returns the number of sends so far. */
  markRetry(id: string, reason: string, now: Date): Promise<number>;
  /** X handles of the wallets that agreed to be tagged (only valid handles). */
  handles(wallets: readonly Address[]): Promise<Map<Address, string>>;
  /** Finished breaks (every card delivered), by on-chain id. */
  delivered(onchainIds: readonly bigint[]): Promise<DeliveredFacts[]>;
}

const placeholders = (from: number, n: number) => Array.from({ length: n }, (_, i) => `$${from + i}`).join(", ");

export class SqlBotStore implements BotStore {
  constructor(private readonly sql: Sql) {}

  async keysSince(since: Date, prefix: string): Promise<Set<string>> {
    const { rows } = await this.sql.query<{ dedupe_key: string }>("select dedupe_key from bot_posts where created_at >= $1 and starts_with(dedupe_key, $2)", [since.toISOString(), prefix]);
    return new Set(rows.map((r) => r.dedupe_key.slice(prefix.length)));
  }

  async enqueue(d: Draft, now: Date): Promise<boolean> {
    const { rows } = await this.sql.query<{ id: string }>(
      `insert into bot_posts (kind, break_id, dedupe_key, body, valid_until, created_at, updated_at)
       values ($1, (select id from breaks where onchain_id = $2::bigint), $3, $4, $5, $6, $6)
       on conflict (dedupe_key) do nothing
       returning id::text as id`,
      [d.kind, d.breakId.toString(), d.dedupeKey, d.body, d.validUntil.toISOString(), now.toISOString()],
    );
    return rows.length > 0;
  }

  async expireStale(now: Date): Promise<number> {
    const { rows } = await this.sql.query<{ id: string }>(
      `update bot_posts set status = 'expired', updated_at = $1
        where status = 'queued' and valid_until is not null and valid_until <= $1
        returning id::text as id`,
      [now.toISOString()],
    );
    return rows.length;
  }

  async due(now: Date, retryStepSecs: number, prefix: string): Promise<QueuedPost | undefined> {
    const { rows } = await this.sql.query<{ id: string; kind: string; dedupe_key: string; body: string; attempts: number }>(
      `select id::text as id, kind, dedupe_key, body, attempts
         from bot_posts
        where status = 'queued'
          and starts_with(dedupe_key, $3)
          and (valid_until is null or valid_until > $1)
          and (attempts = 0 or updated_at <= $1::timestamptz - make_interval(secs => attempts * $2::double precision))
        order by id
        limit 1`,
      [now.toISOString(), retryStepSecs, prefix],
    );
    const r = rows[0];
    return r ? { id: r.id, kind: r.kind, dedupeKey: r.dedupe_key, body: r.body, attempts: Number(r.attempts) } : undefined;
  }

  async lastPostedAt(): Promise<Date | undefined> {
    const { rows } = await this.sql.query<{ at: Date | string | null }>("select max(posted_at) as at from bot_posts where status = 'posted'");
    const at = rows[0]?.at;
    return at ? new Date(at) : undefined;
  }

  async postedSince(since: Date): Promise<number> {
    const { rows } = await this.sql.query<{ n: string }>("select count(*)::text as n from bot_posts where status = 'posted' and posted_at >= $1", [since.toISOString()]);
    return Number(rows[0]?.n ?? 0);
  }

  async markPosted(id: string, xPostId: string | undefined, now: Date, note?: string): Promise<void> {
    await this.sql.query(
      "update bot_posts set status = 'posted', x_post_id = $2, posted_at = $3, updated_at = $3, last_error = $4 where id = $1::bigint and status = 'queued'",
      [id, xPostId ?? null, now.toISOString(), note ?? null],
    );
  }

  async markFailed(id: string, reason: string, now: Date): Promise<void> {
    await this.sql.query("update bot_posts set status = 'failed', last_error = $2, updated_at = $3 where id = $1::bigint and status = 'queued'", [id, reason, now.toISOString()]);
  }

  async markRetry(id: string, reason: string, now: Date): Promise<number> {
    const { rows } = await this.sql.query<{ attempts: number }>(
      "update bot_posts set attempts = attempts + 1, last_error = $2, updated_at = $3 where id = $1::bigint and status = 'queued' returning attempts",
      [id, reason, now.toISOString()],
    );
    return Number(rows[0]?.attempts ?? 0);
  }

  async handles(wallets: readonly Address[]): Promise<Map<Address, string>> {
    const out = new Map<Address, string>();
    if (wallets.length === 0) return out;
    const { rows } = await this.sql.query<{ wallet: string; x_handle: string }>(
      `select wallet, x_handle from x_links where may_tag and wallet in (${placeholders(1, wallets.length)})`,
      [...wallets],
    );
    // The table is filled by the site; a handle that is not a plain X handle is never put into a post.
    for (const r of rows) if (isHandle(r.x_handle)) out.set(r.wallet, r.x_handle);
    return out;
  }

  async delivered(onchainIds: readonly bigint[]): Promise<DeliveredFacts[]> {
    if (onchainIds.length === 0) return [];
    const { rows } = await this.sql.query<{ id: string; cards: number; wallets: number; last: Date | string }>(
      `select b.onchain_id::text as id, count(d.id)::int as cards, count(distinct s.wallet)::int as wallets, max(d.updated_at) as last
         from breaks b
         join deliveries d on d.break_id = b.id and d.status = 'confirmed'
         join spots s on s.id = d.spot_id
        where b.status = 'delivered' and b.onchain_id in (${placeholders(1, onchainIds.length)})
        group by b.onchain_id`,
      onchainIds.map(String),
    );
    return rows.map((r) => ({ breakId: BigInt(r.id), cards: Number(r.cards), wallets: Number(r.wallets), lastDeliveredAt: new Date(r.last) }));
  }
}
