// Where the pipeline gets the accounts for `request_randomness` from.
//
// ORAO's request must name its fee treasury, which is a field of ORAO's network state. The keeper reads it from the
// chain each time (ORAO's authority can change it), so a wrong or stale copy in the configuration is impossible. The fee
// is paid in SOL, which ORAO always accepts; its optional token fee is not used.

import { oraoNetworkState } from "../solana/breaks.js";
import { decodeNetworkState, type OraoNetworkState } from "../solana/orao.js";
import type { Address } from "../solana/pubkey.js";
import type { AccountReader } from "./chain.js";

/** The accounts `request_randomness` passes on to ORAO besides the request and the payer. */
export interface VrfAccounts {
  networkState: Address;
  /** ORAO's fee treasury (a field of its network state). */
  treasury: Address;
  /** ORAO's token-fee accounts, when the fee is paid in ORAO tokens. */
  extra?: { pubkey: Address; writable: boolean }[];
}

export interface VrfSource {
  /** The randomness program this source is for. */
  program: Address;
  /** Throws if the accounts cannot be worked out. */
  accounts(): Promise<VrfAccounts>;
}

/** A source that always gives the same accounts (for tests). */
export const fixedVrf = (program: Address, accounts: VrfAccounts): VrfSource => ({ program, accounts: async () => accounts });

/** ORAO's own program, read from its network state account. */
export class OraoVrf implements VrfSource {
  constructor(
    private readonly chain: AccountReader,
    readonly program: Address,
  ) {}

  /** The current network state. Throws with a reason if there is none. */
  async state(): Promise<OraoNetworkState> {
    const address = oraoNetworkState(this.program);
    const data = await this.chain.getAccountData(address);
    if (!data) {
      throw new Error(`ORAO's network state ${address} does not exist on this cluster: is VRF_PROGRAM_ID (${this.program}) the right program for it?`);
    }
    return decodeNetworkState(data);
  }

  async accounts(): Promise<VrfAccounts> {
    const state = await this.state();
    return { networkState: oraoNetworkState(this.program), treasury: state.treasury };
  }
}
