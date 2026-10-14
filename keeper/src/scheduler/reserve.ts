// What the treasury holds against what the configured break needs. Shared by the scheduler (which creates the break
// when it is enough) and the X bot (which says how far along it is).

import type { AccountReader } from "../pipeline/chain.js";
import type { Programs } from "../solana/breaks.js";
import { decodeTokenAccount } from "../solana/token.js";
import { decodeTreasuryConfig, treasuryAddresses } from "../solana/treasury.js";
import { type BreakTemplate, type ReserveProgress, reserveProgress, unlocked } from "./policy.js";

/** The treasury's config or a vault does not exist (yet). */
export class TreasuryNotInitialized extends Error {
  constructor() {
    super("the treasury is not initialized (its config or a vault is missing)");
    this.name = "TreasuryNotInitialized";
  }
}

/** What each bucket has that is not locked for a break, against the worst case of `template`. */
export async function readReserve(chain: AccountReader, programs: Programs, template: BreakTemplate): Promise<ReserveProgress> {
  const t = treasuryAddresses(programs.treasury);
  const [config, subsidy, holder] = await Promise.all([chain.getAccountData(t.config), chain.getAccountData(t.subsidyVault), chain.getAccountData(t.holderVault)]);
  if (!config || !subsidy || !holder) throw new TreasuryNotInitialized();
  const locked = decodeTreasuryConfig(config);
  return reserveProgress(template, {
    subsidy: unlocked(decodeTokenAccount(subsidy).amount, locked.lockedSubsidy),
    holder: unlocked(decodeTokenAccount(holder).amount, locked.lockedHolder),
  });
}
