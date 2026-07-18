import { createHash } from "node:crypto";
import type { CollectionDef, CollectionFieldDef } from "@samesake/core";
import type { MatcherCtx } from "../types.ts";
import { makeStageCacheService } from "../db/stage-cache.ts";
import { normalizeSchema } from "./schema-input.ts";
import type { SearchFilters } from "./search.ts";
import { embeddingEntries } from "./aspects.ts";

const NLQ_CACHE_STAGE = "__nlq";
const NLQ_CACHE_TTL_DAYS = 7;

function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, " ");
}

function nlqCacheKey(def: CollectionDef, q: string): string {
  const instr = def.search?.nlq?.instructions ?? "";
  const model = def.search?.nlq?.model ?? "default";
  const aspects = embeddingEntries(def)
    .map(([name, embedding]) => `${name}:${embedding.describe ?? name}`)
    .join("|");
  return createHash("sha1")
    .update(`nlq|${model}|${createHash("sha1").update(instr).digest("hex").slice(0, 12)}|${createHash("sha1").update(aspects).digest("hex").slice(0, 12)}|${def.name}|${normalizeQuery(q)}`)
    .digest("hex");
}

import { callWithTimeout, DEFAULT_NLQ_TIMEOUT_MS } from "./policy.ts";

export interface NlqParsed {
  semantic_query: string;
  aspects?: Record<string, { subQuery?: string; weight: number }>;
  [key: string]: unknown;
}

export interface NlqParseResult {
  parsed: NlqParsed;
  degraded: boolean;
  filters: SearchFilters;
  excludeTerms: string[];
  /** field -> implied budget direction, only when no explicit min/max was parsed for that field */
  budgetHints: Record<string, "cheap" | "premium">;
}

function fieldDescription(name: string, field: CollectionFieldDef): string {
  if (field.type === "enum") {
    return `Filter by ${name} (${field.values.join(", ")})`;
  }
  return `Filter by ${name}`;
}

export function deriveNlqSchema(def: CollectionDef): Record<string, unknown> {
  const properties: Record<string, unknown> = {};

  for (const [name, field] of Object.entries(def.fields)) {
    if (!field.filterable) continue;

    switch (field.type) {
      case "enum":
        properties[name] = {
          type: "STRING",
          enum: [...field.values, "any"],
          description: fieldDescription(name, field),
        };
        properties[`exclude_${name}`] = {
          type: "ARRAY",
          items: { type: "STRING", enum: [...field.values] },
          description: `Exclude ${name} values`,
        };
        break;
      case "number":
        properties[`max_${name}`] = {
          type: "NUMBER",
          description: `Maximum ${name}; 0 if none stated`,
        };
        properties[`min_${name}`] = {
          type: "NUMBER",
          description: `Minimum ${name}; 0 if none stated`,
        };
        if (field.budget) {
          properties[`${name}_budget_hint`] = {
            type: "STRING",
            enum: ["cheap", "premium", "none"],
            description: `Implied budget when no explicit number is stated: "cheap"/"affordable"/"budget" -> cheap; "luxury"/"high-end"/"premium" -> premium; otherwise none`,
          };
        }
        break;
      case "boolean":
        properties[name] = {
          type: "BOOLEAN",
          description: fieldDescription(name, field),
        };
        break;
      case "array":
        properties[name] = {
          type: "ARRAY",
          items:
            field.itemType === "enum" && field.values
              ? { type: "STRING", enum: [...field.values] }
              : { type: "STRING" },
          description: fieldDescription(name, field),
        };
        properties[`exclude_${name}`] = {
          type: "ARRAY",
          items:
            field.itemType === "enum" && field.values
              ? { type: "STRING", enum: [...field.values] }
              : { type: "STRING" },
          description: `Exclude ${name} values`,
        };
        break;
      case "text":
        properties[name] = {
          type: "STRING",
          description: fieldDescription(name, field),
        };
        properties[`exclude_${name}`] = {
          type: "ARRAY",
          items: { type: "STRING" },
          description: `Exclude ${name} values`,
        };
        break;
    }
  }

  properties.exclude_terms = {
    type: "ARRAY",
    items: { type: "STRING" },
    description: "negated attributes or styles to exclude from product text",
  };
  properties.semantic_query = {
    type: "STRING",
    description:
      "descriptive intent stripped of price and negation constraints; never empty",
  };
  const fragment = aspectsSchemaFragment(def);
  if (fragment) properties.aspects = fragment;

  return {
    type: "OBJECT",
    properties,
    required: ["semantic_query"],
  };
}

