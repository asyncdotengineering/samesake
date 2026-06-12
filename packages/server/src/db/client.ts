// DB connection utility + the asJsonb helper. No module-level singleton —
// the matcher's db handle is passed via MatcherConfig.db (or built from
// MatcherConfig.databaseUrl by createMatcher() via createDbFromUrl).
//
// Why postgres-js: it's the matcher's reference driver. Consumers using a
// different driver (neon-serverless, bun-sql) build their own Drizzle handle
// and pass it via config.db — the rest of the codebase only talks to Drizzle.
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export type Db = PostgresJsDatabase;

/**
 * Build a Drizzle handle backed by postgres-js from a connection string.
 * Used by createMatcher when the consumer provides `databaseUrl` instead
 * of a pre-built `db`. Returns both the handle and a `close()` for
 * graceful shutdown.
 */
export function createDbFromUrl(url: string): {
  db: PostgresJsDatabase;
  close: () => Promise<void>;
} {
  const client = postgres(url, {
    max: 10,
    idle_timeout: 30,
    connect_timeout: 10,
    types: {
      bigint: postgres.BigInt,
    },
  });
  return {
    db: drizzle(client),
    close: () => client.end({ timeout: 5 }),
  };
}

/**
 * Pass a plain JS object or array as a jsonb parameter to a Drizzle sql
 * template.
 *
 *   db.execute(sql`INSERT INTO foo (scope) VALUES (${asJsonb({x: 1})}::jsonb)`)
 *
 * Why JSON.stringify: postgres-js and Drizzle expand arrays into row
 * constructors `(p1, p2, p3)` — fine for IN-clauses, fatal for jsonb.
 * JSON.stringify forces a single text param. Safe because every call site
 * uses the explicit `::jsonb` cast in SQL.
 */
export function asJsonb(value: object): string {
  return JSON.stringify(value);
}
