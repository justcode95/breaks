// The fee sweep: fee SOL -> USDC -> the treasury.
//
// Two independent steps, each safe to repeat:
//   swap     - if a swapper is configured and the wallet holds SOL above what it keeps, swap at most one capped amount.
//              The swap is saved before it is sent and only one is ever in flight; a new one is prepared only when the
//              chain says the last one landed, reverted or can never land.
//   deposit  - whatever USDC the wallet holds (above a minimum) goes into the treasury with `deposit_fees`. Nothing is
//              remembered: a deposit that landed leaves no USDC to deposit again, and one that did not is simply sent
//              again with the balance that is there. The program splits it between the buckets.
// Anyone can deposit, so the wallet is whatever signs for `chain`; it holds fee money only for as long as these steps take.

import type { Job } from "../job.js";
import type { ChainClient } from "../pipeline/chain.js";
import { associatedTokenAddress, type Address } from "../solana/pubkey.js";
import { decodeTokenAccount } from "../solana/token.js";
import { decodeTreasuryConfig, depositFees, treasuryAddresses } from "../solana/treasury.js";
import { minUsdcOut, swapAmount, type SweepPolicy } from "./policy.js";
import type { SweepStore } from "./store.js";
import type { Swapper } from "./swapper.js";
import type { WalletReader } from "./wallet.js";

export type SwapOutcome =
  | { kind: "off" } // no swapper
  | { kind: "none"; reason: string } // nothing worth swapping
  | { kind: "started"; lamports: bigint; minUsdcOut: bigint; signature: string }
  | { kind: "waiting"; signature: string }
  | { kind: "landed"; signature: string; lamports: bigint }
  | { kind: "failed"; signature: string }
  | { kind: "expired"; signature: string }
  | { kind: "skipped"; reason: string } // the market is not good enough
  | { kind: "backoff" }
  | { kind: "problem"; problem: string };

export type DepositOutcome =
  | { kind: "none"; reason: string }
  | { kind: "deposited"; amount: bigint; signature: string }
  | { kind: "pending"; amount: bigint }
  | { kind: "failed"; amount: bigint; reason: string }
  | { kind: "backoff" }
  | { kind: "problem"; problem: string };

export interface SweepReport {
  swap: SwapOutcome;
  deposit: DepositOutcome;
}

export interface SweeperDeps {
  /** Signs as the sweep wallet. */
  chain: ChainClient;
  /** The treasury program. */
  treasuryProgram: Address;
  /** The wallet that holds the fee SOL and USDC and signs the swap and the deposit. */
  wallet: Address;
  wallets: WalletReader;
  store: SweepStore;
  policy: SweepPolicy;
  /** Absent on devnet: only USDC already in the wallet is deposited. */
  swapper?: Swapper;
  now?: () => Date;
  /** How long to wait after a swap that failed or a deposit that was refused. Default 60 s. */
  retryAfterMs?: number;
}

export class FeeSweeper {
  private readonly now: () => Date;
  private readonly retryAfterMs: number;
  private swapBackoffUntil = 0;
  private depositBackoffUntil = 0;

  constructor(private readonly deps: SweeperDeps) {
    this.now = deps.now ?? (() => new Date());
    this.retryAfterMs = deps.retryAfterMs ?? 60_000;
  }

  async run(): Promise<SweepReport> {
    const { chain, treasuryProgram, wallet } = this.deps;
    const treasury = await chain.getAccountData(treasuryAddresses(treasuryProgram).config);
    if (!treasury) {
      const problem = "the treasury is not initialized";
      return { swap: { kind: "problem", problem }, deposit: { kind: "problem", problem } };
    }
    const ata = associatedTokenAddress(wallet, decodeTreasuryConfig(treasury).usdcMint);
    if (!(await chain.getAccountData(ata))) {
      const problem = `the wallet ${wallet} has no USDC account (${ata}); create it before sweeping`;
      return { swap: { kind: "problem", problem }, deposit: { kind: "problem", problem } };
    }
    // The swap first, so that USDC it just brought in can be deposited in the same run.
    const swap = await this.swap();
    const deposit = await this.deposit(ata);
    return { swap, deposit };
  }

