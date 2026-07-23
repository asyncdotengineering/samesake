import { createHash } from "node:crypto";
import type { CollectionDef, RewriteType, RewriteRecord } from "@samesake/core";
import type { ParseNlqDeps } from "./deps.ts";

// RewriteType / RewriteRecord are canonical @samesake/core types (ConstraintTrace
// and ./constraint-trace.ts already use them). Re-exported here so @samesake/query is
// a single import surface; only the proposal-local Rewrite shape is defined here.
export type { RewriteType, RewriteRecord } from "@samesake/core";

export type Rewrite = { type: RewriteType; query: string };

const REWRITE_SCHEMA_VERSION = "grounded-v2";
const REWRITE_CACHE_STAGE = "__query_rewrite";
const REWRITE_CACHE_TTL_DAYS = 7;
const REWRITE_TYPES = new Set<RewriteType>(["spellfix", "synonym", "broader", "substitute"]);

// Query owns its own rewrite timeout so it never imports the host policy module.
// Mirrors the host's callWithTimeout exactly (Promise.race).
const DEFAULT_REWRITE_TIMEOUT_MS = 5000;

function callWithTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return fn();
  return Promise.race([
    fn(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs)
    ),
  ]);
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

function rewriteCacheKey(def: CollectionDef, query: string): string {
  const instructions = def.search?.nlq?.instructions ?? "";
  const model = def.search?.nlq?.model ?? "default";
  const material = [
    REWRITE_SCHEMA_VERSION,
    def.name ?? "",
    normalizeQuery(query),
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
  q: string,
  def: CollectionDef,
  deps: ParseNlqDeps
): Promise<RewriteRecord[]> {
  if (!(deps.generateConfigured ?? true) || !q.trim()) return [];

  const model = def.search?.nlq?.model ?? "default";
  const instructions = def.search?.nlq?.instructions;
  const cacheKey = rewriteCacheKey(def, q);
  const cache = deps.stageCache ?? null;

  if (cache) {
    try {
      const cached = await cache.getStageCache(cacheKey);
      const rewrites = parseRewrites(cached, q);
      if (rewrites.length > 0 || cached != null) return rewrites.map((r) => ({ type: r.type, from: q, to: r.query }));
    } catch {
      // Rewrite recovery remains best-effort when the stage cache is unavailable.
    }
  }

  const raw = await callWithTimeout(
    () => deps.generate({
      model,
      system: instructions,
      prompt:
        "The catalog search query produced too few results (an empty or thin page). " +
        "Suggest up to three ordered query rewrites that improve catalog coverage. " +
        "Return only typed JSON rewrites: spellfix for spelling corrections, synonym for " +
        "equivalent wording, broader for a broader catalog term, or substitute for a close " +
        "replacement. Preserve the user's intent and do not add constraints.\n" +
        `Query: ${q}`,
      schema: rewriteSchema,
    }),
    deps.timeoutMs ?? DEFAULT_REWRITE_TIMEOUT_MS,
    "query rewrite"
  );
  const rewrites = parseRewrites(raw, q);
  cache
    ?.setStageCache(cacheKey, REWRITE_CACHE_STAGE, { rewrites }, model, REWRITE_CACHE_TTL_DAYS)
    .catch(() => {});
  return rewrites.map((r) => ({ type: r.type, from: q, to: r.query }));
}
