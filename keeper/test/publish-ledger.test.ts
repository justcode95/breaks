import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildDeliveryPlan } from "../src/delivery/plan.js";
import { toHex } from "../src/draw/bytes.js";
import { poolHash } from "../src/draw/pool.js";
import type { AccountReader } from "../src/pipeline/chain.js";
import { PublishExporter } from "../src/publish/exporter.js";
import { ledgerFile } from "../src/publish/files.js";
import { type Ledger, type LedgerInput, type StoredDelivery, type StoredPack, buildLedger } from "../src/publish/ledger.js";
import { DirSink } from "../src/publish/sink.js";
import { SqlPublishStore } from "../src/publish/store.js";
import { packMachineBytes } from "../src/scheduler/machine.js";
import { type BreakAccount, type BreaksConfigAccount, type SpotAccount, breakAddress, configAddress, spotAddress } from "../src/solana/breaks.js";
import { addressToBytes } from "../src/solana/pubkey.js";
import { encodeBreak, encodeBreaksConfig, encodeSpot } from "./support/accounts.js";
import { drawn } from "./support/bot.js";
import { addr } from "./support/chain.js";
import { insertBreak, migratedDb } from "./support/db.js";
import { PROGRAMS } from "./support/world.js";

// A drawn break of three paid spots and two free ones. Its pack list is two cheap packs (cap $10) and then mid ones (cap $25),
// and its pool is five cards.
const CARDS = [44, 40, 43, 41, 42].map((n) => addr(n));
const BUYER = addr(90);
const TIERS = [
  { machine: packMachineBytes("cheap"), maxPrice: 10_000_000n },
  { machine: packMachineBytes("mid"), maxPrice: 25_000_000n },
];
const chainBreak = (over: Partial<BreakAccount> = {}): BreakAccount =>
  drawn({
    id: 4n,
    spotsSold: 3,
    poolSize: 5,
    tiers: TIERS,
    packs: [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    seed: new Uint8Array(32).fill(7),
    poolHash: poolHash(CARDS.map(addressToBytes)),
    ...over,
  });
const paidSpots = (over: Partial<SpotAccount>[] = []): SpotAccount[] =>
  [10, 11, 12].map((n, i) => ({ breakId: 4n, index: i, owner: addr(n), paid: 20_000_000n, refunded: false, bump: 255, ...over[i] }));
const storedPacks = (): StoredPack[] =>
  CARDS.map((card, i) => ({ index: i, status: "pulled", purchaseSig: `buy-${i}`, price: i < 2 ? 9_000_000n : 24_000_000n, cardMint: card, proofRef: `proof-${i}` }));
/** The deliveries the deliverer would have recorded: the draw's own assignment, all confirmed. */
const storedDeliveries = (b = chainBreak()): StoredDelivery[] =>
  buildDeliveryPlan({ breakId: "1", buyer: BUYER, chain: b, paidSpots: paidSpots(), cards: CARDS }).deliveries.map((d) => ({
    kind: d.spot.kind,
    idx: d.spot.idx,
    recipient: d.recipient,
    cardMint: d.cardMint,
    status: "confirmed",
    txSig: `send-${d.spot.kind}-${d.spot.idx}`,
    adopted: false,
  }));
const input = (over: Partial<LedgerInput> = {}): LedgerInput => ({ chain: chainBreak(), buyer: BUYER, paidSpots: paidSpots(), packs: storedPacks(), deliveries: storedDeliveries(), ...over });
const refused = (over: Partial<LedgerInput>) => {
  try {
    buildLedger(input(over));
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected the ledger to be refused");
};
const edit = <T>(rows: T[], i: number, change: Partial<T>): T[] => rows.map((r, j) => (j === i ? { ...r, ...change } : r));

describe("the ledger of a delivered break", () => {
  it("lists every pack in the order of the pack list and every spot with the card the draw gives it", () => {
    const l = buildLedger(input());
    expect(l.poolHash).toBe(toHex(poolHash(CARDS.map(addressToBytes))));
    expect(l.buyer).toBe(BUYER);
    expect(l.packs).toEqual(CARDS.map((card, i) => ({ index: i, price: i < 2 ? 9_000_000n : 24_000_000n, purchaseTx: `buy-${i}`, card, proof: `proof-${i}` })));
    const plan = buildDeliveryPlan({ breakId: "1", buyer: BUYER, chain: chainBreak(), paidSpots: paidSpots(), cards: CARDS });
    expect(l.spots).toEqual(plan.deliveries.map((d) => ({ kind: d.spot.kind, index: d.spot.idx, wallet: d.recipient, card: d.cardMint, deliveryTx: `send-${d.spot.kind}-${d.spot.idx}` })));
    // Paid spots in purchase order, then the free spots in draw order, to the wallets the chain names.
    expect(l.spots.map((s) => [s.kind, s.index, s.wallet])).toEqual([
      ["paid", 0, addr(10)],
      ["paid", 1, addr(11)],
      ["paid", 2, addr(12)],
      ["free", 0, addr(21)],
      ["free", 1, addr(22)],
    ]);
    // Every card once.
    expect(new Set(l.spots.map((s) => s.card))).toEqual(new Set(CARDS));
  });

  it("does not depend on the order the rows come in", () => {
    expect(buildLedger(input({ packs: storedPacks().reverse(), deliveries: storedDeliveries().reverse() }))).toEqual(buildLedger(input()));
  });

  it("keeps what is not known as not known: a price found in the wallet's history, a missing proof, a card found at its wallet", () => {
    const packs = edit(edit(storedPacks(), 1, { price: undefined }), 2, { proofRef: undefined });
    const deliveries = edit(storedDeliveries(), 3, { txSig: undefined, adopted: true });
    const l = buildLedger(input({ packs, deliveries }));
    expect(l.packs[1]?.price).toBeUndefined();
    expect(l.packs[2]?.proof).toBeUndefined();
    expect(l.spots[3]?.deliveryTx).toBeUndefined();
    // An adopted delivery that does have a transaction keeps it.
    expect(buildLedger(input({ deliveries: edit(storedDeliveries(), 3, { adopted: true }) })).spots[3]?.deliveryTx).toBe("send-free-0");
  });

  it("is refused before the break is drawn", () => {
    for (const status of ["Settled", "Cancelled"] as const) expect(refused({ chain: chainBreak({ status }) })).toBe(`the break is ${status} on chain, not drawn`);
  });

  it("is refused when the packs are not exactly the pool's, each pulled and bought", () => {
    expect(refused({ packs: storedPacks().slice(0, 4) })).toBe("4 packs are stored but the pool has 5");
    expect(refused({ packs: [...storedPacks(), { index: 5, status: "pulled", purchaseSig: "buy-5", cardMint: addr(45) }] })).toBe("6 packs are stored but the pool has 5");
    expect(refused({ packs: edit(storedPacks(), 2, { index: 7 }) })).toBe("pack 2 is missing");
    expect(refused({ packs: edit(storedPacks(), 3, { status: "confirmed" }) })).toBe("pack 3 is confirmed, not pulled");
    expect(refused({ packs: edit(storedPacks(), 3, { cardMint: undefined }) })).toBe("pack 3 has no card");
    expect(refused({ packs: edit(storedPacks(), 0, { purchaseSig: undefined }) })).toBe("pack 0 has no purchase transaction");
  });

  it("is refused when a pack cost more than its own cap, and not when it cost exactly that", () => {
    // Pack 1 is a cheap one: its cap is $10, not the $25 of the break's dearest packs.
    expect(refused({ packs: edit(storedPacks(), 1, { price: 10_000_001n }) })).toBe("pack 1 cost 10000001, above its cap of 10000000");
    expect(buildLedger(input({ packs: edit(storedPacks(), 1, { price: 10_000_000n }) })).packs[1]?.price).toBe(10_000_000n);
    expect(refused({ packs: edit(storedPacks(), 4, { price: 25_000_001n }) })).toBe("pack 4 cost 25000001, above its cap of 25000000");
    // A pool bigger than the pack list has a pack with no cap at all.
    expect(refused({ chain: chainBreak({ packs: [0, 0, 1, 1] }) })).toBe("pack 4 is not in the break's pack list");
  });

  it("is refused when the cards are not the committed pool, or the spots are not the chain's", () => {
    expect(refused({ packs: edit(storedPacks(), 0, { cardMint: addr(49) }) })).toBe("the cards are not the pool that was committed on-chain");
    expect(refused({ paidSpots: paidSpots([{}, { refunded: true }]) })).toBe("spot 1 was refunded");
    expect(refused({ paidSpots: paidSpots().slice(0, 2) })).toBe("2 spots given but 3 were sold");
    expect(refused({ packs: edit(storedPacks(), 0, { cardMint: "not an address" }) })).toBe("a card mint is not a valid address: not an address");
  });

  it("is refused unless every spot's card went, confirmed, to the wallet the draw gives it", () => {
    const d = storedDeliveries();
    expect(refused({ deliveries: d.slice(1) })).toBe("4 deliveries are stored but the break has 5 spots");
    expect(refused({ deliveries: [...d.slice(1), { ...(d[1] as StoredDelivery) }] })).toBe("a spot has two deliveries");
    expect(refused({ deliveries: [...d.slice(0, 4), { ...(d[4] as StoredDelivery), idx: 2 }] })).toBe("free spot 1 has no delivery");
    expect(refused({ deliveries: [...d, { ...(d[4] as StoredDelivery), idx: 2 }] })).toBe("6 deliveries are stored but the break has 5 spots");
    const swapped = edit(edit(d, 0, { cardMint: (d[1] as StoredDelivery).cardMint }), 1, { cardMint: (d[0] as StoredDelivery).cardMint });
    expect(refused({ deliveries: swapped })).toBe(`paid spot 0 was sent card ${(d[1] as StoredDelivery).cardMint}, but the draw gives it ${(d[0] as StoredDelivery).cardMint}`);
    expect(refused({ deliveries: edit(d, 2, { recipient: addr(99) }) })).toBe(`paid spot 2 was sent to ${addr(99)}, but the draw gives its card to ${addr(12)}`);
    expect(refused({ deliveries: edit(d, 2, { recipient: undefined }) })).toBe(`paid spot 2 was sent to nobody, but the draw gives its card to ${addr(12)}`);
    for (const status of ["pending", "submitted", "failed"]) expect(refused({ deliveries: edit(d, 4, { status }) })).toBe(`the delivery of free spot 1 is ${status}, not confirmed`);
    expect(refused({ deliveries: edit(d, 4, { txSig: undefined }) })).toBe("the delivery of free spot 1 has no transaction");
  });
});

describe("the ledger file", () => {
  it("pins the bytes, with what is not known as null", () => {
    const l: Ledger = {
      poolHash: "ab".repeat(32),
      buyer: addr(90),
      packs: [
        { index: 0, price: 9_000_000n, purchaseTx: "buy-0", card: addr(40), proof: "proof-0" },
        { index: 1, price: undefined, purchaseTx: "buy-1", card: addr(41), proof: undefined },
      ],
      spots: [
        { kind: "paid", index: 0, wallet: addr(10), card: addr(41), deliveryTx: "send-0" },
        { kind: "free", index: 0, wallet: addr(21), card: addr(40), deliveryTx: undefined },
      ],
    };
    expect(ledgerFile(l)).toEqual({
      path: `ledger/${"ab".repeat(32)}.json`,
      body:
        `{"version":1,"kind":"ledger","poolHash":"${"ab".repeat(32)}","buyer":"${addr(90)}",` +
        `"packs":[{"index":0,"price":"9000000","purchaseTx":"buy-0","card":"${addr(40)}","proof":"proof-0"},{"index":1,"price":null,"purchaseTx":"buy-1","card":"${addr(41)}","proof":null}],` +
        `"spots":[{"kind":"paid","index":0,"wallet":"${addr(10)}","card":"${addr(41)}","deliveryTx":"send-0"},{"kind":"free","index":0,"wallet":"${addr(21)}","card":"${addr(40)}","deliveryTx":null}]}\n`,
    });
  });

  it("keeps a price above 2^53 exact", () => {
    const l: Ledger = { poolHash: "00".repeat(32), buyer: addr(90), packs: [{ index: 0, price: 18_446_744_073_709_551_000n, purchaseTx: "t", card: addr(1), proof: undefined }], spots: [] };
    expect(JSON.parse(ledgerFile(l).body).packs[0].price).toBe("18446744073709551000");
  });
});

// The exporter, against a migrated database and a chain that serves the break, its spots and the program's config.
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
  await db.exec("truncate deliveries, spots, packs, twab_snapshots, eligibility_lists, published_documents, breaks cascade");
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = await mkdtemp(join(tmpdir(), "ledger-test-"));
});

