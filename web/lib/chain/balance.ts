// A wallet's USDC balance, read in the browser: the USDC the paid spots cost is named by the breaks program's config, and the
// wallet's balance is in its associated token account for that mint. The account's owner, mint and authority are checked, since
// the number is shown to someone about to pay.

import type { ConfigAccount } from "./accounts";
import { decodeConfig } from "./accounts";
import { type Address, TOKEN_PROGRAM, associatedTokenAddress, configAddress } from "./address";
import { LoadError } from "./load";
import { RpcFailure, getAccounts } from "./rpc";
import { decodeTokenAccount } from "./treasury";

export interface UsdcBalance {
  /** The USDC mint of the breaks program. */
  mint: Address;
  /** The wallet's associated token account for it, which may not exist yet. */
  account: Address;
  /** What the account holds in USDC base units, or `null` when the wallet has no USDC account yet. */
  balance: bigint | null;
}

export interface BalanceOptions {
  rpcUrl: string;
  /** The breaks program. */
  program: Address;
  /** The wallet. */
  owner: Address;
  /** How settled the data must be. `finalized` (the default) cannot roll back; `confirmed` is quicker and is what a purchase uses. */
  commitment?: "finalized" | "confirmed";
  fetch?: typeof fetch;
}

export async function loadUsdcBalance(opts: BalanceOptions): Promise<UsdcBalance> {
  const extra = { ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(opts.commitment ? { commitment: opts.commitment } : {}) };
  try {
    const [config] = await getAccounts({ url: opts.rpcUrl, addresses: [configAddress(opts.program)], ...extra });
    if (!config) throw new LoadError("The breaks program has not been set up on this network (its config account does not exist).");
    if (config.owner !== opts.program) throw new LoadError("The config account is not owned by the breaks program.");
    let c: ConfigAccount;
    try {
      c = decodeConfig(config.data);
    } catch (err) {
      throw new LoadError(`The config account could not be read: ${err instanceof Error ? err.message : String(err)}`);
    }

    const account = associatedTokenAddress(opts.owner, c.usdcMint);
    const [token] = await getAccounts({ url: opts.rpcUrl, addresses: [account], ...extra });
    if (!token) return { mint: c.usdcMint, account, balance: null };
    if (token.owner !== TOKEN_PROGRAM) throw new LoadError("The wallet's USDC account is not a token account (it is not owned by the token program).");
    let t: ReturnType<typeof decodeTokenAccount>;
    try {
      t = decodeTokenAccount(token.data);
    } catch (err) {
      throw new LoadError(`The wallet's USDC account could not be read: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (t.mint !== c.usdcMint) throw new LoadError("The wallet's USDC account holds another token.");
    if (t.owner !== opts.owner) throw new LoadError("The wallet's USDC account belongs to another wallet.");
    if (t.frozen) throw new LoadError("The wallet's USDC account is frozen, so it cannot pay.");
    return { mint: c.usdcMint, account, balance: t.amount };
  } catch (err) {
    if (err instanceof LoadError) throw err;
    if (err instanceof RpcFailure) throw new LoadError(err.message);
    throw new LoadError(`Could not read the wallet's USDC: ${err instanceof Error ? err.message : String(err)}`);
  }
}
