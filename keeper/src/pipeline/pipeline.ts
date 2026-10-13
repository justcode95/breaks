// The pipeline: drives a funded break through the on-chain steps that need the keeper, from its packs being
// pulled to the draw being recorded.
//
//   Funded ──commit_pool──▶ PoolCommitted ──request_randomness──▶ RandomnessRequested ──settle_randomness──▶ Settled
//   ──claim_free_spot × n──▶ Drawn                                    (ORAO's answer is awaited; repeated on timeout)
//
// Every call to `advance` starts from what the chain says (the `Break` account's status), never from notes of
// its own, so it is safe to call as often as you like and after any crash: a step that already happened is
// simply not the next step any more. The programs refuse a step done out of order, which makes a duplicate
// send harmless; the pipeline additionally waits `resendAfterMs` before repeating a send whose result it could
// not tell.
//
// What it does NOT do: buying packs (the pack buyer), delivering cards (the deliverer), and the steps before
// funding (create, close, eligibility, fund), which belong to the scheduler and the eligibility job.

import { equalBytes } from "../draw/bytes.js";
import { drawFreeWinners } from "../draw/draw.js";
import { poolHash } from "../draw/pool.js";
import { Tree } from "../draw/tree.js";
import type { Logger } from "../job.js";
import { type PackStore } from "../packs/store.js";
import {
  type BreakAccount,
  type BreaksConfigAccount,
  MAX_RANDOMNESS_ATTEMPTS,
  type Programs,
  breakAddress,
  claimFreeSpot,
  commitPool,
  configAddress,
  decodeBreak,
  decodeBreaksConfig,
  decodeRequest,
  drawSeed,
  requestAddress,
  requestId,
  requestRandomness,
  settleRandomness,
} from "../solana/breaks.js";
import type { Instruction } from "../solana/instruction.js";
import { type Address, addressFromBytes, addressToBytes } from "../solana/pubkey.js";
import type { CardTransfer } from "../delivery/transfer.js";
import type { ChainClient, SendResult } from "./chain.js";
import type { EligibilityStore } from "./eligibility-store.js";

export interface ActiveBreak {
  /** `breaks.id` in the database, as text. */
  id: string;
  /** The id used in the program's addresses. */
  onchainId: bigint;
  /** Collector Crypt machine of the break. */
  machine: string;
  /** Status as last mirrored in the database. */
  status: string;
}

/** ORAO's accounts for `request_randomness`. They must be read from ORAO's network state and checked against it. */
export interface VrfAccounts {
  program: Address;
  networkState: Address;
  /** ORAO's fee treasury (a field of its network state). */
  treasury: Address;
  /** ORAO's token-fee accounts, when it charges its fee in ORAO tokens. */
  extra?: { pubkey: Address; writable: boolean }[];
}

export interface PipelineDeps {
  chain: ChainClient;
  programs: Programs;
  /** The keeper wallet: fee payer and the signer the programs expect. */
  keeper: Address;
  vrf: VrfAccounts;
  eligibility: EligibilityStore;
  /** Where the pulled cards are recorded (the pack buyer's notes). */
  packs: PackStore;
  /** Only `ownerOf` is used: the pool is not committed unless the buyer wallet holds every card. */
  cards: Pick<CardTransfer, "ownerOf">;
  log: Logger;
  now(): Date;
  /** How long to wait before repeating a send whose result was unknown. Default 30 s. */
  resendAfterMs?: number;
}

export interface PipelineReport {
  breakId: string;
  chainStatus?: BreakAccount["status"];
  /** What was sent in this call, in order. */
  sent: { step: string; result: SendResult }[];
  /** Waiting for something that is not the pipeline's to do (packs, ORAO, funding, a send to settle). */
  waiting?: string;
  /** Something that needs a human. The pipeline stops on it and tries again next call. */
  problem?: string;
}

type Step = { kind: "go" } | { kind: "wait"; reason: string } | { kind: "problem"; reason: string };

const go: Step = { kind: "go" };
const wait = (reason: string): Step => ({ kind: "wait", reason });
const problem = (reason: string): Step => ({ kind: "problem", reason });

const MAX_HOPS = 40;

export class BreakPipeline {
  private readonly resendAfterMs: number;
  /** Sends whose result was unknown: when they were made. Keyed by the exact step, so a new step is never held back. */
  private readonly unknownSends = new Map<string, number>();

  constructor(private readonly deps: PipelineDeps) {
    this.resendAfterMs = deps.resendAfterMs ?? 30_000;
  }

  /** Does every step that can be done right now, then reports where the break stands. */
  async advance(active: ActiveBreak): Promise<PipelineReport> {
    const report: PipelineReport = { breakId: active.id, sent: [] };
    try {
      for (let hop = 0; hop < MAX_HOPS; hop++) {
        const read = await this.read(active);
        if (read.kind === "problem") return { ...report, problem: read.reason };
        report.chainStatus = read.b.status;
        const step = await this.next(active, read.b, read.config, report);
        if (step.kind === "go") continue;
        if (step.kind === "wait") report.waiting = step.reason;
        else report.problem = step.reason;
        return report;
      }
      report.problem = "too many steps in one call; something is looping";
    } catch (err) {
      // A bad RPC answer or a surprising account must not crash the job; the next call starts again from the chain.
      const message = err instanceof Error ? err.message : String(err);
      this.deps.log.error("pipeline step failed", { break: active.id, error: message });
      report.problem = message;
    }
    return report;
  }

