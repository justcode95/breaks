// What the fee sweep needs from a SOL -> USDC swap. The real one (Jupiter) is a mainnet service, so on devnet there is
// none: the sweep then only deposits USDC that is already in the wallet. The steps are written the way the pack buyer's
// are, so that a restart can never lead to a second swap while the first might still land.

export interface SwapRequest {
  /** Exactly this much SOL, in lamports. */
  lamports: bigint;
  /** The transaction must fail on-chain unless at least this much USDC (base units) comes back. */
  minUsdcOut: bigint;
}

export interface PreparedSwap {
  /** The first signature of the signed transaction: known before it is sent. */
  signature: string;
  /** The last block height at which the transaction can still land (opaque text). */
  expiry: string;
  /** The signed transaction, as the swapper wants it back in `submit` (opaque text). */
  payload: string;
  /** What the transaction really swaps and the least it accepts: checked against the request. */
  lamportsIn: bigint;
  minUsdcOut: bigint;
}

export type SwapStatus =
  | "pending" // not seen yet; it may still land
  | "landed" // landed and succeeded
  | "failed" // landed and reverted
  | "expired"; // past its last block height and not on chain: it can never land

export interface Swapper {
  /** USDC (base units) that `lamports` would fetch now. */
  quote(lamports: bigint): Promise<bigint>;
  prepare(req: SwapRequest): Promise<PreparedSwap>;
  /** Sends the signed transaction. Sending the same one again is harmless. */
  submit(p: Pick<PreparedSwap, "signature" | "payload">): Promise<void>;
  status(p: Pick<PreparedSwap, "signature" | "expiry">): Promise<SwapStatus>;
}
