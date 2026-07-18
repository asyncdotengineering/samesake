import { createHash } from "node:crypto";
import type { CollectionDef } from "@samesake/core";
import type { MatcherCtx } from "../types.ts";
import { makeStageCacheService } from "../db/stage-cache.ts";
import { callWithTimeout, DEFAULT_NLQ_TIMEOUT_MS } from "./policy.ts";

export type RewriteType = "spellfix" | "synonym" | "broader" | "substitute";
export type Rewrite = { type: RewriteType; query: string };
export type RewriteRecord = { type: RewriteType; from: string; to: string };

const REWRITE_SCHEMA_VERSION = "grounded-v2";
const REWRITE_CACHE_STAGE = "__query_rewrite";
const REWRITE_CACHE_TTL_DAYS = 7;
const REWRITE_TYPES = new Set<RewriteType>(["spellfix", "synonym", "broader", "substitute"]);

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

function rewriteCacheKey(def: CollectionDef, query: string, reason: "empty" | "thin"): string {
  const instructions = def.search?.nlq?.instructions ?? "";
  const model = def.search?.nlq?.model ?? "default";
  const material = [
    REWRITE_SCHEMA_VERSION,
    def.name ?? "",
    normalizeQuery(query),
    reason,
    model,
    instructions,
  ].join("|");
  return createHash("sha1").update(material).digest("hex");
}

export const rewriteSchema: Record<string, unknown> = {
  type: "OBJECT",
  properties: {
    rewrites: {
      type: "ARRAY",
      maxItems: 3,
      items: {
        type: "OBJECT",
        properties: {
          type: { type: "STRING", enum: [...REWRITE_TYPES] },
          query: { type: "STRING" },
        },
        required: ["type", "query"],
      },
    },
  },
  required: ["rewrites"],
};

function parseRewrites(raw: unknown, original: string): Rewrite[] {
  const values = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>).rewrites
    : raw;
  if (!Array.isArray(values)) return [];

  const seen = new Set<string>();
  const normalizedOriginal = normalizeQuery(original);
  const out: Rewrite[] = [];
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const type = record.type;
    const query = typeof record.query === "string" ? record.query.trim() : "";
    if (typeof type !== "string" || !REWRITE_TYPES.has(type as RewriteType) || !query) continue;
    const normalized = normalizeQuery(query);
    if (normalized === normalizedOriginal || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push({ type: type as RewriteType, query });
    if (out.length === 3) break;
  }
  return out;
}

export async function proposeRewrites(
  ctx: MatcherCtx,
  def: CollectionDef,
  q: string,
  reason: "empty" | "thin"
): Promise<Rewrite[]> {
  if (!ctx.generateConfigured || !q.trim()) return [];

  const model = def.search?.nlq?.model ?? "default";
  const instructions = def.search?.nlq?.instructions;
  const cacheKey = rewriteCacheKey(def, q, reason);
  const cache = ctx.systemTables?.samesakeStageCache ? makeStageCacheService(ctx) : null;

  if (cache) {
    try {
      const cached = await cache.getStageCache(cacheKey);
      const rewrites = parseRewrites(cached, q);
      if (rewrites.length > 0 || cached != null) return rewrites;
    } catch {
      // Rewrite recovery remains best-effort when the stage cache is unavailable.
    }
  }

  const raw = await callWithTimeout(
    () => ctx.generate({
      model,
      system: instructions,
      prompt:
        `The catalog search query produced an honest ${reason} retrieval gate. ` +
        "Suggest up to three ordered query rewrites that improve catalog coverage. " +
        "Return only typed JSON rewrites: spellfix for spelling corrections, synonym for " +
        "equivalent wording, broader for a broader catalog term, or substitute for a close " +
        "replacement. Preserve the user's intent and do not add constraints.\n" +
        `Query: ${q}`,
      schema: rewriteSchema,
    }),
    ctx.policy?.llm?.timeoutMs ?? DEFAULT_NLQ_TIMEOUT_MS,
    "query rewrite"
  );
  const rewrites = parseRewrites(raw, q);
  cache
    ?.setStageCache(cacheKey, REWRITE_CACHE_STAGE, { rewrites }, model, REWRITE_CACHE_TTL_DAYS)
    .catch(() => {});
  return rewrites;
}
