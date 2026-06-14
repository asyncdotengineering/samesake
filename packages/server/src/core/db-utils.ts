import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { MatcherCtx } from "../types.ts";
import { sanitiseIdent } from "./schema-gen.ts";

export type PgUnsafe = {
  unsafe: (query: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
};

export function getPgClient(db: PostgresJsDatabase | MatcherCtx["db"], context = "query"): PgUnsafe {
  const session = (db as { session?: { client?: PgUnsafe } }).session;
  if (!session?.client?.unsafe) {
    throw new Error(`postgres client unavailable for ${context}`);
  }
  return session.client;
}

export function entityTableName(entityName: string): string {
  return sanitiseIdent(entityName);
}

export function collectionTableName(schema: string, collectionName: string): string {
  return `${sanitiseIdent(schema)}.c_${sanitiseIdent(collectionName)}`;
}
