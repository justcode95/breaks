import { poolHash } from "../../src/draw/pool.js";
import type { BreakAccount, SpotAccount } from "../../src/solana/breaks.js";
import { type Address, addressFromBytes, addressToBytes } from "../../src/solana/pubkey.js";

/** A valid-looking address made of one repeated byte. */
export const addr = (n: number): Address => addressFromBytes(new Uint8Array(32).fill(n));

export const BUYER = addr(250);
const EMPTY = addr(0);

export interface DrawnBreak {
  chain: BreakAccount;
  paidSpots: SpotAccount[];
  cards: Address[];
  buyer: Address;
}

/**
 * What the chain and the database hold for a break that is `Drawn`: `paid` sold spots, `free` drawn winners,
 * and one pulled card per spot, with the pool hash committed over exactly those cards.
 */
export function drawnBreak(opts: { id?: bigint; paid?: number; free?: number; seed?: number; cardBase?: number } = {}): DrawnBreak {
  const id = opts.id ?? 7n;
  const paid = opts.paid ?? 3;
  const free = opts.free ?? 2;
  const cards = Array.from({ length: paid + free }, (_, i) => addr((opts.cardBase ?? 100) + i));
  const paidSpots: SpotAccount[] = Array.from({ length: paid }, (_, i) => ({
    breakId: id,
    index: i,
    owner: addr(10 + i),
    paid: 20_000_000n,
    refunded: false,
    bump: 255,
  }));
  const winners = Array.from({ length: 16 }, (_, i) =>
    i < free ? { wallet: addr(50 + i), start: BigInt(i * 10), weight: 10n } : { wallet: EMPTY, start: 0n, weight: 0n },
  );
  const chain: BreakAccount = {
    id,
    status: "Drawn",
    paidSpots: paid,
    freeSpots: free,
    spotPrice: 20_000_000n,
    maxPackPrice: 25_000_000n,
    packMachine: new Uint8Array(32).fill(0x77),
    opensAt: 1_800_000_000n,
    closesAt: 1_800_021_600n,
    spotsSold: paid,
    lockedSubsidy: 0n,
    lockedHolder: 0n,
    eligibilityRoot: new Uint8Array(32).fill(0x11),
    eligibilityTotalWeight: 100n,
    eligibilityCount: free + 3,
    eligibilityInputsHash: new Uint8Array(32).fill(0x22),
    poolSize: paid + free,
    packBudget: BigInt(paid + free) * 25_000_000n,
    poolHash: poolHash(cards.map(addressToBytes)),
    randomnessAttempt: 0,
    randomnessRequestId: new Uint8Array(32).fill(0x5e),
    randomnessRequestedAt: 1_800_030_000n,
    seed: new Uint8Array(32).fill(opts.seed ?? 0x99),
    seededAt: 1_800_030_100n,
    freeWinnerCount: free,
    freeWinners: winners,
    bump: 254,
    escrowBump: 253,
  };
  return { chain, paidSpots, cards, buyer: BUYER };
}
