import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { toHex } from "../src/draw/bytes.js";
import { Tree } from "../src/draw/tree.js";
import { DbPublisher, SqlEligibilityPlanner } from "../src/eligibility/planner.js";
import { inputsHash } from "../src/eligibility/eligibility.js";
import { exclusionProblem, exclusionsDocument, parseExclusions } from "../src/eligibility/exclusions.js";
import type { BalanceEvent } from "../src/eligibility/twab.js";
import { addressFromBytes, addressToBytes } from "../src/solana/pubkey.js";
import { insertBreak, migratedDb } from "./support/db.js";

// Real wallets (on the curve), because program-derived addresses are never eligible.
const wallet = (n: number) => addressFromBytes(ed25519.getPublicKey(new Uint8Array(32).fill(n)));
const START = 1_000_000;
const END = START + 86_400;
const WINDOW = { start: START, end: END };
const POLICY = { minTwab: 100n };
const SETTLE = 120;

let db: PGlite;
beforeAll(async () => {
  db = await migratedDb();
});

async function event(e: { owner: string; account: string; time: number; delta: bigint; after: bigint; signature: string; slot?: number }) {
  await db.query(
    "insert into balance_events (signature, slot, block_time, owner, token_account, delta, balance_after) values ($1, $2, to_timestamp($3), $4, $5, $6::numeric, $7::numeric)",
    [e.signature, e.slot ?? e.time, e.time, e.owner, e.account, e.delta.toString(), e.after.toString()],
  );
}

async function indexerAt(time: number) {
  await db.query(
    "insert into indexer_state (id, indexed_until) values (1, to_timestamp($1)) on conflict (id) do update set indexed_until = excluded.indexed_until",
    [time],
  );
}

/** A fresh break and fresh wallets, so tests sharing one database never see each other's balances. */
let counter = 10;
async function clean() {
  // balance_events and exclusions are global (one coin), so every scenario starts from an empty history.
  await db.query("delete from balance_events");
  await db.query("delete from exclusions");
}

async function scenario() {
  await clean();
  const id = await insertBreak(db);
  const n = (counter += 10);
  const [a, b, c, d] = [wallet(n), wallet(n + 1), wallet(n + 2), wallet(n + 3)];
  const tag = `${id}`;
  // A held 1000 from before the window: TWAB 1000. B bought 1000 half way through: TWAB 500.
  // C held 50 the whole time: below the minimum. D held 1000 the whole time but is excluded (team).
  await event({ owner: a, account: `acct-a-${tag}`, time: START - 500, delta: 1000n, after: 1000n, signature: `sig-a-${tag}` });
  await event({ owner: b, account: `acct-b-${tag}`, time: START + 43_200, delta: 1000n, after: 1000n, signature: `sig-b-${tag}` });
  await event({ owner: c, account: `acct-c-${tag}`, time: START - 500, delta: 50n, after: 50n, signature: `sig-c-${tag}` });
  await event({ owner: d, account: `acct-d-${tag}`, time: START - 500, delta: 1000n, after: 1000n, signature: `sig-d-${tag}` });
  await db.query("insert into exclusions (wallet, reason_code) values ($1, 'team') on conflict (wallet) do nothing", [d]);
  return { id, a, b, c, d, tag };
}

const planner = () => new SqlEligibilityPlanner(db, new DbPublisher(db), { policy: POLICY, settleSecs: SETTLE });

describe("SqlEligibilityPlanner: when to compute", () => {
  it("waits while the indexer has reported nothing", async () => {
    await db.query("delete from indexer_state");
    const { id } = await scenario();
    const plan = await planner().plan(id, WINDOW);
    expect(plan).toEqual({ kind: "wait", reason: "the balance indexer has not reported any progress yet" });
    expect(await planner().committed(id)).toBeUndefined();
  });

  it("waits until the indexer is past the end of the window by the margin, then computes", async () => {
    const { id } = await scenario();
    await indexerAt(END + SETTLE - 1);
    const early = await planner().plan(id, WINDOW);
    expect(early.kind).toBe("wait");
    expect(early.kind === "wait" && early.reason).toContain(`needs ${END + SETTLE}`);
    expect(await planner().committed(id)).toBeUndefined();

    await indexerAt(END + SETTLE);
    expect((await planner().plan(id, WINDOW)).kind).toBe("ready");
  });
});

