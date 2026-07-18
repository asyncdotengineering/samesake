import { createHash } from "node:crypto";
import type { CollectionDef, CollectionFieldDef } from "@samesake/core";
import type { MatcherCtx } from "../types.ts";
import { makeStageCacheService } from "../db/stage-cache.ts";
import { normalizeSchema } from "./schema-input.ts";
import type { SearchFilters } from "./search.ts";
import { embeddingEntries } from "./aspects.ts";
import {
  groundVocabValues,
  openVocabFieldNames,
  type GroundedValueDecision,
  type VocabCandidates,
  type VocabLookup,
} from "./field-vocab.ts";

const NLQ_CACHE_STAGE = "__nlq";
const NLQ_CACHE_TTL_DAYS = 7;
const NLQ_SCHEMA_VERSION = "grounded-v2";

function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, " ");
}

function candidateHash(candidates: VocabCandidates): string {
  const stable = Object.fromEntries(
    Object.keys(candidates)
      .sort()
      .map((field) => [
        field,
        [...(candidates[field] ?? [])]
          .map(({ value, count }) => ({ value, count }))
          .sort((a, b) => a.value.localeCompare(b.value) || a.count - b.count),
      ])
  );
  return createHash("sha1").update(JSON.stringify(stable)).digest("hex").slice(0, 16);
}

export function nlqCacheKey(def: CollectionDef, q: string, candidates: VocabCandidates = {}): string {
  const instr = def.search?.nlq?.instructions ?? "";
  const model = def.search?.nlq?.model ?? "default";
  const aspects = embeddingEntries(def)
    .map(([name, embedding]) => `${name}:${embedding.describe ?? name}`)
    .join("|");
  return createHash("sha1")
    .update(`${NLQ_SCHEMA_VERSION}|nlq|${model}|${createHash("sha1").update(instr).digest("hex").slice(0, 12)}|${createHash("sha1").update(aspects).digest("hex").slice(0, 12)}|${candidateHash(candidates)}|${def.name}|${normalizeQuery(q)}`)
    .digest("hex");
}

import { callWithTimeout, DEFAULT_NLQ_TIMEOUT_MS } from "./policy.ts";

export interface NlqParsed {
  semantic_query: string;
  lexical_query?: string;
  aspects?: Record<string, { subQuery?: string; weight: number }>;
  [key: string]: unknown;
}

export interface NlqParseResult {
  parsed: NlqParsed;
  degraded: boolean;
  filters: SearchFilters;
  deterministicFilters: SearchFilters;
  groundedValues: Record<string, GroundedValueDecision[]>;
  excludeTerms: string[];
  /** field -> implied budget direction, only when no explicit min/max was parsed for that field */
  budgetHints: Record<string, "cheap" | "premium">;
}

export interface ParseNlqOptions {
  candidates?: VocabLookup;
  deterministicFilters?: SearchFilters;
  grounding?: { available: boolean; decisions: Record<string, GroundedValueDecision[]> };
  schemaCandidates?: VocabCandidates;
  scopeCols?: Record<string, string>;
  schema?: string;
  collection?: string;
}

function fieldDescription(name: string, field: CollectionFieldDef): string {
  if (field.type === "enum") {
    return `Filter by ${name} (${field.values.join(", ")})`;
  }
  return `Filter by ${name}`;
}

export function deriveNlqSchema(def: CollectionDef, candidates: VocabCandidates = {}): Record<string, unknown> {
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
        const catalogValues = candidates[name]?.map(({ value }) => value) ?? [];
        properties[name] = {
          type: "STRING",
          ...(catalogValues.length ? { enum: catalogValues } : {}),
          description: catalogValues.length
            ? `Catalog values for ${name}; use only these visible values`
            : fieldDescription(name, field),
        };
        properties[`exclude_${name}`] = {
          type: "ARRAY",
          items: catalogValues.length ? { type: "STRING", enum: catalogValues } : { type: "STRING" },
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

function isStringSchema(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && (value as Record<string, unknown>).type === "string" ||
    !!value && typeof value === "object" && (value as Record<string, unknown>).type === "STRING";
}

function injectStringEnum(value: unknown, enumValues: string[], label: string): Record<string, unknown> {
  if (isStringSchema(value)) return { ...(value as Record<string, unknown>), enum: enumValues };
  if (value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).anyOf)) {
    const branches = (value as Record<string, unknown>).anyOf as unknown[];
    let changed = false;
    const anyOf = branches.map((branch) => {
      if (!isStringSchema(branch)) return branch;
      changed = true;
      return { ...(branch as Record<string, unknown>), enum: enumValues };
    });
    if (changed) return { ...(value as Record<string, unknown>), anyOf };
  }
  throw new Error(`NLQ schema property "${label}" must contain a string branch for catalog grounding`);
}

