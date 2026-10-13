// From the indexed token balances to the values `commit_eligibility` takes, with the public record of how.
//
// Two properties matter more than the arithmetic (which `eligibility.ts` and `twab.ts` already pin down):
//  1. It never computes from a history that may still be growing. The indexer records how far it has read
//     (`indexer_state`); until that is past the end of the window by a margin, the answer is "wait".
//  2. It computes once. The result is stored (`eligibility_lists`) before anything is sent, and every later
//     call returns the stored values, so a retry after a crash commits exactly what was published, even if the
//     exclusion list or the history has changed since.

import { createHash } from "node:crypto";
import { toHex } from "../draw/bytes.js";
import type { Sql } from "../packs/sql-store.js";
import { type Address } from "../solana/pubkey.js";
import {
  type Eligibility,
  type WeightPolicy,
  buildEligibility,
  inputsHash,
  serializeInputs,
  treeOf,
} from "./eligibility.js";
import type { BalanceEvent, Window } from "./twab.js";

export interface CommitValues {
  root: Uint8Array;
  totalWeight: bigint;
  entryCount: number;
  inputsHash: Uint8Array;
}

export type EligibilityPlan = { kind: "ready"; values: CommitValues } | { kind: "wait"; reason: string };

export interface EligibilityPlanner {
  /** The values to commit for a break whose window is `window`, or why not yet. `breakId` is `breaks.id`. */
  plan(breakId: string, window: Window): Promise<EligibilityPlan>;
  /** Only what is already stored for the break; never computes or writes anything. */
  committed(breakId: string): Promise<CommitValues | undefined>;
}

/** Where published documents go. It answers with the address the document can be fetched from. */
export interface Publisher {
  publish(doc: { contentType: string; body: string }): Promise<string>;
}

/** Stores documents in `published_documents`, addressed by their SHA-256. The website serves them from there. */
export class DbPublisher implements Publisher {
  constructor(private readonly sql: Sql) {}

  async publish(doc: { contentType: string; body: string }): Promise<string> {
    const sha = createHash("sha256").update(doc.body, "utf8").digest("hex");
    await this.sql.query(
      "insert into published_documents (sha256, content_type, body) values ($1, $2, $3) on conflict (sha256) do nothing",
      [sha, doc.contentType, doc.body],
    );
    return `db:sha256:${sha}`;
  }
}

export interface PlannerOptions {
  policy: WeightPolicy;
  /** The indexer must have read this many seconds past the end of the window before the list is computed. */
  settleSecs: number;
}

interface EventRow {
  signature: string;
  slot: string;
  time: string;
  owner: string;
  token_account: string;
  delta: string;
  balance_after: string;
}

const ZERO_ROOT = new Uint8Array(32);

export class SqlEligibilityPlanner implements EligibilityPlanner {
  constructor(
    private readonly sql: Sql,
    private readonly publisher: Publisher,
    private readonly options: PlannerOptions,
  ) {}

  async plan(breakId: string, window: Window): Promise<EligibilityPlan> {
    const stored = await this.stored(breakId);
    if (stored) return { kind: "ready", values: stored };

    const { rows: state } = await this.sql.query<{ until: string }>(
      "select extract(epoch from indexed_until)::bigint::text as until from indexer_state where id = 1",
    );
    if (!state[0]) return { kind: "wait", reason: "the balance indexer has not reported any progress yet" };
    const needed = window.end + this.options.settleSecs;
    if (Number(state[0].until) < needed) {
      return { kind: "wait", reason: `the balance indexer has read up to ${state[0].until} but needs ${needed} (window end + ${this.options.settleSecs} s)` };
    }

    const events = await this.events(window);
    const exclusions = await this.exclusions();
    const eligibility = buildEligibility({ events, window, policy: this.options.policy, exclusions });
    const tree = treeOf(eligibility);
    const values: CommitValues = {
      root: tree ? tree.root.hash : ZERO_ROOT,
      totalWeight: eligibility.totalWeight,
      entryCount: eligibility.leaves.length,
      inputsHash: inputsHash(events, window),
    };

    const listUri = await this.publisher.publish({ contentType: "application/json", body: listDocument(breakId, window, this.options.policy, values, eligibility) });
    const inputsUri = await this.publisher.publish({ contentType: "text/plain; charset=utf-8", body: serializeInputs(events, window) });
    await this.store(breakId, eligibility, values, listUri, inputsUri);

    // Read back what is stored: if another process stored first, theirs is the one that counts.
    const final = await this.stored(breakId);
    if (!final) throw new Error("the eligibility list vanished after it was stored");
    return { kind: "ready", values: final };
  }

