import { eq, and, gt, sql } from "drizzle-orm";
import type { StageCachePort } from "@samesake/enrich";
import type { MatcherCtx } from "../types.ts";

export function makeStageCacheService(ctx: MatcherCtx) {
  const { systemTables } = ctx;
  const db = ctx.storage.db;
  const t = systemTables.samesakeStageCache;

  return {
    async getStageCache(key: string): Promise<unknown | null> {
      const rows = await db
        .select({ payload: t.payload })
        .from(t)
        .where(and(eq(t.cacheKey, key), gt(t.expiresAt, sql`now()`)))
        .limit(1);
      return rows[0]?.payload ?? null;
    },

    async setStageCache(
      key: string,
      stageName: string,
      payload: object,
      model: string,
      ttlDays = 90
    ): Promise<void> {
      const expiresAt = new Date(Date.now() + ttlDays * 24 * 3600 * 1000);
      await db
        .insert(t)
        .values({ cacheKey: key, stageName, payload, model, expiresAt })
        .onConflictDoUpdate({
          target: t.cacheKey,
          set: { payload, stageName, model, expiresAt },
        });
    },
  };
}

export type StageCacheService = ReturnType<typeof makeStageCacheService>;

export function pgStageCache(ctx: MatcherCtx): StageCachePort {
  const service = makeStageCacheService(ctx);
  return {
    async get(key) {
      return (await service.getStageCache(key)) ?? undefined;
    },
    async set(key, value) {
      const [, stageName = "enrich", model = "<default>"] = key.split(":");
      const payload = value && typeof value === "object" ? value : { value };
      await service.setStageCache(key, stageName, payload, model);
    },
  };
}
