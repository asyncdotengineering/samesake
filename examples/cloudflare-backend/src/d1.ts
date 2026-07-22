import { Database } from "bun:sqlite";

export type DB = Database;

export function openDb(path: string): DB {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  return db;
}

export function createSchema(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS catalog (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      pipeline_status TEXT NOT NULL DEFAULT 'pending',
      enriched TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      gate_reason TEXT,
      doc TEXT,
      rerank_doc TEXT,
      fts_src TEXT,
      fts_src_a TEXT,
      product_group TEXT,
      seq INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS catalog_dirty_idx
      ON catalog (pipeline_status, next_attempt_at, seq);
    CREATE TABLE IF NOT EXISTS declined_pairs (
      a TEXT NOT NULL,
      b TEXT NOT NULL,
      PRIMARY KEY (a, b)
    );
    CREATE TABLE IF NOT EXISTS vocab (
      field TEXT NOT NULL,
      value TEXT NOT NULL,
      count INTEGER NOT NULL,
      PRIMARY KEY (field, value)
    );
  `);
}

export function nextSeq(db: DB): number {
  const row = db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM catalog").get() as { next_seq: number };
  return row.next_seq;
}
