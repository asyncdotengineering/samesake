// Dedicated parse-result cache table service. Factory takes a MatcherCtx
// because the parse cache lives in the consumer-configured system schema.
import { eq, and, gt, sql } from "drizzle-orm";
import type { MatcherCtx } from "../types.ts";

export function makeParseCacheService(ctx: MatcherCtx) {
  const { db, systemTables } = ctx;
  const t = systemTables.samesakeParseCache;

  return {
    async getParseCache(key: string): Promise<unknown | null> {
      const rows = await db
        .select({ payload: t.payload })
        .from(t)
        .where(and(eq(t.cacheKey, key), gt(t.expiresAt, sql`now()`)))
        .limit(1);
      return rows[0]?.payload ?? null;
    },

    async setParseCache(
      key: string,
      payload: object,
      model: string,
      ttlDays = 90
    ): Promise<void> {
      const expiresAt = new Date(Date.now() + ttlDays * 24 * 3600 * 1000);
      await db
        .insert(t)
        .values({ cacheKey: key, payload, model, expiresAt })
        .onConflictDoUpdate({
          target: t.cacheKey,
          set: { payload, model, expiresAt },
        });
    },
  };
}

export type ParseCacheService = ReturnType<typeof makeParseCacheService>;
