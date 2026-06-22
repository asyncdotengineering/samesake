import { sql } from "drizzle-orm";
import { getSystemDDL } from "./system-ddl.ts";
import type { MatcherCtx } from "../types.ts";

/**
 * Apply system-level migrations. Idempotent. Run on first request (lazy
 * mode) or eagerly when the matcher is constructed (eager mode).
 * Targets ctx.schema (consumer's choice, defaults to `public`).
 */
export async function runSystemMigrations(ctx: MatcherCtx): Promise<void> {
  await ctx.storage.exec(sql.raw(getSystemDDL(ctx.schema, ctx.phonetic)));
}
