// ORAO's network state: the account in which ORAO keeps its fee and the treasury that receives it. A randomness request
// must name that treasury, so the keeper reads it from the chain instead of trusting a copy in the configuration.
//
// Layout of `orao_solana_vrf::state::NetworkState` (Borsh after the 8-byte Anchor discriminator), checked against the
// real crate by test/fixtures/orao.json:
//   authority: Pubkey, treasury: Pubkey, request_fee: u64, fulfillment_authorities: Vec<Pubkey>,
//   token_fee_config: Option<{ mint: Pubkey, treasury: Pubkey, fee: u64 }>, num_received: u64
// The account is allocated with more room than it uses, so bytes after `num_received` are padding.

import { accountReader } from "./codec.js";
import type { Address } from "./pubkey.js";

export interface OraoTokenFee {
  /** The ORAO token mint. */
  mint: Address;
  /** The treasury that receives fees paid in the token. */
  treasury: Address;
  /** In the token's smallest units. */
  fee: bigint;
}

export interface OraoNetworkState {
  /** Who may change the configuration. */
  authority: Address;
  /** The treasury that receives the request fee paid in SOL. */
  treasury: Address;
  /** The request fee in lamports. */
  requestFee: bigint;
  /** The oracles whose answers are accepted. */
  fulfillmentAuthorities: Address[];
  /** Present when ORAO also accepts its fee in its token. */
  tokenFee?: OraoTokenFee;
  /** Requests received so far. */
  numReceived: bigint;
}

export function decodeNetworkState(data: Uint8Array): OraoNetworkState {
  const r = accountReader(data, "NetworkState");
  const authority = r.address();
  const treasury = r.address();
  const requestFee = r.u64();
  const count = r.u32();
  const fulfillmentAuthorities: Address[] = [];
  // Each read fails if the data ends, so a made-up length cannot run away.
  for (let i = 0; i < count; i++) fulfillmentAuthorities.push(r.address());
  const hasToken = r.bool();
  const tokenFee = hasToken ? { mint: r.address(), treasury: r.address(), fee: r.u64() } : undefined;
  const numReceived = r.u64();
  return { authority, treasury, requestFee, fulfillmentAuthorities, ...(tokenFee ? { tokenFee } : {}), numReceived };
}