  private async swap(): Promise<SwapOutcome> {
    const { swapper, store, wallets, wallet, policy } = this.deps;
    if (!swapper) return { kind: "off" };

    const open = await store.inFlight();
    if (open) {
      const status = await swapper.status(open);
      switch (status) {
        case "landed":
          await store.resolve(open.id, "landed");
          await store.recordEvent({ kind: "swap", asset: "SOL", amount: open.lamportsIn, txSig: open.signature, note: `at least ${open.minUsdcOut} USDC` });
          return { kind: "landed", signature: open.signature, lamports: open.lamportsIn };
        case "failed":
          await store.resolve(open.id, "failed");
          this.swapBackoffUntil = this.now().getTime() + this.retryAfterMs;
          return { kind: "failed", signature: open.signature };
        case "expired":
          await store.resolve(open.id, "expired");
          this.swapBackoffUntil = this.now().getTime() + this.retryAfterMs;
          return { kind: "expired", signature: open.signature };
        default:
          // Not seen yet. It may never have been sent (a restart between saving and sending), so send the same one again.
          await swapper.submit(open);
          if (open.status === "prepared") await store.markSubmitted(open.id);
          return { kind: "waiting", signature: open.signature };
      }
    }

    const lamports = swapAmount(await wallets.lamports(wallet), policy);
    if (lamports === undefined) return { kind: "none", reason: "no SOL above what the wallet keeps" };
    if (this.now().getTime() < this.swapBackoffUntil) return { kind: "backoff" };

    const quote = await swapper.quote(lamports);
    const min = minUsdcOut(quote, lamports, policy);
    if (!min.ok) return { kind: "skipped", reason: min.reason };

    const prepared = await swapper.prepare({ lamports, minUsdcOut: min.minUsdcOut });
    // The transaction must be the one asked for: this amount, and no looser a floor.
    if (prepared.lamportsIn !== lamports) return { kind: "problem", problem: `the swapper prepared a swap of ${prepared.lamportsIn} lamports, not ${lamports}` };
    if (prepared.minUsdcOut < min.minUsdcOut) return { kind: "problem", problem: `the swapper accepts as little as ${prepared.minUsdcOut} USDC, below the floor of ${min.minUsdcOut}` };

    // Saved before it is sent. Another swap in flight (a second process, say) means this one is not sent.
    const saved = await store.insertPrepared(prepared);
    if (!saved) return { kind: "none", reason: "another swap is in flight" };
    await swapper.submit(prepared);
    await store.markSubmitted(saved.id);
    return { kind: "started", lamports, minUsdcOut: prepared.minUsdcOut, signature: prepared.signature };
  }

  private async deposit(ata: Address): Promise<DepositOutcome> {
    const { chain, treasuryProgram, wallet, store, policy } = this.deps;
    const data = await chain.getAccountData(ata);
    if (!data) return { kind: "problem", problem: `the USDC account ${ata} disappeared` };
    const amount = decodeTokenAccount(data).amount;
    if (amount === 0n || amount < policy.minDeposit) return { kind: "none", reason: "no USDC to deposit" };
    if (this.now().getTime() < this.depositBackoffUntil) return { kind: "backoff" };

    const result = await chain.sendAndConfirm([depositFees(treasuryProgram, { depositor: wallet, depositorUsdc: ata, amount })]);
    switch (result.outcome) {
      case "confirmed":
        await store.recordEvent({ kind: "deposit", asset: "USDC", amount, txSig: result.signature });
        return { kind: "deposited", amount, signature: result.signature };
      case "failed":
        this.depositBackoffUntil = this.now().getTime() + this.retryAfterMs;
        return { kind: "failed", amount, reason: result.reason };
      default:
        // Unknown: the next run reads the balance again. If it landed there is nothing left; if not, it is sent again.
        return { kind: "pending", amount };
    }
  }
}

/** The sweep as a keeper job; it speaks when something happened. */
export function feeSweepJob(opts: { sweeper: FeeSweeper; intervalMs: number }): Job {
  let lastProblem: string | undefined;
  return {
    name: "fee-sweep",
    intervalMs: opts.intervalMs,
    async run(ctx) {
      const { swap, deposit } = await opts.sweeper.run();
      const problems = [swap, deposit].flatMap((o) => (o.kind === "problem" ? [o.problem] : []));
      const problem = problems[0];
      if (problem !== lastProblem) {
        lastProblem = problem;
        if (problem) ctx.log.error("the fee sweep cannot run", { problem });
      }
      switch (swap.kind) {
        case "started":
          ctx.log.info("fee swap sent", { lamports: String(swap.lamports), minUsdcOut: String(swap.minUsdcOut), signature: swap.signature });
          break;
        case "landed":
          ctx.log.info("fee swap landed", { lamports: String(swap.lamports), signature: swap.signature });
          break;
        case "failed":
        case "expired":
          ctx.log.error(`fee swap ${swap.kind}`, { signature: swap.signature });
          break;
        case "skipped":
          ctx.log.info("fee swap skipped", { reason: swap.reason });
          break;
        default:
          break;
      }
      switch (deposit.kind) {
        case "deposited":
          ctx.log.info("fees deposited into the treasury", { amount: String(deposit.amount), signature: deposit.signature });
          break;
        case "pending":
          ctx.log.info("fee deposit sent, result not known yet", { amount: String(deposit.amount) });
          break;
        case "failed":
          ctx.log.error("fee deposit failed", { amount: String(deposit.amount), reason: deposit.reason });
          break;
        default:
          break;
      }
    },
  };
}