describe("SqlEligibilityPlanner: what it computes", () => {
  it("weights holders by time-weighted balance and leaves out the rest, with reasons", async () => {
    const { id, a, b, c, d } = await scenario();
    await indexerAt(END + SETTLE);
    const plan = await planner().plan(id, WINDOW);
    if (plan.kind !== "ready") throw new Error(plan.reason);

    expect(plan.values.entryCount).toBe(2);
    expect(plan.values.totalWeight).toBe(1500n); // A 1000 + B 500
    const leaves = [a, b].map((w) => ({ wallet: addressToBytes(w), weight: w === a ? 1000n : 500n })).sort((x, y) => Buffer.compare(Buffer.from(x.wallet), Buffer.from(y.wallet)));
    expect(toHex(plan.values.root)).toBe(toHex(Tree.build(leaves).root.hash));

    const rows = await db.query<{ wallet: string; twab: string; weight: string; eligible: boolean; reason: string | null }>(
      "select wallet, twab::text as twab, weight::text as weight, eligible, reason from twab_snapshots where break_id = $1 order by wallet",
      [id],
    );
    const byWallet = new Map(rows.rows.map((r) => [r.wallet, r]));
    expect(byWallet.get(a)).toMatchObject({ twab: "1000", weight: "1000", eligible: true, reason: null });
    expect(byWallet.get(b)).toMatchObject({ twab: "500", weight: "500", eligible: true, reason: null });
    expect(byWallet.get(c)).toMatchObject({ twab: "50", weight: "0", eligible: false, reason: "below_min_twab" });
    expect(byWallet.get(d)).toMatchObject({ eligible: false, reason: "excluded:team" });
    expect(rows.rows).toHaveLength(4);
  });

  it("publishes what inputs_hash commits to, so anyone can recompute it", async () => {
    const { id } = await scenario();
    await indexerAt(END + SETTLE);
    const plan = await planner().plan(id, WINDOW);
    if (plan.kind !== "ready") throw new Error(plan.reason);

    const { rows } = await db.query<{ list_uri: string; inputs_uri: string }>("select list_uri, inputs_uri from eligibility_lists where break_id = $1", [id]);
    const doc = async (uri: string) => (await db.query<{ body: string; content_type: string }>("select body, content_type from published_documents where sha256 = $1", [uri.replace("db:sha256:", "")])).rows[0]!;

    const inputs = await doc(rows[0]!.inputs_uri);
    expect(createHash("sha256").update(inputs.body, "utf8").digest("hex")).toBe(toHex(plan.values.inputsHash));
    expect(inputs.body.startsWith(`breaks:inputs:v1,${START},${END}\n`)).toBe(true);

    const list = JSON.parse((await doc(rows[0]!.list_uri)).body);
    expect(list).toMatchObject({ version: 1, breakId: id, window: WINDOW, totalWeight: "1500", entryCount: 2, inputsHash: toHex(plan.values.inputsHash), root: toHex(plan.values.root) });
    expect(list.policy).toEqual({ minTwab: "100" });
    expect(list.wallets).toHaveLength(4);
    expect(list.wallets.find((w: { reason: string | null }) => w.reason === "excluded:team")).toBeTruthy();
  });

  it("uses only events before the end of the window", async () => {
    const { id, tag } = await scenario();
    const late = wallet(counter + 50);
    await event({ owner: late, account: `acct-late-${tag}`, time: END, delta: 5000n, after: 5000n, signature: `sig-late-${tag}` });
    await event({ owner: late, account: `acct-late2-${tag}`, time: END - 1, delta: 5000n, after: 5000n, signature: `sig-late2-${tag}` });
    await indexerAt(END + SETTLE);
    const plan = await planner().plan(id, WINDOW);
    if (plan.kind !== "ready") throw new Error(plan.reason);
    expect(plan.values.entryCount).toBe(2);
    const { rows } = await db.query<{ inputs_uri: string }>("select inputs_uri from eligibility_lists where break_id = $1", [id]);
    const body = (await db.query<{ body: string }>("select body from published_documents where sha256 = $1", [rows[0]!.inputs_uri.replace("db:sha256:", "")])).rows[0]!.body;
    expect(body).toContain(`sig-late2-${tag}`);
    expect(body).not.toContain(`sig-late-${tag}`);
  });

  it("applies the cap when there is one", async () => {
    const { id, a } = await scenario();
    await indexerAt(END + SETTLE);
    const capped = new SqlEligibilityPlanner(db, new DbPublisher(db), { policy: { minTwab: 100n, capPerWallet: 300n }, settleSecs: SETTLE });
    const plan = await capped.plan(id, WINDOW);
    if (plan.kind !== "ready") throw new Error(plan.reason);
    expect(plan.values.totalWeight).toBe(600n); // A 300 (capped) + B 300 (capped)
    const row = await db.query<{ weight: string }>("select weight::text as weight from twab_snapshots where break_id = $1 and wallet = $2", [id, a]);
    expect(row.rows[0]?.weight).toBe("300");
  });

  it("commits an empty list as a zero root, zero weight and zero entries", async () => {
    await clean();
    const id = await insertBreak(db);
    await indexerAt(END + SETTLE);
    const plan = await planner().plan(id, WINDOW);
    if (plan.kind !== "ready") throw new Error(plan.reason);
    expect(plan.values).toMatchObject({ totalWeight: 0n, entryCount: 0 });
    expect(toHex(plan.values.root)).toBe("00".repeat(32));
    expect(toHex(plan.values.inputsHash)).toBe(toHex(inputsHash([] as BalanceEvent[], WINDOW)));
  });
});

