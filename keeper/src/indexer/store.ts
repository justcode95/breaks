// The indexer's notes in the database: which addresses it reads, how far it got with each, the balance events it
// found and the watermark `indexer_state.indexed_until`. Every write is safe to repeat.

import type { BalanceEvent } from "../eligibility/twab.js";
import type { Sql } from "../packs/sql-store.js";
import type { Address } from "../solana/pubkey.js";

export interface IndexedAccount {
  address: Address;
  kind: "mint" | "token_account";
  /** Newest signature of the last finished pass: the next pass reads back to here. */
  untilSig?: string;
  /** Where the pass in progress continues (older than this signature). */
  resumeBefore?: string;
  /** Newest signature the pass in progress has seen; it becomes `untilSig` when the pass ends. */
  passNewest?: string;
  /** Unix seconds the pass in progress will have covered when it ends. */
  passCover?: number;
}

export interface PassProgress {
  resumeBefore: string;
  passNewest: string;
  passCover: number;
}

interface AccountSql {
  address: string;
  kind: "mint" | "token_account";
  until_sig: string | null;
  resume_before: string | null;
  pass_newest: string | null;
  pass_cover: string | null;
}

/** Events per insert; whole transactions only, so a transaction's events are never split between two statements. */
const EVENTS_PER_INSERT = 500;

export class SqlIndexStore {
  constructor(private readonly sql: Sql) {}

  async ensureMint(mint: Address): Promise<void> {
    await this.sql.query("insert into indexed_accounts (address, kind) values ($1, 'mint') on conflict (address) do nothing", [mint]);
  }

  /**
   * The account to work on next: a pass in progress first, then an account that was never read, then the one read
   * longest ago. Only accounts that may hold tokens and whose last pass covered less than `target` (unix seconds).
   */
  async next(target: number): Promise<IndexedAccount | undefined> {
    const { rows } = await this.sql.query<AccountSql>(
      `select address, kind, until_sig, resume_before, pass_newest, extract(epoch from pass_cover)::bigint::text as pass_cover
         from indexed_accounts
        where active and (resume_before is not null or covered_until is null or covered_until < to_timestamp($1::bigint))
        order by (resume_before is null), covered_until asc nulls first, address
        limit 1`,
      [String(target)],
    );
    const r = rows[0];
    if (!r) return undefined;
    return {
      address: r.address,
      kind: r.kind,
      ...(r.until_sig !== null ? { untilSig: r.until_sig } : {}),
      ...(r.resume_before !== null ? { resumeBefore: r.resume_before } : {}),
      ...(r.pass_newest !== null ? { passNewest: r.pass_newest } : {}),
      ...(r.pass_cover !== null ? { passCover: Number(r.pass_cover) } : {}),
    };
  }

  /** Which of these transactions already have balance events stored (they need not be fetched again). */
  async known(signatures: readonly string[]): Promise<Set<string>> {
    if (signatures.length === 0) return new Set();
    const { rows } = await this.sql.query<{ signature: string }>(
      "select distinct signature from balance_events where signature = any($1::text[])",
      [signatures],
    );
    return new Set(rows.map((r) => r.signature));
  }

  async addEvents(events: readonly BalanceEvent[]): Promise<void> {
    const bySignature = new Map<string, BalanceEvent[]>();
    for (const e of events) {
      const group = bySignature.get(e.signature);
      if (group) group.push(e);
      else bySignature.set(e.signature, [e]);
    }
    let chunk: BalanceEvent[] = [];
    const flush = async () => {
      if (chunk.length === 0) return;
      const params: unknown[] = [];
      const rows = chunk.map((e, i) => {
        params.push(e.signature, String(e.slot), String(e.time), e.owner, e.tokenAccount, String(e.delta), String(e.balanceAfter));
        const o = i * 7;
        return `($${o + 1}, $${o + 2}::bigint, to_timestamp($${o + 3}::bigint), $${o + 4}, $${o + 5}, $${o + 6}::numeric, $${o + 7}::numeric)`;
      });
      await this.sql.query(
        `insert into balance_events (signature, slot, block_time, owner, token_account, delta, balance_after)
         values ${rows.join(", ")}
         on conflict (signature, token_account, owner) do nothing`,
        params,
      );
      chunk = [];
    };
    for (const group of bySignature.values()) {
      if (chunk.length + group.length > EVENTS_PER_INSERT) await flush();
      chunk.push(...group);
    }
    await flush();
  }

  /** Notes token accounts that may hold tokens; one that was thought empty is read again. */
  async addAccounts(addresses: readonly Address[]): Promise<void> {
    if (addresses.length === 0) return;
    await this.sql.query(
      `insert into indexed_accounts (address, kind) select a, 'token_account' from unnest($1::text[]) as a
       on conflict (address) do update set active = true`,
      [[...new Set(addresses)]],
    );
  }

  async saveProgress(address: Address, p: PassProgress): Promise<void> {
    await this.sql.query(
      `update indexed_accounts set resume_before = $2, pass_newest = $3, pass_cover = to_timestamp($4::bigint) where address = $1`,
      [address, p.resumeBefore, p.passNewest, String(p.passCover)],
    );
  }

  /**
   * Ends the pass: the account is now covered up to `cover` and the next pass reads back to `untilSig`. An account whose
   * balance in its newest slot is empty can send nothing, so it is left alone until a transaction gives it tokens again.
   */
  async finishPass(address: Address, f: { untilSig: string | undefined; cover: number }): Promise<void> {
    await this.sql.query(
      `update indexed_accounts a set
         until_sig = coalesce($2, a.until_sig), resume_before = null, pass_newest = null, pass_cover = null,
         covered_until = to_timestamp($3::bigint),
         active = a.kind = 'mint' or coalesce((
           select bool_or(e.balance_after > 0) from balance_events e
            where e.token_account = a.address
              and e.slot = (select max(slot) from balance_events where token_account = a.address)), true)
       where a.address = $1`,
      [address, f.untilSig ?? null, String(f.cover)],
    );
  }

  /**
   * Moves `indexer_state.indexed_until` forward to the time every account that may still change has been read up to.
   * It never moves back, and it holds while an account has never been read (its history is not in yet).
   */
  async advanceWatermark(): Promise<number | undefined> {
    await this.sql.query(
      `insert into indexer_state (id, indexed_until)
       select 1, min(covered_until) from indexed_accounts where active
       having bool_and(covered_until is not null) and min(covered_until) is not null
       on conflict (id) do update set indexed_until = greatest(indexer_state.indexed_until, excluded.indexed_until), updated_at = now()`,
    );
    return this.watermark();
  }

  async watermark(): Promise<number | undefined> {
    const { rows } = await this.sql.query<{ until: string }>("select extract(epoch from indexed_until)::bigint::text as until from indexer_state where id = 1");
    return rows[0] ? Number(rows[0].until) : undefined;
  }

  /** When the windows of the breaks still waiting for their eligibility list ended (unix seconds). */
  async pendingWindowEnds(): Promise<number[]> {
    const { rows } = await this.sql.query<{ closes_at: string }>(
      `select extract(epoch from b.closes_at)::bigint::text as closes_at from breaks b
        where b.status in ('open', 'closed')
          and not exists (select 1 from eligibility_lists l where l.break_id = b.id)`,
    );
    return rows.map((r) => Number(r.closes_at));
  }
}
