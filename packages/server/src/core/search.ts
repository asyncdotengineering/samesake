import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { CollectionDef, CollectionFieldDef, SearchWeightsInput, SpaceDef } from "@samesake/core";
import type { MatcherCtx } from "../types.ts";
import type { EmbedService } from "./embed.ts";
import { toVectorLiteral } from "./embed.ts";
import { computeFacets } from "./facets.ts";
import { mergeFilters, parseNlq, shouldSkipNlq } from "./nlq.ts";
import type { ProjectsService } from "./projects.ts";
import { ClientError } from "../errors.ts";
import { sanitiseIdent } from "./schema-gen.ts";
import {
  assembleQueryVector,
  encodeCategorical,
  encodeNumberQuery,
  encodeImage,
  encodeRecencyQuery,
  encodeText,
  spaceSegmentDim,
  weightedSegmentCosines,
} from "./spaces.ts";

export { weightedSegmentCosines } from "./spaces.ts";

const RRF_K = 60;
const CANDIDATES = 150;

export type FilterOperator =
  | "$eq"
  | "$ne"
  | "$gt"
  | "$gte"
  | "$lt"
  | "$lte"
  | "$in"
  | "$nin"
  | "$contains"
  | "$exclude"
  | "$not";

export type FilterClause =
  | string
  | number
  | boolean
  | string[]
  | number[]
  | Partial<Record<FilterOperator, string | number | boolean | string[] | number[]>>;

export type SearchFilters = Record<string, FilterClause>;

export interface FilterCompileOpts {
  soft: boolean;
  excludeSoft?: boolean;
  excludeTerms?: string[];
}

export interface CompiledFilter {
  where: string;
  params: unknown[];
  softFieldsUsed: string[];
}

