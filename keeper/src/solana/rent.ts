// What the accounts the keeper creates cost in rent, in lamports. The runtime keeps an account alive only if it holds the
// rent-exempt minimum: 3,480 lamports per byte-year for two years, for the account's data and 128 bytes of its own
// bookkeeping. The keeper pays it whenever it creates an account (a break and its escrow, an ORAO randomness request).
//
// These are constants rather than an answer from the node: they have been the same on every cluster since rent was set, and
// the keeper's SOL only has to be enough, not exact. The tests pin them to values every Solana tool shows (a token account
// needs 2,039,280, an empty account 890,880) and to the size of the Rust account the vectors hold.

/** Lamports per byte of account data for rent exemption: 3,480 per byte-year, for two years. */
export const LAMPORTS_PER_BYTE = 6_960n;

/** Every account is charged for this many bytes of its own bookkeeping on top of its data. */
export const ACCOUNT_OVERHEAD_BYTES = 128n;

/** The least an account with `dataBytes` of data must hold to stay alive. */
export const rentExempt = (dataBytes: number): bigint => (ACCOUNT_OVERHEAD_BYTES + BigInt(dataBytes)) * LAMPORTS_PER_BYTE;

/** A break's account: the 8-byte discriminator and `Break::INIT_SPACE` (programs/breaks/src/state.rs). */
export const BREAK_ACCOUNT_BYTES = 1_418;

/** The treasury's `Config` account: the 8-byte discriminator and `Config::INIT_SPACE` (programs/treasury/src/state.rs). */
export const TREASURY_CONFIG_ACCOUNT_BYTES = 125;

/** The breaks program's `BreaksConfig` account: the 8-byte discriminator and `BreaksConfig::INIT_SPACE` (programs/breaks/src/state.rs). */
export const BREAKS_CONFIG_ACCOUNT_BYTES = 206;

/** An SPL token account (the break's USDC escrow, the treasury's two vaults, a wallet's USDC account). */
export const TOKEN_ACCOUNT_BYTES = 165;

/** ORAO's randomness request account, as seen on devnet (CLAUDE.md, Randomness). */
export const RANDOMNESS_REQUEST_ACCOUNT_BYTES = 749;

/** The fee for a transaction with one signature. */
export const SIGNATURE_FEE = 5_000n;

export interface CreateBreakCost {
  /** Rent of the two accounts `create_break` makes: the break and its escrow. */
  rent: bigint;
  /** The network fee of the transaction. */
  fee: bigint;
  /** What the wallet must still hold afterwards: a wallet that is left with less than an empty account needs is refused. */
  keep: bigint;
  /** The least the keeper's wallet must hold to create a break. */
  total: bigint;
}

export function createBreakCost(): CreateBreakCost {
  const rent = rentExempt(BREAK_ACCOUNT_BYTES) + rentExempt(TOKEN_ACCOUNT_BYTES);
  const fee = SIGNATURE_FEE;
  const keep = rentExempt(0);
  return { rent, fee, keep, total: rent + fee + keep };
}
