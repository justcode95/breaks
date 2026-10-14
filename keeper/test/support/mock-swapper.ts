// A pretend SOL -> USDC swap on a MockChain: the wallet's lamports go down and its USDC account goes up when the
// transaction lands. Transactions can land at once, never arrive, revert, or be held until the test lets them land;
// the block height is the test's to move, so a transaction can expire.

import type { Address } from "../../src/solana/pubkey.js";
import type { PreparedSwap, SwapRequest, SwapStatus, Swapper } from "../../src/sweep/swapper.js";
import type { MockChain } from "./mock-chain.js";

export type SwapBehavior = "land" | "drop" | "revert" | "hold";

interface Tx {
  lamports: bigint;
  minUsdcOut: bigint;
  state: "built" | "sent" | "landed" | "failed";
  /** Whether a `hold` is waiting to land. */
  held: boolean;
}

export class MockSwapper implements Swapper {
  public height = 1_000;
  /** Base units of USDC for one whole SOL. */
  public price = 150_000_000n;
  /** What the next submits do; once the list is used up, transactions land. */
  public readonly behaviors: SwapBehavior[] = [];
  public readonly prepared: string[] = [];
  public readonly submitted: string[] = [];
  /** When set, `prepare` returns a swap of this many lamports whatever was asked. */
  public overrideLamports: bigint | undefined;
  /** When set, `prepare` accepts this little USDC whatever was asked. */
  public overrideMin: bigint | undefined;
  /** Runs inside `submit`, before anything lands. */
  public onSubmit: (() => Promise<void>) | undefined;
  private readonly txs = new Map<string, Tx>();
  private serial = 0;

  constructor(
    private readonly chain: MockChain,
    private readonly wallet: Address,
  ) {}

  async quote(lamports: bigint): Promise<bigint> {
    return (lamports * this.price) / 1_000_000_000n;
  }

  async prepare(req: SwapRequest): Promise<PreparedSwap> {
    const signature = `swap-${++this.serial}`;
    const lamports = this.overrideLamports ?? req.lamports;
    const minUsdcOut = this.overrideMin ?? req.minUsdcOut;
    this.txs.set(signature, { lamports, minUsdcOut, state: "built", held: false });
    this.prepared.push(signature);
    return { signature, expiry: String(this.height + 150), payload: `payload:${signature}`, lamportsIn: lamports, minUsdcOut };
  }

  async submit(p: { signature: string; payload: string }): Promise<void> {
    this.submitted.push(p.signature);
    await this.onSubmit?.();
    const tx = this.txs.get(p.signature);
    if (!tx || tx.state === "landed" || tx.state === "failed") return;
    if (tx.state === "sent") return; // already out there; sending it again changes nothing
    tx.state = "sent";
    const behavior = this.behaviors.shift() ?? "land";
    if (behavior === "drop") tx.state = "built"; // never arrived: a later submit may try again
    else if (behavior === "revert") tx.state = "failed";
    else if (behavior === "hold") tx.held = true;
    else this.land(tx);
  }

  /** Lets a held transaction land. */
  release(signature: string): void {
    const tx = this.txs.get(signature);
    if (tx?.held) {
      tx.held = false;
      this.land(tx);
    }
  }

  private land(tx: Tx): void {
    const have = this.chain.solBalances.get(this.wallet) ?? 0n;
    const out = (tx.lamports * this.price) / 1_000_000_000n;
    // The transaction itself refuses to give back less than the floor it was built with.
    if (have < tx.lamports || out < tx.minUsdcOut) {
      tx.state = "failed";
      return;
    }
    this.chain.solBalances.set(this.wallet, have - tx.lamports);
    this.chain.giveUsdc(this.wallet, out);
    tx.state = "landed";
  }

  async status(p: { signature: string; expiry: string }): Promise<SwapStatus> {
    const tx = this.txs.get(p.signature);
    if (tx?.state === "landed") return "landed";
    if (tx?.state === "failed") return "failed";
    return this.height > Number(p.expiry) ? "expired" : "pending";
  }
}
