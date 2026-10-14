import type { Address } from "../solana/pubkey.js";
import type { Commitment, RpcClient } from "../solana/rpc.js";

/** What the fee sweep needs to know about a wallet besides its token accounts: how much SOL it holds. */
export interface WalletReader {
  lamports(address: Address): Promise<bigint>;
}

/** A `WalletReader` over JSON-RPC. */
export class RpcWalletReader implements WalletReader {
  constructor(
    private readonly rpc: RpcClient,
    private readonly commitment: Commitment = "finalized",
  ) {}

  lamports(address: Address): Promise<bigint> {
    return this.rpc.getBalance(address, this.commitment);
  }
}