  private async read(active: ActiveBreak): Promise<
    | { kind: "ok"; b: BreakAccount; config: BreaksConfigAccount }
    | { kind: "problem"; reason: string }
  > {
    const { chain, programs } = this.deps;
    const [breakData, configData] = await Promise.all([
      chain.getAccountData(breakAddress(programs, active.onchainId)),
      chain.getAccountData(configAddress(programs)),
    ]);
    if (!breakData) return { kind: "problem", reason: `break ${active.onchainId} does not exist on-chain` };
    if (!configData) return { kind: "problem", reason: "the breaks program is not initialized" };
    return { kind: "ok", b: decodeBreak(breakData), config: decodeBreaksConfig(configData) };
  }

  private async next(active: ActiveBreak, b: BreakAccount, config: BreaksConfigAccount, report: PipelineReport): Promise<Step> {
    switch (b.status) {
      case "Open":
      case "Closed":
      case "EligibilityCommitted":
        return wait(`break is ${b.status}: not funded yet`);
      case "Funded":
        return this.commitPool(active, b, config, report);
      case "PoolCommitted":
        return this.requestFirst(active, b, config, report);
      case "RandomnessRequested":
        return this.settleOrRepeat(active, b, config, report);
      case "Settled":
        return this.claimNext(active, b, report);
      case "Drawn":
        return wait("drawn: ready for delivery");
      case "Cancelled":
        return wait("break was cancelled");
    }
  }

  // ---------------------------------------------------------------- sending

  private async send(active: ActiveBreak, b: BreakAccount, step: string, ix: Instruction, report: PipelineReport): Promise<Step> {
    // The key names the exact step the break is at, so it changes as soon as the chain moves on.
    const key = `${active.onchainId}:${step}:${b.status}:${b.randomnessAttempt}:${b.freeWinnerCount}`;
    const unknownAt = this.unknownSends.get(key);
    if (unknownAt !== undefined && this.deps.now().getTime() - unknownAt < this.resendAfterMs) {
      return wait(`${step}: sent, result unknown; waiting before sending again`);
    }
    const result = await this.deps.chain.sendAndConfirm([ix]);
    report.sent.push({ step, result });
    if (result.outcome === "confirmed") {
      this.unknownSends.delete(key);
      this.deps.log.info("pipeline step done", { break: active.id, step, signature: result.signature });
      return go;
    }
    if (result.outcome === "unknown") {
      this.unknownSends.set(key, this.deps.now().getTime());
      return wait(`${step}: result unknown (${result.reason})`);
    }
    this.deps.log.error("pipeline step failed on-chain", { break: active.id, step, reason: result.reason });
    return problem(`${step} failed: ${result.reason}`);
  }

  // ---------------------------------------------------------------- Funded → PoolCommitted

  private async commitPool(active: ActiveBreak, b: BreakAccount, config: BreaksConfigAccount, report: PipelineReport): Promise<Step> {
    const { packs, cards, programs, keeper } = this.deps;
    const rows = await packs.listForBreak(active.id);
    const failed = rows.filter((r) => r.status === "failed");
    if (failed.length > 0) {
      return problem(`${failed.length} pack(s) failed for good (${failed.map((r) => r.key.index).join(", ")}); the partial-failure policy decides what happens`);
    }
    const pulled = rows.filter((r) => r.status === "pulled" && r.cardMint);
    if (rows.length < b.poolSize || pulled.length < b.poolSize) {
      return wait(`packs: ${pulled.length}/${b.poolSize} pulled`);
    }
    if (rows.length !== b.poolSize) return problem(`${rows.length} packs recorded but the pool has ${b.poolSize}`);

    const mints = pulled.map((r) => r.cardMint as Address);
    if (new Set(mints).size !== mints.length) return problem("two packs report the same card");
    // The pool cannot be changed once committed, so make sure every card is really in the buyer wallet first.
    for (const mint of mints) {
      const owner = await cards.ownerOf(mint);
      if (owner !== config.buyer) return problem(`card ${mint} is held by ${owner ?? "nobody found"}, not by the buyer wallet`);
    }
    const hash = poolHash(mints.map(addressToBytes));
    return this.send(active, b, "commit_pool", commitPool(programs, { keeper, breakId: active.onchainId, poolHash: hash, poolSize: b.poolSize }), report);
  }

  // ---------------------------------------------------------------- PoolCommitted / RandomnessRequested

  private vrfMatches(config: BreaksConfigAccount): string | undefined {
    return config.randomnessProgram === this.deps.vrf.program
      ? undefined
      : `the program is set to use ${config.randomnessProgram} for randomness but the keeper is configured for ${this.deps.vrf.program}`;
  }

