import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { ed25519 } from "@noble/curves/ed25519.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { serializeInputs } from "../src/eligibility/eligibility.js";
import { type BalanceEvent, twabByOwner } from "../src/eligibility/twab.js";
import { DbPublisher, SqlEligibilityPlanner } from "../src/eligibility/planner.js";
import { compareBytes, hashv, toHex, utf8 } from "../src/draw/bytes.js";
import { poolHash } from "../src/draw/pool.js";
import { type Leaf, Tree } from "../src/draw/tree.js";
import type { JobContext } from "../src/job.js";
import type { AccountReader } from "../src/pipeline/chain.js";
import { PublishExporter, publishJob } from "../src/publish/exporter.js";
import { eligibilityFile, inputsFile, poolFile } from "../src/publish/files.js";
import { DirSink, PublishedMismatch } from "../src/publish/sink.js";
import { SqlPublishStore } from "../src/publish/store.js";
import { type BreakAccount, breakAddress } from "../src/solana/breaks.js";
import { addressToBytes } from "../src/solana/pubkey.js";
import { encodeBreak } from "./support/accounts.js";
import { brk } from "./support/bot.js";
import { addr } from "./support/chain.js";
import { insertBreak, migratedDb } from "./support/db.js";
import { PROGRAMS, logger } from "./support/world.js";

let db: PGlite;
let dir: string;
const sql = { query: (text: string, params?: unknown[]) => db.query(text, params) as never };

beforeAll(async () => {
  db = await migratedDb();
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await db.exec("truncate packs, twab_snapshots, eligibility_lists, published_documents, breaks cascade");
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = await mkdtemp(join(tmpdir(), "publish-test-"));
});

const WEIGHTS: [number, bigint][] = [[7, 30n], [3, 10n], [5, 50n], [9, 5n]];
const leavesOf = (weights = WEIGHTS): Leaf[] => weights.map(([n, w]) => ({ wallet: addressToBytes(addr(n)), weight: w })).sort((a, b) => compareBytes(a.wallet, b.wallet));
const CARDS = [addr(60), addr(40), addr(50)]; // only their count matters: see makeBreak

/** The balance-event record of a break: one per break (the window differs), as the planner would have published it. */
function inputsFor(onchainId: bigint) {
  const start = 1_700_000_000 + Number(onchainId) * 100_000;
  const text = serializeInputs(
    [{ signature: `sig-${onchainId}`, slot: 5n, time: start + 10, owner: addr(1), tokenAccount: addr(2), delta: 100n, balanceAfter: 100n }],
    { start, end: start + 43_200 },
  );
  return { text, hash: hashv(utf8(text)) };
}

/** Where the inputs of a made break are published. */
const inputsPath = (b: { chain: BreakAccount }) => `inputs/${toHex(b.chain.eligibilityInputsHash)}.txt`;

interface Made {
  breakId: string;
  onchainId: bigint;
  chain: BreakAccount;
}

/**
 * A break the keeper has: its row, a stored eligibility list (the wallets in `weights`, inserted in no particular
 * order), its pulled cards, and the account the chain holds for it. `over` changes what the chain says.
 */
async function makeBreak(onchainId: bigint, status: string, over: { weights?: [number, bigint][]; cards?: string[]; chainStatus?: BreakAccount["status"]; chain?: Partial<BreakAccount>; list?: boolean } = {}): Promise<Made> {
  const breakId = await insertBreak(db);
  await db.query("update breaks set onchain_id = $1::bigint, status = $2 where id = $3::bigint", [onchainId.toString(), status, breakId]);
  const leaves = leavesOf(over.weights);
  const inputs = inputsFor(onchainId);
  const inputsHex = toHex(inputs.hash);
  await db.query("insert into published_documents (sha256, content_type, body) values ($1, 'text/plain; charset=utf-8', $2) on conflict do nothing", [inputsHex, inputs.text]);
  if (over.list !== false) {
    const tree = Tree.build(leaves);
    for (const l of [...leaves].reverse()) {
      await db.query("insert into twab_snapshots (break_id, wallet, twab, weight, eligible) values ($1::bigint, $2, $3::numeric, $3::numeric, true)", [breakId, toBase58(l.wallet), l.weight.toString()]);
    }
    // A wallet that is out: never part of the list.
    await db.query("insert into twab_snapshots (break_id, wallet, twab, weight, eligible, reason) values ($1::bigint, $2, 1, 0, false, 'min_twab')", [breakId, addr(99)]);
    await db.query(
      "insert into eligibility_lists (break_id, root, total_weight, entry_count, inputs_hash, list_uri, inputs_uri) values ($1::bigint, decode($2, 'hex'), $3::numeric, $4, decode($5, 'hex'), 'db:x', $6)",
      [breakId, toHex(tree.root.hash), tree.root.sum.toString(), leaves.length, inputsHex, `db:sha256:${inputsHex}`],
    );
  } else {
    await db.query("insert into eligibility_lists (break_id, root, total_weight, entry_count, inputs_hash, list_uri, inputs_uri) values ($1::bigint, decode($2, 'hex'), 0, 0, decode($3, 'hex'), 'db:x', $4)", [breakId, "00".repeat(32), inputsHex, `db:sha256:${inputsHex}`]);
  }
  // Card mints are unique across breaks, so each break gets its own by default.
  const cards = over.cards ?? CARDS.map((_, i) => addr(120 + Number(onchainId) * 3 + i));
  for (const [i, mint] of cards.entries()) {
    await db.query("insert into packs (break_id, pack_index, status, purchase_sig, card_mint) values ($1::bigint, $2, 'pulled', $3, $4)", [breakId, i, `sig-${breakId}-${i}`, mint]);
  }
  const tree = over.list === false ? undefined : Tree.build(leaves);
  const chain = brk({
    id: onchainId,
    status: over.chainStatus ?? (status === "eligibility_committed" ? "EligibilityCommitted" : "Settled"),
    ...(tree ? { eligibilityRoot: tree.root.hash, eligibilityTotalWeight: tree.root.sum, eligibilityCount: leaves.length } : {}),
    eligibilityInputsHash: inputs.hash,
    poolHash: poolHash(cards.map(addressToBytes)),
    poolSize: cards.length,
    ...over.chain,
  });
  return { breakId, onchainId, chain };
}

