// Buying a paid spot: the instruction the buyer's wallet signs, and whether a spot can be bought right now. Both follow
// `buy_spot` in programs/breaks/src/lifecycle.rs (its accounts and its checks) and are pinned to the Rust program's own
// instruction bytes in instruction-vectors.json. Nothing here sends anything: it builds what a wallet is asked to sign.

import { concat, hashv, u16le, utf8 } from "../draw/bytes";
import { type Address, SYSTEM_PROGRAM, TOKEN_PROGRAM, breakAddress, configAddress, escrowAddress, spotAddress } from "./address";
import type { BreakAccount, ConfigAccount } from "./accounts";
import { money, utcTime } from "./view";

export interface AccountMeta {
  pubkey: Address;
  signer: boolean;
  writable: boolean;
}

export interface Instruction {
  programId: Address;
  accounts: AccountMeta[];
  data: Uint8Array;
}

/** Anchor's name for an instruction: the first 8 bytes of the hash of `global:<name>`. */
export const discriminator = (name: string): Uint8Array => hashv(utf8(`global:${name}`)).slice(0, 8);

/**
 * `buy_spot(index)`: the buyer pays the break's spot price in USDC from `buyerUsdc` into the break's escrow and gets spot
 * `index`. The spot account is created at the buyer's cost, and `index` has to be the next free one (the program refuses
 * any other, so two buyers racing for the same spot cannot both get it).
 */
export function buySpotInstruction(a: { program: Address; buyer: Address; buyerUsdc: Address; breakId: bigint; index: number }): Instruction {
  const breakKey = breakAddress(a.program, a.breakId);
  return {
    programId: a.program,
    accounts: [
      { pubkey: a.buyer, signer: true, writable: true },
      { pubkey: configAddress(a.program), signer: false, writable: false },
      { pubkey: breakKey, signer: false, writable: true },
      { pubkey: escrowAddress(a.program, breakKey), signer: false, writable: true },
      { pubkey: a.buyerUsdc, signer: false, writable: true },
      { pubkey: spotAddress(a.program, breakKey, a.index), signer: false, writable: true },
      { pubkey: TOKEN_PROGRAM, signer: false, writable: false },
      { pubkey: SYSTEM_PROGRAM, signer: false, writable: false },
    ],
    data: concat(discriminator("buy_spot"), u16le(a.index)),
  };
}

export type SaleCheck = { ok: true; index: number; price: bigint; spotsLeft: number } | { ok: false; reason: string };

/**
 * Whether the program would take a purchase now, judged from the break and the config as they stand. The same checks, in the
 * same order, as `buy_spot`: not paused, the sale is open, inside its window, a spot left. When a spot can be bought, this
 * is the spot the next buyer gets (`index`) and what it costs. Another buyer can still be first, so a wallet should read
 * the break again just before it signs.
 */
export function checkSale(c: { config: Pick<ConfigAccount, "paused">; break: BreakAccount; now: number }): SaleCheck {
  const b = c.break;
  if (c.config.paused) return { ok: false, reason: "Sales are paused by the program's admin." };
  if (b.status === "Cancelled") return { ok: false, reason: "This break was cancelled." };
  if (b.status !== "Open") return { ok: false, reason: "The sale of this break is over." };
  if (BigInt(c.now) < b.opensAt) return { ok: false, reason: `The sale opens ${utcTime(b.opensAt)}.` };
  if (BigInt(c.now) >= b.closesAt) return { ok: false, reason: "The sale has ended." };
  if (b.spotsSold >= b.paidSpots) return { ok: false, reason: "All paid spots are taken." };
  return { ok: true, index: b.spotsSold, price: b.spotPrice, spotsLeft: b.paidSpots - b.spotsSold };
}

export type AffordCheck = { ok: true } | { ok: false; reason: string };

/** Whether a wallet's USDC covers `price`. `balance` is `null` when the wallet has no USDC account at all. */
export function checkAfford(price: bigint, balance: bigint | null): AffordCheck {
  if (balance === null) return { ok: false, reason: "This wallet has no USDC account yet, so it has no USDC to pay with." };
  if (balance < price) return { ok: false, reason: `A spot costs ${money(price)} USDC and this wallet has ${money(balance)}.` };
  return { ok: true };
}

/** A transaction signature is 64 bytes, which is 64 to 88 base58 characters. */
const SIGNATURE_TEXT = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

/**
 * Where a transaction can be looked at on the devnet explorer, or `undefined` unless the text is a plausible signature. The
 * signature came from a wallet, so it is checked before it goes into a link.
 */
export function explorerTxUrl(signature: string): string | undefined {
  return SIGNATURE_TEXT.test(signature) ? `https://explorer.solana.com/tx/${signature}?cluster=devnet` : undefined;
}
