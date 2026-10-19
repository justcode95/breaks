import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { ed25519 } from "@noble/curves/ed25519.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildEligibility, serializeInputs } from "../src/eligibility/eligibility.js";
import { type BalanceEvent, twabByOwner } from "../src/eligibility/twab.js";
import { DbPublisher, SqlEligibilityPlanner, listDocument } from "../src/eligibility/planner.js";
import { checkExclusions, exclusionsDocument, parseExclusions } from "../src/eligibility/exclusions.js";
import { compareBytes, hashv, toHex, utf8 } from "../src/draw/bytes.js";
import { drawFreeWinners } from "../src/draw/draw.js";
import { assignCards, poolHash } from "../src/draw/pool.js";
import { type Leaf, Tree } from "../src/draw/tree.js";
import type { JobContext } from "../src/job.js";
import type { AccountReader } from "../src/pipeline/chain.js";
import { PublishExporter, publishJob } from "../src/publish/exporter.js";
import { buildDeliveryPlan } from "../src/delivery/plan.js";
import { eligibilityFile, exclusionsFile, inputsFile, ledgerFile, poolFile, recordFile } from "../src/publish/files.js";
import { buildLedger } from "../src/publish/ledger.js";
import { checkRecord, parseStoredRecord } from "../src/publish/record.js";
import { parseInputsText } from "../src/eligibility/inputs-text.js";
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

/** A holder's wallet: a real public key, so on the curve (the rules leave out program-derived addresses, which are not). */
const holder = (n: number) => addressFromBytes(ed25519.getPublicKey(new Uint8Array(32).fill(n)));
const WEIGHTS: [number, bigint][] = [[7, 30n], [3, 10n], [5, 50n], [9, 5n]];
const leavesOf = (weights = WEIGHTS, who: (n: number) => string = addr): Leaf[] =>
  weights.map(([n, w]) => ({ wallet: addressToBytes(who(n)), weight: w })).sort((a, b) => compareBytes(a.wallet, b.wallet));
const CARDS = [addr(60), addr(40), addr(50)]; // only their count matters: see makeBreak
/** The rules the helper's breaks were made with: a wallet needs an average of 2 to be on the list. */
const POLICY = { minTwab: 2n };
/** The holder who is out: an average balance of 1, below the minimum. */
const OUT = 99;
/** A team wallet on the exclusion list that holds none of the token: the record does not name it, the exclusion list does. */
const TEAM = 77;

/**
 * The balance events of a break: one per break (the window differs), as the planner would have published it. Each holder in
 * `weights` holds its weight from before the window opens, so its average balance is its weight; holder 99 holds 1.
 */
function inputsFor(onchainId: bigint, weights = WEIGHTS) {
  const start = 1_700_000_000 + Number(onchainId) * 100_000;
  const window = { start, end: start + 43_200 };
  const events: BalanceEvent[] = [...weights, [OUT, 1n] as [number, bigint]].map(([n, w], i) => ({
    signature: `sig-${onchainId}-${i}`,
    slot: BigInt(start - 100 + i),
    time: start - 100 + i,
    owner: holder(n),
    tokenAccount: addr(200 + i),
    delta: w,
    balanceAfter: w,
  }));
  const text = serializeInputs(events, window);
  return { text, hash: hashv(utf8(text)), events, window };
}

/** Where the inputs of a made break are published. */
const inputsPath = (b: { chain: BreakAccount }) => `inputs/${toHex(b.chain.eligibilityInputsHash)}.txt`;
/** Where the record of why each wallet is in or out is published: under the same inputs hash. */
const recordPath = (b: { chain: BreakAccount }) => `records/${toHex(b.chain.eligibilityInputsHash)}.json`;
/** Where the exclusion list the list was made with is published: under the same inputs hash too. */
const exclusionsPath = (b: { chain: BreakAccount }) => `exclusions/${toHex(b.chain.eligibilityInputsHash)}.json`;

interface Made {
  breakId: string;
  onchainId: bigint;
  chain: BreakAccount;
}

/**
 * A break the keeper has: its row, a stored eligibility list (the wallets in `weights`, inserted in no particular
 * order), its pulled cards, and the account the chain holds for it. `over` changes what the chain says.
 */
