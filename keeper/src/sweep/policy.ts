// The rules for turning fee SOL into treasury USDC, as pure functions: how much to swap, and the least USDC a swap
// may give back.

export interface SweepPolicy {
  /** SOL (lamports) that always stays in the wallet: the keeper's own float for rent and fees. */
  keepLamports: bigint;
  /** Smaller amounts are not worth a swap. */
  minLamports: bigint;
  /** The most one swap may move: limits what a bad quote or a thin market can cost. */
  maxLamports: bigint;
  /** How far below the quote a swap may land, in basis points. The transaction itself fails below that. */
  slippageBps: number;
  /** Optional hard floor: the least USDC (base units) one whole SOL must fetch. Below it nothing is swapped. */
  minUsdcPerSol?: bigint;
  /** USDC (base units) below which nothing is deposited: each deposit costs a transaction fee. */
  minDeposit: bigint;
}

const LAMPORTS_PER_SOL = 1_000_000_000n;

/** How much SOL to swap now, or undefined if there is not enough above what the wallet keeps. */
export function swapAmount(solLamports: bigint, p: SweepPolicy): bigint | undefined {
  const spendable = solLamports - p.keepLamports;
  if (spendable <= 0n || spendable < p.minLamports) return undefined;
  return spendable > p.maxLamports ? p.maxLamports : spendable;
}

export type MinOut = { ok: true; minUsdcOut: bigint } | { ok: false; reason: string };

/**
 * The least USDC the swap of `lamports` may give back, given the quote: the quote less the slippage, and never below
 * the hard floor price if one is set. If the quote itself is under the floor, there is no swap.
 */
export function minUsdcOut(quote: bigint, lamports: bigint, p: SweepPolicy): MinOut {
  const floor = p.minUsdcPerSol === undefined ? 0n : (lamports * p.minUsdcPerSol) / LAMPORTS_PER_SOL;
  if (quote < floor) return { ok: false, reason: `the quote of ${quote} is below the floor price (${floor} for this amount)` };
  const slipped = (quote * BigInt(10_000 - p.slippageBps)) / 10_000n;
  const minUsdcOut = slipped > floor ? slipped : floor;
  if (minUsdcOut <= 0n) return { ok: false, reason: "the swap would give back nothing" };
  return { ok: true, minUsdcOut };
}