// base58 of 32 bytes, through the keeper's own helper
import { addressFromBytes } from "../src/solana/pubkey.js";
const toBase58 = addressFromBytes;

/** A chain that serves the given breaks, and remembers every account it was asked for. */
function chainOf(...made: Made[]) {
  const accounts = new Map(made.map((m) => [breakAddress(PROGRAMS, m.onchainId), encodeBreak(m.chain)]));
  const reads: string[] = [];
  const reader: AccountReader = {
    async getAccountData(a) {
      reads.push(a);
      return accounts.get(a);
    },
  };
  return { reader, reads, accounts };
}

const exporter = (reader: AccountReader) => new PublishExporter({ store: new SqlPublishStore(sql), sink: new DirSink(dir), chain: reader, programs: PROGRAMS });
const files = async (sub: string) => (await readdir(join(dir, sub)).catch(() => [] as string[])).sort();

describe("the format of the published files", () => {
  const leaves = leavesOf([[1, 5n], [2, 7n]]);

  it("pins the bytes of an eligibility file", () => {
    const tree = Tree.build(leaves);
    const root = toHex(tree.root.hash);
    expect(eligibilityFile(tree.root.hash, tree.root.sum, leaves)).toEqual({
      path: `eligibility/${root}.json`,
      body: `{"version":1,"kind":"eligibility","root":"${root}","totalWeight":"12","entryCount":2,"entries":[{"wallet":"${addr(1)}","weight":"5"},{"wallet":"${addr(2)}","weight":"7"}]}\n`,
    });
  });

  it("pins the bytes of a pool file, with the cards sorted by mint whatever order they come in", () => {
    const hash = poolHash([addressToBytes(addr(8)), addressToBytes(addr(2))]);
    const hex = toHex(hash);
    const expected = { path: `pool/${hex}.json`, body: `{"version":1,"kind":"pool","poolHash":"${hex}","cards":["${addr(2)}","${addr(8)}"]}\n` };
    expect(poolFile(hash, [addressToBytes(addr(8)), addressToBytes(addr(2))])).toEqual(expected);
    expect(poolFile(hash, [addressToBytes(addr(2)), addressToBytes(addr(8))])).toEqual(expected);
  });

  it("pins the bytes of an inputs file: the text as the planner wrote it, named by its own SHA-256", () => {
    const text = "breaks:inputs:v1,100,200\nsig-a,5,110," + addr(1) + "," + addr(2) + ",100,100\n";
    const f = inputsFile(text);
    expect(f.body).toBe(text);
    expect(f.path).toBe("inputs/" + createHash("sha256").update(text, "utf8").digest("hex") + ".txt");
    // Not a hash of anything else: change one character and the name changes.
    expect(inputsFile(text.replace("100,100", "101,101")).path).not.toBe(f.path);
    // Only the text decides the name and the body keeps its newline at the end.
    expect(f.body.endsWith("\n")).toBe(true);
  });

  it("keeps a weight above 2^53 exact", () => {
    const big = 18_446_744_073_709_551_000n;
    const f = eligibilityFile(new Uint8Array(32).fill(1), big, [{ wallet: addressToBytes(addr(1)), weight: big }]);
    expect(JSON.parse(f.body).entries[0].weight).toBe("18446744073709551000");
  });
});