// Shared with parseNlq: custom nlq schemas (predating aspects, or filter-only) must still be
// able to emit routing — without this property in the structured-output schema, constrained
// decoding silently disables routing and every query runs all aspect legs at default weights
// (the V02g flat-weights failure).
export function aspectsSchemaFragment(def: CollectionDef): Record<string, unknown> | null {
  if (embeddingEntries(def).length === 0) return null;
  return {
    type: "OBJECT",
    description: "Aspect routing for retrieval. Omit aspects not referenced by the query.",
    properties: Object.fromEntries(
      embeddingEntries(def).map(([name, embedding]) => [name, {
        type: "OBJECT",
        properties: {
          subQuery: { type: "STRING", description: "Focused fragment for this aspect" },
          weight: { type: "NUMBER", minimum: 0, maximum: 1 },
        },
        required: ["weight"],
        description: embedding.describe ?? name,
      }])
    ),
  };
}

export function tokenCount(q: string): number {
  return q.trim().split(/\s+/).filter(Boolean).length;
}

export function shouldSkipNlq(def: CollectionDef, q: string): boolean {
  if (!def.search?.nlq) return true;
  if (def.search.nlq.enable === false) return true;
  return tokenCount(q) <= 2 && !/\d/.test(q);
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.length > 0);
}

export function nlqParsedToFilters(
  parsed: Record<string, unknown>,
  def: CollectionDef
): { filters: SearchFilters; excludeTerms: string[]; budgetHints: Record<string, "cheap" | "premium"> } {
  const filters: SearchFilters = {};
  const excludeTerms = asStringArray(parsed.exclude_terms);
  const budgetHints: Record<string, "cheap" | "premium"> = {};

  const excludePatterns = asStringArray(parsed.exclude_patterns);
  if (excludePatterns.length && def.fields.pattern?.filterable) {
    filters.pattern = { $nin: excludePatterns };
  }

  for (const [name, field] of Object.entries(def.fields)) {
    if (!field.filterable) continue;

    const excludeKey = `exclude_${name}`;

    if (field.type === "number") {
      const ops: Partial<Record<"$gte" | "$lte", number>> = {};
      const max = parsed[`max_${name}`];
      const min = parsed[`min_${name}`];
      if (typeof max === "number" && max > 0) ops.$lte = max;
      if (typeof min === "number" && min > 0) ops.$gte = min;
      if (Object.keys(ops).length) {
        filters[name] = ops;
      } else if (field.budget) {
        const hint = parsed[`${name}_budget_hint`];
        if (hint === "cheap" || hint === "premium") budgetHints[name] = hint;
      }
      continue;
    }

    if (field.type === "enum") {
      const val = parsed[name];
      const ex = asStringArray(parsed[excludeKey]);
      if (typeof val === "string" && val !== "any") {
        filters[name] = ex.length ? { $in: [val], $nin: ex } : val;
      } else if (ex.length) {
        filters[name] = { $nin: ex };
      }
      continue;
    }

    if (field.type === "boolean") {
      if (typeof parsed[name] === "boolean") filters[name] = parsed[name];
      continue;
    }

    if (field.type === "array") {
      const inc = asStringArray(parsed[name]);
      const ex = asStringArray(parsed[excludeKey]);
      if (inc.length && ex.length) {
        filters[name] = { $contains: inc, $exclude: ex };
      } else if (inc.length) {
        filters[name] = inc;
      } else if (ex.length) {
        filters[name] = { $exclude: ex };
      }
      continue;
    }

    if (field.type === "text") {
      const val = parsed[name];
      const ex = asStringArray(parsed[excludeKey]);
      if (typeof val === "string" && val.length) {
        filters[name] = ex.length ? { $contains: val, $nin: ex } : val;
      } else if (ex.length) {
        filters[name] = { $nin: ex };
      }
    }
  }

  return { filters, excludeTerms, budgetHints };
}

export function mergeFilters(
  nlqFilters: SearchFilters,
  explicit?: SearchFilters
): SearchFilters {
  if (!explicit || !Object.keys(explicit).length) return nlqFilters;
  return { ...nlqFilters, ...explicit };
}

