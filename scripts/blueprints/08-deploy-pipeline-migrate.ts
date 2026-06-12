#!/usr/bin/env bun
// BLUEPRINT 8 — Standalone migrations (deploy-pipeline pattern).
//
// Use when: you want to run migrations as a SEPARATE deploy step,
// BEFORE the app starts up — the prisma-migrate-deploy / drizzle-kit-push
// pattern. Doesn't construct a matcher, doesn't open HTTP, doesn't need
// provider API keys.
//
// In CI / a deploy script:
//   1. `samesake migrate --db=$DATABASE_URL` (or `prepareMigrations({...})`)
//   2. Deploy the app
//   3. App boots with `migrate: "manual"` — no migrations on the hot path
import { prepareMigrations } from "../../packages/server/src/index.ts";

const TEST_SCHEMA = "blueprint_migrate_test";

// 1. Run migrations programmatically (the same thing `samesake migrate` does)
await prepareMigrations({
  databaseUrl: process.env.SAMESAKE_DATABASE_URL!,
  schema: TEST_SCHEMA,
});
console.log(`[08-deploy-pipeline-migrate] ✓ prepareMigrations() applied DDL to '${TEST_SCHEMA}'`);

// 2. Idempotent — run a second time, expect a no-op
await prepareMigrations({
  databaseUrl: process.env.SAMESAKE_DATABASE_URL!,
  schema: TEST_SCHEMA,
});
console.log("[08-deploy-pipeline-migrate] ✓ second call is a no-op (CREATE IF NOT EXISTS / OR REPLACE)");

// 3. Cleanup — drop the test schema
import { createDbFromUrl } from "../../packages/server/src/index.ts";
import { sql } from "drizzle-orm";
const { db, close } = createDbFromUrl(process.env.SAMESAKE_DATABASE_URL!);
await db.execute(sql.raw(`DROP SCHEMA ${TEST_SCHEMA} CASCADE`));
await close();
console.log("[08-deploy-pipeline-migrate] ✓ deploy-pipeline migration pattern works");
console.log("[08-deploy-pipeline-migrate] equivalent CLI: bunx samesake migrate --schema=<name>");