// The files the website's tests read (web/test/published.test.ts): made here by the keeper's own code, so the producer and
// the consumer of the format cannot drift apart. `UPDATE_PUBLISHED_EXAMPLE=1 pnpm --filter keeper test` rewrites them.
describe("the published example the website reads", () => {
  const EXAMPLE = join(import.meta.dirname, "..", "..", "docs", "published-example");
  const leaves = leavesOf([[1, 10n], [2, 30n], [3, 5n], [4, 50n], [5, 20n], [6, 15n]]);
  const cards = [44, 40, 43, 41, 42].map((n) => addressToBytes(addr(n)));
  const tree = Tree.build(leaves);

  // The balance events behind those weights, over a 12-hour window: wallet 1 held 10 all along, 2 bought 60 halfway (30), 3 sold
  // its 10 halfway (5), 4 held 50, 5 held 12 and 8 in two token accounts (20), 6 held 10 and bought 10 more halfway (15). Wallet 7
  // held 1000 all along and is not on the list.
  const WINDOW = { start: 1_800_000_000, end: 1_800_043_200 };
  const MID = WINDOW.start + 21_600;
  const steps: [owner: number, account: number, time: number, delta: bigint][] = [
    [7, 107, WINDOW.start - 3000, 1000n],
    [4, 104, WINDOW.start - 2000, 50n],
    [1, 101, WINDOW.start - 1000, 10n],
    [3, 103, WINDOW.start - 1000, 10n],
    [5, 105, WINDOW.start - 1000, 12n],
    [6, 106, WINDOW.start - 1000, 10n],
    [5, 115, WINDOW.start - 500, 8n],
    [2, 102, MID, 60n],
    [3, 103, MID, -10n],
    [6, 106, MID, 10n],
  ];
  const held = new Map<number, bigint>();
  const events: BalanceEvent[] = steps.map(([owner, account, time, delta], i) => {
    const after = (held.get(account) ?? 0n) + delta;
    held.set(account, after);
    return { signature: `example-sig-${i + 1}`, slot: BigInt(time), time, owner: addr(owner), tokenAccount: addr(account), delta, balanceAfter: after };
  });
  const inputsText = serializeInputs(events, WINDOW);
  const made = [eligibilityFile(tree.root.hash, tree.root.sum, leaves), poolFile(poolHash(cards), cards), inputsFile(inputsText)];

  it("has balance events whose time-weighted average balances are the weights on the list, and one wallet that is not on it", () => {
    const twab = twabByOwner(events, WINDOW);
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => twab.get(addr(n)))).toEqual([10n, 30n, 5n, 50n, 20n, 15n, 1000n]);
    // The list is wallets 1 to 6 with exactly those weights.
    expect(leaves.map((l) => [toBase58(l.wallet), l.weight]).sort()).toEqual([1, 2, 3, 4, 5, 6].map((n) => [addr(n), twab.get(addr(n))]).sort());
    // And the file is named by the hash of its text, which is what the chain's inputs hash is.
    expect(inputsFile(inputsText).path).toBe(`inputs/${toHex(hashv(utf8(inputsText)))}.txt`);
  });

  it("is exactly what the keeper writes for this list and these cards, and nothing else", async () => {
    if (process.env.UPDATE_PUBLISHED_EXAMPLE) {
      await rm(EXAMPLE, { recursive: true, force: true });
      for (const f of made) {
        await mkdir(dirname(join(EXAMPLE, f.path)), { recursive: true });
        await writeFile(join(EXAMPLE, f.path), f.body, "utf8");
      }
    }
    for (const f of made) expect(await readFile(join(EXAMPLE, f.path), "utf8"), f.path).toBe(f.body);
    const found = [
      ...(await readdir(join(EXAMPLE, "eligibility"))).map((n) => `eligibility/${n}`),
      ...(await readdir(join(EXAMPLE, "inputs"))).map((n) => `inputs/${n}`),
      ...(await readdir(join(EXAMPLE, "pool"))).map((n) => `pool/${n}`),
    ].sort();
    expect(found).toEqual(made.map((f) => f.path).sort());
  });
});

