import { createHash } from "node:crypto";
import type { Address } from "../solana/pubkey.js";
import type { SubmitBehavior } from "../packs/mock-provider.js";
import type { CardTransfer, DeliveryRequest, PreparedTransfer, TransferStatus } from "./transfer.js";

interface Landed {
  request: DeliveryRequest;
  outcome: "confirmed" | "reverted";
}

const BLOCKS_VALID = 150;
const digest = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * A pretend chain for cards: each card has an owner, transfers have a signature before they are sent and a
 * block height after which they cannot land, and a transfer only works if `from` really owns the card (like the
 * token program). Failures are injected with `queueSubmit`, the same behaviours as `MockPackProvider`.
 */
export class MockCardTransfer implements CardTransfer {
  private height = 1_000;
  private seq = 0;
  private readonly owners = new Map<Address, Address>();
  private readonly prepared = new Map<string, { request: DeliveryRequest; expiry: number }>();
  private readonly landed = new Map<string, Landed>();
  private readonly behaviors: SubmitBehavior[] = [];

  public prepareCalls = 0;

  /** Puts a card in a wallet. */
  give(cardMint: Address, owner: Address) {
    this.owners.set(cardMint, owner);
  }

  advanceBlocks(n: number) {
    this.height += n;
  }

  queueSubmit(...behaviors: SubmitBehavior[]) {
    this.behaviors.push(...behaviors);
  }

  /** How many times the card changed wallets. */
  transfersOf(cardMint: Address): number {
    return [...this.landed.values()].filter((l) => l.outcome === "confirmed" && l.request.cardMint === cardMint).length;
  }

  async ownerOf(cardMint: Address): Promise<Address | undefined> {
    return this.owners.get(cardMint);
  }

  async prepare(request: DeliveryRequest): Promise<PreparedTransfer> {
    this.prepareCalls++;
    const signature = `mock-transfer-${this.seq++}-${digest(request.cardMint).slice(0, 8)}`;
    const expiry = this.height + BLOCKS_VALID;
    this.prepared.set(signature, { request, expiry });
    return { request, signature, expiry: String(expiry) };
  }

  async submit(transfer: PreparedTransfer): Promise<void> {
    const p = this.prepared.get(transfer.signature);
    if (!p) throw new Error(`mock: unknown transfer ${transfer.signature}`);
    const behavior = this.behaviors.shift() ?? "land";
    const tooLate = this.height > p.expiry;
    const land = (wanted: Landed["outcome"]) => {
      if (tooLate) return;
      // The token program refuses a transfer from a wallet that does not own the card.
      const ownsIt = this.owners.get(p.request.cardMint) === p.request.from;
      const outcome = wanted === "confirmed" && ownsIt ? "confirmed" : "reverted";
      if (outcome === "confirmed") this.owners.set(p.request.cardMint, p.request.recipient);
      this.landed.set(transfer.signature, { request: p.request, outcome });
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

  async status(signature: string, expiry: string): Promise<TransferStatus> {
    const l = this.landed.get(signature);
    if (l) return l.outcome === "confirmed" ? { state: "confirmed" } : { state: "failed", reason: "mock: reverted" };
    return this.height > Number(expiry) ? { state: "expired" } : { state: "pending" };
  }
}
