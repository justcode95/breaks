// The treasury program's accounts, read in the browser: its config (the split, who controls it, how much is reserved
// for breaks) and the two token accounts that hold the buckets. An independent decoder of programs/treasury/src/state.rs
// and of the SPL token account; the Rust programs' own sample bytes (instruction-vectors.json) pin it.

import { type Address, type Bucket, addressFromBytes, configAddress, vaultAddress } from "./address";
import { accountReader } from "./accounts";
import { LoadError } from "./load";
import { RpcFailure, getAccounts } from "./rpc";

/** The SPL token program: the owner of the vaults. */
export const TOKEN_PROGRAM: Address = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SYSTEM_PROGRAM: Address = "11111111111111111111111111111111";
const TOKEN_ACCOUNT_LEN = 165;

export interface TreasuryConfig {
  /** The Squads multisig: changes the split and appoints the controller. */
  admin: Address;
  usdcMint: Address;
  /** The only signer that may lock, unlock and pay out; all zeros (the system program's address) until the admin sets it. */
  controller: Address;
  subsidyBps: number;
  holderBps: number;
  lockedSubsidy: bigint;
  lockedHolder: bigint;
}

export function decodeTreasuryConfig(data: Uint8Array): TreasuryConfig {
  const r = accountReader(data, "Config");
  return { admin: r.address(), usdcMint: r.address(), controller: r.address(), subsidyBps: r.u16(), holderBps: r.u16(), lockedSubsidy: r.u64(), lockedHolder: r.u64() };
}

export interface TokenAccount {
  mint: Address;
  /** The token authority (who may move the tokens), not the program that owns the account. */
  owner: Address;
  amount: bigint;
  frozen: boolean;
}

/** The SPL token account: `mint` at 0, `owner` at 32, `amount` at 64, `state` at 108 (0 uninitialized, 1 ready, 2 frozen). */
export function decodeTokenAccount(data: Uint8Array): TokenAccount {
  if (data.length < TOKEN_ACCOUNT_LEN) throw new RangeError(`a token account is at least ${TOKEN_ACCOUNT_LEN} bytes, got ${data.length}`);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const state = view.getUint8(108);
  if (state === 0) throw new RangeError("the token account is not initialized");
  if (state > 2) throw new RangeError(`unknown token account state ${state}`);
  return { mint: addressFromBytes(data.slice(0, 32)), owner: addressFromBytes(data.slice(32, 64)), amount: view.getBigUint64(64, true), frozen: state === 2 };
}

export interface BucketView {
  /** What the vault holds. */
  balance: bigint;
  /** Reserved for breaks that exist: not available for new ones. */
  locked: bigint;
  /** What a new break could still lock: the balance less the reserved part. */
  available: bigint;
  vault: Address;
}

export interface Treasury {
  config: TreasuryConfig;
  configAddress: Address;
  subsidy: BucketView;
  holder: BucketView;
  /** Things that look wrong but are shown rather than hidden. */
  notes: string[];
}

export interface TreasuryOptions {
  rpcUrl: string;
  treasuryProgram: Address;
  fetch?: typeof fetch;
}

/** The config and both vaults, read in one request so they come from the same moment. */
export async function loadTreasury(opts: TreasuryOptions): Promise<Treasury> {
  const configKey = configAddress(opts.treasuryProgram);
  const vaults: Record<Bucket, Address> = { subsidy: vaultAddress(opts.treasuryProgram, "subsidy"), holder: vaultAddress(opts.treasuryProgram, "holder") };
  try {
    const [config, subsidyVault, holderVault] = await getAccounts({ url: opts.rpcUrl, addresses: [configKey, vaults.subsidy, vaults.holder], ...(opts.fetch ? { fetch: opts.fetch } : {}) });
    if (!config) throw new LoadError("The treasury has not been set up on this network (its config account does not exist).");
    if (config.owner !== opts.treasuryProgram) throw new LoadError("The treasury's config account is not owned by the treasury program.");
    let c: TreasuryConfig;
    try {
      c = decodeTreasuryConfig(config.data);
    } catch (err) {
      throw new LoadError(`The treasury's config account could not be read: ${err instanceof Error ? err.message : String(err)}`);
    }

    const notes: string[] = [];
    const bucket = (name: Bucket, account: typeof subsidyVault, locked: bigint): BucketView => {
      if (!account) throw new LoadError(`The ${name} vault should exist but its account is missing.`);
      if (account.owner !== TOKEN_PROGRAM) throw new LoadError(`The ${name} vault is not a token account (it is not owned by the token program).`);
      let t: TokenAccount;
      try {
        t = decodeTokenAccount(account.data);
      } catch (err) {
        throw new LoadError(`The ${name} vault could not be read: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (t.owner !== configKey) throw new LoadError(`The ${name} vault is not controlled by the treasury (its token authority is another address).`);
      if (t.mint !== c.usdcMint) throw new LoadError(`The ${name} vault does not hold the treasury's USDC.`);
      if (t.frozen) notes.push(`The ${name} vault is frozen: no money can move in or out of it.`);
      if (locked > t.amount) notes.push(`More is reserved in the ${name} bucket than its vault holds. This should not happen.`);
      return { balance: t.amount, locked, available: t.amount > locked ? t.amount - locked : 0n, vault: vaults[name] };
    };
    const subsidy = bucket("subsidy", subsidyVault, c.lockedSubsidy);
    const holder = bucket("holder", holderVault, c.lockedHolder);
    if (c.subsidyBps + c.holderBps !== 10_000) notes.push("The two shares of the split do not add up to 100%.");
    return { config: c, configAddress: configKey, subsidy, holder, notes };
  } catch (err) {
    if (err instanceof LoadError) throw err;
    if (err instanceof RpcFailure) throw new LoadError(err.message);
    throw new LoadError(`Could not read the treasury: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** True until the admin has appointed a controller. */
export const noController = (controller: Address): boolean => controller === SYSTEM_PROGRAM;