describe("publishing a committed eligibility list", () => {
  it("writes the list under the root the chain committed, sorted the way the tree sorts it, and the file hashes back to its name", async () => {
    const b = await makeBreak(4n, "eligibility_committed");
    const report = await exporter(chainOf(b).reader).run();
    const root = toHex(b.chain.eligibilityRoot);
    expect(report).toEqual({ written: [`eligibility/${root}.json`, inputsPath(b)], problems: [] });
    expect(await files("eligibility")).toEqual([`${root}.json`]);

    const text = await readFile(join(dir, "eligibility", `${root}.json`), "utf8");
    const doc = JSON.parse(text);
    expect(doc).toMatchObject({ version: 1, kind: "eligibility", root, totalWeight: "95", entryCount: 4 });
    // Not the wallet that was out (addr 99), and in the tree's order: the file rebuilds the root it is named after.
    expect(doc.entries.map((e: { wallet: string }) => e.wallet)).not.toContain(addr(99));
    const rebuilt = Tree.build(doc.entries.map((e: { wallet: string; weight: string }) => ({ wallet: addressToBytes(e.wallet), weight: BigInt(e.weight) })));
    expect(toHex(rebuilt.root.hash)).toBe(root);
    expect(rebuilt.root.sum).toBe(95n);
    expect(text).toBe(eligibilityFile(b.chain.eligibilityRoot, 95n, leavesOf()).body);
  });

  it("is quiet when run again: nothing is written and the chain is not read", async () => {
    const b = await makeBreak(4n, "eligibility_committed");
    const chain = chainOf(b);
    await exporter(chain.reader).run();
    expect(chain.reads).toHaveLength(1);
    const again = await exporter(chain.reader).run();
    expect(again).toEqual({ written: [], problems: [] });
    expect(chain.reads).toHaveLength(1);
  });

  it("is just as quiet about the cards: a pool already published is not read from the chain again", async () => {
    const b = await makeBreak(4n, "settled");
    const chain = chainOf(b);
    const first = await exporter(chain.reader).run();
    expect(first.written).toHaveLength(3);
    const reads = chain.reads.length;
    expect(await exporter(chain.reader).run()).toEqual({ written: [], problems: [] });
    expect(chain.reads).toHaveLength(reads);
  });

  it("publishes every committed break, newest first, and also a later one on a later run", async () => {
    const first = await makeBreak(0n, "delivered", { weights: [[1, 5n], [2, 5n]] });
    const second = await makeBreak(1n, "eligibility_committed", { weights: [[3, 9n]] });
    const chain = chainOf(first, second);
    const report = await exporter(chain.reader).run();
    expect(report.problems).toEqual([]);
    // Newest first (the first break is delivered, so its cards are published too).
    expect(report.written.filter((p) => p.startsWith("eligibility/"))).toEqual([`eligibility/${toHex(second.chain.eligibilityRoot)}.json`, `eligibility/${toHex(first.chain.eligibilityRoot)}.json`]);
    expect(report.written).toHaveLength(5);
    expect((await files("eligibility")).length).toBe(2);
    const third = await makeBreak(2n, "funded", { weights: [[4, 1n], [5, 2n]] });
    const later = await exporter(chainOf(first, second, third).reader).run();
    expect(later.written).toEqual([`eligibility/${toHex(third.chain.eligibilityRoot)}.json`, inputsPath(third)]);
  });

  it("publishes no list for an empty one, only the record of the inputs behind it (which is where to see why nobody is on it)", async () => {
    const b = await makeBreak(4n, "eligibility_committed", { list: false, cards: [] });
    const chain = chainOf(b);
    expect(await exporter(chain.reader).run()).toEqual({ written: [inputsPath(b)], problems: [] });
    expect(chain.reads).toHaveLength(1);
    expect(await files("eligibility")).toEqual([]);
  });

  it("leaves alone a break that has not committed its list yet, and one that was cancelled", async () => {
    const open = await makeBreak(1n, "open");
    const closed = await makeBreak(2n, "closed");
    const cancelled = await makeBreak(3n, "cancelled");
    const scheduled = await makeBreak(4n, "scheduled");
    const chain = chainOf(open, closed, cancelled, scheduled);
    expect(await exporter(chain.reader).run()).toEqual({ written: [], problems: [] });
    expect(chain.reads).toEqual([]);
  });

  it("leaves alone a break the keeper has not created on chain", async () => {
    const b = await makeBreak(4n, "eligibility_committed");
    await db.query("update breaks set onchain_id = null where id = $1::bigint", [b.breakId]);
    const chain = chainOf(b);
    expect(await exporter(chain.reader).run()).toEqual({ written: [], problems: [] });
    expect(chain.reads).toEqual([]);
  });
});