function injectCandidateEnums(schema: Record<string, unknown>, candidates: VocabCandidates): Record<string, unknown> {
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return schema;
  const next = { ...schema, properties: { ...(properties as Record<string, unknown>) } };
  const nextProperties = next.properties as Record<string, unknown>;
  for (const [field, values] of Object.entries(candidates)) {
    const enumValues = values.map(({ value }) => value);
    if (!enumValues.length) continue;
    if (Object.hasOwn(nextProperties, field)) {
      nextProperties[field] = injectStringEnum(nextProperties[field], enumValues, field);
    }
    const exclude = `exclude_${field}`;
    const excludeSchema = nextProperties[exclude];
    if (excludeSchema && typeof excludeSchema === "object" && !Array.isArray(excludeSchema)) {
      const items = (excludeSchema as Record<string, unknown>).items;
      if (items !== undefined) {
        nextProperties[exclude] = {
          ...(excludeSchema as Record<string, unknown>),
          items: injectStringEnum(items, enumValues, `${exclude}.items`),
        };
      }
    }
  }
  return next;
}

function augmentNlqSchema(
  def: CollectionDef,
  candidates: VocabCandidates
): Record<string, unknown> {
  const input = def.search?.nlq?.schema ?? deriveNlqSchema(def, candidates);
  const schema = normalizeSchema(input);
  const copy = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
  const properties = copy.properties && typeof copy.properties === "object" && !Array.isArray(copy.properties)
    ? copy.properties as Record<string, unknown>
    : {};
  copy.properties = properties;
  if (!Object.hasOwn(properties, "semantic_query")) {
    properties.semantic_query = { type: "STRING", description: "descriptive intent stripped of constraints; never empty" };
  }
  if (!Object.hasOwn(properties, "lexical_query")) {
    properties.lexical_query = { type: "STRING", description: "corrected keyword surface with structured constraints removed" };
  }
  const aspectFragment = aspectsSchemaFragment(def);
  if (aspectFragment && !Object.hasOwn(properties, "aspects")) properties.aspects = aspectFragment;
  return injectCandidateEnums(copy, candidates);
}

export function shouldSkipNlq(def: CollectionDef, q: string): boolean {
  if (!def.search?.nlq) return true;
  if (def.search.nlq.enable === false) return true;
  if (!q.trim()) return true;
  return false;
}

function normalizeEnumQuery(q: string): string {
  return q
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function enumTokens(value: string): string[] {
  return normalizeEnumQuery(value).split(" ").filter(Boolean);
}

interface EnumTokenCandidate {
  field: string;
  value: string;
  tokens: string[];
}

const NEGATION_TOKENS = new Set(["not", "no", "without", "exclude", "except"]);

export function deriveEnumTokenFilters(q: string, def: CollectionDef): SearchFilters {
  const queryTokens = normalizeEnumQuery(q).split(" ").filter(Boolean);
  const candidates: EnumTokenCandidate[] = [];
  for (const [field, fieldDef] of Object.entries(def.fields)) {
    if (!fieldDef.filterable || fieldDef.soft !== true) continue;
    const values = fieldDef.type === "enum" || (fieldDef.type === "array" && fieldDef.itemType === "enum")
      ? fieldDef.values ?? []
      : [];
    for (const value of values) {
      const tokens = enumTokens(value);
      if (tokens.length) candidates.push({ field, value, tokens });
    }
    if (fieldDef.type === "enum") {
      for (const value of fieldDef.alsoMatch ?? []) {
        const tokens = enumTokens(value);
        if (tokens.length) candidates.push({ field, value, tokens });
      }
    }
  }

  const phraseFields = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const phrase = candidate.tokens.join(" ");
    const fields = phraseFields.get(phrase) ?? new Set<string>();
    fields.add(candidate.field);
    phraseFields.set(phrase, fields);
  }

  const filtersByField = new Map<string, string[]>();
  const consumed = new Set<number>();
  const ordered = [...candidates].sort(
    (a, b) => b.tokens.length - a.tokens.length || b.value.length - a.value.length || a.field.localeCompare(b.field) || a.value.localeCompare(b.value)
  );
  for (const candidate of ordered) {
    const phrase = candidate.tokens.join(" ");
    if ((phraseFields.get(phrase)?.size ?? 0) > 1) continue;
    for (let start = 0; start <= queryTokens.length - candidate.tokens.length; start++) {
      const end = start + candidate.tokens.length;
      if (candidate.tokens.some((token, offset) => queryTokens[start + offset] !== token)) continue;
      if (Array.from({ length: 2 }, (_, offset) => queryTokens[start - offset - 1]).some((token) => token && NEGATION_TOKENS.has(token))) continue;
      if (Array.from({ length: candidate.tokens.length }, (_, offset) => start + offset).some((index) => consumed.has(index))) continue;
      for (let index = start; index < end; index++) consumed.add(index);
      const valuesForField = filtersByField.get(candidate.field) ?? [];
      if (!valuesForField.includes(candidate.value)) valuesForField.push(candidate.value);
      filtersByField.set(candidate.field, valuesForField);
      break;
    }
  }

  const filters: SearchFilters = {};
  for (const [field, values] of filtersByField) {
    const fieldDef = def.fields[field];
    if (fieldDef?.type === "array") filters[field] = values;
    else if (values.length === 1) filters[field] = values[0]!;
    else filters[field] = { $in: values };
  }
  return filters;
}