const CONFIG: BreaksConfigAccount = {
  admin: addr(80),
  keeper: addr(81),
  buyer: BUYER,
  usdcMint: addr(82),
  randomnessProgram: addr(83),
  randomnessTimeoutSecs: 600n,
  nextBreakId: 5n,
  minWindowSecs: 3600n,
  maxWindowSecs: 21_600n,
  maxPaidSpots: 10,
  maxFreeSpots: 16,
  paused: false,
  bump: 255,
};

/** A break the keeper has delivered: its packs, its spots and its deliveries as the jobs record them. */
async function delivered(status = "delivered", deliveries = storedDeliveries()): Promise<string> {
  const breakId = await insertBreak(db);
  await db.query("update breaks set onchain_id = 4, status = $2 where id = $1::bigint", [breakId, status]);
  for (const p of storedPacks()) {
    await db.query("insert into packs (break_id, pack_index, status, purchase_sig, price, card_mint, proof_ref) values ($1::bigint, $2, 'pulled', $3, $4::bigint, $5, $6)", [
      breakId,
      p.index,
      p.purchaseSig,
      p.price?.toString(),
      p.cardMint,
      p.proofRef,
    ]);
  }
  for (const d of deliveries) {
    const wallet = d.kind === "paid" ? addr(10 + d.idx) : addr(21 + d.idx);
    const { rows } = await db.query<{ id: string }>("insert into spots (break_id, kind, idx, wallet, paid) values ($1::bigint, $2, $3, $4, $5::bigint) returning id::text as id", [
      breakId,
      d.kind,
      d.idx,
      wallet,
      d.kind === "paid" ? "20000000" : null,
    ]);
    await db.query("insert into deliveries (break_id, spot_id, card_mint, status, tx_sig, recipient, adopted) values ($1::bigint, $2::bigint, $3, $4, $5, $6, $7)", [
      breakId,
      rows[0]?.id,
      d.cardMint,
      d.status,
      d.txSig ?? null,
      d.recipient ?? null,
      d.adopted,
    ]);
  }
  return breakId;
}