describe("a list that is not what the chain committed is never published", () => {
  it("refuses a list whose weights were changed after the commit, and says so", async () => {
    const b = await makeBreak(4n, "eligibility_committed");
    await db.query("update twab_snapshots set weight = weight + 1 where break_id = $1::bigint and wallet = $2", [b.breakId, addr(3)]);
    const report = await exporter(chainOf(b).reader).run();
    expect(report.written).toEqual([inputsPath(b)]);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]?.breakId).toBe(b.breakId);
    expect(report.problems[0]?.message).toMatch(/is not what was committed on chain/);
    expect(await files("eligibility")).toEqual([]);
  });

  it("refuses a list with a wallet missing, with one extra, and one with another total", async () => {
    for (const [i, change] of [
      (id: string) => db.query("delete from twab_snapshots where break_id = $1::bigint and wallet = $2", [id, addr(9)]),
      (id: string) => db.query("insert into twab_snapshots (break_id, wallet, twab, weight, eligible) values ($1::bigint, $2, 1, 1, true)", [id, addr(77)]),
      (id: string) => db.query("update twab_snapshots set weight = 31, twab = 31 where break_id = $1::bigint and wallet = $2", [id, addr(7)]),
    ].entries()) {
      await db.exec("truncate packs, twab_snapshots, eligibility_lists, published_documents, breaks cascade");
      // A break of its own each time: the directory keeps the record of the inputs the one before published.
      const b = await makeBreak(BigInt(4 + i), "eligibility_committed");
      await change(b.breakId);
      const report = await exporter(chainOf(b).reader).run();
      expect(report.written).toEqual([inputsPath(b)]);
      expect(report.problems[0]?.message).toMatch(/not what was committed on chain/);
    }
  });

  it("refuses when the chain says another root, count or total, even if the stored list is consistent", async () => {
    for (const [i, chain] of ([
      { eligibilityRoot: new Uint8Array(32).fill(5) },
      { eligibilityCount: 5 },
      { eligibilityTotalWeight: 96n },
    ] as Partial<BreakAccount>[]).entries()) {
      await db.exec("truncate packs, twab_snapshots, eligibility_lists, published_documents, breaks cascade");
      const b = await makeBreak(BigInt(4 + i), "eligibility_committed", { chain });
      const report = await exporter(chainOf(b).reader).run();
      expect(report.written, JSON.stringify(Object.keys(chain))).toEqual([inputsPath(b)]);
      expect(report.problems[0]?.message).toMatch(/not what was committed on chain/);
    }
  });

  it("refuses to publish an empty list when the chain says a list was committed", async () => {
    const b = await makeBreak(4n, "eligibility_committed");
    await db.query("delete from twab_snapshots where break_id = $1::bigint", [b.breakId]);
    const report = await exporter(chainOf(b).reader).run();
    expect(report.written).toEqual([inputsPath(b)]);
    expect(report.problems[0]?.message).toBe("the stored eligibility list is empty but a list was committed");
  });

  it("reports a break with no account on chain, and one whose account is another break", async () => {
    const b = await makeBreak(4n, "eligibility_committed");
    const none = await exporter({ async getAccountData() { return undefined; } }).run();
    expect(none.problems[0]?.message).toBe("break 4 has no account on chain");
    const wrong = chainOf(b);
    wrong.accounts.set(breakAddress(PROGRAMS, 4n), encodeBreak({ ...b.chain, id: 5n }));
    expect((await exporter(wrong.reader).run()).problems[0]?.message).toBe("the account for break 4 says it is break 5");
    expect(await files("eligibility")).toEqual([]);
  });

  it("goes on with the other breaks when one has a problem, and reports it on every run", async () => {
    const bad = await makeBreak(1n, "eligibility_committed", { chain: { eligibilityCount: 9 } });
    const good = await makeBreak(2n, "eligibility_committed", { weights: [[1, 4n]] });
    const chain = chainOf(bad, good);
    const first = await exporter(chain.reader).run();
    // Newest first. The bad break's list is held back, its (consistent) record of the inputs is not.
    expect(first.written).toEqual([`eligibility/${toHex(good.chain.eligibilityRoot)}.json`, inputsPath(good), inputsPath(bad)]);
    expect(first.problems.map((p) => p.breakId)).toEqual([bad.breakId]);
    const second = await exporter(chain.reader).run();
    expect(second.written).toEqual([]);
    expect(second.problems.map((p) => p.breakId)).toEqual([bad.breakId]);
  });
});

describe("publishing the balance events behind the weights", () => {
  it("writes the text the planner stored under the inputs hash the chain committed, and the file hashes back to its name", async () => {
    const b = await makeBreak(4n, "eligibility_committed");
    const report = await exporter(chainOf(b).reader).run();
    const name = inputsPath(b);
    expect(report.problems).toEqual([]);
    expect(report.written).toContain(name);
    expect(await files("inputs")).toEqual([name.replace("inputs/", "")]);
    const text = await readFile(join(dir, name), "utf8");
    expect(text).toBe(inputsFor(4n).text);
    expect(text.startsWith("breaks:inputs:v1,")).toBe(true);
    expect(createHash("sha256").update(text, "utf8").digest("hex")).toBe(toHex(b.chain.eligibilityInputsHash));
    expect(inputsFile(text).path).toBe(name);
  });

  it("does not wait for the seed: it is there from the committed list on, like the list itself", async () => {
    const b = await makeBreak(4n, "eligibility_committed");
    expect((await exporter(chainOf(b).reader).run()).written).toContain(inputsPath(b));
  });

  it("refuses when the chain committed another inputs hash than the keeper stored", async () => {
    const b = await makeBreak(4n, "eligibility_committed", { chain: { eligibilityInputsHash: new Uint8Array(32).fill(9) } });
    const report = await exporter(chainOf(b).reader).run();
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]?.message).toMatch(/record of the inputs \(hash [0-9a-f]{64}\) is not what was committed on chain \(inputs hash (?:09){32}\); nothing was published$/);
    expect(await files("inputs")).toEqual([]);
    // The list is its own step and is still published.
    expect(report.written).toEqual([`eligibility/${toHex(b.chain.eligibilityRoot)}.json`]);
  });

  it("refuses when the keeper's stored inputs hash is not the one on chain, even though the stored text matches it", async () => {
    const b = await makeBreak(4n, "eligibility_committed");
    await db.query("update eligibility_lists set inputs_hash = decode($2, 'hex') where break_id = $1::bigint", [b.breakId, "22".repeat(32)]);
    const report = await exporter(chainOf(b).reader).run();
    expect(report.problems[0]?.message).toMatch(/not what was committed on chain/);
    expect(await files("inputs")).toEqual([]);
  });

  it("refuses a text that was changed after the commit: it no longer hashes to what the chain committed", async () => {
    const b = await makeBreak(4n, "eligibility_committed");
    await db.query("update published_documents set body = body || 'extra,line\n' where sha256 = $1", [toHex(b.chain.eligibilityInputsHash)]);
    const report = await exporter(chainOf(b).reader).run();
    expect(report.problems[0]?.message).toBe(`the stored record of the inputs does not hash to the inputs hash committed on chain (${toHex(b.chain.eligibilityInputsHash)}); nothing was published`);
    expect(await files("inputs")).toEqual([]);
  });

  it("reports a text that cannot be read, whether it was never stored or lives somewhere this store cannot read", async () => {
    const missing = await makeBreak(4n, "eligibility_committed");
    await db.query("delete from published_documents where sha256 = $1", [toHex(missing.chain.eligibilityInputsHash)]);
    expect((await exporter(chainOf(missing).reader).run()).problems[0]?.message).toBe("the stored record of the inputs cannot be read, though its hash was committed");

    await db.exec("truncate packs, twab_snapshots, eligibility_lists, published_documents, breaks cascade");
    const elsewhere = await makeBreak(5n, "eligibility_committed");
    await db.query("update eligibility_lists set inputs_uri = 'ipfs://somewhere' where break_id = $1::bigint", [elsewhere.breakId]);
    expect((await exporter(chainOf(elsewhere).reader).run()).problems[0]?.message).toBe("the stored record of the inputs cannot be read, though its hash was committed");
    expect(await files("inputs")).toEqual([]);
  });

  it("reads the break's account once for the list, the inputs and the cards, and says a missing account once", async () => {
    const b = await makeBreak(4n, "settled");
    const chain = chainOf(b);
    const report = await exporter(chain.reader).run();
    expect(report.written).toHaveLength(3);
    expect(chain.reads).toHaveLength(1);

    await db.exec("truncate packs, twab_snapshots, eligibility_lists, published_documents, breaks cascade");
    const gone = await makeBreak(6n, "settled");
    let asked = 0;
    const none = await exporter({ async getAccountData() { asked++; return undefined; } }).run();
    expect(none.problems.map((p) => p.message)).toEqual(["break 6 has no account on chain"]);
    expect(none.problems[0]?.breakId).toBe(gone.breakId);
    expect(asked).toBe(1);
  });

  it("publishes nothing, and reads nothing, for a break the keeper marks committed but holds no list for", async () => {
    const b = await makeBreak(4n, "eligibility_committed");
    await db.query("delete from eligibility_lists where break_id = $1::bigint", [b.breakId]);
    const chain = chainOf(b);
    expect(await exporter(chain.reader).run()).toEqual({ written: [], problems: [] });
    expect(chain.reads).toEqual([]);
    expect(await files("inputs")).toEqual([]);
  });

  it("keeps the record of one break apart from another's, since the window and so the text differ", async () => {
    const first = await makeBreak(0n, "delivered");
    const second = await makeBreak(1n, "delivered");
    expect(inputsPath(first)).not.toBe(inputsPath(second));
    const report = await exporter(chainOf(first, second).reader).run();
    expect(report.problems).toEqual([]);
    expect((await files("inputs")).length).toBe(2);
  });
});

