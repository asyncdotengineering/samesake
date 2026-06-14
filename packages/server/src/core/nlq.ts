import { createHash } from "node:crypto";
import type { CollectionDef, CollectionFieldDef } from "@samesake/core";
import type { MatcherCtx } from "../types.ts";
import { makeStageCacheService } from "../db/stage-cache.ts";
import { normalizeSchema } from "./schema-input.ts";
import type { SearchFilters } from "./search.ts";

const NLQ_CACHE_STAGE = "__nlq";
const NLQ_CACHE_TTL_DAYS = 7;

function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, " ");
}

function nlqCacheKey(def: CollectionDef, q: string): string {
  const instr = def.search?.nlq?.instructions ?? "";
  const model = def.search?.nlq?.model ?? "default";
  return createHash("sha1")
    .update(`nlq|${model}|${createHash("sha1").update(instr).digest("hex").slice(0, 12)}|${def.name}|${normalizeQuery(q)}`)
    .digest("hex");
}

import { callWithTimeout, DEFAULT_NLQ_TIMEOUT_MS } from "./policy.ts";

export interface NlqParsed {
  semantic_query: string;
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

  return {
    type: "OBJECT",
    properties,
    required: ["semantic_query"],
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

function buildNlqPrompt(q: string, instructions?: string): string {
  const parts: string[] = [];
  if (instructions?.trim()) parts.push(instructions.trim());
  parts.push(`Query: "${q}"`);
  return parts.join("\n\n");
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

  const schema = normalizeSchema(def.search?.nlq?.schema ?? deriveNlqSchema(def));
  const instructions = def.search?.nlq?.instructions;
  // Caching is best-effort: minimal test/embedded contexts may lack system tables.
  const cache = ctx.systemTables?.samesakeStageCache ? makeStageCacheService(ctx) : null;
  const cacheKey = nlqCacheKey(def, q);

  if (cache) {
    try {
      const hit = (await cache.getStageCache(cacheKey)) as Record<string, unknown> | null;
      if (hit && typeof hit.semantic_query === "string") {
        ctx.observability?.inc("nlq_cache_hits");
        const parsed: NlqParsed = { ...hit, semantic_query: hit.semantic_query };
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
      prompt: buildNlqPrompt(q, instructions),
      system: instructions,
      schema,
    })) as Record<string, unknown>;

    const semantic =
      typeof raw.semantic_query === "string" && raw.semantic_query.trim()
        ? raw.semantic_query.trim()
        : q;

    const parsed: NlqParsed = { ...raw, semantic_query: semantic };
    const { filters, excludeTerms, budgetHints } = nlqParsedToFilters(parsed, def);
    cache
      ?.setStageCache(cacheKey, NLQ_CACHE_STAGE, parsed, def.search?.nlq?.model ?? "default", NLQ_CACHE_TTL_DAYS)
      .catch(() => {});
    return { parsed, degraded: false, filters, excludeTerms, budgetHints };
  } catch {
    return fallback;
  }
}
