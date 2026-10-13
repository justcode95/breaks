import { createHash } from "node:crypto";
import { addressFromBytes } from "../solana/pubkey.js";
import {
  type BuyOptions,
  type ExistingPurchase,
  type PackKey,
  type PackProvider,
  type PackReveal,
  PriceAboveCapError,
  type PreparedPurchase,
  type PurchaseStatus,
  keyString,
} from "./provider.js";

/** What happens to the next `submit` call. */
export type SubmitBehavior =
  /** The purchase reaches the chain and succeeds. */
  | "land"
  /** `submit` returns normally but the transaction is lost. */
  | "drop"
  /** `submit` throws and the transaction is lost. */
  | "throw"
  /** The transaction lands, then `submit` throws anyway (a timeout after the fact): the dangerous case. */
  | "land-then-throw"
  /** The transaction lands and reverts: nothing is bought. */
  | "revert";

interface Prepared {
  key: PackKey;
  machine: string;
  price: bigint;
  expiry: number;
}

interface Landed {
  key: PackKey;
  machine: string;
  price: bigint;
  expiry: number;
  outcome: "confirmed" | "reverted";
}

const BLOCKS_VALID = 150;
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
/** A card mint is a 32-byte address, like a real one (the pool hash is computed over the raw bytes). */
const mintFor = (s: string) => addressFromBytes(createHash("sha256").update(s).digest());

/**
 * A pretend chain for devnet and tests. Purchases have a signature before they are sent and a block height
 * after which they can no longer land, like Solana transactions. Failures are injected with `queueSubmit`.
 */
export class MockPackProvider implements PackProvider {
  private height = 1_000;
  private seq = 0;
  private readonly prepared = new Map<string, Prepared>();
  /** In landing order. */
  private readonly landed = new Map<string, Landed>();
  private readonly behaviors: SubmitBehavior[] = [];
  private readonly revealCalls = new Map<string, number>();

  /** How many `reveal` calls per purchase return nothing before the card shows up. */
  public revealDelay = 0;
  public prepareCalls = 0;

  constructor(private livePrice: bigint) {}

  setLivePrice(price: bigint) {
    this.livePrice = price;
  }

  /** Moves the pretend chain forward. */
  advanceBlocks(n: number) {
    this.height += n;
  }

  /** The next `submit` calls behave like this, one entry each; afterwards they land. */
  queueSubmit(...behaviors: SubmitBehavior[]) {
    this.behaviors.push(...behaviors);
  }

  /** Signatures of successful purchases for a key. More than one means money was spent twice. */
  confirmedFor(key: PackKey): string[] {
    return [...this.landed.entries()]
      .filter(([, l]) => l.outcome === "confirmed" && keyString(l.key) === keyString(key))
      .map(([sig]) => sig);
  }

  /** Everything spent so far, micro-USDC. */
  moneySpent(): bigint {
    let total = 0n;
    for (const l of this.landed.values()) if (l.outcome === "confirmed") total += l.price;
    return total;
  }

  /** Lands a purchase for `key` out of band (as if an earlier run of the keeper had sent it and lost its notes). */
  landUnrecorded(key: PackKey, machine = "mock-machine"): string {
    const p = this.prepareFor(key, machine, this.livePrice);
    this.landed.set(p.signature, { key, machine, price: p.price, expiry: Number(p.expiry), outcome: "confirmed" });
    return p.signature;
  }

  async findExisting(key: PackKey): Promise<ExistingPurchase[]> {
    return [...this.landed.entries()]
      .filter(([, l]) => keyString(l.key) === keyString(key))
      .map(([signature, l]) => ({ signature, expiry: String(l.expiry) }));
  }

  async prepare(key: PackKey, opts: BuyOptions): Promise<PreparedPurchase> {
    this.prepareCalls++;
    if (this.livePrice > opts.maxPrice) throw new PriceAboveCapError(this.livePrice, opts.maxPrice);
    return this.prepareFor(key, opts.machine, this.livePrice);
  }

  private prepareFor(key: PackKey, machine: string, price: bigint): PreparedPurchase {
    const signature = `mock-sig-${this.seq++}-${digest(keyString(key)).slice(0, 8)}`;
    const expiry = this.height + BLOCKS_VALID;
    this.prepared.set(signature, { key, machine, price, expiry });
    return { key, signature, expiry: String(expiry), price };
  }

  async submit(purchase: PreparedPurchase): Promise<void> {
    const p = this.prepared.get(purchase.signature);
    if (!p) throw new Error(`mock: unknown purchase ${purchase.signature}`);
    const behavior = this.behaviors.shift() ?? "land";
    // A transaction whose blockhash is too old is refused by the network.
    const tooLate = this.height > p.expiry;
    const land = (outcome: Landed["outcome"]) => {
      if (!tooLate) this.landed.set(purchase.signature, { ...p, outcome });
    };
    switch (behavior) {
      case "land":
        land("confirmed");
        return;
      case "revert":
        land("reverted");
        return;
      case "drop":
        return;
      case "throw":
        throw new Error("mock: network error");
      case "land-then-throw":
        land("confirmed");
        throw new Error("mock: timed out waiting for confirmation");
    }
  }

  async status(signature: string, expiry: string): Promise<PurchaseStatus> {
    const l = this.landed.get(signature);
    if (l) return l.outcome === "confirmed" ? { state: "confirmed" } : { state: "failed", reason: "mock: reverted" };
    return this.height > Number(expiry) ? { state: "expired" } : { state: "pending" };
  }

  async reveal(signature: string): Promise<PackReveal | undefined> {
    const l = this.landed.get(signature);
    if (!l || l.outcome !== "confirmed") return undefined;
    const calls = (this.revealCalls.get(signature) ?? 0) + 1;
    this.revealCalls.set(signature, calls);
    if (calls <= this.revealDelay) return undefined;
    return {
      cardMint: mintFor(`card:${l.machine}:${keyString(l.key)}:${signature}`),
      proofRef: `mock-proof-${digest(signature).slice(0, 12)}`,
      price: l.price,
    };
  }
}
