// Account bytes as the Rust program writes them, and a node that serves them. Test code only: the encoder is checked
// byte for byte against the Rust program's own sample account (chain-load.test.ts).

import { base64 } from "@scure/base";
import { type Address, addressToBytes } from "../../lib/chain/address";
import { concat, fromHex, hashv, utf8 } from "../../lib/draw/bytes";

const disc = (name: string) => hashv(utf8(`account:${name}`)).slice(0, 8);
const u = (bytes: number, n: bigint | number, signed = false): Uint8Array => {
  const out = new Uint8Array(bytes);
  const v = new DataView(out.buffer);
  const big = BigInt(n);
  if (bytes === 1) v.setUint8(0, Number(big));
  else if (bytes === 2) v.setUint16(0, Number(big), true);
  else if (bytes === 4) v.setUint32(0, Number(big), true);
  else if (signed) v.setBigInt64(0, big, true);
  else v.setBigUint64(0, big, true);
  return out;
};

export const STATUS_INDEX = { Open: 0, Closed: 1, EligibilityCommitted: 2, Funded: 3, PoolCommitted: 4, RandomnessRequested: 5, Settled: 6, Drawn: 7, Cancelled: 8 } as const;

export interface BreakFields {
  id: bigint;
  status: keyof typeof STATUS_INDEX;
  paidSpots: number;
  freeSpots: number;
  spotPrice: bigint;
  maxPackPrice: bigint;
  packMachine: Uint8Array;
  opensAt: bigint;
  closesAt: bigint;
  spotsSold: number;
  lockedSubsidy: bigint;
  lockedHolder: bigint;
  eligibilityRoot: Uint8Array;
  eligibilityTotalWeight: bigint;
  eligibilityCount: number;
  eligibilityInputsHash: Uint8Array;
  poolSize: number;
  packBudget: bigint;
  poolHash: Uint8Array;
  randomnessAttempt: number;
  randomnessRequestId: Uint8Array;
  randomnessRequestedAt: bigint;
  seed: Uint8Array;
  seededAt: bigint;
  freeWinnerCount: number;
  freeWinners: { wallet: Address; start: bigint; weight: bigint }[];
  bump: number;
  escrowBump: number;
}

/** The fields of the Rust program's sample Break (`breaks.account.Break` in instruction-vectors.json), as numbers and bytes. */
export function breakFieldsFromVector(o: Record<string, any>): BreakFields {
  const hex = (s: string) => fromHex(s);
  return {
    id: BigInt(o.id),
    status: o.status,
    paidSpots: o.paidSpots,
    freeSpots: o.freeSpots,
    spotPrice: BigInt(o.spotPrice),
    maxPackPrice: BigInt(o.maxPackPrice),
    packMachine: hex(o.packMachine),
    opensAt: BigInt(o.opensAt),
    closesAt: BigInt(o.closesAt),
    spotsSold: o.spotsSold,
    lockedSubsidy: BigInt(o.lockedSubsidy),
    lockedHolder: BigInt(o.lockedHolder),
    eligibilityRoot: hex(o.eligibilityRoot),
    eligibilityTotalWeight: BigInt(o.eligibilityTotalWeight),
    eligibilityCount: o.eligibilityCount,
    eligibilityInputsHash: hex(o.eligibilityInputsHash),
    poolSize: o.poolSize,
    packBudget: BigInt(o.packBudget),
    poolHash: hex(o.poolHash),
    randomnessAttempt: o.randomnessAttempt,
    randomnessRequestId: hex(o.randomnessRequestId),
    randomnessRequestedAt: BigInt(o.randomnessRequestedAt),
    seed: hex(o.seed),
    seededAt: BigInt(o.seededAt),
    freeWinnerCount: o.freeWinnerCount,
    freeWinners: (o.freeWinners as { wallet: string; start: string; weight: string }[]).slice(0, o.freeWinnerCount).map((w) => ({ wallet: w.wallet, start: BigInt(w.start), weight: BigInt(w.weight) })),
    bump: o.bump,
    escrowBump: o.escrowBump,
  };
}

export function encodeBreak(b: BreakFields): Uint8Array {
  const slots = Array.from({ length: 16 }, (_, i) => b.freeWinners[i] ?? { wallet: "11111111111111111111111111111111", start: 0n, weight: 0n });
  return concat(
    disc("Break"),
    u(8, b.id),
    u(1, STATUS_INDEX[b.status]),
    u(2, b.paidSpots),
    u(2, b.freeSpots),
    u(8, b.spotPrice),
    u(8, b.maxPackPrice),
    b.packMachine,
    u(8, b.opensAt, true),
    u(8, b.closesAt, true),
    u(2, b.spotsSold),
    u(8, b.lockedSubsidy),
    u(8, b.lockedHolder),
    b.eligibilityRoot,
    u(8, b.eligibilityTotalWeight),
    u(4, b.eligibilityCount),
    b.eligibilityInputsHash,
    u(2, b.poolSize),
    u(8, b.packBudget),
    b.poolHash,
    u(1, b.randomnessAttempt),
    b.randomnessRequestId,
    u(8, b.randomnessRequestedAt, true),
    b.seed,
    u(8, b.seededAt, true),
    u(1, b.freeWinnerCount),
    ...slots.flatMap((w) => [addressToBytes(w.wallet), u(8, w.start), u(8, w.weight)]),
    u(1, b.bump),
    u(1, b.escrowBump),
  );
}

export function encodeSpot(s: { breakId: bigint; index: number; owner: Address; paid: bigint; refunded: boolean; bump?: number }): Uint8Array {
  return concat(disc("Spot"), u(8, s.breakId), u(2, s.index), addressToBytes(s.owner), u(8, s.paid), u(1, s.refunded ? 1 : 0), u(1, s.bump ?? 255));
}

export interface Served {
  data: Uint8Array;
  owner: Address;
}

/** A Solana node that only knows `getMultipleAccounts`, and remembers what it was asked. */
export function fakeNode(accounts: Map<Address, Served>) {
  const requests: { addresses: string[]; config: Record<string, unknown> }[] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const { method, params } = JSON.parse(init.body as string) as { method: string; params: [string[], Record<string, unknown>] };
    if (method !== "getMultipleAccounts") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: `no ${method} here` } }));
    requests.push({ addresses: params[0], config: params[1] });
    const value = params[0].map((a) => {
      const s = accounts.get(a);
      return s ? { data: [base64.encode(s.data), "base64"], owner: s.owner, lamports: 1, executable: false } : null;
    });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value } }));
  }) as unknown as typeof fetch;
  return { fetchFn, requests };
}