describe("what the real planner stores is what gets published", () => {
  it("publishes, byte for byte, the balance events the planner committed to, and the list it built from them", async () => {
    // Real wallets (on the curve): program-derived addresses are never eligible.
    const wallet = (n: number) => addressFromBytes(ed25519.getPublicKey(new Uint8Array(32).fill(n)));
    const START = 1_000_000;
    const WINDOW = { start: START, end: START + 86_400 };
    await db.query("delete from balance_events");
    await db.query("delete from exclusions");
    const [a, b] = [wallet(11), wallet(12)];
    for (const [owner, account, time, after, sig] of [[a, "acct-a", START - 500, 1000n, "sig-a"], [b, "acct-b", START + 43_200, 1000n, "sig-b"]] as const) {
      await db.query(
        "insert into balance_events (signature, slot, block_time, owner, token_account, delta, balance_after) values ($1, $2, to_timestamp($3), $4, $5, $6::numeric, $6::numeric)",
        [sig, time, time, owner, account, after.toString()],
      );
    }
    await db.query("insert into indexer_state (id, indexed_until) values (1, to_timestamp($1)) on conflict (id) do update set indexed_until = excluded.indexed_until", [WINDOW.end + 1_000]);

    const breakId = await insertBreak(db);
    const plan = await new SqlEligibilityPlanner(sql, new DbPublisher(sql), { policy: { minTwab: 100n }, settleSecs: 120 }).plan(breakId, WINDOW);
    if (plan.kind !== "ready") throw new Error(plan.reason);
    await db.query("update breaks set onchain_id = 7, status = 'eligibility_committed' where id = $1::bigint", [breakId]);

    const account = brk({ id: 7n, status: "EligibilityCommitted", eligibilityRoot: plan.values.root, eligibilityTotalWeight: plan.values.totalWeight, eligibilityCount: plan.values.entryCount, eligibilityInputsHash: plan.values.inputsHash });
    const reader: AccountReader = { getAccountData: async (addrOf) => (addrOf === breakAddress(PROGRAMS, 7n) ? encodeBreak(account) : undefined) };
    const report = await exporter(reader).run();

    const events = [
      { signature: "sig-a", slot: BigInt(START - 500), time: START - 500, owner: a, tokenAccount: "acct-a", delta: 1000n, balanceAfter: 1000n },
      { signature: "sig-b", slot: BigInt(START + 43_200), time: START + 43_200, owner: b, tokenAccount: "acct-b", delta: 1000n, balanceAfter: 1000n },
    ];
    const text = serializeInputs(events, WINDOW);
    const hex = toHex(plan.values.inputsHash);
    expect(report.problems).toEqual([]);
    expect(report.written).toEqual([`eligibility/${toHex(plan.values.root)}.json`, `inputs/${hex}.txt`]);
    expect(await readFile(join(dir, "inputs", `${hex}.txt`), "utf8")).toBe(text);
    expect(createHash("sha256").update(text, "utf8").digest("hex")).toBe(hex);
    // The list and the record agree: A held 1000 all window, B held 1000 for half of it.
    const list = JSON.parse(await readFile(join(dir, "eligibility", `${toHex(plan.values.root)}.json`), "utf8"));
    expect(Object.fromEntries(list.entries.map((e: { wallet: string; weight: string }) => [e.wallet, e.weight]))).toEqual({ [a]: "1000", [b]: "500" });
    await db.query("delete from balance_events");
  });
});

