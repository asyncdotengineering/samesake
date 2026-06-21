import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { SQL } from "drizzle-orm";
import type { CollectionDef } from "@samesake/core";
import { computeFacets, type FacetResult } from "../core/facets.ts";
import { getPgClient, type PgUnsafe } from "../core/db-utils.ts";

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
  /** Close the connection. No-op when the consumer owns the handle. */
  close(): Promise<void>;
  /** Facet aggregation over the filtered candidate set. */
  facets(query: FacetQuery): Promise<Record<string, FacetResult>>;
}

/**
 * Postgres implementation of {@link StorageAdapter}. Owns the connection
 * lifecycle; all Postgres-specific SQL (pgvector, FTS, RRF) lives here as
 * operations are migrated.
 */
export class PostgresAdapter implements StorageAdapter {
  constructor(private readonly handle: { db: PostgresJsDatabase; close: () => Promise<void> }) {}

  get db(): PostgresJsDatabase {
    return this.handle.db;
  }

  client(context = "query"): PgUnsafe {
    return getPgClient(this.handle.db, context);
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
}