  private async requestFirst(active: ActiveBreak, b: BreakAccount, config: BreaksConfigAccount, report: PipelineReport): Promise<Step> {
    const mismatch = this.vrfMatches(config);
    if (mismatch) return problem(mismatch);
    return this.sendRequest(active, b, 0, undefined, report);
  }

  private async sendRequest(active: ActiveBreak, b: BreakAccount, attempt: number, previous: Address | undefined, report: PipelineReport): Promise<Step> {
    const { programs, keeper, vrf } = this.deps;
    const seed = requestId(breakAddress(programs, active.onchainId), attempt, b.eligibilityRoot, b.poolHash);
    const ix = requestRandomness(programs, {
      keeper,
      breakId: active.onchainId,
      vrfProgram: vrf.program,
      vrfNetworkState: vrf.networkState,
      vrfTreasury: vrf.treasury,
      seed,
      ...(previous ? { previousRequest: previous } : {}),
      ...(vrf.extra ? { extra: vrf.extra } : {}),
    });
    return this.send(active, b, attempt === 0 ? "request_randomness" : `request_randomness#${attempt}`, ix, report);
  }

  private async settleOrRepeat(active: ActiveBreak, b: BreakAccount, config: BreaksConfigAccount, report: PipelineReport): Promise<Step> {
    const { chain, programs, vrf } = this.deps;
    const mismatch = this.vrfMatches(config);
    if (mismatch) return problem(mismatch);

    const requestAt = requestAddress(vrf.program, b.randomnessRequestId);
    const data = await chain.getAccountData(requestAt);
    if (!data) return problem(`the randomness request account ${requestAt} does not exist`);
    const state = decodeRequest(data, b.randomnessRequestId);

    if (state.state === "fulfilled") {
      // Answered: settle it. An answered request is never replaced.
      const step = await this.send(active, b, "settle_randomness", settleRandomness(programs, { breakId: active.onchainId, request: requestAt }), report);
      if (step.kind !== "go") return step;
      const after = decodeBreak((await chain.getAccountData(breakAddress(programs, active.onchainId))) as Uint8Array);
      if (!equalBytes(after.seed, drawSeed(state.randomness))) {
        return problem("the settled seed is not the hash of ORAO's answer");
      }
      return go;
    }

    const dueAt = b.randomnessRequestedAt + config.randomnessTimeoutSecs;
    const nowSecs = BigInt(Math.floor(this.deps.now().getTime() / 1000));
    if (nowSecs < dueAt) return wait(`randomness requested, ORAO has not answered (repeat possible in ${dueAt - nowSecs}s)`);
    if (b.randomnessAttempt + 1 >= MAX_RANDOMNESS_ATTEMPTS) {
      return problem(`ORAO never answered ${MAX_RANDOMNESS_ATTEMPTS} requests; the admin must switch the randomness program`);
    }
    return this.sendRequest(active, b, b.randomnessAttempt + 1, requestAt, report);
  }

  // ---------------------------------------------------------------- Settled → Drawn

  private async claimNext(active: ActiveBreak, b: BreakAccount, report: PipelineReport): Promise<Step> {
    const { eligibility, programs, keeper } = this.deps;
    const k = b.poolSize - b.spotsSold;
    const leaves = await eligibility.leaves(active.id);
    if (leaves.length === 0) return problem("the eligibility list is not stored");
    const tree = Tree.build(leaves);
    if (!equalBytes(tree.root.hash, b.eligibilityRoot) || tree.root.sum !== b.eligibilityTotalWeight || leaves.length !== b.eligibilityCount) {
      return problem("the stored eligibility list is not the one that was committed on-chain");
    }

    const winners = drawFreeWinners(b.seed, leaves, k);
    // Whoever is already recorded must be who the draw says; otherwise something is wrong with the list or the seed.
    for (let i = 0; i < b.freeWinnerCount; i++) {
      const expected = addressFromBytes((leaves[(winners[i] as (typeof winners)[number]).leafIndex] as (typeof leaves)[number]).wallet);
      if (b.freeWinners[i]?.wallet !== expected) {
        return problem(`recorded free winner ${i} is ${b.freeWinners[i]?.wallet} but the draw says ${expected}`);
      }
    }

    const index = b.freeWinnerCount;
    const winner = winners[index];
    if (!winner) return problem(`no winner ${index} in a draw of ${k}`);
    const leaf = leaves[winner.leafIndex] as (typeof leaves)[number];
    const proof = tree.proof(winner.leafIndex).map((s) => ({ hash: s.sibling.hash, sum: s.sibling.sum, siblingIsLeft: s.siblingIsLeft }));
    const ix = claimFreeSpot(programs, {
      payer: keeper,
      breakId: active.onchainId,
      index,
      wallet: addressFromBytes(leaf.wallet),
      weight: leaf.weight,
      proof,
    });
    return this.send(active, b, `claim_free_spot#${index}`, ix, report);
  }
}
