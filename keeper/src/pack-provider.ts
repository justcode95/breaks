import { createHash } from "node:crypto";

export interface PackKey {
  breakId: string;
  /** Position of the pack within the break (one pack per spot). */
  index: number;
}

export type PackStatus = "planned" | "submitted" | "confirmed" | "pulled" | "failed";

export interface PackRecord {
  key: PackKey;
  status: PackStatus;
  signature?: string;
  cardMint?: string;
  /** Price paid, in micro-USDC. */
  price?: bigint;
}

export interface BuyOptions {
  machine: string;
  /** Hard cap in micro-USDC. A live price above this must fail the purchase. */
  maxPrice: bigint;
}

/**
 * Buys and pulls Collector Crypt packs. Real purchases cost real money, so `buy` MUST be idempotent
 * per key: calling it again for the same (breakId, index) never buys a second pack. Implementations
 * reconcile with on-chain history before resubmitting after a crash (see CLAUDE.md, "Pack buyer").
 */
export interface PackProvider {
  buy(key: PackKey, opts: BuyOptions): Promise<PackRecord>;
  get(key: PackKey): Promise<PackRecord | undefined>;
}

const keyString = (k: PackKey) => `${k.breakId}:${k.index}`;
const digest = (s: string) => createHash("sha256").update(s).digest("hex");

/** In-memory stand-in used on devnet and in tests. Pulls are deterministic per key. */
export class MockPackProvider implements PackProvider {
  private records = new Map<string, PackRecord>();
  public buyCalls = 0;

  constructor(private livePrice: bigint) {}

  setLivePrice(price: bigint) {
    this.livePrice = price;
  }

  async buy(key: PackKey, opts: BuyOptions): Promise<PackRecord> {
    const existing = this.records.get(keyString(key));
    if (existing) return existing;

    this.buyCalls++;
    const record: PackRecord =
      this.livePrice > opts.maxPrice
        ? { key, status: "failed" }
        : {
            key,
            status: "pulled",
            signature: `mock-sig-${digest(keyString(key)).slice(0, 16)}`,
            cardMint: `mock-card-${digest(`${opts.machine}:${keyString(key)}`).slice(0, 16)}`,
            price: this.livePrice,
          };
    this.records.set(keyString(key), record);
    return record;
  }

  async get(key: PackKey): Promise<PackRecord | undefined> {
    return this.records.get(keyString(key));
  }
}