async function makeBreak(
  onchainId: bigint,
  status: string,
  over: { weights?: [number, bigint][]; cards?: string[]; chainStatus?: BreakAccount["status"]; chain?: Partial<BreakAccount>; list?: boolean; exclusions?: [number, string][] | "none" } = {},
): Promise<Made> {
  const breakId = await insertBreak(db);
  await db.query("update breaks set onchain_id = $1::bigint, status = $2 where id = $3::bigint", [onchainId.toString(), status, breakId]);
  const leaves = leavesOf(over.weights, holder);
  const inputs = inputsFor(onchainId, over.list === false ? [] : over.weights);
  const inputsHex = toHex(inputs.hash);
  await db.query("insert into published_documents (sha256, content_type, body) values ($1, 'text/plain; charset=utf-8', $2) on conflict do nothing", [inputsHex, inputs.text]);
  // The record of why each wallet is in or out, as the planner stores it.
  const eligibility = buildEligibility({ events: inputs.events, window: inputs.window, policy: POLICY, exclusions: new Map() });
  const listTree = eligibility.leaves.length > 0 ? Tree.build(eligibility.leaves) : undefined;
  const record = listDocument(breakId, inputs.window, POLICY, { root: listTree?.root.hash ?? new Uint8Array(32), totalWeight: eligibility.totalWeight, entryCount: eligibility.leaves.length, inputsHash: inputs.hash }, eligibility);
  const recordHex = toHex(hashv(utf8(record)));
  await db.query("insert into published_documents (sha256, content_type, body) values ($1, 'application/json', $2) on conflict do nothing", [recordHex, record]);
  // The exclusion list the planner used, unless the list was made before it kept one.
  let exclusionsUri: string | null = null;
  if (over.exclusions !== "none") {
    const body = exclusionsDocument(inputs.hash, new Map((over.exclusions ?? [[TEAM, "team"]]).map(([n, code]) => [holder(n), code])));
    const sha = toHex(hashv(utf8(body)));
    await db.query("insert into published_documents (sha256, content_type, body) values ($1, 'application/json', $2) on conflict do nothing", [sha, body]);
    exclusionsUri = `db:sha256:${sha}`;
  }
  if (over.list !== false) {
    const tree = Tree.build(leaves);
    for (const l of [...leaves].reverse()) {
      await db.query("insert into twab_snapshots (break_id, wallet, twab, weight, eligible) values ($1::bigint, $2, $3::numeric, $3::numeric, true)", [breakId, toBase58(l.wallet), l.weight.toString()]);
    }
    // A wallet that is out: never part of the list.
    await db.query("insert into twab_snapshots (break_id, wallet, twab, weight, eligible, reason) values ($1::bigint, $2, 1, 0, false, 'below_min_twab')", [breakId, holder(OUT)]);
    await db.query(
      "insert into eligibility_lists (break_id, root, total_weight, entry_count, inputs_hash, list_uri, inputs_uri, exclusions_uri) values ($1::bigint, decode($2, 'hex'), $3::numeric, $4, decode($5, 'hex'), $6, $7, $8)",
      [breakId, toHex(tree.root.hash), tree.root.sum.toString(), leaves.length, inputsHex, `db:sha256:${recordHex}`, `db:sha256:${inputsHex}`, exclusionsUri],
    );
  } else {
    await db.query(
      "insert into eligibility_lists (break_id, root, total_weight, entry_count, inputs_hash, list_uri, inputs_uri, exclusions_uri) values ($1::bigint, decode($2, 'hex'), 0, 0, decode($3, 'hex'), $4, $5, $6)",
      [breakId, "00".repeat(32), inputsHex, `db:sha256:${recordHex}`, `db:sha256:${inputsHex}`, exclusionsUri],
    );
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
    opensAt: BigInt(inputs.window.start),
    closesAt: BigInt(inputs.window.end),
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
  const leaves = leavesOf([[1, 10n], [2, 30n], [3, 5n], [4, 50n], [5, 20n], [6, 15n]], holder);
  const cards = [44, 40, 43, 41, 42].map((n) => addressToBytes(addr(n)));
  const tree = Tree.build(leaves);
  // The rules: an average of at least 3, no cap; wallet 7 is an exchange's and left out, and so is wallet 20, the team's, which
  // held none of the token (so only the exclusion list names it, not the record).
  const POLICY = { minTwab: 3n };
  const EXCLUDED = new Map([[holder(7), "exchange"], [holder(20), "team"]]);
  // A pool's vault: a program-derived address, off the curve, so never a holder.
  const POOL_VAULT = addr(2);

  // The balance events behind those weights, over a 12-hour window: wallet 1 held 10 all along, 2 bought 60 halfway (30), 3 sold
  // its 10 halfway (5), 4 held 50, 5 held 12 and 8 in two token accounts (20), 6 held 10 and bought 10 more halfway (15). Three
  // more held tokens and are not on the list, one for each reason: wallet 7 held 1000 and is excluded (an exchange), wallet 8
  // held 2 (below the minimum of 3) and the pool's vault held 7 (off the curve).
  const WINDOW = { start: 1_800_000_000, end: 1_800_043_200 };
  const MID = WINDOW.start + 21_600;
  const steps: [owner: number | string, account: number, time: number, delta: bigint][] = [
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
    [8, 108, WINDOW.start - 900, 2n],
    [POOL_VAULT, 109, WINDOW.start - 800, 7n],
  ];
  const held = new Map<number, bigint>();
  const events: BalanceEvent[] = steps.map(([owner, account, time, delta], i) => {
    const after = (held.get(account) ?? 0n) + delta;
    held.set(account, after);
    return { signature: `example-sig-${i + 1}`, slot: BigInt(time), time, owner: typeof owner === "string" ? owner : holder(owner), tokenAccount: addr(account), delta, balanceAfter: after };
  });
  const inputsText = serializeInputs(events, WINDOW);
  // The record, as the planner would store it for these events and rules, and as the exporter publishes it.
  const eligibility = buildEligibility({ events, window: WINDOW, policy: POLICY, exclusions: EXCLUDED });
  const values = { root: tree.root.hash, totalWeight: tree.root.sum, entryCount: leaves.length, inputsHash: hashv(utf8(inputsText)) };
  const record = parseStoredRecord(listDocument("example", WINDOW, POLICY, values, eligibility));
  // The break these lists belong to, drawn and delivered: three paid spots and the two free winners the draw really gives for
  // this seed and list, so the ledger can be checked against a draw that happened (the website's tests rebuild it from these
  // values: break id 7, seed 0x5a × 32, the paid spots bought by holders 11, 12 and 13, two free spots). One pack's price is not
  // known (its purchase was found in the wallet's history), one pack has no proof reference and one card was found at its
  // wallet without a transfer on record, so every null the format allows is in it.
  const SEED = new Uint8Array(32).fill(0x5a);
  const BUYERS = [11, 12, 13].map(holder);
  const winners = drawFreeWinners(SEED, leaves, 2).map((w) => ({ wallet: toBase58((leaves[w.leafIndex] as Leaf).wallet), start: w.start, weight: w.weight }));
  const drawnBreak = brk({
    id: 7n,
    status: "Drawn",
    spotsSold: 3,
    freeSpots: 2,
    poolSize: 5,
    seed: SEED,
    poolHash: poolHash(cards),
    eligibilityRoot: tree.root.hash,
    eligibilityTotalWeight: tree.root.sum,
    eligibilityCount: leaves.length,
    eligibilityInputsHash: hashv(utf8(inputsText)),
    opensAt: BigInt(WINDOW.start),
    closesAt: BigInt(WINDOW.end),
    freeWinnerCount: 2,
    freeWinners: [...winners, ...Array.from({ length: 14 }, () => ({ wallet: addr(0), start: 0n, weight: 0n }))],
  });
  const paidSpots = BUYERS.map((owner, index) => ({ breakId: 7n, index, owner, paid: 20_000_000n, refunded: false, bump: 255 }));
  const cardMints = cards.map(toBase58);
  const plan = buildDeliveryPlan({ breakId: "example", buyer: holder(90), chain: drawnBreak, paidSpots, cards: cardMints });
  const ledger = buildLedger({
    chain: drawnBreak,
    buyer: holder(90),
    paidSpots,
    packs: cardMints.map((card, i) => ({
      index: i,
      status: "pulled",
      purchaseSig: `example-buy-${i + 1}`,
      ...(i === 2 ? {} : { price: 20_000_000n + BigInt(i) * 1_000_000n }),
      cardMint: card,
      ...(i === 4 ? {} : { proofRef: `example-proof-${i + 1}` }),
    })),
    deliveries: plan.deliveries.map((d, i) => ({
      kind: d.spot.kind,
      idx: d.spot.idx,
      recipient: d.recipient,
      cardMint: d.cardMint,
      status: "confirmed",
      ...(i === 1 ? {} : { txSig: `example-send-${d.spot.kind}-${d.spot.idx + 1}` }),
      adopted: i === 1,
    })),
  });
  const exclusions = parseExclusions(exclusionsDocument(values.inputsHash, EXCLUDED));
  const made = [eligibilityFile(tree.root.hash, tree.root.sum, leaves), poolFile(poolHash(cards), cards), inputsFile(inputsText), recordFile(record), exclusionsFile(exclusions), ledgerFile(ledger)];

  it("has a ledger of a draw that really happened: the free winners are drawn from the list, every card goes where the draw says", () => {
    expect(winners.map((w) => w.wallet).every((w) => leaves.some((l) => toBase58(l.wallet) === w))).toBe(true);
    expect(new Set(winners.map((w) => w.wallet)).size).toBe(2);
    expect(ledger.spots.map((x) => x.wallet)).toEqual([...BUYERS, ...winners.map((w) => w.wallet)]);
    expect(ledger.spots.map((x) => x.card)).toEqual(assignCards(SEED, cards, BUYERS, winners.map((w) => w.wallet)).map((a) => toBase58(a.card)));
    expect(ledger.packs.map((p) => p.card)).toEqual(cardMints);
    expect([ledger.packs[2]?.price, ledger.packs[4]?.proof, ledger.spots[1]?.deliveryTx]).toEqual([undefined, undefined, undefined]);
  });

  it("has balance events whose time-weighted average balances are the weights on the list, and one wallet that is not on it", () => {
    const twab = twabByOwner(events, WINDOW);
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((n) => twab.get(holder(n)))).toEqual([10n, 30n, 5n, 50n, 20n, 15n, 1000n, 2n]);
    expect(twab.get(POOL_VAULT)).toBe(7n);
    // The list is wallets 1 to 6 with exactly those weights, and it is what the rules make of the events.
    expect(leaves.map((l) => [toBase58(l.wallet), l.weight]).sort()).toEqual([1, 2, 3, 4, 5, 6].map((n) => [holder(n), twab.get(holder(n))]).sort());
    expect(eligibility.leaves).toEqual(leaves);
    // One wallet for each reason a wallet is out.
    const reasons = Object.fromEntries(record.wallets.filter((w) => w.reason !== null).map((w) => [w.wallet, w.reason]));
    expect(reasons).toEqual({ [holder(7)]: "excluded:exchange", [holder(8)]: "below_min_twab", [POOL_VAULT]: "off_curve" });
    // The record passes the exporter's own check against the commitments, and the exclusion list is the one it was made with.
    checkRecord(record, inputsText, brk({ eligibilityRoot: tree.root.hash, eligibilityTotalWeight: tree.root.sum, eligibilityCount: 6, eligibilityInputsHash: values.inputsHash, opensAt: BigInt(WINDOW.start), closesAt: BigInt(WINDOW.end) }));
    checkExclusions(exclusions, record);
    expect(record.wallets.map((w) => w.wallet)).not.toContain(holder(20));
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
      ...(await readdir(join(EXAMPLE, "records"))).map((n) => `records/${n}`),
      ...(await readdir(join(EXAMPLE, "exclusions"))).map((n) => `exclusions/${n}`),
      ...(await readdir(join(EXAMPLE, "ledger"))).map((n) => `ledger/${n}`),
    ].sort();
    expect(found).toEqual(made.map((f) => f.path).sort());
  });
});

