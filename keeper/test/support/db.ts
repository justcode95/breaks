import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const dir = join(import.meta.dirname, "..", "..", "..", "db", "migrations");

/** An in-memory Postgres with every migration applied. */
export async function migratedDb(): Promise<PGlite> {
  const db = new PGlite();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(join(dir, file), "utf8"));
  }
  return db;
}

/** Inserts a break (packs reference one) and returns its id as text. */
export async function insertBreak(db: PGlite): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into breaks (paid_spots, free_spots, spot_price, pack_machine, max_pack_price, opens_at, closes_at)
     values (10, 2, 20000000, 'pokemon-25', 25000000, now(), now() + interval '12 hours') returning id::text as id`,
  );
  return rows[0]!.id;
}