  async committed(breakId: string): Promise<CommitValues | undefined> {
    return this.stored(breakId);
  }

  private async stored(breakId: string): Promise<CommitValues | undefined> {
    const { rows } = await this.sql.query<{ root: string; total_weight: string; entry_count: number; inputs_hash: string }>(
      `select encode(root, 'hex') as root, total_weight::text as total_weight, entry_count, encode(inputs_hash, 'hex') as inputs_hash
         from eligibility_lists where break_id = $1::bigint`,
      [breakId],
    );
    const r = rows[0];
    if (!r) return undefined;
    return {
      root: Uint8Array.from(Buffer.from(r.root, "hex")),
      totalWeight: BigInt(r.total_weight),
      entryCount: Number(r.entry_count),
      inputsHash: Uint8Array.from(Buffer.from(r.inputs_hash, "hex")),
    };
  }

  private async events(window: Window): Promise<BalanceEvent[]> {
    // Everything that happened before the window ended, including the history needed for the opening balances.
    const { rows } = await this.sql.query<EventRow>(
      `select signature, slot::text as slot, extract(epoch from block_time)::bigint::text as time, owner, token_account,
              delta::text as delta, balance_after::text as balance_after
         from balance_events where block_time < to_timestamp($1::bigint)
        order by block_time, slot, signature, token_account`,
      [window.end],
    );
    return rows.map((r) => ({
      signature: r.signature,
      slot: BigInt(r.slot),
      time: Number(r.time),
      owner: r.owner,
      tokenAccount: r.token_account,
      delta: BigInt(r.delta),
      balanceAfter: BigInt(r.balance_after),
    }));
  }

  private async exclusions(): Promise<Map<Address, string>> {
    const { rows } = await this.sql.query<{ wallet: string; reason_code: string }>(
      "select wallet, reason_code from exclusions where removed_at is null",
    );
    return new Map(rows.map((r) => [r.wallet, r.reason_code]));
  }

  /**
   * The snapshot rows first and the list row last: the list row existing means everything before it was written.
   * The writes are upserts, so two planners computing the same list at once cannot collide. (The history is frozen
   * once the indexer is past the window, so they do compute the same list; the keeper still runs as one process.)
   */
  private async store(breakId: string, e: Eligibility, v: CommitValues, listUri: string, inputsUri: string): Promise<void> {
    for (const row of e.snapshot) {
      await this.sql.query(
        `insert into twab_snapshots (break_id, wallet, twab, weight, eligible, reason) values ($1::bigint, $2, $3::numeric, $4::numeric, $5, $6)
         on conflict (break_id, wallet) do update set twab = excluded.twab, weight = excluded.weight, eligible = excluded.eligible, reason = excluded.reason`,
        [breakId, row.wallet, row.twab.toString(), row.weight.toString(), row.eligible, row.reason],
      );
    }
    // A crashed earlier attempt may have left rows for wallets that are not in this list.
    await this.sql.query(
      "delete from twab_snapshots where break_id = $1::bigint and wallet not in (select jsonb_array_elements_text($2::jsonb))",
      [breakId, JSON.stringify(e.snapshot.map((s) => s.wallet))],
    );
    await this.sql.query(
      `insert into eligibility_lists (break_id, root, total_weight, entry_count, inputs_hash, list_uri, inputs_uri)
       values ($1::bigint, decode($2, 'hex'), $3::numeric, $4, decode($5, 'hex'), $6, $7)
       on conflict (break_id) do nothing`,
      [breakId, toHex(v.root), v.totalWeight.toString(), v.entryCount, toHex(v.inputsHash), listUri, inputsUri],
    );
  }
}

/** The public record of one break's eligibility: every wallet that held the token, its TWAB and why it is in or out. */
function listDocument(breakId: string, window: Window, policy: WeightPolicy, v: CommitValues, e: Eligibility): string {
  return JSON.stringify(
    {
      version: 1,
      breakId,
      window,
      policy: { minTwab: policy.minTwab.toString(), ...(policy.capPerWallet !== undefined ? { capPerWallet: policy.capPerWallet.toString() } : {}) },
      root: toHex(v.root),
      totalWeight: v.totalWeight.toString(),
      entryCount: v.entryCount,
      inputsHash: toHex(v.inputsHash),
      wallets: e.snapshot.map((s) => ({ wallet: s.wallet, twab: s.twab.toString(), weight: s.weight.toString(), eligible: s.eligible, reason: s.reason })),
    },
    null,
    2,
  );
}
