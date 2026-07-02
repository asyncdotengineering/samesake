import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { SQL } from "drizzle-orm";
import type { CollectionDef } from "@samesake/core";
import { computeFacets, type FacetResult } from "./postgres/facets.ts";
import { getPgClient, getPgSql, type PgUnsafe } from "../core/db-utils.ts";

/** Inputs for a facet aggregation over a collection's filtered candidate set. */
export interface FacetQuery {
  table: string;
  def: CollectionDef;
  where: string;
  params: unknown[];
  facetNames: string[];
}

/**
 * The database contract the engine depends on. The intent (see issue #59) is for
 * every database operation — schema/DDL, upsert, hybrid search, facets, … — to
 * become a method here, so the core never touches a raw driver and a future
 * dialect is an additive implementation rather than a rewrite.
 *
 * Migration is incremental: `db` is the escape hatch for operations not yet
 * relocated behind a method, and is removed once they all are.
 */
export interface StorageAdapter {
  /** Drizzle handle for portable query-builder operations (insert/update/select). */
  readonly db: PostgresJsDatabase;
  /** Raw parameterized-query client (`.unsafe(sql, params)`) for dialect-specific SQL. */
  client(context?: string): PgUnsafe;
  /** Execute a Drizzle `sql` template; returns the driver result (rows for SELECTs). */
  exec<T = unknown>(query: SQL): Promise<T>;
  /** Run `fn` inside a single DB transaction — everything commits together or rolls back on throw. */
  transaction<T>(fn: (tx: PostgresJsDatabase) => Promise<T>): Promise<T>;
  /** Close the connection. No-op when the consumer owns the handle. */
  close(): Promise<void>;
  /** Facet aggregation over the filtered candidate set. */
  facets(query: FacetQuery): Promise<Record<string, FacetResult>>;
  /** Mark a pipeline row failed: bump attempt count, store the error, set exponential backoff. */
  recordFailure(table: string, rowId: string, message: string): Promise<void>;
  /** A single row's `data` column by id (agent image lookup). */
  rowData(table: string, id: string): Promise<Record<string, unknown> | undefined>;
  /** `indexed_at` / `updated_at` for a set of ids (staleness check). */
  indexStatus(table: string, ids: string[]): Promise<Array<Record<string, unknown>>>;
  /** Mark failed rows past max attempts as dead; returns how many. */
  markDead(table: string, maxAttempts: number): Promise<number>;
  /** Failed rows due for retry (under max attempts). */
  retryableRows(table: string, maxAttempts: number, limit: number): Promise<Array<Record<string, unknown>>>;
  /**
   * Upsert a source document (content-hash-aware `updated_at`). `scopeCols`
   * maps scope column name → value; on id conflict with a DIFFERENT scope the
   * upsert is rejected (cross-tenant id takeover).
   */
  upsertDocument(
    table: string,
    id: string,
    dataJson: string,
    contentHash: string,
    scopeCols?: Record<string, string>
  ): Promise<void>;
  /** Delete documents by id (constrained to `scopeCols` when given); returns how many were removed. */
  deleteDocuments(table: string, ids: string[], scopeCols?: Record<string, string>): Promise<number>;
  /** Installed pgvector version as [major, minor], cached; null when absent. */
  pgvectorVersion(): Promise<[number, number] | null>;
  /**
   * Run a parameterized query with `SET LOCAL` session settings scoped to it
   * (one transaction). With no settings, behaves like `client().unsafe`.
   */
  unsafeWithSettings(
    context: string,
    settings: string[],
    query: string,
    params: unknown[]
  ): Promise<Record<string, unknown>[]>;
}

/**
 * Postgres implementation of {@link StorageAdapter}. Owns the connection
 * lifecycle; all Postgres-specific SQL (pgvector, FTS, RRF) lives here as
 * operations are migrated.
 */
export class PostgresAdapter implements StorageAdapter {
  #pgvectorVersion: [number, number] | null | undefined;

  constructor(private readonly handle: { db: PostgresJsDatabase; close: () => Promise<void> }) {}

  get db(): PostgresJsDatabase {
    return this.handle.db;
  }

  client(context = "query"): PgUnsafe {
    return getPgClient(this.handle.db, context);
  }

