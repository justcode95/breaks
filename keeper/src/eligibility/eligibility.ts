// From balance history to the eligibility tree: who is eligible, with which weight, and the
// public record of why everyone else is not.

import { compareBytes, hashv, u64le, U64_MAX, utf8 } from "../draw/bytes.js";
import { Tree, type Leaf } from "../draw/tree.js";
import { addressToBytes, isOnCurve, type Address } from "../solana/pubkey.js";
import { sortEvents, twabByOwner, type BalanceEvent, type Window } from "./twab.js";

export interface WeightPolicy {
  /** Wallets with a smaller TWAB are not eligible (in token base units). */
  minTwab: bigint;
  /**
   * Largest weight a single wallet can have. Undefined = no cap (weight = TWAB).
   * NOTE: pending decision A2 in CLAUDE.md. A cap rewards splitting a balance over many wallets.
   */
  capPerWallet?: bigint;
}

/** A public reason a wallet is excluded, e.g. `lp_pool`, `exchange`, `team`, `bundle`. */
export type ExclusionCode = string;

export interface EligibilityInput {
  events: readonly BalanceEvent[];
  window: Window;
  policy: WeightPolicy;
  /** Wallets that never take part, with the public reason. */
  exclusions: ReadonlyMap<Address, ExclusionCode>;
  /** Program-derived addresses (pools, vaults, other protocols' accounts) cannot be holders. Default true. */
  excludeOffCurve?: boolean;
}

export interface SnapshotRow {
  wallet: Address;
  twab: bigint;
  weight: bigint;
  eligible: boolean;
  /** Why the wallet is not eligible. Null when it is. */
  reason: string | null;
}

export interface Eligibility {
  /** Eligible wallets sorted by address bytes, ready for `Tree.build`. */
  leaves: Leaf[];
  totalWeight: bigint;
  /** One row per wallet that appears in the history, eligible or not (for `twab_snapshots`). */
  snapshot: SnapshotRow[];
}

export function weightOf(twab: bigint, policy: WeightPolicy): bigint {
  if (twab < policy.minTwab || twab <= 0n) return 0n;
  return policy.capPerWallet !== undefined && twab > policy.capPerWallet ? policy.capPerWallet : twab;
}

export function buildEligibility(input: EligibilityInput): Eligibility {
  const { events, window, policy, exclusions } = input;
  const excludeOffCurve = input.excludeOffCurve ?? true;
  const twabs = twabByOwner(events, window);

  const snapshot: SnapshotRow[] = [];
  const eligible: Leaf[] = [];
  for (const [wallet, twab] of twabs) {
    const bytes = addressToBytes(wallet);
    const excluded = exclusions.get(wallet);
    let reason: string | null = null;
    let weight = 0n;
    if (excluded !== undefined) reason = `excluded:${excluded}`;
    else if (excludeOffCurve && !isOnCurve(bytes)) reason = "off_curve";
    else {
      weight = weightOf(twab, policy);
      if (weight === 0n) reason = "below_min_twab";
    }
    snapshot.push({ wallet, twab, weight, eligible: reason === null, reason });
    if (reason === null) eligible.push({ wallet: bytes, weight });
  }
  eligible.sort((a, b) => compareBytes(a.wallet, b.wallet));
  snapshot.sort((a, b) => compareBytes(addressToBytes(a.wallet), addressToBytes(b.wallet)));

  const totalWeight = eligible.reduce((acc, l) => acc + l.weight, 0n);
  if (totalWeight > U64_MAX) throw new RangeError("total weight does not fit in a u64");
  return { leaves: eligible, totalWeight, snapshot };
}

/** The tree for the eligible wallets, or undefined when nobody is eligible. */
export function treeOf(eligibility: Eligibility): Tree | undefined {
  return eligibility.leaves.length === 0 ? undefined : Tree.build(eligibility.leaves);
}

/**
 * The text that `inputs_hash` commits to, so anyone can recompute the TWAB: a header with the
 * window, then one line per balance event in chronological order.
 * `signature,slot,time,owner,tokenAccount,delta,balanceAfter`
 */
export function serializeInputs(events: readonly BalanceEvent[], window: Window): string {
  const lines = sortEvents(events).map(
    (e) => `${e.signature},${e.slot},${e.time},${e.owner},${e.tokenAccount},${e.delta},${e.balanceAfter}`,
  );
  return [`breaks:inputs:v1,${window.start},${window.end}`, ...lines].join("\n") + "\n";
}

/** SHA-256 of `serializeInputs`; goes on-chain as `inputs_hash` in `commit_eligibility`. */
export function inputsHash(events: readonly BalanceEvent[], window: Window): Uint8Array {
  return hashv(utf8(serializeInputs(events, window)));
}

export { u64le };
