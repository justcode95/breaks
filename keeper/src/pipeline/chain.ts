// What the pipeline needs from the chain: read an account, send one transaction. The real implementation
// (JSON-RPC, the keeper key, blockhashes) is a separate piece; the pipeline and its tests only use this.

import type { Instruction } from "../solana/instruction.js";
import type { Address } from "../solana/pubkey.js";

export type SendResult =
  /** Landed and succeeded. */
  | { outcome: "confirmed"; signature: string }
  /** Landed and reverted (or was refused before landing): the chain did not change. */
  | { outcome: "failed"; reason: string; signature?: string }
  /** Could not tell: a timeout, an expiry that was not confirmed. It may still land. The next tick reads the chain. */
  | { outcome: "unknown"; reason: string; signature?: string };

export interface ChainClient {
  /** Raw data of an account, or undefined if it does not exist. Read at a commitment where the data cannot roll back. */
  getAccountData(address: Address): Promise<Uint8Array | undefined>;

  /**
   * Signs with the keeper key (the fee payer), sends the instructions as one transaction and waits for the
   * result. Never throws for something the chain decided; it answers `failed` or `unknown` instead.
   */
  sendAndConfirm(instructions: Instruction[]): Promise<SendResult>;
}