  async pgvectorVersion(): Promise<[number, number] | null> {
    if (this.#pgvectorVersion !== undefined) return this.#pgvectorVersion;
    const rows = await getPgClient(this.handle.db, "capabilities").unsafe(
      `SELECT extversion FROM pg_extension WHERE extname = 'vector'`
    );
    const raw = rows[0]?.extversion;
    const m = typeof raw === "string" ? raw.match(/^(\d+)\.(\d+)/) : null;
    this.#pgvectorVersion = m ? [Number(m[1]), Number(m[2])] : null;
    return this.#pgvectorVersion;
  }

  async unsafeWithSettings(
    context: string,
    settings: string[],
    query: string,
    params: unknown[]
  ): Promise<Record<string, unknown>[]> {
    const sql = getPgSql(this.handle.db, context);
    if (!settings.length) return sql.unsafe(query, params);
    return sql.begin(async (tx) => {
      for (const s of settings) await tx.unsafe(s);
      return tx.unsafe(query, params);
    });
  }

  transaction<T>(fn: (tx: PostgresJsDatabase) => Promise<T>): Promise<T> {
    return this.handle.db.transaction((tx) => fn(tx as unknown as PostgresJsDatabase));
  }

  async exec<T = unknown>(query: SQL): Promise<T> {
    return (await this.handle.db.execute(query)) as T;
  }

  close(): Promise<void> {
    return this.handle.close();
  }

  facets(q: FacetQuery): Promise<Record<string, FacetResult>> {
    return computeFacets(this.db, q.table, q.def, q.where, q.params, q.facetNames);
  }

  async recordFailure(table: string, rowId: string, message: string): Promise<void> {
    await getPgClient(this.handle.db, "pipeline-failure").unsafe(
      `UPDATE ${table}
       SET attempt_count = attempt_count + 1,
           last_error = $1,
           pipeline_status = 'failed',
           next_attempt_at = now() + make_interval(secs => LEAST(3600, power(2, LEAST(attempt_count, 12))::int)),
           updated_at = now()
       WHERE id = $2`,
      [message, rowId]
    );
  }

  async rowData(table: string, id: string): Promise<Record<string, unknown> | undefined> {
    const rows = await getPgClient(this.handle.db, "agent-tools").unsafe(
      `SELECT data FROM ${table} WHERE id = $1 LIMIT 1`,
      [id]
    );
    return rows[0]?.data as Record<string, unknown> | undefined;
  }

  indexStatus(table: string, ids: string[]): Promise<Array<Record<string, unknown>>> {
    return getPgClient(this.handle.db, "agent-tools").unsafe(
      `SELECT id, indexed_at, updated_at FROM ${table} WHERE id = ANY($1::text[])`,
      [ids]
    );
  }

  async markDead(table: string, maxAttempts: number): Promise<number> {
    const rows = await getPgClient(this.handle.db, "retry").unsafe(
      `UPDATE ${table}
       SET pipeline_status = 'dead', updated_at = now()
       WHERE pipeline_status = 'failed' AND attempt_count >= $1
       RETURNING id`,
      [maxAttempts]
    );
    return rows.length;
  }

  retryableRows(table: string, maxAttempts: number, limit: number): Promise<Array<Record<string, unknown>>> {
    return getPgClient(this.handle.db, "retry").unsafe(
      `SELECT id, data, enriched, image_etag, enriched_at
       FROM ${table}
       WHERE pipeline_status = 'failed'
         AND next_attempt_at <= now()
         AND attempt_count < $1
       ORDER BY id
       LIMIT $2`,
      [maxAttempts, limit]
    );
  }

  async upsertDocument(
    table: string,
    id: string,
    dataJson: string,
    contentHash: string,
    scopeCols?: Record<string, string>
  ): Promise<void> {
    const scopeEntries = Object.entries(scopeCols ?? {});
    const scopeColSql = scopeEntries.map(([c]) => `, ${c}`).join("");
    const scopeValSql = scopeEntries.map((_, i) => `, $${4 + i}`).join("");
    // Cross-tenant takeover guard: on id conflict the update only applies when
    // the existing row belongs to the SAME scope. A skipped update (WHERE
    // false) returns no row — detected below and rejected loudly.
    const scopeGuard = scopeEntries.length
      ? ` WHERE ${scopeEntries.map(([c]) => `${table}.${c} = EXCLUDED.${c}`).join(" AND ")}`
      : "";
    const rows = await getPgClient(this.handle.db, "ingest").unsafe(
      `INSERT INTO ${table} (id, data, content_hash, ingested_at, updated_at${scopeColSql})
       VALUES ($1, $2::jsonb, $3, now(), now()${scopeValSql})
       ON CONFLICT (id) DO UPDATE SET
         data = EXCLUDED.data,
         content_hash = EXCLUDED.content_hash,
         updated_at = CASE
           WHEN ${table}.content_hash <> EXCLUDED.content_hash THEN now()
           ELSE ${table}.updated_at
         END,
         enriched_at = CASE
           WHEN ${table}.content_hash <> EXCLUDED.content_hash THEN NULL
           ELSE ${table}.enriched_at
         END,
         indexed_at = CASE
           WHEN ${table}.content_hash <> EXCLUDED.content_hash THEN NULL
           ELSE ${table}.indexed_at
         END,
         enriched = CASE
           WHEN ${table}.content_hash <> EXCLUDED.content_hash THEN NULL
           ELSE ${table}.enriched
         END${scopeGuard}
       RETURNING id`,
      [id, dataJson, contentHash, ...scopeEntries.map(([, v]) => v)]
    );
    if (scopeEntries.length > 0 && rows.length === 0) {
      throw new Error(
        `document "${id}" already exists under a different scope — ids are unique per collection, not per scope`
      );
    }
  }

  async deleteDocuments(table: string, ids: string[], scopeCols?: Record<string, string>): Promise<number> {
    const scopeEntries = Object.entries(scopeCols ?? {});
    const scopeSql = scopeEntries.map(([c], i) => ` AND ${c} = $${2 + i}`).join("");
    const result = await getPgClient(this.handle.db, "ingest").unsafe(
      `DELETE FROM ${table} WHERE id = ANY($1)${scopeSql}`,
      [ids, ...scopeEntries.map(([, v]) => v)]
    );
    return (result as { count?: number }).count ?? 0;
  }
}