export function mergeDeterministicSoftFilters(
  parsedFilters: SearchFilters,
  deterministicFilters: SearchFilters,
  def: CollectionDef
): SearchFilters {
  const merged = { ...parsedFilters };
  for (const [field, value] of Object.entries(deterministicFilters)) {
    if (def.fields[field]?.soft === true) merged[field] = value;
  }
  return merged;
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

function buildNlqPrompt(
  q: string,
  def: CollectionDef,
  instructions?: string,
  candidates: VocabCandidates = {}
): string {
  const parts: string[] = [];
  if (instructions?.trim()) parts.push(instructions.trim());
  const aspects = embeddingEntries(def);
  if (aspects.length) {
    parts.push(
      `Retrieval aspects:\n${aspects.map(([name, embedding]) => `- ${name}: ${embedding.describe ?? name}`).join("\n")}\nFor each aspect referenced by the query, assign a relevance weight from 0 to 1 and optionally provide a focused subQuery. Omit unreferenced aspects.`
    );
  }
  if (Object.keys(candidates).length > 0) {
    parts.push(`Catalog-grounded filter candidates (JSON data; use only values represented by the schema enums):\n${JSON.stringify(candidates)}`);
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

function openVocabFilterValues(filters: SearchFilters, def: CollectionDef): Record<string, string[]> {
  const openFields = new Set(openVocabFieldNames(def));
  const values: Record<string, string[]> = {};
  for (const [field, raw] of Object.entries(filters)) {
    if (!openFields.has(field)) continue;
    const fieldValues: string[] = [];
    if (typeof raw === "string") fieldValues.push(raw);
    else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const value of Object.values(raw)) {
        if (typeof value === "string") fieldValues.push(value);
        else if (Array.isArray(value)) fieldValues.push(...value.filter((item): item is string => typeof item === "string"));
      }
    }
    if (fieldValues.length) values[field] = fieldValues;
  }
  return values;
}

function unavailableGrounding(values: Record<string, string[]>): Record<string, GroundedValueDecision[]> {
  return Object.fromEntries(
    Object.entries(values).map(([field, fieldValues]) => [
      field,
      fieldValues.map((parsed) => ({ parsed, action: "dropped" as const })),
    ])
  );
}

function applyGrounding(
  filters: SearchFilters,
  decisions: Record<string, GroundedValueDecision[]>
): { filters: SearchFilters; dropped: string[] } {
  const out: SearchFilters = { ...filters };
  const dropped: string[] = [];
  for (const [field, fieldDecisions] of Object.entries(decisions)) {
    const raw = out[field];
    if (raw === undefined) continue;
    const byParsed = new Map(fieldDecisions.map((decision) => [decision.parsed, decision]));
    const resolve = (value: string): string | undefined => {
      const decision = byParsed.get(value);
      if (!decision || decision.action === "dropped") {
        if (decision) dropped.push(decision.parsed);
        return undefined;
      }
      return decision.mapped ?? decision.parsed;
    };
    if (typeof raw === "string") {
      const mapped = resolve(raw);
      if (mapped === undefined) delete out[field];
      else out[field] = mapped;
      continue;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const next: Record<string, unknown> = {};
    for (const [operator, value] of Object.entries(raw)) {
      if (typeof value === "string") {
        const mapped = resolve(value);
        if (mapped !== undefined) next[operator] = mapped;
      } else if (Array.isArray(value)) {
        const mapped = value
          .filter((item): item is string => typeof item === "string")
          .map(resolve)
          .filter((item): item is string => item !== undefined);
        if (mapped.length) next[operator] = mapped;
      } else {
        next[operator] = value;
      }
    }
    if (Object.keys(next).length) out[field] = next as SearchFilters[string];
    else delete out[field];
  }
  return { filters: out, dropped: [...new Set(dropped)] };
}

function appendDroppedSemantic(semantic: string, dropped: string[]): string {
  let out = semantic.trim();
  for (const value of dropped) {
    if (!out.toLowerCase().includes(value.toLowerCase())) out = `${out} ${value}`.trim();
  }
  return out || dropped.join(" ");
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
  q: string,
  options: ParseNlqOptions = {}
): Promise<NlqParseResult> {
  const enabled = !shouldSkipNlq(def, q);
  const deterministicFilters = enabled
    ? options.deterministicFilters ?? deriveEnumTokenFilters(q, def)
    : {};
  const fallback: NlqParseResult = {
    parsed: { semantic_query: q },
    degraded: true,
    filters: deterministicFilters,
    deterministicFilters,
    groundedValues: {},
    excludeTerms: [],
    budgetHints: {},
  };

  if (!enabled) {
    return {
      parsed: { semantic_query: q },
      degraded: false,
      filters: deterministicFilters,
      deterministicFilters,
      groundedValues: {},
      excludeTerms: [],
      budgetHints: {},
    };
  }

  if (!ctx.generateConfigured) {
    return fallback;
  }

  const schemaCandidates = options.schemaCandidates ?? options.candidates?.candidates ?? {};
  const schema = augmentNlqSchema(def, schemaCandidates);
  const instructions = def.search?.nlq?.instructions;
  // Caching is best-effort: minimal test/embedded contexts may lack system tables.
  const cache = ctx.systemTables?.samesakeStageCache ? makeStageCacheService(ctx) : null;
  const cacheKey = nlqCacheKey(def, q, schemaCandidates);

  const finishParsed = async (parsed: NlqParsed, degraded: boolean): Promise<NlqParseResult> => {
    const { filters: parsedFilters, excludeTerms, budgetHints } = nlqParsedToFilters(parsed, def);
    const vocabValues = openVocabFilterValues(parsedFilters, def);
    let groundedValues: Record<string, GroundedValueDecision[]> = {};
    if (Object.keys(vocabValues).length > 0) {
      if (options.grounding) {
        groundedValues = options.grounding.decisions;
      } else if (options.candidates) {
        if (!options.candidates.available) groundedValues = unavailableGrounding(vocabValues);
        else if (options.schema && options.collection && options.scopeCols) {
          const grounded = await groundVocabValues(
            ctx,
            options.schema,
            options.collection,
            vocabValues,
            options.scopeCols
          );
          groundedValues = grounded.available ? grounded.decisions : unavailableGrounding(vocabValues);
        } else {
          groundedValues = unavailableGrounding(vocabValues);
        }
      }
    }
    const grounded = applyGrounding(parsedFilters, groundedValues);
    const filters = mergeDeterministicSoftFilters(grounded.filters, deterministicFilters, def);
    const semantic_query = appendDroppedSemantic(parsed.semantic_query, grounded.dropped);
    return {
      parsed: semantic_query === parsed.semantic_query ? parsed : { ...parsed, semantic_query },
      degraded,
      filters,
      deterministicFilters,
      groundedValues,
      excludeTerms,
      budgetHints,
    };
  };

  if (cache) {
    let hit: Record<string, unknown> | null = null;
    try {
      hit = (await cache.getStageCache(cacheKey)) as Record<string, unknown> | null;
    } catch {
      // cache read failures never block the query path
    }
    if (hit && typeof hit.semantic_query === "string") {
      ctx.observability?.inc("nlq_cache_hits");
      const parsed = normalizeAspectRoutes(def, { ...hit, semantic_query: hit.semantic_query });
      return finishParsed(parsed, false);
    }
  }

  let raw: Record<string, unknown>;
  try {
    raw = (await generateWithTimeout(ctx, {
      model: def.search?.nlq?.model,
      prompt: buildNlqPrompt(q, def, instructions, schemaCandidates),
      system: instructions,
      schema,
    })) as Record<string, unknown>;
  } catch {
    return fallback;
  }
  const semantic =
    typeof raw.semantic_query === "string" && raw.semantic_query.trim()
      ? raw.semantic_query.trim()
      : q;
  const parsed = normalizeAspectRoutes(def, { ...raw, semantic_query: semantic });
  cache
    ?.setStageCache(cacheKey, NLQ_CACHE_STAGE, parsed, def.search?.nlq?.model ?? "default", NLQ_CACHE_TTL_DAYS)
    .catch(() => {});
  return finishParsed(parsed, false);
}
