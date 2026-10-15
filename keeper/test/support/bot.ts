import type { PostResult, Poster } from "../../src/bot/poster.js";
import { packMachineBytes } from "../../src/scheduler/machine.js";
import type { BreakAccount } from "../../src/solana/breaks.js";
import { addr } from "./chain.js";
import { uniformPacks } from "./packs.js";

export const T0 = 1_800_000_000n;
export const HOUR = 3_600n;

/** A break as it is on chain: an open sale of 10 paid spots and 2 free ones, 3 sold. */
export function brk(over: Partial<BreakAccount> = {}): BreakAccount {
  return {
    id: 4n,
    status: "Open",
    paidSpots: 10,
    freeSpots: 2,
    spotPrice: 20_000_000n,
    ...uniformPacks(packMachineBytes("pokemon-25"), 25_000_000n, 12),
    opensAt: T0,
    closesAt: T0 + 12n * HOUR,
    spotsSold: 3,
    lockedSubsidy: 0n,
    lockedHolder: 0n,
    eligibilityRoot: new Uint8Array(32),
    eligibilityTotalWeight: 0n,
    eligibilityCount: 0,
    eligibilityInputsHash: new Uint8Array(32),
    poolSize: 0,
    packBudget: 0n,
    poolHash: new Uint8Array(32),
    randomnessAttempt: 0,
    randomnessRequestId: new Uint8Array(32),
    randomnessRequestedAt: 0n,
    seed: new Uint8Array(32),
    seededAt: 0n,
    freeWinnerCount: 0,
    freeWinners: Array.from({ length: 16 }, () => ({ wallet: addr(0), start: 0n, weight: 0n })),
    bump: 255,
    escrowBump: 254,
    ...over,
  };
}

/** A drawn break with two recorded free-spot winners (addresses 21 and 22). */
export const drawn = (over: Partial<BreakAccount> = {}): BreakAccount =>
  brk({
    status: "Drawn",
    seededAt: T0 + 13n * HOUR,
    freeWinnerCount: 2,
    freeWinners: [
      { wallet: addr(21), start: 0n, weight: 5n },
      { wallet: addr(22), start: 5n, weight: 5n },
      ...Array.from({ length: 14 }, () => ({ wallet: addr(0), start: 0n, weight: 0n })),
    ],
    ...over,
  });

/** A poster that answers from a script (then `posted`) and remembers every text it was asked to send. */
export class ScriptedPoster implements Poster {
  public readonly sent: string[] = [];
  public throws: Error | undefined;
  private readonly script: PostResult[] = [];
  private n = 0;

  /** The next answers, in order. */
  answer(...results: PostResult[]): this {
    this.script.push(...results);
    return this;
  }

  async post(text: string): Promise<PostResult> {
    this.sent.push(text);
    if (this.throws) throw this.throws;
    return this.script.shift() ?? { outcome: "posted", id: `x-${++this.n}` };
  }
}
