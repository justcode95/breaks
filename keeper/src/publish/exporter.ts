// Publishes a break's eligibility list and card pool as files named by the hashes the chain committed.
//
// A file is written only when the data the keeper holds provably hashes to what the chain (read at `finalized`) says
// was committed: the rebuilt Merkle root, total weight and wallet count for the list, the pool hash and size for the
// cards. A list that does not match is reported and never published. Files are never overwritten, and a run first
// looks for the file by name, so a quiet run reads nothing from the chain.

import { equalBytes, toHex } from "../draw/bytes.js";
import { poolHash } from "../draw/pool.js";
import { Tree } from "../draw/tree.js";
import type { Job } from "../job.js";
import type { AccountReader } from "../pipeline/chain.js";
import { type Programs, breakAddress, decodeBreak } from "../solana/breaks.js";
import { addressToBytes } from "../solana/pubkey.js";
import { eligibilityFile, poolFile } from "./files.js";
import type { FileSink } from "./sink.js";
import type { Candidate, PublishStore } from "./store.js";

export interface PublishReport {
  /** Paths written this run. */
  written: string[];
  /** Breaks where something is wrong, and what. The rest of the breaks are still published. */
  problems: { breakId: string; message: string }[];
}

// Once the seed is final the cards can be published: the draw is settled and the assignment can be checked.
const SEEDED = new Set(["settled", "drawn", "delivered"]);

export interface ExporterDeps {
  store: PublishStore;
  sink: FileSink;
  /** Must read at `finalized`: nothing is published against a commitment that could still roll back. */
  chain: AccountReader;
  programs: Programs;
}

export class PublishExporter {
  constructor(private readonly deps: ExporterDeps) {}

  async run(): Promise<PublishReport> {
    const report: PublishReport = { written: [], problems: [] };
    for (const c of await this.deps.store.candidates()) {
      // Each list is its own step: a problem with the cards must not hold back a list that is fine, and what was
      // written is reported even when the other step failed.
      const errors: string[] = [];
      for (const step of [() => this.eligibility(c), () => this.pool(c)]) {
        try {
          report.written.push(...(await step()));
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err));
        }
      }
      if (errors.length > 0) report.problems.push({ breakId: c.breakId, message: errors.join("; ") });
    }
    return report;
  }

  private async eligibility(c: Candidate): Promise<string[]> {
    // An empty list is a zero root with nothing behind it: there is nothing to publish.
    if (c.entryCount === 0 || c.root === undefined) return [];
    const path = `eligibility/${c.root}.json`;
    if (await this.deps.sink.exists(path)) return [];

    const b = await this.onChain(c);
    const leaves = await this.deps.store.leaves(c.breakId);
    if (leaves.length === 0) throw new Error("the stored eligibility list is empty but a list was committed");
    const tree = Tree.build(leaves);
    if (!equalBytes(tree.root.hash, b.eligibilityRoot) || tree.root.sum !== b.eligibilityTotalWeight || leaves.length !== b.eligibilityCount) {
      throw new Error(
        `the stored eligibility list (root ${toHex(tree.root.hash)}, ${leaves.length} wallets) is not what was committed on chain (root ${toHex(b.eligibilityRoot)}, ${b.eligibilityCount} wallets); nothing was published`,
      );
    }
    return this.write(eligibilityFile(tree.root.hash, tree.root.sum, leaves));
  }

  private async pool(c: Candidate): Promise<string[]> {
    if (!SEEDED.has(c.status) || c.cards.length === 0) return [];
    const mints = c.cards.map(addressToBytes);
    const hash = poolHash(mints);
    if (await this.deps.sink.exists(`pool/${toHex(hash)}.json`)) return [];

    const b = await this.onChain(c);
    if (b.status !== "Settled" && b.status !== "Drawn") throw new Error(`the break is ${b.status} on chain, not yet settled, so its cards are not published`);
    if (!equalBytes(hash, b.poolHash) || mints.length !== b.poolSize) {
      throw new Error(
        `the ${mints.length} stored cards (pool hash ${toHex(hash)}) are not the pool that was committed on chain (pool hash ${toHex(b.poolHash)}, ${b.poolSize} cards); nothing was published`,
      );
    }
    return this.write(poolFile(hash, mints));
  }

  private async onChain(c: Candidate) {
    const data = await this.deps.chain.getAccountData(breakAddress(this.deps.programs, c.onchainId));
    if (!data) throw new Error(`break ${c.onchainId} has no account on chain`);
    const b = decodeBreak(data);
    if (b.id !== c.onchainId) throw new Error(`the account for break ${c.onchainId} says it is break ${b.id}`);
    return b;
  }

  private async write(file: { path: string; body: string }): Promise<string[]> {
    return (await this.deps.sink.write(file)) === "written" ? [file.path] : [];
  }
}

/** Runs the exporter on an interval. A break with a problem is logged on every run until it is dealt with. */
export function publishJob(opts: { exporter: PublishExporter; intervalMs: number }): Job {
  return {
    name: "publish",
    intervalMs: opts.intervalMs,
    async run(ctx) {
      const report = await opts.exporter.run();
      for (const path of report.written) ctx.log.info("published", { path });
      for (const p of report.problems) ctx.log.error("could not publish a break's lists", { breakId: p.breakId, problem: p.message });
    },
  };
}