function chainOf(b = chainBreak(), opts: { config?: boolean; spots?: number } = {}) {
  const accounts = new Map<string, Uint8Array>([[breakAddress(PROGRAMS, b.id), encodeBreak(b)]]);
  if (opts.config !== false) accounts.set(configAddress(PROGRAMS), encodeBreaksConfig(CONFIG));
  const key = breakAddress(PROGRAMS, b.id);
  for (const s of paidSpots().slice(0, opts.spots ?? 3)) accounts.set(spotAddress(PROGRAMS, key, s.index), encodeSpot(s));
  const reads: string[] = [];
  const reader: AccountReader = {
    async getAccountData(a) {
      reads.push(a);
      return accounts.get(a);
    },
  };
  return { reader, reads };
}
const exporter = (reader: AccountReader) => new PublishExporter({ store: new SqlPublishStore(sql), sink: new DirSink(dir), chain: reader, programs: PROGRAMS });
const LEDGER = `ledger/${toHex(poolHash(CARDS.map(addressToBytes)))}.json`;
const POOL = `pool/${toHex(poolHash(CARDS.map(addressToBytes)))}.json`;

describe("publishing the ledger", () => {
  it("writes it once every card is delivered, from what the tables hold and the chain commits, next to the cards", async () => {
    await delivered();
    const report = await exporter(chainOf().reader).run();
    expect(report).toEqual({ written: [POOL, LEDGER], problems: [] });
    expect(await readFile(join(dir, LEDGER), "utf8")).toBe(ledgerFile(buildLedger(input())).body);
    // The buyer wallet is the one the program's config names, not the keeper or anyone else.
    expect(JSON.parse(await readFile(join(dir, LEDGER), "utf8")).buyer).toBe(CONFIG.buyer);
  });

  it("keeps each break's packs and deliveries apart", async () => {
    await delivered();
    // Another break of the keeper's, with its own packs, spots and deliveries (and cards of its own: a card is in one pack).
    const other = await insertBreak(db);
    await db.query("update breaks set onchain_id = 3, status = 'funded' where id = $1::bigint", [other]);
    for (const i of [0, 1, 2]) {
      await db.query("insert into packs (break_id, pack_index, status, purchase_sig, card_mint) values ($1::bigint, $2, 'pulled', $3, $4)", [other, i, `other-buy-${i}`, addr(60 + i)]);
    }
    const { rows } = await db.query<{ id: string }>("insert into spots (break_id, kind, idx, wallet, paid) values ($1::bigint, 'paid', 0, $2, 20000000) returning id::text as id", [other, addr(70)]);
    await db.query("insert into deliveries (break_id, spot_id, card_mint, status, recipient) values ($1::bigint, $2::bigint, $3, 'pending', $4)", [other, rows[0]?.id, addr(60), addr(70)]);
    const report = await exporter(chainOf().reader).run();
    expect(report.problems).toEqual([]);
    expect(report.written).toContain(LEDGER);
    expect(await readFile(join(dir, LEDGER), "utf8")).toBe(ledgerFile(buildLedger(input())).body);
  });

  it("reads the store's rows as the jobs wrote them: prices, proofs and an adopted delivery", async () => {
    const deliveries = edit(storedDeliveries(), 3, { txSig: undefined, adopted: true });
    const breakId = await delivered("delivered", deliveries);
    await db.query("update packs set price = null, proof_ref = null where break_id = $1::bigint and pack_index = 1", [breakId]);
    // Paid spots first, each kind in order; what is null in the tables is left out.
    const read = await new SqlPublishStore(sql).ledger(breakId);
    expect(read).toEqual({ packs: edit(storedPacks(), 1, { price: undefined, proofRef: undefined }), deliveries });
    expect(read.packs[1]).not.toHaveProperty("price");
    expect(read.deliveries[3]).not.toHaveProperty("txSig");
    await exporter(chainOf().reader).run();
    const doc = JSON.parse(await readFile(join(dir, LEDGER), "utf8"));
    expect(doc.packs[1]).toEqual({ index: 1, price: null, purchaseTx: "buy-1", card: CARDS[1], proof: null });
    expect(doc.spots[3].deliveryTx).toBeNull();
  });

  it("is quiet when run again: nothing is written and the chain is not read", async () => {
    await delivered();
    await exporter(chainOf().reader).run();
    const chain = chainOf();
    expect(await exporter(chain.reader).run()).toEqual({ written: [], problems: [] });
    expect(chain.reads).toEqual([]);
  });

  it("does not publish a ledger before every card is delivered", async () => {
    await delivered("drawn");
    expect(await exporter(chainOf().reader).run()).toEqual({ written: [POOL], problems: [] });
    expect(await readdir(join(dir, "ledger")).catch(() => [])).toEqual([]);
  });

  it("reports a ledger that does not add up, writes nothing for it, and still publishes the cards", async () => {
    await delivered("delivered", edit(storedDeliveries(), 2, { recipient: addr(99) }));
    const report = await exporter(chainOf().reader).run();
    expect(report.written).toEqual([POOL]);
    expect(report.problems).toEqual([{ breakId: expect.any(String), message: `the ledger does not add up: paid spot 2 was sent to ${addr(99)}, but the draw gives its card to ${addr(12)}; nothing was published` }]);
    expect(await readdir(join(dir, "ledger")).catch(() => [])).toEqual([]);
  });

  it("reports what it cannot read on chain: the program's config, a paid spot", async () => {
    await delivered();
    expect((await exporter(chainOf(chainBreak(), { config: false }).reader).run()).problems.map((p) => p.message)).toEqual(["the breaks program has no config account on chain"]);
    expect((await exporter(chainOf(chainBreak(), { spots: 2 }).reader).run()).problems.map((p) => p.message)).toEqual(["spot 2 of break 4 has no account on chain"]);
    expect(await readdir(join(dir, "ledger")).catch(() => [])).toEqual([]);
  });

  it("goes by the chain, not the tables: a break the chain does not call drawn has no ledger", async () => {
    await delivered();
    const report = await exporter(chainOf(chainBreak({ status: "Settled" })).reader).run();
    expect(report.problems.map((p) => p.message)).toEqual(["the ledger does not add up: the break is Settled on chain, not drawn; nothing was published"]);
  });
});
