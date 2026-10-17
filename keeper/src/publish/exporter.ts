// Publishes a break's eligibility list, the balance events behind it, the record of why each wallet is in or out, its card
// pool and, once every card is delivered, its per-spot ledger, as files named by the hashes the chain committed.
//
// A file is written only when the data the keeper holds provably hashes to what the chain (read at `finalized`) says
// was committed: the rebuilt Merkle root, total weight and wallet count for the list, the SHA-256 of the balance-event
// text for the record of the inputs, the pool hash and size for the cards. The record of why each wallet is in or out has no
// hash of its own on chain, so it must be exactly what the eligibility rules make of the committed balance events (record.ts); nor does
// the ledger, so its packs, cards and spots must agree with the chain and the draw (ledger.ts). Data that does not match is reported and never
// published. Files are never overwritten, and a run first looks for the file by name, so a quiet run reads nothing from
// the chain (and a busy one reads each break once).

import { equalBytes, toHex } from "../draw/bytes.js";
import { poolHash } from "../draw/pool.js";
import { Tree } from "../draw/tree.js";
import type { Job } from "../job.js";
import type { AccountReader } from "../pipeline/chain.js";
import { type BreakAccount, type Programs, type SpotAccount, breakAddress, configAddress, decodeBreak, decodeBreaksConfig, decodeSpot, spotAddress } from "../solana/breaks.js";
import { addressToBytes } from "../solana/pubkey.js";
import { eligibilityFile, inputsFile, ledgerFile, poolFile, recordFile } from "./files.js";
import { type Ledger, buildLedger } from "./ledger.js";
import { checkRecord, parseStoredRecord } from "./record.js";
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
      // Each file is its own step: a problem with the cards must not hold back a list that is fine, and what was
      // written is reported even when another step failed. The break's account is read once for all of them.
      let read: Promise<BreakAccount> | undefined;
      const chain = () => (read ??= this.onChain(c));
      const errors: string[] = [];
      for (const step of [() => this.eligibility(c, chain), () => this.inputs(c, chain), () => this.record(c, chain), () => this.pool(c, chain), () => this.ledger(c, chain)]) {
        try {
          report.written.push(...(await step()));
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err));
        }
      }
      // Steps that hit the same trouble (no account on chain) say it once.
      if (errors.length > 0) report.problems.push({ breakId: c.breakId, message: [...new Set(errors)].join("; ") });
    }
    return report;
  }

  private async eligibility(c: Candidate, chain: () => Promise<BreakAccount>): Promise<string[]> {
    // An empty list is a zero root with nothing behind it: there is nothing to publish.
    if (c.entryCount === 0 || c.root === undefined) return [];
    const path = `eligibility/${c.root}.json`;
    if (await this.deps.sink.exists(path)) return [];

    const b = await chain();
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

  /**
   * The balance events the weights were computed from. Unlike the list it is published even when nobody was eligible: that
   * is exactly when a reader wants to see why. The file is the stored text as it is; what makes it the right one is that its
   * SHA-256 is the `inputs_hash` the chain committed.
   */
  private async inputs(c: Candidate, chain: () => Promise<BreakAccount>): Promise<string[]> {
    if (c.inputsHash === undefined) return [];
    if (await this.deps.sink.exists(`inputs/${c.inputsHash}.txt`)) return [];

    const b = await chain();
    const committed = toHex(b.eligibilityInputsHash);
    if (committed !== c.inputsHash) {
      throw new Error(`the stored record of the inputs (hash ${c.inputsHash}) is not what was committed on chain (inputs hash ${committed}); nothing was published`);
    }
    const text = await this.deps.store.inputsText(c.breakId);
    if (text === undefined) throw new Error("the stored record of the inputs cannot be read, though its hash was committed");
    const file = inputsFile(text);
    if (file.path !== `inputs/${committed}.txt`) {
      throw new Error(`the stored record of the inputs does not hash to the inputs hash committed on chain (${committed}); nothing was published`);
    }
    return this.write(file);
  }

  /**
   * Every wallet's average balance, weight and reason, with the minimum and the cap. Like the balance events it is published
   * also when nobody was eligible, and under the same inputs hash. It goes out only if it is exactly what the rules make of the
   * committed balance events and the wallets it calls eligible rebuild the committed root (`checkRecord`).
   */
  private async record(c: Candidate, chain: () => Promise<BreakAccount>): Promise<string[]> {
    if (c.inputsHash === undefined) return [];
    if (await this.deps.sink.exists(`records/${c.inputsHash}.json`)) return [];

    const b = await chain();
    const committed = toHex(b.eligibilityInputsHash);
    if (committed !== c.inputsHash) {
      // The same words as the balance events' own step: it is the same fault, and the report says it once.
      throw new Error(`the stored record of the inputs (hash ${c.inputsHash}) is not what was committed on chain (inputs hash ${committed}); nothing was published`);
    }
    const body = await this.deps.store.recordText(c.breakId);
    if (body === undefined) throw new Error("the stored eligibility record cannot be read, though its list was committed");
    const text = await this.deps.store.inputsText(c.breakId);
    if (text === undefined) throw new Error("the stored record of the inputs cannot be read, though its hash was committed");
    const record = parseStoredRecord(body);
    try {
      checkRecord(record, text, b);
    } catch (err) {
      throw new Error(`${err instanceof Error ? err.message : String(err)}; nothing was published`);
    }
    return this.write(recordFile(record));
  }

  private async pool(c: Candidate, chain: () => Promise<BreakAccount>): Promise<string[]> {
    if (!SEEDED.has(c.status) || c.cards.length === 0) return [];
    const mints = c.cards.map(addressToBytes);
    const hash = poolHash(mints);
    if (await this.deps.sink.exists(`pool/${toHex(hash)}.json`)) return [];

    const b = await chain();
    if (b.status !== "Settled" && b.status !== "Drawn") throw new Error(`the break is ${b.status} on chain, not yet settled, so its cards are not published`);
    if (!equalBytes(hash, b.poolHash) || mints.length !== b.poolSize) {
      throw new Error(
        `the ${mints.length} stored cards (pool hash ${toHex(hash)}) are not the pool that was committed on chain (pool hash ${toHex(b.poolHash)}, ${b.poolSize} cards); nothing was published`,
      );
    }
    return this.write(poolFile(hash, mints));
  }

  /**
   * The per-spot ledger, once every card is delivered. It goes out only if the packs, their cards and every spot's wallet and
   * card agree with the chain and the draw (`buildLedger`); the spots and the buyer wallet are read at `finalized` too.
   */
  private async ledger(c: Candidate, chain: () => Promise<BreakAccount>): Promise<string[]> {
    if (c.status !== "delivered" || c.cards.length === 0) return [];
    if (await this.deps.sink.exists(`ledger/${toHex(poolHash(c.cards.map(addressToBytes)))}.json`)) return [];

    const b = await chain();
    const { programs } = this.deps;
    const config = await this.deps.chain.getAccountData(configAddress(programs));
    if (!config) throw new Error("the breaks program has no config account on chain");
    const breakKey = breakAddress(programs, b.id);
    const paidSpots: SpotAccount[] = [];
    for (let i = 0; i < b.spotsSold; i++) {
      const data = await this.deps.chain.getAccountData(spotAddress(programs, breakKey, i));
      if (!data) throw new Error(`spot ${i} of break ${b.id} has no account on chain`);
      paidSpots.push(decodeSpot(data));
    }
    const { packs, deliveries } = await this.deps.store.ledger(c.breakId);
    let ledger: Ledger;
    try {
      ledger = buildLedger({ chain: b, buyer: decodeBreaksConfig(config).buyer, paidSpots, packs, deliveries });
    } catch (err) {
      throw new Error(`the ledger does not add up: ${err instanceof Error ? err.message : String(err)}; nothing was published`);
    }
    return this.write(ledgerFile(ledger));
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