describe("SqlEligibilityPlanner: it computes once", () => {
  it("returns the stored list however the history or the exclusions change afterwards", async () => {
    const { id, a, tag } = await scenario();
    await indexerAt(END + SETTLE);
    const first = await planner().plan(id, WINDOW);
    if (first.kind !== "ready") throw new Error(first.reason);
    const docsBefore = (await db.query<{ n: string }>("select count(*)::text as n from published_documents")).rows[0]!.n;

    // Things change: a new exclusion, a late event inside the window.
    await db.query("insert into exclusions (wallet, reason_code) values ($1, 'exchange') on conflict (wallet) do nothing", [a]);
    await event({ owner: wallet(counter + 60), account: `acct-new-${tag}`, time: START + 10, delta: 9999n, after: 9999n, signature: `sig-new-${tag}` });

    const second = await planner().plan(id, WINDOW);
    expect(second).toEqual(first);
    expect(await planner().committed(id)).toEqual(first.values);
    expect((await db.query<{ n: string }>("select count(*)::text as n from published_documents")).rows[0]!.n).toBe(docsBefore);
    expect((await db.query<{ n: string }>("select count(*)::text as n from twab_snapshots where break_id = $1", [id])).rows[0]!.n).toBe("4");
  });

  it("recovers from a crash that left snapshot rows but no list", async () => {
    const { id } = await scenario();
    await indexerAt(END + SETTLE);
    await db.query("insert into twab_snapshots (break_id, wallet, twab, weight, eligible, reason) values ($1, 'stale-wallet', 1, 1, true, null)", [id]);
    expect(await planner().committed(id)).toBeUndefined();
    const plan = await planner().plan(id, WINDOW);
    expect(plan.kind).toBe("ready");
    const stale = await db.query("select 1 from twab_snapshots where break_id = $1 and wallet = 'stale-wallet'", [id]);
    expect(stale.rows).toHaveLength(0);
  });

  it("two planners at the same time end with one stored list, and both report it", async () => {
    const { id } = await scenario();
    await indexerAt(END + SETTLE);
    const [x, y] = await Promise.all([planner().plan(id, WINDOW), planner().plan(id, WINDOW)]);
    expect(x).toEqual(y);
    expect((await db.query<{ n: string }>("select count(*)::text as n from eligibility_lists where break_id = $1", [id])).rows[0]!.n).toBe("1");
  });
});

