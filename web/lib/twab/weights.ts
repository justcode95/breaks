// Is each weight on the eligibility list what the balance events say it should be? The list's weight for a wallet is its TWAB
// (docs/PUBLISHED.md), unless a rule that caps a wallet's weight is in force (still being decided), in which case it can be
// lower. It can never be higher, and a wallet cannot be on the list without any history in the record.

export interface ListedWallet {
  wallet: string;
  weight: bigint;
}

/**
 * `equal`: the weight is the TWAB. `below`: the weight is less than the TWAB, which only a cap explains. `above`: more than
 * the TWAB, which nothing explains. `no-history`: the record has no event of this wallet at all.
 */
export type WeightStatus = "equal" | "below" | "above" | "no-history";

export interface WeightRow extends ListedWallet {
  /** Undefined for `no-history`. */
  twab: bigint | undefined;
  status: WeightStatus;
}

export interface WeightCheck {
  /** One row for each wallet on the list, in the list's order. */
  rows: WeightRow[];
  counts: Record<WeightStatus, number>;
  /** Wallets with a TWAB above zero that are not on the list: below the minimum or left out on purpose, the reasons are not published. Biggest first. */
  offList: { wallet: string; twab: bigint }[];
  /** `equal`: every weight is its TWAB. `capped`: nothing is wrong, but some weights are below the TWAB. `wrong`: something cannot be explained. */
  verdict: "equal" | "capped" | "wrong";
}

/** Compares the list with the TWABs. The wallets on the list are expected to be unique (the tree refuses a list where they are not). */
export function checkWeights(list: readonly ListedWallet[], twabs: ReadonlyMap<string, bigint>): WeightCheck {
  const counts: Record<WeightStatus, number> = { equal: 0, below: 0, above: 0, "no-history": 0 };
  const rows = list.map((l): WeightRow => {
    const twab = twabs.get(l.wallet);
    const status: WeightStatus = twab === undefined ? "no-history" : l.weight === twab ? "equal" : l.weight < twab ? "below" : "above";
    counts[status]++;
    return { wallet: l.wallet, weight: l.weight, twab, status };
  });

  const listed = new Set(list.map((l) => l.wallet));
  const offList = [...twabs]
    .filter(([wallet, twab]) => twab > 0n && !listed.has(wallet))
    .map(([wallet, twab]) => ({ wallet, twab }))
    .sort((a, b) => (a.twab > b.twab ? -1 : a.twab < b.twab ? 1 : a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0));

  const verdict = counts.above > 0 || counts["no-history"] > 0 ? "wrong" : counts.below > 0 ? "capped" : "equal";
  return { rows, counts, offList, verdict };
}