describe("publishing a committed eligibility list", () => {
  it("writes the list under the root the chain committed, sorted the way the tree sorts it, and the file hashes back to its name", async () => {
    const b = await makeBreak(4n, "eligibility_committed");
    const report = await exporter(chainOf(b).reader).run();
    const root = toHex(b.chain.eligibilityRoot);
    expect(report).toEqual({ written: [`eligibility/${root}.json`, inputsPath(b), recordPath(b), exclusionsPath(b)], problems: [] });
    expect(await files("eligibility")).toEqual([`${root}.json`]);

    const text = await readFile(join(dir, "eligibility", `${root}.json`), "utf8");
    const doc = JSON.parse(text);
    expect(doc).toMatchObject({ version: 1, kind: "eligibility", root, totalWeight: "95", entryCount: 4 });
    // Not the wallet that was out (addr 99), and in the tree's order: the file rebuilds the root it is named after.
    expect(doc.entries.map((e: { wallet: string }) => e.wallet)).not.toContain(holder(OUT));
    const rebuilt = Tree.build(doc.entries.map((e: { wallet: string; weight: string }) => ({ wallet: addressToBytes(e.wallet), weight: BigInt(e.weight) })));
    expect(toHex(rebuilt.root.hash)).toBe(root);
    expect(rebuilt.root.sum).toBe(95n);
    expect(text).toBe(eligibilityFile(b.chain.eligibilityRoot, 95n, leavesOf(WEIGHTS, holder)).body);
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
    expect(first.written).toHaveLength(5);
    const reads = chain.reads.length;
    expect(await exporter(chain.reader).run()).toEqual({ written: [], problems: [] });
    expect(chain.reads).toHaveLength(reads);
  });

  it("publishes every committed break, newest first, and also a later one on a later run", async () => {
    const first = await makeBreak(0n, "drawn", { weights: [[1, 5n], [2, 5n]] });
    const second = await makeBreak(1n, "eligibility_committed", { weights: [[3, 9n]] });
    const chain = chainOf(first, second);
    const report = await exporter(chain.reader).run();
    expect(report.problems).toEqual([]);
    // Newest first (the first break is drawn, so its cards are published too).
    expect(report.written.filter((p) => p.startsWith("eligibility/"))).toEqual([`eligibility/${toHex(second.chain.eligibilityRoot)}.json`, `eligibility/${toHex(first.chain.eligibilityRoot)}.json`]);
    expect(report.written).toHaveLength(9);
    expect((await files("eligibility")).length).toBe(2);
    expect((await files("records")).length).toBe(2);
    const third = await makeBreak(2n, "funded", { weights: [[4, 2n], [5, 3n]] });
    const later = await exporter(chainOf(first, second, third).reader).run();
    expect(later.written).toEqual([`eligibility/${toHex(third.chain.eligibilityRoot)}.json`, inputsPath(third), recordPath(third), exclusionsPath(third)]);
  });

  it("publishes no list for an empty one, only the record of the inputs behind it (which is where to see why nobody is on it)", async () => {
    const b = await makeBreak(4n, "eligibility_committed", { list: false, cards: [] });
    const chain = chainOf(b);
    expect(await exporter(chain.reader).run()).toEqual({ written: [inputsPath(b), recordPath(b), exclusionsPath(b)], problems: [] });
    expect(chain.reads).toHaveLength(1);
    expect(await files("eligibility")).toEqual([]);
    // The record says why: the one holder had an average of 1, below the minimum of 2.
    const record = JSON.parse(await readFile(join(dir, recordPath(b)), "utf8"));
    expect(record).toMatchObject({ entryCount: 0, totalWeight: "0", root: "00".repeat(32), policy: { minTwab: "2" } });
    expect(record.wallets).toEqual([{ wallet: holder(OUT), twab: "1", weight: "0", reason: "below_min_twab" }]);
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
    await db.query("update twab_snapshots set weight = weight + 1 where break_id = $1::bigint and wallet = $2", [b.breakId, holder(3)]);
    const report = await exporter(chainOf(b).reader).run();
    // The balance events and the record are their own steps, checked against the chain on their own, and still go out.
    expect(report.written).toEqual([inputsPath(b), recordPath(b), exclusionsPath(b)]);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]?.breakId).toBe(b.breakId);
    expect(report.problems[0]?.message).toMatch(/is not what was committed on chain/);
    expect(await files("eligibility")).toEqual([]);
  });

  it("refuses a list with a wallet missing, with one extra, and one with another total", async () => {
    for (const [i, change] of [
      (id: string) => db.query("delete from twab_snapshots where break_id = $1::bigint and wallet = $2", [id, holder(9)]),
      (id: string) => db.query("insert into twab_snapshots (break_id, wallet, twab, weight, eligible) values ($1::bigint, $2, 1, 1, true)", [id, holder(77)]),
      (id: string) => db.query("update twab_snapshots set weight = 31, twab = 31 where break_id = $1::bigint and wallet = $2", [id, holder(7)]),
    ].entries()) {
      await db.exec("truncate packs, twab_snapshots, eligibility_lists, published_documents, breaks cascade");
      // A break of its own each time: the directory keeps the record of the inputs the one before published.
      const b = await makeBreak(BigInt(4 + i), "eligibility_committed");
      await change(b.breakId);
      const report = await exporter(chainOf(b).reader).run();
      expect(report.written).toEqual([inputsPath(b), recordPath(b), exclusionsPath(b)]);
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
      // The record is held back too: it has to agree with the same commitments.
      expect(report.problems[0]?.message).toMatch(/the stored eligibility record .* is not what was committed on chain/);
    }
  });

  it("refuses to publish an empty list when the chain says a list was committed", async () => {
    const b = await makeBreak(4n, "eligibility_committed");
    await db.query("delete from twab_snapshots where break_id = $1::bigint", [b.breakId]);
    const report = await exporter(chainOf(b).reader).run();
    expect(report.written).toEqual([inputsPath(b), recordPath(b), exclusionsPath(b)]);
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
    // Newest first. The bad break's list and record are held back, its (consistent) record of the inputs is not.
    expect(first.written).toEqual([`eligibility/${toHex(good.chain.eligibilityRoot)}.json`, inputsPath(good), recordPath(good), exclusionsPath(good), inputsPath(bad)]);
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
    expect(report.written).toHaveLength(5);
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
    const first = await makeBreak(0n, "drawn");
    const second = await makeBreak(1n, "drawn");
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
    // A team wallet that held none of the token: only the exclusion list shows it.
    const team = wallet(13);
    await db.query("insert into exclusions (wallet, reason_code, note) values ($1, 'team', 'not for the public')", [team]);

    const breakId = await insertBreak(db);
    const plan = await new SqlEligibilityPlanner(sql, new DbPublisher(sql), { policy: { minTwab: 100n }, settleSecs: 120 }).plan(breakId, WINDOW);
    if (plan.kind !== "ready") throw new Error(plan.reason);
    await db.query("update breaks set onchain_id = 7, status = 'eligibility_committed' where id = $1::bigint", [breakId]);

    const account = brk({
      id: 7n,
      status: "EligibilityCommitted",
      opensAt: BigInt(WINDOW.start),
      closesAt: BigInt(WINDOW.end),
      eligibilityRoot: plan.values.root,
      eligibilityTotalWeight: plan.values.totalWeight,
      eligibilityCount: plan.values.entryCount,
      eligibilityInputsHash: plan.values.inputsHash,
    });
    const reader: AccountReader = { getAccountData: async (addrOf) => (addrOf === breakAddress(PROGRAMS, 7n) ? encodeBreak(account) : undefined) };
    const report = await exporter(reader).run();

    const events = [
      { signature: "sig-a", slot: BigInt(START - 500), time: START - 500, owner: a, tokenAccount: "acct-a", delta: 1000n, balanceAfter: 1000n },
      { signature: "sig-b", slot: BigInt(START + 43_200), time: START + 43_200, owner: b, tokenAccount: "acct-b", delta: 1000n, balanceAfter: 1000n },
    ];
    const text = serializeInputs(events, WINDOW);
    const hex = toHex(plan.values.inputsHash);
    expect(report.problems).toEqual([]);
    expect(report.written).toEqual([`eligibility/${toHex(plan.values.root)}.json`, `inputs/${hex}.txt`, `records/${hex}.json`, `exclusions/${hex}.json`]);
    // The exclusion list the planner used, whole: the team wallet with its code, and never the private note.
    const exclusions = await readFile(join(dir, "exclusions", `${hex}.json`), "utf8");
    expect(exclusions).toBe(`{"version":1,"kind":"exclusions","inputsHash":"${hex}","entries":[{"wallet":"${team}","code":"team"}]}\n`);
    expect(await readFile(join(dir, "inputs", `${hex}.txt`), "utf8")).toBe(text);
    expect(createHash("sha256").update(text, "utf8").digest("hex")).toBe(hex);
    // The list and the record agree: A held 1000 all window, B held 1000 for half of it.
    const list = JSON.parse(await readFile(join(dir, "eligibility", `${toHex(plan.values.root)}.json`), "utf8"));
    expect(Object.fromEntries(list.entries.map((e: { wallet: string; weight: string }) => [e.wallet, e.weight]))).toEqual({ [a]: "1000", [b]: "500" });
    // The record the planner stored goes out as it was built: both wallets, their averages and the rule that was applied.
    const record = JSON.parse(await readFile(join(dir, "records", `${hex}.json`), "utf8"));
    expect(record).toMatchObject({ version: 1, kind: "record", inputsHash: hex, root: toHex(plan.values.root), totalWeight: "1500", entryCount: 2, window: WINDOW, policy: { minTwab: "100" } });
    expect(record.policy).not.toHaveProperty("capPerWallet");
    expect(Object.fromEntries(record.wallets.map((w: { wallet: string; twab: string; reason: string | null }) => [w.wallet, [w.twab, w.reason]]))).toEqual({ [a]: ["1000", null], [b]: ["500", null] });
    await db.query("delete from balance_events");
    await db.query("delete from exclusions");
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
    // The delivered break's ledger cannot be made here (this chain has no config account and the break no deliveries on
    // record): that is reported, and its cards still go out.
    expect(report.problems).toEqual([{ breakId: delivered.breakId, message: "the breaks program has no config account on chain" }]);
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
    expect(report.written).toEqual([`eligibility/${toHex(b.chain.eligibilityRoot)}.json`, inputsPath(b), recordPath(b), exclusionsPath(b)]);
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
    for (const path of ["../escape.json", "eligibility/../x.json", "eligibility/short.json", `eligibility/${"A".repeat(64)}.json`, `other/${"a".repeat(64)}.json`, `eligibility/${"a".repeat(64)}.txt`, `inputs/${"a".repeat(64)}.json`, `pool/${"a".repeat(64)}.txt`, `inputs/${"A".repeat(64)}.txt`, `inputs/${"a".repeat(65)}.txt`, `inputs/short.txt`, `records/${"a".repeat(64)}.txt`, `records/${"A".repeat(64)}.json`, `record/${"a".repeat(64)}.json`, `exclusions/${"a".repeat(64)}.txt`, `exclusion/${"a".repeat(64)}.json`, `exclusions/${"A".repeat(64)}.json`, `/eligibility/${"a".repeat(64)}.json`, `eligibility/${"a".repeat(64)}.json/../../x`]) {
      await expect(sink.write({ path, body: "x" }), path).rejects.toThrow(/not a published file name/);
      await expect(sink.exists(path), path).rejects.toThrow(/not a published file name/);
    }
    await mkdir(join(dir, "ok"), { recursive: true });
    expect(await readdir(dir)).not.toContain("escape.json");
  });

  it("writes an exclusion list under its own folder", async () => {
    const sink = new DirSink(dir);
    const file = { path: `exclusions/${"a".repeat(64)}.json`, body: "{}\n" };
    expect(await sink.write(file)).toBe("written");
    expect(await readFile(join(dir, file.path), "utf8")).toBe("{}\n");
  });
});