describe("SqlEligibilityPlanner: the exclusion list it used", () => {
  const storedExclusions = async (id: string) => {
    const { rows } = await db.query<{ uri: string | null; body: string | null }>(
      "select e.exclusions_uri as uri, p.body from eligibility_lists e left join published_documents p on e.exclusions_uri = 'db:sha256:' || p.sha256 where e.break_id = $1",
      [id],
    );
    return rows[0];
  };

  it("stores the whole active list with the list: every wallet and its code, also those that held nothing, and never the note", async () => {
    const { id, d } = await scenario();
    const [never, removed] = [wallet(counter + 7), wallet(counter + 8)];
    await db.query("update exclusions set note = 'private: flagged by a friend' where wallet = $1", [d]);
    await db.query("insert into exclusions (wallet, reason_code, note) values ($1, 'bundle', 'also private')", [never]);
    await db.query("insert into exclusions (wallet, reason_code, removed_at) values ($1, 'exchange', now())", [removed]);
    await indexerAt(END + SETTLE);
    const plan = await planner().plan(id, WINDOW);
    if (plan.kind !== "ready") throw new Error(plan.reason);

    const stored = await storedExclusions(id);
    expect(stored?.body).toBe(exclusionsDocument(plan.values.inputsHash, new Map([[d, "team"], [never, "bundle"]])));
    expect(stored?.uri).toBe(`db:sha256:${createHash("sha256").update(stored?.body ?? "").digest("hex")}`);
    expect(stored?.body).not.toContain("private");
    expect(stored?.body).not.toContain(removed);
    expect(parseExclusions(stored?.body ?? "").inputsHash).toBe(toHex(plan.values.inputsHash));
  });

  it("keeps the list it used however the exclusions change afterwards", async () => {
    const { id, a, d } = await scenario();
    await indexerAt(END + SETTLE);
    const first = await planner().plan(id, WINDOW);
    if (first.kind !== "ready") throw new Error(first.reason);
    const before = await storedExclusions(id);
    await db.query("insert into exclusions (wallet, reason_code) values ($1, 'exchange')", [a]);
    await db.query("update exclusions set removed_at = now() where wallet = $1", [d]);
    await planner().plan(id, WINDOW);
    expect(await storedExclusions(id)).toEqual(before);
  });

  it("stores an empty list when nothing is excluded", async () => {
    const { id } = await scenario();
    await db.query("delete from exclusions");
    await indexerAt(END + SETTLE);
    const plan = await planner().plan(id, WINDOW);
    if (plan.kind !== "ready") throw new Error(plan.reason);
    expect((await storedExclusions(id))?.body).toBe(`{"version":1,"kind":"exclusions","inputsHash":"${toHex(plan.values.inputsHash)}","entries":[]}\n`);
  });

  it("is a problem for a person, and stores nothing, while a row is one the public list cannot carry", async () => {
    for (const [wallet_, code] of [["not-a-wallet", "team"], [wallet(counter + 9), "has space"], [wallet(counter + 9), ""], [wallet(counter + 9), "x".repeat(65)]] as const) {
      const { id } = await scenario();
      await db.query("insert into exclusions (wallet, reason_code) values ($1, $2)", [wallet_, code]);
      await indexerAt(END + SETTLE);
      const docs = (await db.query<{ n: string }>("select count(*)::text as n from published_documents")).rows[0]!.n;
      const plan = await planner().plan(id, WINDOW);
      expect(plan, `${wallet_} ${code}`).toEqual({ kind: "problem", reason: `the exclusions table has a row the public exclusion list cannot carry: ${exclusionProblem(wallet_, code)}; fix or remove it` });
      expect(plan.kind === "problem" && plan.reason).toContain(code === "team" ? '"not-a-wallet" is not a Solana address' : `the code of ${wallet_}`);
      expect(await planner().committed(id)).toBeUndefined();
      expect((await db.query<{ n: string }>("select count(*)::text as n from published_documents")).rows[0]!.n).toBe(docs);
      expect((await db.query<{ n: string }>("select count(*)::text as n from twab_snapshots where break_id = $1", [id])).rows[0]!.n).toBe("0");
      // Fixed: the list is made.
      await db.query("delete from exclusions where wallet = $1", [wallet_]);
      expect((await planner().plan(id, WINDOW)).kind).toBe("ready");
    }
  });

  it("is not stopped by a bad row that was removed", async () => {
    const { id } = await scenario();
    await db.query("insert into exclusions (wallet, reason_code, removed_at) values ('not-a-wallet', 'team', now())");
    await indexerAt(END + SETTLE);
    expect((await planner().plan(id, WINDOW)).kind).toBe("ready");
  });
});

describe("DbPublisher", () => {
  it("addresses a document by its hash and stores it once", async () => {
    const pub = new DbPublisher(db);
    const body = `hello ${Math.random()}`;
    const uri = await pub.publish({ contentType: "text/plain", body });
    expect(uri).toBe(`db:sha256:${createHash("sha256").update(body).digest("hex")}`);
    expect(await pub.publish({ contentType: "text/plain", body })).toBe(uri);
    expect((await db.query<{ n: string }>("select count(*)::text as n from published_documents where sha256 = $1", [uri.slice(10)])).rows[0]!.n).toBe("1");
    expect(await pub.publish({ contentType: "text/plain", body: `${body}!` })).not.toBe(uri);
  });
});
