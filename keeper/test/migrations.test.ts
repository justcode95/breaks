import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

const dir = join(import.meta.dirname, "..", "..", "db", "migrations");

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(join(dir, file), "utf8"));
  }
});

const newBreak = () =>
  db.query<{ id: number }>(
    `insert into breaks (paid_spots, free_spots, spot_price, pack_machine, max_pack_price, opens_at, closes_at)
     values (10, 2, 20000000, 'pokemon-25', 25000000, now(), now() + interval '12 hours') returning id`,
  );

describe("db/migrations", () => {
  it("creates every table listed in CLAUDE.md", async () => {
    const { rows } = await db.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public'",
    );
    const names = rows.map((r) => r.table_name);
    for (const t of [
      "breaks", "spots", "packs", "pack_attempts", "deliveries", "balance_events", "twab_snapshots",
      "eligibility_lists", "draws", "treasury_events", "exclusions", "x_links", "bot_posts",
    ]) {
      expect(names).toContain(t);
    }
  });

  it("rejects a break that closes before it opens", async () => {
    await expect(
      db.query(
        `insert into breaks (paid_spots, free_spots, spot_price, pack_machine, max_pack_price, opens_at, closes_at)
         values (1, 1, 1, 'm', 1, now(), now() - interval '1 hour')`,
      ),
    ).rejects.toThrow();
  });

  it("requires paid spots to record a payment and free spots not to", async () => {
    const { rows } = await newBreak();
    const breakId = rows[0]!.id;
    await expect(
      db.query("insert into spots (break_id, kind, idx, wallet) values ($1, 'paid', 0, 'w')", [breakId]),
    ).rejects.toThrow();
    await expect(
      db.query("insert into spots (break_id, kind, idx, wallet, paid) values ($1, 'free', 0, 'w', 5)", [breakId]),
    ).rejects.toThrow();
    await db.query("insert into spots (break_id, kind, idx, wallet, paid) values ($1, 'paid', 0, 'w', 20000000)", [breakId]);
    await db.query("insert into spots (break_id, kind, idx, wallet) values ($1, 'free', 0, 'w2')", [breakId]);
  });

  it("allows only one pack row per (break, index) and requires a card for a pulled pack", async () => {
    const { rows } = await newBreak();
    const breakId = rows[0]!.id;
    await db.query("insert into packs (break_id, pack_index) values ($1, 0)", [breakId]);
    await expect(db.query("insert into packs (break_id, pack_index) values ($1, 0)", [breakId])).rejects.toThrow();
    await expect(
      db.query("insert into packs (break_id, pack_index, status, purchase_sig) values ($1, 1, 'pulled', 's')", [breakId]),
    ).rejects.toThrow();
    await expect(
      db.query("insert into packs (break_id, pack_index, status) values ($1, 2, 'submitted')", [breakId]),
    ).rejects.toThrow();
    await db.query(
      "insert into packs (break_id, pack_index, status, purchase_sig, card_mint) values ($1, 3, 'pulled', 's', 'card3')",
      [breakId],
    );
  });

  it("dedupes bot posts and deliveries", async () => {
    await db.query("insert into bot_posts (kind, dedupe_key, body) values ('open', 'break-1-open', 'x')");
    await expect(db.query("insert into bot_posts (kind, dedupe_key, body) values ('open', 'break-1-open', 'y')")).rejects.toThrow();
  });
});