describe("publishing the cards", () => {
  it("writes the pool under the pool hash once the seed is final, and the file hashes back to its name", async () => {
    const b = await makeBreak(4n, "settled", { cards: [addr(60), addr(40), addr(50)] });
    const report = await exporter(chainOf(b).reader).run();
    const hash = toHex(b.chain.poolHash);
    expect(report.problems).toEqual([]);
    expect(report.written).toContain(`pool/${hash}.json`);
    const text = await readFile(join(dir, "pool", `${hash}.json`), "utf8");
    const doc = JSON.parse(text);
    expect(doc).toMatchObject({ version: 1, kind: "pool", poolHash: hash });
    expect(toHex(poolHash(doc.cards.map(addressToBytes)))).toBe(hash);
    // Sorted by mint, not in pack order.
    expect(doc.cards).toEqual([addr(40), addr(50), addr(60)]);
    expect(text).toBe(poolFile(b.chain.poolHash, [addr(60), addr(40), addr(50)].map(addressToBytes)).body);
  });

  it("publishes the cards of a drawn and of a delivered break too", async () => {
    const drawn = await makeBreak(1n, "drawn", { chainStatus: "Drawn", cards: [addr(41), addr(42)] });
    const delivered = await makeBreak(2n, "delivered", { chainStatus: "Drawn", cards: [addr(43), addr(44)] });
    const report = await exporter(chainOf(drawn, delivered).reader).run();
    expect(report.problems).toEqual([]);
    expect((await files("pool")).length).toBe(2);
  });

  it("does not publish the cards before the seed is final, not even those of a funded break", async () => {
    for (const status of ["eligibility_committed", "funded", "pool_committed", "randomness_requested"]) {
      await db.exec("truncate packs, twab_snapshots, eligibility_lists, published_documents, breaks cascade");
      const b = await makeBreak(4n, status);
      await exporter(chainOf(b).reader).run();
      expect(await files("pool"), status).toEqual([]);
    }
  });

  it("does not publish when the database is ahead of the chain", async () => {
    const b = await makeBreak(4n, "settled", { chainStatus: "PoolCommitted" });
    const report = await exporter(chainOf(b).reader).run();
    expect(report.problems[0]?.message).toMatch(/PoolCommitted on chain, not yet settled/);
    expect(await files("pool")).toEqual([]);
  });

  it("refuses cards that are not the pool the chain committed", async () => {
    const wrongHash = await makeBreak(1n, "settled", { chain: { poolHash: new Uint8Array(32).fill(3) } });
    const wrongSize = await makeBreak(2n, "settled", { cards: [addr(70), addr(71)], chain: { poolSize: 3 } });
    const report = await exporter(chainOf(wrongHash, wrongSize).reader).run();
    expect(report.problems.map((p) => p.breakId).sort()).toEqual([wrongHash.breakId, wrongSize.breakId].sort());
    for (const p of report.problems) expect(p.message).toMatch(/not the pool that was committed on chain/);
    expect(await files("pool")).toEqual([]);
  });

  it("counts only the packs that were pulled, even one that was given up after a card was seen", async () => {
    for (const change of ["status = 'confirmed', card_mint = null", "status = 'failed'"]) {
      await db.exec("truncate packs, twab_snapshots, eligibility_lists, published_documents, breaks cascade");
      const b = await makeBreak(4n, "settled");
      await db.query(`update packs set ${change} where break_id = $1::bigint and pack_index = 2`, [b.breakId]);
      const report = await exporter(chainOf(b).reader).run();
      expect(report.problems[0]?.message, change).toMatch(/not the pool that was committed on chain/);
      expect(await files("pool"), change).toEqual([]);
    }
  });

  it("publishes the list even when the cards have a problem, and says what the problem is", async () => {
    const b = await makeBreak(4n, "settled", { chain: { poolSize: 99 } });
    const report = await exporter(chainOf(b).reader).run();
    expect(report.written).toEqual([`eligibility/${toHex(b.chain.eligibilityRoot)}.json`, inputsPath(b)]);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]?.message).toMatch(/not the pool/);
  });

  it("publishes the cards even when the list has a problem, and says what the problem is", async () => {
    const b = await makeBreak(4n, "settled", { chain: { eligibilityCount: 9 } });
    const report = await exporter(chainOf(b).reader).run();
    expect(report.written).toEqual([inputsPath(b), `pool/${toHex(b.chain.poolHash)}.json`]);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]?.message).toMatch(/not what was committed on chain/);
  });

  it("publishes nothing for a break with no cards pulled", async () => {
    const b = await makeBreak(4n, "settled", { cards: [] });
    const report = await exporter(chainOf(b).reader).run();
    expect(report.problems).toEqual([]);
    expect(await files("pool")).toEqual([]);
  });
});