function buildNlqPrompt(q: string, def: CollectionDef, instructions?: string): string {
  const parts: string[] = [];
  if (instructions?.trim()) parts.push(instructions.trim());
  const aspects = embeddingEntries(def);
  if (aspects.length) {
    parts.push(
      `Retrieval aspects:\n${aspects.map(([name, embedding]) => `- ${name}: ${embedding.describe ?? name}`).join("\n")}\nFor each aspect referenced by the query, assign a relevance weight from 0 to 1 and optionally provide a focused subQuery. Omit unreferenced aspects.`
    );
  }
  parts.push(`Query: "${q}"`);
  return parts.join("\n\n");
}

function normalizeAspectRoutes(def: CollectionDef, parsed: NlqParsed): NlqParsed {
  const raw = parsed.aspects;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...parsed, aspects: undefined };
  const allowed = new Set(embeddingEntries(def).map(([name]) => name));
  const aspects: Record<string, { subQuery?: string; weight: number }> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!allowed.has(name) || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const rawWeight = typeof record.weight === "number" && Number.isFinite(record.weight) ? record.weight : 0;
    const subQuery = typeof record.subQuery === "string" && record.subQuery.trim() ? record.subQuery.trim() : undefined;
    aspects[name] = { ...(subQuery ? { subQuery } : {}), weight: Math.max(0, Math.min(1, rawWeight)) };
  }
  return { ...parsed, aspects };
}

async function generateWithTimeout(
  ctx: MatcherCtx,
  req: Parameters<MatcherCtx["generate"]>[0]
): Promise<unknown> {
  const timeoutMs = ctx.policy?.llm?.timeoutMs ?? DEFAULT_NLQ_TIMEOUT_MS;
  return callWithTimeout(() => ctx.generate(req), timeoutMs, "NLQ");
}

export async function parseNlq(
  ctx: MatcherCtx,
  def: CollectionDef,
  q: string
): Promise<NlqParseResult> {
  const fallback: NlqParseResult = {
    parsed: { semantic_query: q },
    degraded: true,
    filters: {},
    excludeTerms: [],
    budgetHints: {},
  };

  if (shouldSkipNlq(def, q)) {
    return { parsed: { semantic_query: q }, degraded: false, filters: {}, excludeTerms: [], budgetHints: {} };
  }

  if (!ctx.generateConfigured) {
    return fallback;
  }

  const schema = normalizeSchema(def.search?.nlq?.schema ?? deriveNlqSchema(def)) as {
    properties?: Record<string, unknown>;
  };
  // Custom (filter-only / pre-aspects) schemas still get the routing property — without it,
  // constrained decoding can never emit `aspects` and routing silently dies (V02g redux).
  const aspectFragment = aspectsSchemaFragment(def);
  if (aspectFragment && schema?.properties && !schema.properties.aspects) {
    schema.properties.aspects = aspectFragment;
  }
  const instructions = def.search?.nlq?.instructions;
  // Caching is best-effort: minimal test/embedded contexts may lack system tables.
  const cache = ctx.systemTables?.samesakeStageCache ? makeStageCacheService(ctx) : null;
  const cacheKey = nlqCacheKey(def, q);

  if (cache) {
    try {
      const hit = (await cache.getStageCache(cacheKey)) as Record<string, unknown> | null;
      if (hit && typeof hit.semantic_query === "string") {
        ctx.observability?.inc("nlq_cache_hits");
        const parsed = normalizeAspectRoutes(def, { ...hit, semantic_query: hit.semantic_query });
        const { filters, excludeTerms, budgetHints } = nlqParsedToFilters(parsed, def);
        return { parsed, degraded: false, filters, excludeTerms, budgetHints };
      }
    } catch {
      // cache read failures never block the query path
    }
  }

  try {
    const raw = (await generateWithTimeout(ctx, {
      model: def.search?.nlq?.model,
      prompt: buildNlqPrompt(q, def, instructions),
      system: instructions,
      schema,
    })) as Record<string, unknown>;

    const semantic =
      typeof raw.semantic_query === "string" && raw.semantic_query.trim()
        ? raw.semantic_query.trim()
        : q;

    const parsed = normalizeAspectRoutes(def, { ...raw, semantic_query: semantic });
    const { filters, excludeTerms, budgetHints } = nlqParsedToFilters(parsed, def);
    cache
      ?.setStageCache(cacheKey, NLQ_CACHE_STAGE, parsed, def.search?.nlq?.model ?? "default", NLQ_CACHE_TTL_DAYS)
      .catch(() => {});
    return { parsed, degraded: false, filters, excludeTerms, budgetHints };
  } catch {
    return fallback;
  }
}
