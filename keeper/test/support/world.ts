import { MockCardTransfer } from "../../src/delivery/mock-transfer.js";
import { Tree, type Leaf } from "../../src/draw/tree.js";
import { poolHash } from "../../src/draw/pool.js";
import type { Logger } from "../../src/job.js";
import { MemoryPackStore } from "../../src/packs/store.js";
import { BreakPipeline, type ActiveBreak, type PipelineDeps } from "../../src/pipeline/pipeline.js";
import type { EligibilityStore } from "../../src/pipeline/eligibility-store.js";
import type { BreakRepo, DbBreakStatus, SpotRecord } from "../../src/pipeline/repo.js";
import { type BreakAccount, type BreaksConfigAccount, ORAO_PROGRAM, type Programs } from "../../src/solana/breaks.js";
import { type Address, addressToBytes } from "../../src/solana/pubkey.js";
import { addr, BUYER } from "./chain.js";
import { MockChain } from "./mock-chain.js";

export const PROGRAMS: Programs = {
  breaks: "8tmJjCG3D4TF7oPiPWNoaCjZ4pN2U4H237BSGVw2B8KU",
  treasury: "Bvq3U9fz2MiHkLH8u4zyt6T1bimxnaEuHkZhezNDT5R9",
};
export const KEEPER = addr(3);
export const WEIGHTS = [10n, 30n, 5n, 50n, 20n, 15n];
export const ANSWER = Uint8Array.from({ length: 64 }, (_, i) => (i * 7 + 1) & 0xff);

export function logger() {
  const errors: string[] = [];
  const infos: string[] = [];
  const log: Logger = { info: (m) => infos.push(m), error: (m) => errors.push(m) };
  return { log, errors, infos };
}

export class MemoryEligibility implements EligibilityStore {
  constructor(public list: Leaf[]) {}
  async leaves(): Promise<Leaf[]> {
    return this.list;
  }
}

export class MemoryRepo implements BreakRepo {
  public statuses = new Map<string, string>();
  constructor(public breaks: ActiveBreak[]) {
    for (const b of breaks) this.statuses.set(b.id, b.status);
  }
  async activeBreaks(): Promise<ActiveBreak[]> {
    return this.breaks
      .filter((b) => !["delivered", "cancelled"].includes(this.statuses.get(b.id) ?? ""))
      .map((b) => ({ ...b, status: this.statuses.get(b.id) ?? b.status }));
  }
  async setStatus(id: string, status: DbBreakStatus): Promise<void> {
    this.statuses.set(id, status);
  }
  public spots = new Map<string, SpotRecord>();
  async recordSpots(breakId: string, spots: readonly SpotRecord[]): Promise<void> {
    for (const s of spots) {
      const key = `${breakId}:${s.kind}:${s.idx}`;
      const known = this.spots.get(key);
      if (known && known.wallet !== s.wallet) throw new Error(`spot ${key} is recorded for ${known.wallet} but the chain says ${s.wallet}`);
      this.spots.set(key, known ?? s);
    }
  }
}

/**
 * A break that is `Funded` on a pretend chain: 3 paid spots, 2 free spots drawn from 6 eligible wallets, the
 * pool's cards pulled and held by the buyer wallet, the eligibility list stored.
 */
export function world(opts: { paid?: number; free?: number; cardBase?: number; id?: bigint; wallets?: number } = {}) {
  const paid = opts.paid ?? 3;
  const free = opts.free ?? 2;
  const id = opts.id ?? 7n;
  const poolSize = paid + free;

  // Six wallets by default; more to get a deeper tree (proofs of several steps, odd nodes carried up).
  const wallets = opts.wallets ?? WEIGHTS.length;
  const leaves: Leaf[] = Array.from({ length: wallets }, (_, i) => ({
    wallet: addressToBytes(addr(60 + i)),
    weight: WEIGHTS[i] ?? BigInt((i * 7919) % 97) + 1n,
  }));
  const tree = Tree.build(leaves);
  const cards = Array.from({ length: poolSize }, (_, i) => addr((opts.cardBase ?? 100) + i));

  const config: BreaksConfigAccount = {
    admin: addr(2),
    keeper: KEEPER,
    buyer: BUYER,
    usdcMint: addr(5),
    randomnessProgram: ORAO_PROGRAM,
    randomnessTimeoutSecs: 3_600n,
    nextBreakId: id + 1n,
    minWindowSecs: 21_600n,
    maxWindowSecs: 86_400n,
    maxPaidSpots: 20,
    maxFreeSpots: 6,
    paused: false,
    bump: 255,
  };
  const chain = new MockChain(PROGRAMS, config);
  const b: BreakAccount = {
    id,
    status: "Funded",
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
    eligibilityRoot: tree.root.hash,
    eligibilityTotalWeight: tree.root.sum,
    eligibilityCount: leaves.length,
    eligibilityInputsHash: new Uint8Array(32).fill(0x22),
    poolSize,
    packBudget: BigInt(poolSize) * 25_000_000n,
    poolHash: new Uint8Array(32),
    randomnessAttempt: 0,
    randomnessRequestId: new Uint8Array(32),
    randomnessRequestedAt: 0n,
    seed: new Uint8Array(32),
    seededAt: 0n,
    freeWinnerCount: 0,
    freeWinners: Array.from({ length: 16 }, () => ({ wallet: addr(0), start: 0n, weight: 0n })),
    bump: 254,
    escrowBump: 253,
  };
  chain.breaks.set(id, b);
  for (let i = 0; i < paid; i++) {
    chain.addSpot({ breakId: id, index: i, owner: addr(10 + i), paid: 20_000_000n, refunded: false, bump: 255 });
  }

  const active: ActiveBreak = { id: String(id), onchainId: id, machine: "pokemon-25", status: "funded" };
  const packs = new MemoryPackStore();
  const transfer = new MockCardTransfer();
  const eligibility = new MemoryEligibility(leaves);
  const clock = { now: () => new Date(Number(chain.unixTime) * 1000) };

  /** Pulls the first `upTo` packs. `order` says which card each pack index gets (default: in order). */
  async function pullPacks(upTo = poolSize, order: number[] = cards.map((_, i) => i)) {
    for (let i = 0; i < upTo; i++) {
      const key = { breakId: active.id, index: i };
      await packs.ensure(key);
      await packs.startAttempt(key, { signature: `${id}-pack-${i}`, expiry: "9", price: 25_000_000n });
      await packs.resolveAttempt(key, `${id}-pack-${i}`, { to: "confirmed" });
      const card = cards[order[i] as number] as Address;
      await packs.complete(key, { cardMint: card });
      transfer.give(card, BUYER);
    }
  }

  const { log, errors, infos } = logger();
  function pipeline(overrides: Partial<PipelineDeps> = {}) {
    return new BreakPipeline({
      chain,
      programs: PROGRAMS,
      keeper: KEEPER,
      vrf: { program: ORAO_PROGRAM, networkState: addr(0xa1), treasury: addr(0xa2) },
      eligibility,
      packs,
      cards: transfer,
      log,
      now: clock.now,
      ...overrides,
    });
  }

  const expectedPoolHash = () => poolHash(cards.map(addressToBytes));
  return { chain, b, active, packs, transfer, eligibility, tree, leaves, cards, config, pipeline, pullPacks, clock, errors, infos, log, expectedPoolHash };
}
