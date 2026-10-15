// Encoders for the on-chain accounts, the inverse of the decoders in src/solana/breaks.ts. Only tests need them
// (to put a pretend chain into a given state); test/pipeline-accounts.test.ts checks them against the bytes the
// Rust program writes.

import { Writer } from "../../src/solana/codec.js";
import { accountDiscriminator } from "../../src/solana/instruction.js";
import {
  BREAK_STATUSES,
  type BreakAccount,
  type BreaksConfigAccount,
  MAX_FREE_SPOTS,
  MAX_PACKS,
  MAX_TIERS,
  type RequestState,
  type SpotAccount,
} from "../../src/solana/breaks.js";
import type { OraoNetworkState } from "../../src/solana/orao.js";
import type { TreasuryConfig } from "../../src/solana/treasury.js";
import type { Address } from "../../src/solana/pubkey.js";
import { addressToBytes } from "../../src/solana/pubkey.js";
import { concat } from "../../src/draw/bytes.js";

const withDiscriminator = (name: string, w: Writer) => concat(accountDiscriminator(name), w.finish());

export function encodeBreak(b: BreakAccount): Uint8Array {
  const w = new Writer()
    .u64(b.id)
    .u8(BREAK_STATUSES.indexOf(b.status))
    .u16(b.paidSpots)
    .u16(b.freeSpots)
    .u64(b.spotPrice)
    .u8(b.tiers.length);
  if (b.tiers.length > MAX_TIERS) throw new Error("a break lists at most 8 tiers");
  // The program keeps room for 8 tiers and 64 packs, whatever the break uses; the rest is zeros.
  for (let i = 0; i < MAX_TIERS; i++) {
    const t = b.tiers[i];
    w.fixed(t ? t.machine : new Uint8Array(32), 32).u64(t ? t.maxPrice : 0n);
  }
  if (b.packs.length > MAX_PACKS) throw new Error("a break has at most 64 packs");
  w.fixed(Uint8Array.from({ length: MAX_PACKS }, (_, i) => b.packs[i] ?? 0), MAX_PACKS);
  w.i64(b.opensAt)
    .i64(b.closesAt)
    .u16(b.spotsSold)
    .u64(b.lockedSubsidy)
    .u64(b.lockedHolder)
    .fixed(b.eligibilityRoot, 32)
    .u64(b.eligibilityTotalWeight)
    .u32(b.eligibilityCount)
    .fixed(b.eligibilityInputsHash, 32)
    .u16(b.poolSize)
    .u64(b.packBudget)
    .fixed(b.poolHash, 32)
    .u8(b.randomnessAttempt)
    .fixed(b.randomnessRequestId, 32)
    .i64(b.randomnessRequestedAt)
    .fixed(b.seed, 32)
    .i64(b.seededAt)
    .u8(b.freeWinnerCount);
  if (b.freeWinners.length !== MAX_FREE_SPOTS) throw new Error("a break holds 16 winner slots");
  for (const f of b.freeWinners) w.address(f.wallet).u64(f.start).u64(f.weight);
  w.u8(b.bump).u8(b.escrowBump);
  return withDiscriminator("Break", w);
}

export function encodeBreaksConfig(c: BreaksConfigAccount): Uint8Array {
  return withDiscriminator(
    "BreaksConfig",
    new Writer()
      .address(c.admin)
      .address(c.keeper)
      .address(c.buyer)
      .address(c.usdcMint)
      .address(c.randomnessProgram)
      .i64(c.randomnessTimeoutSecs)
      .u64(c.nextBreakId)
      .i64(c.minWindowSecs)
      .i64(c.maxWindowSecs)
      .u16(c.maxPaidSpots)
      .u16(c.maxFreeSpots)
      .bool(c.paused)
      .u8(c.bump),
  );
}

export function encodeSpot(s: SpotAccount): Uint8Array {
  return withDiscriminator("Spot", new Writer().u64(s.breakId).u16(s.index).address(s.owner).u64(s.paid).bool(s.refunded).u8(s.bump));
}

const REQUEST_DISCRIMINATOR = Uint8Array.of(139, 239, 184, 215, 227, 86, 191, 226);

/** An ORAO request account (`RandomnessV2`): discriminator, tag, client, seed, then no responses or the 64 answer bytes. */
export function encodeRequest(client: Address, seed: Uint8Array, state: RequestState): Uint8Array {
  const w = new Writer().u8(state.state === "pending" ? 0 : 1).address(client).fixed(seed, 32);
  if (state.state === "pending") w.u32(0);
  else w.fixed(state.randomness, 64);
  return concat(REQUEST_DISCRIMINATOR, w.finish());
}

/** The treasury program's `Config` account. */
export function encodeTreasuryConfig(c: TreasuryConfig): Uint8Array {
  return withDiscriminator(
    "Config",
    new Writer()
      .address(c.admin)
      .address(c.usdcMint)
      .address(c.controller)
      .u16(c.subsidyBps)
      .u16(c.holderBps)
      .u64(c.lockedSubsidy)
      .u64(c.lockedHolder)
      .u8(c.bump),
  );
}

/** An initialized SPL token account (165 bytes): mint at 0, owner at 32, amount at 64, state at 108. */
export function encodeTokenAccount(a: { mint: Address; owner: Address; amount: bigint }): Uint8Array {
  const data = new Uint8Array(165);
  data.set(addressToBytes(a.mint), 0);
  data.set(addressToBytes(a.owner), 32);
  new DataView(data.buffer).setBigUint64(64, a.amount, true);
  data[108] = 1;
  return data;
}

/** ORAO's network state account, padded to the 8 + 464 bytes ORAO allocates for it. */
export function encodeNetworkState(s: OraoNetworkState): Uint8Array {
  const w = new Writer().address(s.authority).address(s.treasury).u64(s.requestFee).u32(s.fulfillmentAuthorities.length);
  for (const a of s.fulfillmentAuthorities) w.address(a);
  w.bool(s.tokenFee !== undefined);
  if (s.tokenFee) w.address(s.tokenFee.mint).address(s.tokenFee.treasury).u64(s.tokenFee.fee);
  w.u64(s.numReceived);
  const body = withDiscriminator("NetworkState", w);
  const padded = new Uint8Array(8 + 464);
  padded.set(body, 0);
  return padded;
}
