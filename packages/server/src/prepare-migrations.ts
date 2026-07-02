// Standalone migration runner — for deploy-pipeline use without constructing
// a full matcher. Equivalent to `matcher.migrate()` but with a lighter
// surface (no provider keys, no apiKey, no Hono app built).
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createDbFromUrl } from "./db/client.ts";
import { getSystemDDL } from "./db/system-ddl.ts";
import type { PhoneticProvider } from "./db/postgres/phonetic.ts";

export interface PrepareMigrationsConfig {
  /** Either provide a Drizzle handle directly... */
  db?: PostgresJsDatabase;
  /** ...or a database URL (we build the postgres-js handle, then close it). */
  databaseUrl?: string;
  /** Postgres schema where samesake's system tables live. Default "public". */
  schema?: string;
  /** Opt-in phonetic provider (installs `samesake_phonetic`). Default: none. */
  phonetic?: PhoneticProvider;
}

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/i;

/**
 * Apply samesake's system DDL (creates samesake_projects + caches + the
 * normalise/phonetic/unit utility functions). Idempotent — safe to run on
 * every deploy. Use this from CI before booting the app, instead of
 * relying on createMatcher's lazy/eager migration mode.
 *
 * @example
 *   // CI script (run before `vercel deploy` / `wrangler deploy` / etc.):
 *   import { prepareMigrations } from "@samesake/server";
 *   await prepareMigrations({
 *     databaseUrl: process.env.SAMESAKE_DATABASE_URL!,
 *     schema: "public",
 *   });
 */
export async function prepareMigrations(config: PrepareMigrationsConfig): Promise<void> {
  if (!config.db && !config.databaseUrl) {
    throw new Error(
      "prepareMigrations: provide either `db` (Drizzle handle) or `databaseUrl` (connection string)"
    );
  }
  if (config.db && config.databaseUrl) {
    throw new Error("prepareMigrations: provide only ONE of `db` or `databaseUrl`, not both");
  }
  const schema = config.schema ?? "public";
  if (!IDENT.test(schema)) {
    throw new Error(`prepareMigrations: invalid schema "${schema}" — must match /^[a-z_][a-z0-9_]+$/i`);
  }

  // We own the connection if databaseUrl was passed — close it before returning.
  const built = config.databaseUrl
    ? createDbFromUrl(config.databaseUrl)
    : { db: config.db!, close: async (): Promise<void> => {} };

  try {
    await built.db.execute(sql.raw(getSystemDDL(schema, config.phonetic)));
  } finally {
    await built.close();
  }
}