describe("the directory the files go to", () => {
  const file = (n: string, body = "{}\n") => ({ path: `eligibility/${n.repeat(64)}.json`, body });

  it("writes a file, whole, and says it is already there when the same file comes again", async () => {
    const sink = new DirSink(dir);
    expect(await sink.exists(file("a").path)).toBe(false);
    expect(await sink.write(file("a", "one\n"))).toBe("written");
    expect(await sink.exists(file("a").path)).toBe(true);
    expect(await sink.write(file("a", "one\n"))).toBe("present");
    expect(await readFile(join(dir, file("a").path), "utf8")).toBe("one\n");
  });

  it("never overwrites a file with something else", async () => {
    const sink = new DirSink(dir);
    await sink.write(file("a", "one\n"));
    await expect(sink.write(file("a", "two\n"))).rejects.toBeInstanceOf(PublishedMismatch);
    expect(await readFile(join(dir, file("a").path), "utf8")).toBe("one\n");
  });

  it("leaves no half-written or temporary file behind", async () => {
    const sink = new DirSink(dir);
    await sink.write(file("b"));
    await sink.write({ path: `pool/${"c".repeat(64)}.json`, body: "x\n" });
    expect(await files("eligibility")).toEqual([`${"b".repeat(64)}.json`]);
    expect(await files("pool")).toEqual([`${"c".repeat(64)}.json`]);
    // A failed write (the folder cannot be made) leaves nothing either.
    await writeFile(join(dir, "blocker"), "x");
    const blocked = new DirSink(join(dir, "blocker"));
    await expect(blocked.write(file("d"))).rejects.toThrow();
    expect(await readdir(dir)).not.toContain("d");
  });

  it("writes a record of the inputs under its own folder, as text", async () => {
    const sink = new DirSink(dir);
    const f = inputsFile("breaks:inputs:v1,1,2\n");
    expect(await sink.write(f)).toBe("written");
    expect(await files("inputs")).toEqual([f.path.replace("inputs/", "")]);
    expect(await readFile(join(dir, f.path), "utf8")).toBe("breaks:inputs:v1,1,2\n");
    expect(await sink.write(f)).toBe("present");
    await expect(sink.write({ path: f.path, body: "other\n" })).rejects.toBeInstanceOf(PublishedMismatch);
  });

  it("only writes the names the formats use, whatever it is asked", async () => {
    const sink = new DirSink(dir);
    for (const path of ["../escape.json", "eligibility/../x.json", "eligibility/short.json", `eligibility/${"A".repeat(64)}.json`, `other/${"a".repeat(64)}.json`, `eligibility/${"a".repeat(64)}.txt`, `inputs/${"a".repeat(64)}.json`, `pool/${"a".repeat(64)}.txt`, `inputs/${"A".repeat(64)}.txt`, `inputs/${"a".repeat(65)}.txt`, `inputs/short.txt`, `/eligibility/${"a".repeat(64)}.json`, `eligibility/${"a".repeat(64)}.json/../../x`]) {
      await expect(sink.write({ path, body: "x" }), path).rejects.toThrow(/not a published file name/);
      await expect(sink.exists(path), path).rejects.toThrow(/not a published file name/);
    }
    await mkdir(join(dir, "ok"), { recursive: true });
    expect(await readdir(dir)).not.toContain("escape.json");
  });
});

describe("the job", () => {
  const ctx = () => {
    const { log, errors } = logger();
    const infos: [string, Record<string, unknown> | undefined][] = [];
    const wrapped = { info: (m: string, e?: Record<string, unknown>) => { infos.push([m, e]); log.info(m, e); }, error: log.error };
    return { ctx: { now: () => new Date(), log: wrapped } as JobContext, infos, errors };
  };

  it("logs what it published and what it could not publish, and keeps its interval", async () => {
    const good = await makeBreak(1n, "eligibility_committed", { weights: [[1, 4n]] });
    const bad = await makeBreak(2n, "eligibility_committed", { chain: { eligibilityCount: 9 } });
    const job = publishJob({ exporter: exporter(chainOf(good, bad).reader), intervalMs: 60_000 });
    expect(job.name).toBe("publish");
    expect(job.intervalMs).toBe(60_000);
    const { ctx: c, infos, errors } = ctx();
    await job.run(c);
    expect(infos).toEqual([
      // The newer break (`bad`) first: its list is held back, its record of the inputs is not.
      ["published", { path: inputsPath(bad) }],
      ["published", { path: `eligibility/${toHex(good.chain.eligibilityRoot)}.json` }],
      ["published", { path: inputsPath(good) }],
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/could not publish a break's lists/);
  });
});
