import { compareBytes } from "../draw/bytes.js";
import type { Leaf } from "../draw/tree.js";
import type { Sql } from "../packs/sql-store.js";
import { addressToBytes } from "../solana/pubkey.js";

/** A break the keeper has on chain whose eligibility list is committed (or later): what may have lists to publish. */
export interface Candidate {
  /** `breaks.id`. */
  breakId: string;
  /** The id in the program's PDAs. */
  onchainId: bigint;
  /** The keeper's own status for the break (mirrored from the chain). */
  status: string;
  /** The stored eligibility root as 64 hex digits, if a list is stored. */
  root: string | undefined;
  entryCount: number;
  /** The stored `inputs_hash` as 64 hex digits, if a list is stored: what the balance-event record must hash to. */
  inputsHash: string | undefined;
  /** Mints of the packs pulled so far, in pack order. */
  cards: string[];
}

export interface PublishStore {
  candidates(): Promise<Candidate[]>;
  /** The eligible wallets and weights of a break, sorted by wallet bytes (the order of the tree). */
  leaves(breakId: string): Promise<Leaf[]>;
  /** The balance-event text the planner published for the break (the one `inputs_hash` was made from), if it can be read. */
  inputsText(breakId: string): Promise<string | undefined>;
}

// Statuses from the committed list on; `cancelled` and the ones before the commit have nothing to publish.
const LISTED = ["eligibility_committed", "funded", "pool_committed", "randomness_requested", "settled", "drawn", "delivered"];

export class SqlPublishStore implements PublishStore {
  constructor(private readonly sql: Sql) {}

  async candidates(): Promise<Candidate[]> {
    const { rows } = await this.sql.query<{ id: string; onchain_id: string; status: string; root: string | null; entry_count: number | null; inputs_hash: string | null; cards: string[] | null }>(
      `select b.id::text as id, b.onchain_id::text as onchain_id, b.status, encode(e.root, 'hex') as root, e.entry_count, encode(e.inputs_hash, 'hex') as inputs_hash,
              (select array_agg(p.card_mint order by p.pack_index) from packs p where p.break_id = b.id and p.status = 'pulled' and p.card_mint is not null) as cards
         from breaks b left join eligibility_lists e on e.break_id = b.id
        where b.onchain_id is not null and b.status = any($1::text[])
        order by b.id desc`,
      [LISTED],
    );
    return rows.map((r) => ({
      breakId: r.id,
      onchainId: BigInt(r.onchain_id),
      status: r.status,
      root: r.root ?? undefined,
      entryCount: r.entry_count ?? 0,
      inputsHash: r.inputs_hash ?? undefined,
      cards: r.cards ?? [],
    }));
  }

  async leaves(breakId: string): Promise<Leaf[]> {
    const { rows } = await this.sql.query<{ wallet: string; weight: string }>(
      "select wallet, weight::text as weight from twab_snapshots where break_id = $1::bigint and eligible and weight > 0",
      [breakId],
    );
    return rows.map((r) => ({ wallet: addressToBytes(r.wallet), weight: BigInt(r.weight) })).sort((a, b) => compareBytes(a.wallet, b.wallet));
  }

  async inputsText(breakId: string): Promise<string | undefined> {
    // `inputs_uri` is where the planner put the text (`db:sha256:<hash>` for the database publisher).
    const { rows } = await this.sql.query<{ body: string }>(
      "select p.body from eligibility_lists e join published_documents p on e.inputs_uri = 'db:sha256:' || p.sha256 where e.break_id = $1::bigint",
      [breakId],
    );
    return rows[0]?.body;
  }
}