describe("publishing the record of why each wallet is in or out", () => {
  const record = async (b: Made) => JSON.parse(await readFile(join(dir, recordPath(b)), "utf8"));
  /** Rewrites the record the planner stored for a break, as if it had been changed after the commit. */
  const tamper = async (b: Made, edit: (doc: any) => void) => {
    const { rows } = await db.query<{ list_uri: string }>("select list_uri from eligibility_lists where break_id = $1::bigint", [b.breakId]);
    const sha = (rows[0]?.list_uri as string).replace("db:sha256:", "");
    const { rows: docs } = await db.query<{ body: string }>("select body from published_documents where sha256 = $1", [sha]);
    const doc = JSON.parse(docs[0]?.body as string);
    edit(doc);
    await db.query("update published_documents set body = $2 where sha256 = $1", [sha, JSON.stringify(doc)]);
  };
  const problemOf = async (b: Made) => {
    const report = await exporter(chainOf(b).reader).run();
    expect(report.written, "the record must not go out").not.toContain(recordPath(b));
    expect(await files("records")).toEqual([]);
    return report.problems.map((p) => p.message).join("; ");
  };

  it("writes every wallet with its average balance, its weight and its reason, under the inputs hash, with the rules", async () => {
    const b = await makeBreak(4n, "eligibility_committed");
    const report = await exporter(chainOf(b).reader).run();
    expect(report.problems).toEqual([]);
    expect(report.written).toContain(recordPath(b));
    const doc = await record(b);
    expect(doc).toMatchObject({
      version: 1,
      kind: "record",
      inputsHash: toHex(b.chain.eligibilityInputsHash),
      root: toHex(b.chain.eligibilityRoot),
      totalWeight: "95",
      entryCount: 4,
      window: { start: Number(b.chain.opensAt), end: Number(b.chain.closesAt) },
      policy: { minTwab: "2" },
    });
    // Each holder of the list with its weight, and the one who is out with the reason, in the tree's order of wallets.
    const rows = doc.wallets.map((w: any) => [w.wallet, w.twab, w.weight, w.reason]);
    expect([...rows].sort()).toEqual([...WEIGHTS.map(([n, w]) => [holder(n), `${w}`, `${w}`, null]), [holder(OUT), "1", "0", "below_min_twab"]].sort());
    expect(doc.wallets.map((w: any) => w.wallet)).toEqual([...doc.wallets.map((w: any) => w.wallet)].sort((x: string, y: string) => compareBytes(addressToBytes(x), addressToBytes(y))));
    // The wallets it calls eligible rebuild the committed root.
    const eligible = doc.wallets.filter((w: any) => w.reason === null).map((w: any) => ({ wallet: addressToBytes(w.wallet), weight: BigInt(w.weight) }));
    expect(toHex(Tree.build(eligible).root.hash)).toBe(toHex(b.chain.eligibilityRoot));
  });

  it("pins the bytes of a record file, with a cap when there is one", () => {
    const base = { inputsHash: "ab".repeat(32), root: "cd".repeat(32), totalWeight: 7n, entryCount: 1, window: { start: 10, end: 20 }, wallets: [{ wallet: addr(1), twab: 9n, weight: 7n, reason: null }, { wallet: addr(2), twab: 3n, weight: 0n, reason: "excluded:team" }] };
    expect(recordFile({ ...base, policy: { minTwab: 5n } })).toEqual({
      path: `records/${"ab".repeat(32)}.json`,
      body: `{"version":1,"kind":"record","inputsHash":"${"ab".repeat(32)}","root":"${"cd".repeat(32)}","totalWeight":"7","entryCount":1,"window":{"start":10,"end":20},"policy":{"minTwab":"5"},"wallets":[{"wallet":"${addr(1)}","twab":"9","weight":"7","reason":null},{"wallet":"${addr(2)}","twab":"3","weight":"0","reason":"excluded:team"}]}\n`,
    });
    expect(recordFile({ ...base, policy: { minTwab: 5n, capPerWallet: 7n } }).body).toContain(`"policy":{"minTwab":"5","capPerWallet":"7"}`);
  });

  it("publishes a record whose rules had a cap, and an exclusion, when they are what the planner applied", async () => {
    const b = await makeBreak(4n, "eligibility_committed", { weights: [[3, 10n], [9, 5n]] });
    // As if the planner had capped at 8 and left wallet 3 out as the team's: then wallet 9 alone is on the list.
    const leaves = leavesOf([[9, 5n]], holder);
    const tree = Tree.build(leaves);
    await tamper(b, (doc) => {
      doc.policy.capPerWallet = "8";
      doc.root = toHex(tree.root.hash);
      doc.totalWeight = "5";
      doc.entryCount = 1;
      for (const w of doc.wallets) if (w.wallet === holder(3)) Object.assign(w, { weight: "0", eligible: false, reason: "excluded:team" });
    });
    const chain = { ...b.chain, eligibilityRoot: tree.root.hash, eligibilityTotalWeight: 5n, eligibilityCount: 1 };
    const accounts = chainOf({ ...b, chain });
    const report = await exporter(accounts.reader).run();
    expect(report.written).toContain(recordPath(b));
    const doc = await record(b);
    expect(doc.policy).toEqual({ minTwab: "2", capPerWallet: "8" });
    expect(doc.wallets.find((w: any) => w.wallet === holder(3))).toEqual({ wallet: holder(3), twab: "10", weight: "0", reason: "excluded:team" });
  });

  it("refuses a record that is not what the rules make of the committed balance events", async () => {
    const cases: [string, (doc: any) => void, RegExp][] = [
      ["a weight changed", (d) => (d.wallets.find((w: any) => w.weight === "30").weight = "29"), /first difference at wallet \d+/],
      ["an average changed", (d) => (d.wallets.find((w: any) => w.reason !== null).twab = "2"), /not what the rules make of the committed balance events/],
      ["a reason changed", (d) => (d.wallets.find((w: any) => w.reason !== null).reason = "off_curve"), /not what the rules make/],
      ["a wallet left out", (d) => d.wallets.pop(), /not what the rules make/],
      ["a wallet added", (d) => d.wallets.push({ wallet: holder(55), twab: "3", weight: "3", eligible: true, reason: null }), /not what the rules make/],
      ["a minimum that would leave wallet 9 out", (d) => (d.policy.minTwab = "6"), /not what the rules make/],
      ["a cap that is not what was applied", (d) => (d.policy.capPerWallet = "20"), /not what the rules make/],
      ["the wallets in another order", (d) => d.wallets.reverse(), /not what the rules make/],
    ];
    for (const [i, [what, edit, message]] of cases.entries()) {
      await db.exec("truncate packs, twab_snapshots, eligibility_lists, published_documents, breaks cascade");
      if (dir) await rm(dir, { recursive: true, force: true });
      dir = await mkdtemp(join(tmpdir(), "publish-test-"));
      const b = await makeBreak(BigInt(4 + i), "eligibility_committed");
      await tamper(b, edit);
      expect(await problemOf(b), what).toMatch(message);
    }
  });

  it("refuses a record that does not agree with the chain's commitments, or whose window is not the break's", async () => {
    const cases: [string, Partial<BreakAccount> | undefined, ((doc: any) => void) | undefined, RegExp][] = [
      ["another window on chain", { closesAt: 1n }, undefined, /measures \d+ to \d+, not the break's window \d+ to 1/],
      ["another opening on chain", { opensAt: 1n }, undefined, /measures \d+ to \d+, not the break's window 1 to \d+/],
      ["another window in the record", undefined, (d) => (d.window.end -= 1), /measures/],
      ["another inputs hash in the record", undefined, (d) => (d.inputsHash = "ee".repeat(32)), /is for inputs hash (?:ee){32}, not the [0-9a-f]{64} committed on chain/],
      ["a root that is not the chain's in the record", undefined, (d) => (d.root = "11".repeat(32)), /stored eligibility record \(root (?:11){32}/],
      ["a count that is not the chain's in the record", undefined, (d) => (d.entryCount = 5), /5 wallets/],
      ["a total that is not the chain's in the record", undefined, (d) => (d.totalWeight = "96"), /total 96/],
    ];
    for (const [i, [what, chain, edit, message]] of cases.entries()) {
      await db.exec("truncate packs, twab_snapshots, eligibility_lists, published_documents, breaks cascade");
      if (dir) await rm(dir, { recursive: true, force: true });
      dir = await mkdtemp(join(tmpdir(), "publish-test-"));
      const b = await makeBreak(BigInt(4 + i), "eligibility_committed", chain ? { chain } : {});
      if (edit) await tamper(b, edit);
      expect(await problemOf(b), what).toMatch(message);
    }
  });

  it("refuses a record whose balance events were measured over another window than the one it and the chain state", async () => {
    // As if the keeper had committed balance events taken over the wrong window: the record and the chain agree on a window,
    // the text says another one.
    const b = await makeBreak(4n, "eligibility_committed", { chain: { opensAt: 1n, closesAt: 2n } });
    await tamper(b, (d) => (d.window = { start: 1, end: 2 }));
    expect(await problemOf(b)).toMatch(/the stored eligibility record and its balance events are for different windows/);
  });

  it("refuses a record whose wallets follow the rules when the root the chain committed is not the one they build", async () => {
    // As if the keeper had committed a wrong list: the record repeats the chain's root, but its eligible wallets build another.
    const wrong = new Uint8Array(32).fill(3);
    const b = await makeBreak(4n, "eligibility_committed", { chain: { eligibilityRoot: wrong } });
    await tamper(b, (d) => (d.root = toHex(wrong)));
    expect(await problemOf(b)).toMatch(/the wallets the stored eligibility record calls eligible do not rebuild the committed root/);
  });

  it("refuses a record whose eligible wallets do not rebuild the root, even when they agree with the counts", async () => {
    const b = await makeBreak(4n, "eligibility_committed");
    // Two eligible wallets swap weights: same total, same count, and the record says the same root, but the rules disagree.
    await tamper(b, (d) => {
      const [x, y] = d.wallets.filter((w: any) => w.reason === null);
      [x.weight, y.weight] = [y.weight, x.weight];
      [x.twab, y.twab] = [y.twab, x.twab];
    });
    expect(await problemOf(b)).toMatch(/not what the rules make/);
  });

  it("reports a record that cannot be read, or that is not the planner's record, and still publishes the rest", async () => {
    const cases: [string, (b: Made) => Promise<unknown>, RegExp][] = [
      ["never stored", (b) => db.query("update eligibility_lists set list_uri = 'ipfs://elsewhere' where break_id = $1::bigint", [b.breakId]), /^the stored eligibility record cannot be read, though its list was committed$/],
      ["not JSON", (b) => tamper(b, () => {}).then(() => db.query("update published_documents set body = 'nope' where content_type = 'application/json'")), /is not JSON/],
      ["another version", (b) => tamper(b, (d) => (d.version = 2)), /no valid version/],
      ["a weight that is not a number", (b) => tamper(b, (d) => (d.wallets[0].weight = "1.5")), /no valid weight of wallet 1/],
      ["an eligible flag that disagrees with the reason", (b) => tamper(b, (d) => (d.wallets[0].eligible = !d.wallets[0].eligible)), /no valid eligibility of wallet 1/],
      ["a minimum that is missing", (b) => tamper(b, (d) => delete d.policy.minTwab), /no valid minimum/],
    ];
    for (const [i, [what, change, message]] of cases.entries()) {
      await db.exec("truncate packs, twab_snapshots, eligibility_lists, published_documents, breaks cascade");
      if (dir) await rm(dir, { recursive: true, force: true });
      dir = await mkdtemp(join(tmpdir(), "publish-test-"));
      const b = await makeBreak(BigInt(4 + i), "eligibility_committed");
      await change(b);
      const report = await exporter(chainOf(b).reader).run();
      expect(report.problems.map((p) => p.message).join("; "), what).toMatch(message);
      expect(report.written, what).toEqual([`eligibility/${toHex(b.chain.eligibilityRoot)}.json`, inputsPath(b)]);
    }
  });

  it("is quiet once it is out, and keeps the record of one break apart from another's", async () => {
    const first = await makeBreak(4n, "eligibility_committed");
    const second = await makeBreak(5n, "eligibility_committed", { weights: [[1, 4n]] });
    const chain = chainOf(first, second);
    await exporter(chain.reader).run();
    expect(await files("records")).toEqual([recordPath(first), recordPath(second)].map((p) => p.replace("records/", "")).sort());
    const reads = chain.reads.length;
    expect(await exporter(chain.reader).run()).toEqual({ written: [], problems: [] });
    expect(chain.reads).toHaveLength(reads);
  });
});

describe("publishing the exclusion list a list was made with", () => {
  /** Rewrites the record the planner stored for a break, as if it had been changed after the commit. */
  const tamper = async (b: Made, edit: (doc: any) => void) => {
    const { rows } = await db.query<{ list_uri: string }>("select list_uri from eligibility_lists where break_id = $1::bigint", [b.breakId]);
    const sha = (rows[0]?.list_uri as string).replace("db:sha256:", "");
    const { rows: docs } = await db.query<{ body: string }>("select body from published_documents where sha256 = $1", [sha]);
    const doc = JSON.parse(docs[0]?.body as string);
    edit(doc);
    await db.query("update published_documents set body = $2 where sha256 = $1", [sha, JSON.stringify(doc)]);
  };
  /** Rewrites the stored exclusion list itself. */
  const tamperList = async (b: Made, body: string) => {
    const { rows } = await db.query<{ uri: string }>("select exclusions_uri as uri from eligibility_lists where break_id = $1::bigint", [b.breakId]);
    await db.query("update published_documents set body = $2 where sha256 = $1", [(rows[0]?.uri as string).replace("db:sha256:", ""), body]);
  };
  /**
   * A break whose rules left wallet 3 out (it held 10) as `code`, with the exclusion list `list`: the record says wallet 3 is
   * excluded as the team's, and wallet 9 alone is on the list.
   */
  const excludedBreak = async (list: [number, string][]) => {
    const b = await makeBreak(4n, "eligibility_committed", { weights: [[3, 10n], [9, 5n]], exclusions: list });
    const tree = Tree.build(leavesOf([[9, 5n]], holder));
    await tamper(b, (doc) => {
      Object.assign(doc, { root: toHex(tree.root.hash), totalWeight: "5", entryCount: 1 });
      for (const w of doc.wallets) if (w.wallet === holder(3)) Object.assign(w, { weight: "0", eligible: false, reason: "excluded:team" });
    });
    await db.query("update twab_snapshots set weight = 0, eligible = false, reason = 'excluded:team' where break_id = $1::bigint and wallet = $2", [b.breakId, holder(3)]);
    return { ...b, chain: { ...b.chain, eligibilityRoot: tree.root.hash, eligibilityTotalWeight: 5n, eligibilityCount: 1 } };
  };
  const problemOf = async (b: Made) => {
    const report = await exporter(chainOf(b).reader).run();
    expect(report.written, "the exclusion list must not go out").not.toContain(exclusionsPath(b));
    expect(await files("exclusions")).toEqual([]);
    return report.problems.map((p) => p.message).join("; ");
  };

  it("writes the list the planner stored under the inputs hash: every wallet left out, also one that held none of the token", async () => {
    const b = await makeBreak(4n, "eligibility_committed");
    const chain = chainOf(b);
    const report = await exporter(chain.reader).run();
    expect(report.problems).toEqual([]);
    expect(report.written).toContain(exclusionsPath(b));
    const body = await readFile(join(dir, exclusionsPath(b)), "utf8");
    expect(body).toBe(exclusionsDocument(b.chain.eligibilityInputsHash, new Map([[holder(TEAM), "team"]])));
    // The team wallet held nothing, so only this file names it: the record does not.
    expect(await readFile(join(dir, recordPath(b)), "utf8")).not.toContain(holder(TEAM));
    // The break's account was read once for every file, and a second run is quiet.
    expect(chain.reads).toHaveLength(1);
    expect(await exporter(chain.reader).run()).toEqual({ written: [], problems: [] });
    expect(chain.reads).toHaveLength(1);
  });

  it("pins the bytes of the file", () => {
    const list = { inputsHash: "ab".repeat(32), entries: [{ wallet: addr(1), code: "team" }] };
    expect(exclusionsFile(list)).toEqual({ path: `exclusions/${"ab".repeat(32)}.json`, body: `{"version":1,"kind":"exclusions","inputsHash":"${"ab".repeat(32)}","entries":[{"wallet":"${addr(1)}","code":"team"}]}\n` });
  });

  it("publishes a list whose wallet held the token, when the record leaves it out with the same code", async () => {
    const b = await excludedBreak([[3, "team"], [TEAM, "bundle"]]);
    const report = await exporter(chainOf(b).reader).run();
    expect(report.problems).toEqual([]);
    expect(report.written).toEqual(expect.arrayContaining([recordPath(b), exclusionsPath(b)]));
    expect(parseExclusions(await readFile(join(dir, exclusionsPath(b)), "utf8")).entries.map((e) => [e.wallet, e.code]).sort()).toEqual([[holder(3), "team"], [holder(TEAM), "bundle"]].sort());
  });

  it("refuses a list that is not the one the record was made with, and says why", async () => {
    const cases: [[number, string][], string][] = [
      [[[TEAM, "team"]], `the record leaves ${holder(3)} out as "team", but the stored exclusion list does not name it`],
      [[[3, "exchange"]], `the stored exclusion list gives ${holder(3)} the code "exchange", but the record says "team"`],
      [[[3, "team"], [9, "team"]], `the stored exclusion list names ${holder(9)} ("team"), but the record does not leave it out`],
    ];
    for (const [list, message] of cases) {
      await db.exec("truncate packs, twab_snapshots, eligibility_lists, published_documents, breaks cascade");
      await rm(join(dir, "exclusions"), { recursive: true, force: true });
      const b = await excludedBreak(list);
      expect(await problemOf(b), message).toBe(`${message}; nothing was published`);
    }
  });

  it("refuses a list for another inputs hash, and one that is not written the way the keeper writes it", async () => {
    const b = await makeBreak(4n, "eligibility_committed");
    await tamperList(b, exclusionsDocument("ef".repeat(32), new Map([[holder(TEAM), "team"]])));
    expect(await problemOf(b)).toBe(`the stored exclusion list is for inputs hash ${"ef".repeat(32)}, not the ${toHex(b.chain.eligibilityInputsHash)} of its record; nothing was published`);
    await tamperList(b, `${JSON.stringify(JSON.parse(exclusionsDocument(b.chain.eligibilityInputsHash, new Map([[holder(TEAM), "team"]]))), null, 2)}\n`);
    expect(await problemOf(b)).toBe("the stored exclusion list is not written the way the keeper writes it; nothing was published");
  });

  it("does not publish the list while its record does not add up, and says the record's fault once", async () => {
    const b = await makeBreak(4n, "eligibility_committed");
    await tamper(b, (d) => (d.wallets.find((w: any) => w.weight === "30").weight = "29"));
    const message = await problemOf(b);
    expect(message).toMatch(/^the stored eligibility record is not what the rules make of the committed balance events \(first difference at wallet \d+/);
    expect(message.split("first difference").length).toBe(2);
  });

  it("says nothing for a list made before the planner kept its exclusions, and reports one it points to but cannot read", async () => {
    const old = await makeBreak(4n, "eligibility_committed", { exclusions: "none" });
    expect(await exporter(chainOf(old).reader).run()).toMatchObject({ problems: [] });
    expect(await files("exclusions")).toEqual([]);

    await db.exec("truncate packs, twab_snapshots, eligibility_lists, published_documents, breaks cascade");
    const lost = await makeBreak(4n, "eligibility_committed");
    await db.query("update eligibility_lists set exclusions_uri = 'ipfs://somewhere' where break_id = $1::bigint", [lost.breakId]);
    expect(await problemOf(lost)).toBe("the stored exclusion list cannot be read, though its list was committed");
  });

  it("publishes it for an empty list too, like the record", async () => {
    const b = await makeBreak(4n, "eligibility_committed", { list: false });
    const report = await exporter(chainOf({ ...b, chain: { ...b.chain, eligibilityRoot: new Uint8Array(32), eligibilityTotalWeight: 0n, eligibilityCount: 0 } }).reader).run();
    expect(report.problems).toEqual([]);
    expect(report.written).toEqual([inputsPath(b), recordPath(b), exclusionsPath(b)]);
  });
});

describe("reading back the published balance-event text", () => {
  const WINDOW = { start: 100, end: 200 };
  const events: BalanceEvent[] = [
    { signature: "s1", slot: 5n, time: 90, owner: addr(1), tokenAccount: addr(2), delta: 100n, balanceAfter: 100n },
    { signature: "s2", slot: 7n, time: 150, owner: addr(1), tokenAccount: addr(2), delta: -40n, balanceAfter: 60n },
  ];
  const text = serializeInputs(events, WINDOW);

  it("gives back the window and the events the text was written from", () => {
    expect(parseInputsText(text)).toEqual({ window: WINDOW, events });
    expect(parseInputsText(serializeInputs([], WINDOW))).toEqual({ window: WINDOW, events: [] });
  });

  it("refuses anything the keeper would not have written, naming the line", () => {
    const cases: [string, RegExp][] = [
      [text.slice(0, -1), /does not end with a line feed/],
      [text.replace("breaks:inputs:v1", "breaks:inputs:v2"), /line 1: not a breaks:inputs:v1 header/],
      [text.replace("v1,100,200", "v1,200,100"), /line 1: the window does not end after it starts/],
      [text.replace("v1,100,200", "v1,100,0200"), /line 1/],
      [text + "\n", /line 4: 1 fields, not 7/],
      [text.replace(",-40,", ",x,"), /line 3: not a whole number/],
      [text.replace(",-40,", ",+40,"), /line 3: not a whole number/],
      [text.replace("s1,5,", ",5,"), /line 2: an empty name/],
      [text.replace(",90,", ",99999999999999999999,"), /line 2: the time is too large/],
      [text.replace(",-40,60", ",-40,60,1"), /line 3: 8 fields, not 7/],
      // Two lines swapped: every line is fine on its own, but it is not the order the keeper writes.
      [["breaks:inputs:v1,100,200", ...text.trim().split("\n").slice(1).reverse()].join("\n") + "\n", /not in the form the keeper writes it/],
      [text.replace("\n", "\r\n"), /line 1/],
    ];
    for (const [bad, message] of cases) expect(() => parseInputsText(bad), JSON.stringify(bad)).toThrow(message);
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
      // The newer break (`bad`) first: its list and record are held back, its record of the inputs is not.
      ["published", { path: inputsPath(bad) }],
      ["published", { path: `eligibility/${toHex(good.chain.eligibilityRoot)}.json` }],
      ["published", { path: inputsPath(good) }],
      ["published", { path: recordPath(good) }],
      ["published", { path: exclusionsPath(good) }],
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/could not publish a break's lists/);
  });
});