type PgUnsafe = {
  unsafe: (query: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
};

function pgClient(db: PostgresJsDatabase): PgUnsafe {
  const session = (db as { session?: { client?: PgUnsafe } }).session;
  if (!session?.client?.unsafe) {
    throw new Error("postgres client unavailable for parameterized search query");
  }
  return session.client;
}

function isOperatorObject(
  v: FilterClause
): v is Partial<Record<FilterOperator, string | number | boolean | string[] | number[]>> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function filterableFields(def: CollectionDef): Map<string, CollectionFieldDef> {
  const m = new Map<string, CollectionFieldDef>();
  for (const [k, f] of Object.entries(def.fields)) {
    if (f.filterable) m.set(k, f);
  }
  return m;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertNumeric(val: unknown, field: string, op: string): asserts val is number {
  if (typeof val !== "number" || Number.isNaN(val)) {
    throw new ClientError(
      "invalid_filter_value",
      `Filter ${op} on field "${field}" requires a numeric value`
    );
  }
}

function filterClientError(code: string, message: string): never {
  throw new ClientError(code, message);
}

export function buildFilterSql(
  filters: SearchFilters,
  def: CollectionDef,
  opts: FilterCompileOpts,
  startIndex: number
): CompiledFilter {
  const allowed = filterableFields(def);
  const clauses: string[] = [];
  const params: unknown[] = [];
  const softFieldsUsed: string[] = [];
  const next = () => `$${startIndex + params.length}`;

  for (const [field, raw] of Object.entries(filters)) {
    const fieldDef = allowed.get(field);
    if (!fieldDef) {
      const valid = [...allowed.keys()].sort().join(", ");
      filterClientError(
        "unknown_filter_field",
        `Unknown filter field "${field}". Filterable fields: ${valid || "(none)"}`
      );
    }

    if (fieldDef.soft && opts.excludeSoft) continue;
    if (fieldDef.soft && opts.soft) softFieldsUsed.push(field);

    const col = sanitiseIdent(field);
    const isArray = fieldDef.type === "array";

    if (!isOperatorObject(raw)) {
      if (isArray && Array.isArray(raw)) {
        clauses.push(`${col} && ${next()}::text[]`);
        params.push(raw);
        continue;
      }
      if (fieldDef.type === "enum" && fieldDef.alsoMatch?.length && typeof raw === "string") {
        // next() must be interleaved with params.push — two next() calls in one
        // template both render the same index (params.length only grows on push).
        const eqParam = next();
        params.push(raw);
        const anyParam = next();
        params.push([...fieldDef.alsoMatch]);
        clauses.push(`(${col} = ${eqParam} OR ${col} = ANY(${anyParam}::text[]))`);
        continue;
      }
      if (fieldDef.type === "text" || fieldDef.type === "enum") {
        clauses.push(`${col} = ${next()}`);
        params.push(raw);
        continue;
      }
      if (fieldDef.type === "number") {
        assertNumeric(raw, field, "=");
        clauses.push(`${col} = ${next()}::numeric`);
        params.push(raw);
        continue;
      }
      if (fieldDef.type === "boolean") {
        if (typeof raw !== "boolean") {
          filterClientError(
            "invalid_filter_value",
            `Filter on field "${field}" requires a boolean value`
          );
        }
        clauses.push(`${col} = ${next()}::boolean`);
        params.push(raw);
        continue;
      }
    }

    const ops = raw as Partial<Record<FilterOperator, unknown>>;
    for (const [op, val] of Object.entries(ops)) {
      switch (op as FilterOperator) {
        case "$eq":
          if (isArray) {
            clauses.push(`${col} = ${next()}`);
            params.push(val);
          } else if (fieldDef.type === "number") {
            assertNumeric(val, field, "$eq");
            clauses.push(`${col} = ${next()}::numeric`);
            params.push(val);
          } else if (fieldDef.type === "boolean") {
            if (typeof val !== "boolean") {
              filterClientError(
                "invalid_filter_value",
                `Filter $eq on field "${field}" requires a boolean value`
              );
            }
            clauses.push(`${col} = ${next()}::boolean`);
            params.push(val);
          } else if (
            fieldDef.type === "enum" &&
            fieldDef.alsoMatch?.length &&
            typeof val === "string"
          ) {
            const eqParam = next();
            params.push(val);
            const anyParam = next();
            params.push([...fieldDef.alsoMatch]);
            clauses.push(`(${col} = ${eqParam} OR ${col} = ANY(${anyParam}::text[]))`);
          } else {
            clauses.push(`${col} = ${next()}`);
            params.push(val);
          }
          break;
        case "$ne":
          clauses.push(`(${col} IS NULL OR ${col} <> ${next()})`);
          params.push(val);
          break;
        case "$gt":
          assertNumeric(val, field, "$gt");
          clauses.push(`${col} > ${next()}::numeric`);
          params.push(val);
          break;
        case "$gte":
          assertNumeric(val, field, "$gte");
          clauses.push(`${col} >= ${next()}::numeric`);
          params.push(val);
          break;
        case "$lt":
          assertNumeric(val, field, "$lt");
          clauses.push(`${col} < ${next()}::numeric`);
          params.push(val);
          break;
        case "$lte":
          assertNumeric(val, field, "$lte");
          clauses.push(`${col} <= ${next()}::numeric`);
          params.push(val);
          break;
        case "$in":
          clauses.push(`${col} = ANY(${next()}::text[])`);
          params.push(val);
          break;
        case "$nin":
          clauses.push(`(${col} IS NULL OR NOT (${col} = ANY(${next()}::text[])))`);
          params.push(val);
          break;
        case "$contains":
          if (isArray) {
            clauses.push(`${col} && ${next()}::text[]`);
            params.push(val);
          } else {
            clauses.push(`${col} ILIKE '%' || ${next()} || '%'`);
            params.push(val);
          }
          break;
        case "$exclude":
          if (isArray) {
            clauses.push(`NOT (${col} && ${next()}::text[])`);
            params.push(val);
          } else {
            filterClientError(
              "invalid_filter_operator",
              `Operator $exclude is only supported on array fields (field "${field}")`
            );
          }
          break;
        case "$not":
          if (fieldDef.type === "text") {
            clauses.push(`(${col} IS NULL OR ${col} !~* ${next()})`);
            params.push(escapeRegex(String(val)));
          } else {
            filterClientError(
              "invalid_filter_operator",
              `Operator $not is only supported on text fields (field "${field}")`
            );
          }
          break;
        default:
          filterClientError(
            "unknown_filter_operator",
            `Unknown filter operator "${op}" on field "${field}"`
          );
      }
    }
  }

  for (const term of opts.excludeTerms ?? []) {
    const searchableCols = Object.entries(def.fields)
      .filter(([, f]) => f.type === "text" && f.searchable)
      .map(([k]) => `coalesce(${sanitiseIdent(k)}, '')`);
    const textExpr =
      searchableCols.length > 0
        ? `(coalesce(doc, '') || ' ' || ${searchableCols.join(" || ' ' || ")})`
        : "coalesce(doc, '')";
    clauses.push(`${textExpr} !~* ${next()}`);
    params.push(escapeRegex(term));
  }

  return {
    where: clauses.length ? clauses.join(" AND ") : "true",
    params,
    softFieldsUsed,
  };
}

export interface IndexDocumentRow {
  id: string;
  data: Record<string, unknown>;
  enriched?: Record<string, unknown> | null;
  content_hash?: string;
  doc?: string | null;
  embedding?: number[] | null;
  fields?: Record<string, unknown>;
}

export interface SearchHit {
  id: string;
  score: number;
  data: Record<string, unknown>;
  [field: string]: unknown;
}

export interface SearchResult {
  hits: SearchHit[];
  parsed?: Record<string, unknown>;
  nlq_degraded?: boolean;
  relaxed: boolean;
  took_ms: number;
  facets?: Record<string, import("./facets.ts").FacetResult>;
  total_candidates?: number;
  /** true when served from the in-process result cache */
  cached?: boolean;
}

export interface ExplainDocBreakdown {
  id: string;
  fts_rank: number | null;
  cosine_rank: number | null;
  spaces_rank: number | null;
  recency_rank: number | null;
  rrf_score: number;
  space_cosines?: Record<string, number>;
}

export interface SearchExplainResult {
  q: string;
  parsed?: Record<string, unknown>;
  nlq_degraded?: boolean;
  filters: { sql: string; params: Array<{ index: number; type: string }> };
  relaxation: boolean;
  cache_hit: boolean;
  weights: ChannelWeights;
  docs: ExplainDocBreakdown[];
  took_ms: number;
}

export interface SearchOpts {
  q: string;
  filters?: SearchFilters;
  weights?: SearchWeightsInput;
  limit?: number;
  offset?: number;
  facets?: string[];
  /** Set false to bypass the short-TTL in-process result cache. */
  cache?: boolean;
}

const MAX_OFFSET = 200;

// ── In-process result cache (Q2) ─────────────────────────────────────────
// Short-TTL head-query cache: same process, 60s staleness budget, LRU-capped.
const RESULT_CACHE_TTL_MS = 60_000;
const RESULT_CACHE_MAX = 500;
const resultCache = new Map<string, { value: SearchResult; at: number }>();

function resultCacheKey(project: string, collection: string, opts: SearchOpts): string {
  return [
    project,
    collection,
    opts.q.trim().toLowerCase().replace(/\s+/g, " "),
    JSON.stringify(opts.filters ?? {}),
    JSON.stringify(opts.weights ?? {}),
    opts.limit ?? 20,
    opts.offset ?? 0,
    JSON.stringify(opts.facets ?? []),
  ].join("|");
}

// ── Implied-budget resolution (Q1) ──────────────────────────────────────
// "cheap"/"premium" NLQ hints become percentile filters on the budget field,
// scoped to the parsed category when present. Percentiles cached 10 min.
const BUDGET_CHEAP_PCT = 0.3;
const BUDGET_PREMIUM_PCT = 0.75;
const budgetPctCache = new Map<string, { value: number; at: number }>();
const BUDGET_CACHE_TTL_MS = 10 * 60 * 1000;

export async function resolveBudgetHints(
  ctx: MatcherCtx,
  schemaName: string,
  collectionName: string,
  def: CollectionDef,
  hints: Record<string, "cheap" | "premium">,
  filters: SearchFilters
): Promise<void> {
  for (const [field, hint] of Object.entries(hints)) {
    const existing = filters[field];
    if (existing && typeof existing === "object" && ("$lte" in existing || "$gte" in existing)) continue;
    if (typeof existing === "number") continue;

    const pct = hint === "cheap" ? BUDGET_CHEAP_PCT : BUDGET_PREMIUM_PCT;
    const category = typeof filters.category === "string" ? filters.category : null;
    const table = tableName(schemaName, collectionName);
    const col = sanitiseIdent(field);
    const cacheKey = `${table}|${col}|${category ?? "*"}|${hint}`;
    const cached = budgetPctCache.get(cacheKey);
    let threshold: number;
    if (cached && Date.now() - cached.at < BUDGET_CACHE_TTL_MS) {
      threshold = cached.value;
    } else {
      const where = category ? `WHERE category = $2 AND ${col} IS NOT NULL` : `WHERE ${col} IS NOT NULL`;
      const params: unknown[] = [pct];
      if (category) params.push(category);
      const rows = await pgClient(ctx.db).unsafe(
        `SELECT percentile_cont($1) WITHIN GROUP (ORDER BY ${col}) AS v FROM ${table} ${where}`,
        params
      );
      const v = rows[0]?.v;
      if (v == null) continue;
      threshold = Number(v);
      budgetPctCache.set(cacheKey, { value: threshold, at: Date.now() });
    }
    filters[field] = hint === "cheap" ? { $lte: threshold } : { $gte: threshold };
  }
}

function tableName(schema: string, collection: string): string {
  return `${schema}.c_${sanitiseIdent(collection)}`;
}

export interface ChannelWeights {
  fts: number;
  cosine: number;
  recency: number;
  spaces: number;
  recencyHalfLife: number;
  recencyField: string;
  spaceSegmentWeights: Record<string, number>;
}

function defaultSpaceWeights(def: CollectionDef): Record<string, number> {
  const declared = def.search?.defaultSpaceWeights;
  const keys = def.spaces ? Object.keys(def.spaces) : [];
  const out: Record<string, number> = {};
  for (const k of keys) {
    out[k] = declared?.[k] ?? 1;
  }
  return out;
}

function parseSearchWeights(
  def: CollectionDef,
  override?: SearchWeightsInput
): ChannelWeights {
  const channels = def.search?.channels ?? [];
  let fts = 0;
  let cosine = 0;
  let recency = 0;
  let spaces = 0;
  let recencyHalfLife = 90;
  let recencyField = "updated_at";

  for (const ch of channels) {
    if (ch.kind === "fts") fts = ch.weight ?? 0;
    if (ch.kind === "cosine") cosine = ch.weight ?? 0;
    if (ch.kind === "recency") {
      recency = ch.weight ?? 0;
      recencyHalfLife = ch.halfLifeDays ?? 90;
      recencyField = ch.field ?? "updated_at";
    }
    if (ch.kind === "spaces") spaces = ch.weight ?? 0;
  }

  const spaceSegmentWeights = defaultSpaceWeights(def);

  if (override?.fts !== undefined) fts = override.fts;
  if (override?.cosine !== undefined) cosine = override.cosine;
  if (override?.recency !== undefined) recency = override.recency;

  if (override?.spaces !== undefined) {
    if (typeof override.spaces === "number") {
      spaces = override.spaces;
    } else {
      spaces = spaces > 0 ? spaces : 1;
      for (const [k, v] of Object.entries(override.spaces)) {
        if (k in spaceSegmentWeights && typeof v === "number") spaceSegmentWeights[k] = v;
      }
    }
  }

  return { fts, cosine, recency, spaces, recencyHalfLife, recencyField, spaceSegmentWeights };
}

function spaceKeys(def: CollectionDef): string[] {
  return def.spaces ? Object.keys(def.spaces) : [];
}

async function buildQuerySpaceVector(
  def: CollectionDef,
  queryEmbedding: number[] | null,
  filters: SearchFilters,
  segmentWeights: Record<string, number>,
  embedService: EmbedService,
  semanticText: string
): Promise<number[] | null> {
  const built = await buildQuerySpaceSegments(
    def,
    queryEmbedding,
    filters,
    segmentWeights,
    embedService,
    semanticText
  );
  if (!built) return null;
  return assembleQueryVector(built.segments, built.weights, built.dims);
}

function redactFilterParams(params: unknown[]): Array<{ index: number; type: string }> {
  return params.map((p, i) => ({
    index: i + 1,
    type: Array.isArray(p) ? "array" : p === null ? "null" : typeof p,
  }));
}

type HybridRunMode = "search" | "explain";

async function runHybridQuery(
  ctx: MatcherCtx,
  schema: string,
  def: CollectionDef,
  collection: string,
  q: string,
  vector: number[] | null,
  spaceVector: number[] | null,
  filters: SearchFilters,
  filterOpts: FilterCompileOpts,
  weights: ChannelWeights,
  limit: number,
  offset: number,
  mode: HybridRunMode = "search"
): Promise<{
  rows: Array<Record<string, unknown>>;
  softFieldsUsed: string[];
  totalCandidates: number;
  filterSql: string;
  filterParams: unknown[];
}> {
  const table = tableName(schema, collection);
  const params: unknown[] = [];
  const addParam = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };

  const hasFts = weights.fts > 0;
  const hasCos = weights.cosine > 0 && vector !== null;
  const hasSpc = weights.spaces > 0 && spaceVector !== null;
  const hasRec = weights.recency > 0;
  const recField = sanitiseIdent(weights.recencyField);
  const fieldCols = Object.keys(def.fields).map((k) => `d.${sanitiseIdent(k)}`).join(", ");

  const qRef = hasFts ? addParam(q) : null;
  const vecRef = hasCos && vector ? addParam(toVectorLiteral(vector)) : null;
  const spcRef = hasSpc && spaceVector ? addParam(toVectorLiteral(spaceVector)) : null;

  const compiled = buildFilterSql(filters, def, filterOpts, params.length + 1);
  const where = compiled.where;
  params.push(...compiled.params);

  const limitRef = addParam(limit);
  const offsetRef = addParam(offset);

  let query: string;

  if (!hasFts && !hasCos && !hasSpc) {
    if (mode === "explain") {
      query = `
        SELECT d.id,
               NULL::int AS fts_rank,
               NULL::int AS cosine_rank,
               NULL::int AS spaces_rank,
               NULL::int AS recency_rank,
               0::float AS rrf_score
        FROM ${table} d
        WHERE ${where}
        ORDER BY d.updated_at DESC
        LIMIT ${limitRef} OFFSET ${offsetRef}
      `;
    } else {
      query = `
        WITH filtered AS (
          SELECT id FROM ${table} WHERE ${where}
        )
        SELECT d.id, d.data, ${fieldCols}, 0::float AS score,
               (SELECT count(*)::int FROM filtered) AS total_candidates
        FROM ${table} d
        JOIN filtered f ON f.id = d.id
        ORDER BY d.updated_at DESC
        LIMIT ${limitRef} OFFSET ${offsetRef}
      `;
    }
  } else {
    const ctes: string[] = [];
    const rankLegs: Array<{ cte: string; alias: string; weight: number }> = [];

    if (hasFts && qRef) {
      ctes.push(`lex AS (
        SELECT id, row_number() OVER (
          ORDER BY ts_rank_cd(fts, plainto_tsquery('english', ${qRef})) DESC
        ) AS rn
        FROM ${table}
        WHERE fts @@ plainto_tsquery('english', ${qRef}) AND ${where}
        LIMIT ${CANDIDATES}
      )`);
      rankLegs.push({ cte: "lex", alias: "l", weight: weights.fts });
    }

    if (hasCos && vecRef) {
      ctes.push(`sem AS (
        SELECT id, row_number() OVER (ORDER BY embedding <=> ${vecRef}::vector) AS rn
        FROM ${table}
        WHERE embedding IS NOT NULL AND ${where}
        ORDER BY embedding <=> ${vecRef}::vector
        LIMIT ${CANDIDATES}
      )`);
      rankLegs.push({ cte: "sem", alias: "s", weight: weights.cosine });
    }

    if (hasSpc && spcRef) {
      ctes.push(`spc AS (
        SELECT id, row_number() OVER (ORDER BY space_vec <=> ${spcRef}::vector) AS rn
        FROM ${table}
        WHERE space_vec IS NOT NULL AND ${where}
        ORDER BY space_vec <=> ${spcRef}::vector
        LIMIT ${CANDIDATES}
      )`);
      rankLegs.push({ cte: "spc", alias: "p", weight: weights.spaces });
    }

    const candidateUnion = rankLegs.map((l) => `SELECT id FROM ${l.cte}`).join(" UNION ");

    if (hasRec && candidateUnion) {
      ctes.push(`rec AS (
        SELECT t.id,
               row_number() OVER (
                 ORDER BY exp(
                   -ln(2) * extract(epoch FROM (now() - t.${recField})) / 86400.0 / ${weights.recencyHalfLife}
                 ) DESC
               ) AS rn
        FROM (${candidateUnion}) c
        JOIN ${table} t ON t.id = c.id
      )`);
    }

    const scoreExprs = rankLegs.map(
      (l) => `COALESCE(${l.weight}::float / (${RRF_K} + ${l.alias}.rn), 0)`
    );
    if (hasRec) scoreExprs.push(`COALESCE(${weights.recency}::float / (${RRF_K} + r.rn), 0)`);

    let fusedFrom = `FROM ${rankLegs[0]!.cte} ${rankLegs[0]!.alias}`;
    let fusedId = `${rankLegs[0]!.alias}.id`;
    for (let i = 1; i < rankLegs.length; i++) {
      const leg = rankLegs[i]!;
      fusedFrom += ` FULL OUTER JOIN ${leg.cte} ${leg.alias} ON ${fusedId} = ${leg.alias}.id`;
      fusedId = `COALESCE(${fusedId}, ${leg.alias}.id)`;
    }
    if (hasRec) {
      fusedFrom += ` FULL OUTER JOIN rec r ON ${fusedId} = r.id`;
      fusedId = `COALESCE(${fusedId}, r.id)`;
    }

    const ftsRankCol = hasFts ? "l.rn::int" : "NULL::int";
    const cosRankCol = hasCos ? "s.rn::int" : "NULL::int";
    const spcRankCol = hasSpc ? "p.rn::int" : "NULL::int";
    const recRankCol = hasRec ? "r.rn::int" : "NULL::int";
    const legAlias = (kind: string) => rankLegs.find((l) => l.cte === kind)?.alias;

    if (mode === "explain") {
      query = `
        WITH ${ctes.join(", ")},
        fused AS (
          SELECT ${fusedId} AS id,
                 ${ftsRankCol} AS fts_rank,
                 ${cosRankCol} AS cosine_rank,
                 ${spcRankCol} AS spaces_rank,
                 ${recRankCol} AS recency_rank,
                 (${scoreExprs.join(" + ")}) AS rrf_score
          ${fusedFrom}
        )
        SELECT id, fts_rank, cosine_rank, spaces_rank, recency_rank, rrf_score::float AS rrf_score
        FROM fused
        WHERE id IS NOT NULL
        ORDER BY rrf_score DESC
        LIMIT ${limitRef} OFFSET ${offsetRef}
      `;
      void legAlias;
    } else {
      query = `
        WITH ${ctes.join(", ")},
        fused AS (
          SELECT ${fusedId} AS id,
                 (${scoreExprs.join(" + ")}) AS score
          ${fusedFrom}
        ),
        ranked AS (
          SELECT id, score, count(*) OVER ()::int AS total_candidates
          FROM fused
          WHERE id IS NOT NULL
          ORDER BY score DESC
          LIMIT ${limitRef} OFFSET ${offsetRef}
        )
        SELECT d.id, d.data, ${fieldCols}, r.score::float AS score, r.total_candidates
        FROM ranked r
        JOIN ${table} d ON d.id = r.id
        ORDER BY r.score DESC
      `;
    }
  }

  const rows = await pgClient(ctx.db).unsafe(query, params);
  const totalCandidates =
    mode === "explain"
      ? rows.length
      : rows.length > 0
        ? Number(rows[0]!.total_candidates ?? rows.length)
        : 0;
  return {
    rows,
    softFieldsUsed: compiled.softFieldsUsed,
    totalCandidates,
    filterSql: where,
    filterParams: compiled.params,
  };
}

async function buildQuerySpaceSegments(
  def: CollectionDef,
  queryEmbedding: number[] | null,
  filters: SearchFilters,
  segmentWeights: Record<string, number>,
  embedService: EmbedService,
  semanticText: string
): Promise<{ segments: Array<number[] | null>; dims: number[]; keys: string[]; weights: number[] } | null> {
  const keys = spaceKeys(def);
  if (!keys.length) return null;

  const segments: Array<number[] | null> = [];
  const dims: number[] = [];
  const weights: number[] = [];
  const embKey = def.embeddings ? Object.keys(def.embeddings)[0] : null;
  const embDef = embKey ? def.embeddings![embKey]! : null;

  for (const name of keys) {
    const sdef = def.spaces![name] as SpaceDef;
    dims.push(spaceSegmentDim(sdef));
    weights.push(segmentWeights[name] ?? 1);

    if (sdef.kind === "text") {
      if (
        queryEmbedding &&
        embDef &&
        sdef.source === embDef.source &&
        queryEmbedding.length === sdef.dim
      ) {
        segments.push(encodeText(queryEmbedding));
      } else {
        try {
          const vec = await embedService.embedQuery({
            text: semanticText,
            model: sdef.model,
            dim: sdef.dim,
            taskType: sdef.taskType ?? "RETRIEVAL_QUERY",
            inputType: "query",
          });
          segments.push(encodeText(vec));
        } catch {
          segments.push(null);
        }
      }
      continue;
    }
    if (sdef.kind === "image") {
      try {
        const vec = await embedService.embedQuery({
          text: semanticText,
          model: sdef.model,
          dim: sdef.dim,
          taskType: sdef.taskType ?? "RETRIEVAL_QUERY",
          inputType: "query",
        });
        segments.push(encodeImage(vec));
      } catch {
        segments.push(null);
      }
      continue;
    }
    if (sdef.kind === "number") {
      const target =
        typeof filters[sdef.field] === "number"
          ? (filters[sdef.field] as number)
          : typeof filters[sdef.field] === "object" &&
              filters[sdef.field] !== null &&
              "$eq" in (filters[sdef.field] as object)
            ? Number((filters[sdef.field] as { $eq: number }).$eq)
            : null;
      segments.push(encodeNumberQuery(target, sdef));
      continue;
    }
    if (sdef.kind === "recency") {
      segments.push(encodeRecencyQuery(sdef));
      continue;
    }
    if (sdef.kind === "categorical") {
      const raw = filters[sdef.field];
      const cat =
        typeof raw === "string"
          ? raw
          : typeof raw === "object" && raw !== null && "$eq" in raw
            ? String((raw as { $eq: string }).$eq)
            : null;
      segments.push(encodeCategorical(cat, sdef));
      continue;
    }
    segments.push(null);
  }

  return { segments, dims, keys, weights };
}

export function makeSearchService(
  ctx: MatcherCtx,
  embedService: EmbedService,
  projectsService: ProjectsService
) {
  async function getCollectionDef(
    projectSlug: string,
    collectionName: string
  ): Promise<CollectionDef | null> {
    return projectsService.getCollectionDef(projectSlug, collectionName);
  }

  async function indexDocuments(
    projectSlug: string,
    collectionName: string,
    rows: IndexDocumentRow[]
  ): Promise<{ indexed: number }> {
    const project = await projectsService.getProject(projectSlug);
    if (!project) throw new Error(`project "${projectSlug}" not found`);
    const def = await getCollectionDef(projectSlug, collectionName);
    if (!def) throw new Error(`collection "${collectionName}" not found in project "${projectSlug}"`);

    const table = tableName(project.schema_name, collectionName);
    const fieldCols = Object.keys(def.fields).map((k) => sanitiseIdent(k));
    let indexed = 0;

    for (const row of rows) {
      const cols = ["id", "data", "enriched", "content_hash", "doc", "embedding", ...fieldCols];
      const values: unknown[] = [
        row.id,
        JSON.stringify(row.data),
        row.enriched ? JSON.stringify(row.enriched) : null,
        row.content_hash ?? "test",
        row.doc ?? null,
        row.embedding ? toVectorLiteral(row.embedding) : null,
        ...fieldCols.map((c) => {
          const orig = Object.keys(def.fields).find((k) => sanitiseIdent(k) === c);
          return orig ? (row.fields?.[orig] ?? null) : null;
        }),
      ];

      const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");
      const updateSet = cols
        .filter((c) => c !== "id")
        .map((c) => `${c} = EXCLUDED.${c}`)
        .join(", ");

      await pgClient(ctx.db).unsafe(
        `INSERT INTO ${table} (${cols.join(", ")}, indexed_at, updated_at)
         VALUES (${placeholders}, now(), now())
         ON CONFLICT (id) DO UPDATE SET ${updateSet}, indexed_at = now(), updated_at = now()`,
        values
      );
      indexed++;
    }

    return { indexed };
  }

  async function search(
    projectSlug: string,
    collectionName: string,
    opts: SearchOpts
  ): Promise<SearchResult> {
    const t0 = Date.now();
    ctx.observability.inc("searches_total");
    const cacheKey = opts.cache === false ? null : resultCacheKey(projectSlug, collectionName, opts);
    if (cacheKey) {
      const hit = resultCache.get(cacheKey);
      if (hit && Date.now() - hit.at < RESULT_CACHE_TTL_MS) {
        ctx.observability.inc("search_cache_hits");
        return { ...hit.value, took_ms: Date.now() - t0, cached: true };
      }
    }
    const project = await projectsService.getProject(projectSlug);
    if (!project) throw new Error(`project "${projectSlug}" not found`);
    const def = await getCollectionDef(projectSlug, collectionName);
    if (!def) throw new Error(`collection "${collectionName}" not found in project "${projectSlug}"`);

    const q = opts.q?.trim() ?? "";
    if (!q) throw new Error("search requires a non-empty q");

    const limit = opts.limit ?? 20;
    const offset = Math.min(Math.max(opts.offset ?? 0, 0), MAX_OFFSET);
    const weights = parseSearchWeights(def, opts.weights);

    const nlq = await parseNlq(ctx, def, q);
    const mergedFilters = mergeFilters(nlq.filters, opts.filters);
    await resolveBudgetHints(ctx, project.schema_name, collectionName, def, nlq.budgetHints, mergedFilters);
    const filterOpts: FilterCompileOpts = {
      soft: true,
      excludeTerms: nlq.excludeTerms,
    };

    const semanticText = nlq.parsed.semantic_query || q;

    let vector: number[] | null = null;
    const embKey = def.embeddings ? Object.keys(def.embeddings)[0] : null;
    const needsQueryEmbed =
      (embKey && weights.cosine > 0) ||
      (weights.spaces > 0 &&
        def.spaces &&
        Object.values(def.spaces).some((s) => s.kind === "text" || s.kind === "image"));
    if (embKey && needsQueryEmbed) {
      const embDef = def.embeddings![embKey]!;
      try {
        vector = await embedService.embedQuery({
          text: semanticText,
          model: embDef.model,
          dim: embDef.dim,
          taskType: embDef.taskType ?? "RETRIEVAL_QUERY",
          inputType: "query",
        });
      } catch {
        vector = null;
      }
    }

    let spaceVector: number[] | null = null;
    if (weights.spaces > 0 && def.spaces && Object.keys(def.spaces).length > 0) {
      spaceVector = await buildQuerySpaceVector(
        def,
        vector,
        mergedFilters,
        weights.spaceSegmentWeights,
        embedService,
        semanticText
      );
    }

    let { rows, softFieldsUsed, totalCandidates } = await runHybridQuery(
      ctx,
      project.schema_name,
      def,
      collectionName,
      q,
      vector,
      spaceVector,
      mergedFilters,
      filterOpts,
      weights,
      limit,
      offset
    );

    let relaxed = false;
    const hasSoftFilters =
      softFieldsUsed.length > 0 ||
      Object.keys(mergedFilters).some((k) => def.fields[k]?.soft);

    if (rows.length < 3 && hasSoftFilters) {
      const retry = await runHybridQuery(
        ctx,
        project.schema_name,
        def,
        collectionName,
        q,
        vector,
        spaceVector,
        mergedFilters,
        { ...filterOpts, excludeSoft: true },
        weights,
        limit,
        offset
      );
      rows = retry.rows;
      totalCandidates = retry.totalCandidates;
      relaxed = true;
    }

    let facets: SearchResult["facets"];
    if (opts.facets?.length) {
      const compiled = buildFilterSql(mergedFilters, def, filterOpts, 1);
      facets = await computeFacets(
        ctx.db,
        tableName(project.schema_name, collectionName),
        def,
        compiled.where,
        compiled.params,
        opts.facets
      );
    }

    const fieldKeys = Object.keys(def.fields);
    const hits: SearchHit[] = rows.map((r) => {
      const hit: SearchHit = {
        id: String(r.id),
        score: Number(r.score),
        data: (typeof r.data === "string" ? JSON.parse(r.data as string) : r.data) as Record<
          string,
          unknown
        >,
      };
      for (const k of fieldKeys) {
        hit[k] = r[sanitiseIdent(k)] ?? r[k];
      }
      return hit;
    });

    const result: SearchResult = {
      hits,
      relaxed,
      took_ms: Date.now() - t0,
      total_candidates: totalCandidates,
    };

    if (def.search?.nlq && !shouldSkipNlq(def, q)) {
      result.parsed = nlq.parsed;
      if (nlq.degraded) {
        result.nlq_degraded = true;
        ctx.observability.inc("nlq_degraded_total");
      }
    } else if (Object.keys(nlq.filters).length || nlq.excludeTerms.length) {
      result.parsed = nlq.parsed;
    }

    if (facets) result.facets = facets;

    if (cacheKey && !nlq.degraded) {
      if (resultCache.size >= RESULT_CACHE_MAX) {
        const oldest = resultCache.keys().next().value;
        if (oldest) resultCache.delete(oldest);
      }
      resultCache.set(cacheKey, { value: result, at: Date.now() });
    }

    return result;
  }

  async function searchExplain(
    projectSlug: string,
    collectionName: string,
    opts: SearchOpts
  ): Promise<SearchExplainResult> {
    const t0 = Date.now();
    ctx.observability.inc("searches_total");
    const cacheKey = opts.cache === false ? null : resultCacheKey(projectSlug, collectionName, opts);
    let cacheHit = false;
    if (cacheKey) {
      const hit = resultCache.get(cacheKey);
      if (hit && Date.now() - hit.at < RESULT_CACHE_TTL_MS) {
        cacheHit = true;
        ctx.observability.inc("search_cache_hits");
      }
    }

    const project = await projectsService.getProject(projectSlug);
    if (!project) throw new Error(`project "${projectSlug}" not found`);
    const def = await getCollectionDef(projectSlug, collectionName);
    if (!def) throw new Error(`collection "${collectionName}" not found in project "${projectSlug}"`);

    const q = opts.q?.trim() ?? "";
    if (!q) throw new Error("search explain requires a non-empty q");

    const limit = Math.min(opts.limit ?? 20, 20);
    const offset = Math.min(Math.max(opts.offset ?? 0, 0), MAX_OFFSET);
    const weights = parseSearchWeights(def, opts.weights);

    const nlq = await parseNlq(ctx, def, q);
    const mergedFilters = mergeFilters(nlq.filters, opts.filters);
    await resolveBudgetHints(ctx, project.schema_name, collectionName, def, nlq.budgetHints, mergedFilters);
    const filterOpts: FilterCompileOpts = {
      soft: true,
      excludeTerms: nlq.excludeTerms,
    };

    const semanticText = nlq.parsed.semantic_query || q;

    let vector: number[] | null = null;
    const embKey = def.embeddings ? Object.keys(def.embeddings)[0] : null;
    const needsQueryEmbed =
      (embKey && weights.cosine > 0) ||
      (weights.spaces > 0 &&
        def.spaces &&
        Object.values(def.spaces).some((s) => s.kind === "text" || s.kind === "image"));
    if (embKey && needsQueryEmbed) {
      const embDef = def.embeddings![embKey]!;
      try {
        vector = await embedService.embedQuery({
          text: semanticText,
          model: embDef.model,
          dim: embDef.dim,
          taskType: embDef.taskType ?? "RETRIEVAL_QUERY",
          inputType: "query",
        });
      } catch {
        vector = null;
      }
    }

    const spaceSegments = await buildQuerySpaceSegments(
      def,
      vector,
      mergedFilters,
      weights.spaceSegmentWeights,
      embedService,
      semanticText
    );
    const spaceVector =
      weights.spaces > 0 && spaceSegments
        ? assembleQueryVector(spaceSegments.segments, spaceSegments.weights, spaceSegments.dims)
        : null;

    let { rows, softFieldsUsed, filterSql, filterParams } = await runHybridQuery(
      ctx,
      project.schema_name,
      def,
      collectionName,
      q,
      vector,
      spaceVector,
      mergedFilters,
      filterOpts,
      weights,
      limit,
      offset,
      "explain"
    );

    let relaxed = false;
    const hasSoftFilters =
      softFieldsUsed.length > 0 ||
      Object.keys(mergedFilters).some((k) => def.fields[k]?.soft);

    if (rows.length < 3 && hasSoftFilters) {
      const retry = await runHybridQuery(
        ctx,
        project.schema_name,
        def,
        collectionName,
        q,
        vector,
        spaceVector,
        mergedFilters,
        { ...filterOpts, excludeSoft: true },
        weights,
        limit,
        offset,
        "explain"
      );
      rows = retry.rows;
      filterSql = retry.filterSql;
      filterParams = retry.filterParams;
      relaxed = true;
    }

    const table = tableName(project.schema_name, collectionName);
    const spaceCosinesById = new Map<string, Record<string, number>>();
    if (weights.spaces > 0 && spaceSegments && rows.length) {
      const ids = rows.map((r) => String(r.id));
      const vecRows = await pgClient(ctx.db).unsafe(
        `SELECT id, space_vec::text AS space_vec FROM ${table} WHERE id = ANY($1::text[])`,
        [ids]
      );
      for (const vr of vecRows) {
        const id = String(vr.id);
        const raw = String(vr.space_vec ?? "");
        const docVec = raw
          .replace(/^\[/, "")
          .replace(/\]$/, "")
          .split(",")
          .map((x) => Number(x.trim()))
          .filter((x) => Number.isFinite(x));
        if (!docVec.length) continue;
        const cosines = weightedSegmentCosines(
          docVec,
          spaceSegments.segments,
          spaceSegments.weights,
          spaceSegments.dims
        );
        const perSpace: Record<string, number> = {};
        spaceSegments.keys.forEach((k, i) => {
          perSpace[k] = cosines[i] ?? 0;
        });
        spaceCosinesById.set(id, perSpace);
      }
    }

    const docs: ExplainDocBreakdown[] = rows.map((r) => {
      const id = String(r.id);
      const breakdown: ExplainDocBreakdown = {
        id,
        fts_rank: r.fts_rank == null ? null : Number(r.fts_rank),
        cosine_rank: r.cosine_rank == null ? null : Number(r.cosine_rank),
        spaces_rank: r.spaces_rank == null ? null : Number(r.spaces_rank),
        recency_rank: r.recency_rank == null ? null : Number(r.recency_rank),
        rrf_score: Number(r.rrf_score ?? 0),
      };
      const sc = spaceCosinesById.get(id);
      if (sc) breakdown.space_cosines = sc;
      return breakdown;
    });

    const explain: SearchExplainResult = {
      q,
      relaxation: relaxed,
      cache_hit: cacheHit,
      weights,
      filters: { sql: filterSql, params: redactFilterParams(filterParams) },
      docs,
      took_ms: Date.now() - t0,
    };

    if (def.search?.nlq && !shouldSkipNlq(def, q)) {
      explain.parsed = nlq.parsed;
      if (nlq.degraded) {
        explain.nlq_degraded = true;
        ctx.observability.inc("nlq_degraded_total");
      }
    } else if (Object.keys(nlq.filters).length || nlq.excludeTerms.length) {
      explain.parsed = nlq.parsed;
    }

    return explain;
  }

  return { search, searchExplain, indexDocuments, getCollectionDef };
}

export type SearchService = ReturnType<typeof makeSearchService>;
