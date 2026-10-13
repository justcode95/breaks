import { compareBytes } from "../draw/bytes.js";
import type { Leaf } from "../draw/tree.js";
import type { Sql } from "../packs/sql-store.js";
import { addressToBytes } from "../solana/pubkey.js";

/** The published eligibility list of a break: the leaves of the tree whose root was committed on-chain. */
export interface EligibilityStore {
  /** Leaves sorted by wallet, strictly increasing, weights above zero. Empty if the list is not stored. */
  leaves(breakId: string): Promise<Leaf[]>;
}

/** Reads the eligible rows of `twab_snapshots`. The pipeline checks the rebuilt root against the chain before using them. */
export class SqlEligibilityStore implements EligibilityStore {
  constructor(private readonly sql: Sql) {}

  async leaves(breakId: string): Promise<Leaf[]> {
    const { rows } = await this.sql.query<{ wallet: string; weight: string }>(
      "select wallet, weight::text as weight from twab_snapshots where break_id = $1::bigint and eligible and weight > 0",
      [breakId],
    );
    return rows
      .map((r) => ({ wallet: addressToBytes(r.wallet), weight: BigInt(r.weight) }))
      .sort((a, b) => compareBytes(a.wallet, b.wallet));
  }
}
