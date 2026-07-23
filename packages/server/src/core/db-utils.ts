import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sanitiseIdent } from "./schema-gen.ts";

export type PgUnsafe = {
  unsafe: (query: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
};

export function getPgClient(db: PostgresJsDatabase, context = "query"): PgUnsafe {
  const session = (db as { session?: { client?: PgUnsafe } }).session;
  if (!session?.client?.unsafe) {
    throw new Error(`postgres client unavailable for ${context}`);
  }
  return session.client;
}

export type PgSql = PgUnsafe & {
  begin: <T>(fn: (tx: PgUnsafe) => Promise<T>) => Promise<T>;
};

/** The full postgres-js client (adds `begin` for SET LOCAL-scoped queries). */
export function getPgSql(db: PostgresJsDatabase, context = "query"): PgSql {
  const client = getPgClient(db, context) as Partial<PgSql>;
  if (typeof client.begin !== "function") {
    throw new Error(`postgres transaction client unavailable for ${context}`);
  }
  return client as PgSql;
}

export function entityTableName(entityName: string): string {
  return sanitiseIdent(entityName);
}

export function collectionTableName(schema: string, collectionName: string): string {
  return `${sanitiseIdent(schema)}.c_${sanitiseIdent(collectionName)}`;
}

// Pure dotted-path reader — relocated to @samesake/core (shared with @samesake/enrich).
export { getByPath } from "@samesake/core";
