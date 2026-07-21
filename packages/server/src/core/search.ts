import type { CollectionDef, ConstraintTrace, SearchMode, SearchWeightsInput } from "@samesake/core";
import type { MatcherCtx } from "../types.ts";
import { mergeBlendedRerank, rerankCandidateText } from "./rerank.ts";
import { applyRankingPolicy, type SearchHit } from "@samesake/query";
import type { EmbedService } from "./embed.ts";
import { toVectorLiteral } from "./embed.ts";
import { buildConstraintTrace } from "@samesake/query";
import { mergeFilters, parseNlq, shouldSkipNlq } from "./nlq.ts";
import { vocabCandidates } from "./field-vocab.ts";
import type { ProjectsService, ProjectRow } from "./projects.ts";
import { sanitiseIdent } from "./schema-gen.ts";
import { ftsLanguage } from "./collections-schema-gen.ts";
import { collectionTableName } from "./db-utils.ts";
import { searchResultCache, type SearchCacheKey } from "./search-cache.ts";
import { buildFilterSql, type FilterCompileOpts, type SearchFilters } from "./search-filter.ts";
import { applyCutoff, type CutoffEvidence } from "@samesake/query";
import { proposeRewrites, type RewriteRecord } from "./query-rewrite.ts";
import { appendScopeSql, resolveScope } from "./scope.ts";
import {
  buildQueryAspectImageVectors,
  parseSearchWeights,
  resolveAspectPlans,
  type AspectPlan,
  type ChannelWeights,
} from "./search-query.ts";
import { embeddingColumn, embeddingEntries, evidenceEntries, evidenceTable, EVIDENCE_OVERFETCH_FACTOR } from "./aspects.ts";

export {
  buildFilterSql,
  normalizeFiltersToConstraintPredicates,
  type CompiledFilter,
  type FilterClause,
  type FilterCompileOpts,
  type FilterOperator,
  type SearchFilters,
} from "./search-filter.ts";

const RRF_K = 60;
const CANDIDATES = 150;

export interface IndexDocumentRow {
  id: string;
  data: Record<string, unknown>;
  enriched?: Record<string, unknown> | null;
  content_hash?: string;
  doc?: string | null;
  embedding?: number[] | null;
  embeddings?: Record<string, number[] | null>;
  evidence?: Record<string, Array<{ src: string; vector: number[] }>>;
  scope?: Record<string, string>;
  fields?: Record<string, unknown>;
}

export type { SearchHit } from "@samesake/query";

export interface SearchResult {
  hits: SearchHit[];
  parsed?: Record<string, unknown>;
  constraintTrace: ConstraintTrace;
  nlq_degraded?: boolean;
  relaxed: boolean;
  relaxedFields: string[];
  took_ms: number;
  facets?: Record<string, import("../db/postgres/facets.ts").FacetResult>;
  total_candidates?: number;
  /** hits removed by the result-cutoff strategy (honest zero-results); absent when 0 */
  cutoff_dropped?: number;
  /** true when served from the in-process result cache */
  cached?: boolean;
  rewritten?: RewriteRecord;
}

export interface ExplainDocBreakdown {
  id: string;
  fts_rank: number | null;
  cosine_rank: number | null;
  recency_rank: number | null;
  rrf_score: number;
  aspect_ranks?: Record<string, { rank: number | null; cosine: number | null }>;
}

export interface SearchExplainResult {
  q: string;
  parsed?: Record<string, unknown>;
  constraintTrace: ConstraintTrace;
  nlq_degraded?: boolean;
  filters: { sql: string; params: Array<{ index: number; type: string }> };
  relaxation: boolean;
  relaxedFields: string[];
  cache_hit: boolean;
  weights: ChannelWeights;
  docs: ExplainDocBreakdown[];
  took_ms: number;
  rewritten?: RewriteRecord;
}

export interface SearchOpts {
  q: string;
  image?: {
    url?: string;
    bytes?: Uint8Array;
    bytesBase64?: string;
    mimeType?: string;
  };
  filters?: SearchFilters;
  weights?: SearchWeightsInput;
  /**
   * Retrieval objective. Omit to auto-resolve: "similar" when an image is present, else
   * "intent". "intent" keeps keyword as a tiebreaker; "similar" turns keyword off so
   * semantic + visual decide. Explicit `weights` still override the mode's defaults.
   */
  mode?: SearchMode;
  limit?: number;
  offset?: number;
  facets?: string[];
  /** Set true to opt into the short-TTL in-process result cache. */
  cache?: boolean;
  /**
   * Second-stage reranking. Defaults to on when a `rerank` fn is configured on the
   * matcher. Set false to force pure first-stage (RRF) order.
   */
  rerank?: boolean;
  /**
   * Collapse near-duplicate variants (same `search.variantGroup` value) to the
   * best-scoring item per group. Defaults to on when the collection declares
   * `variantGroup`. Set false to return every variant.
   */
  diversify?: boolean;
  /**
   * HNSW recall/latency dial (pgvector `hnsw.ef_search`, clamped to 10–1000).
   * Higher = better ANN recall, slower query. Omit for the pgvector default (40).
   */
  efSearch?: number;
  /**
   * Tenancy scope. REQUIRED (all declared keys) when the collection declares
   * `scopes` — every query runs inside exactly one scope; there is no
   * cross-scope search. Rejected on unscoped collections.
   */
  scope?: Record<string, string>;
  /**
   * Attach cross-vendor `offers` to each hit (dedup-enabled collections only). Defaults
   * to on when the collection declares `dedup`; set false to skip the batched offers
   * query. No effect on collections without `dedup`.
   */
  offers?: boolean;
}

// Second-stage rerank: how many first-stage candidates to hand the reranker.
const RERANK_POOL = 50;

/** Everything expensive and shared between a search and its explain breakdown, computed once. */
interface Retrieval {
  project: ProjectRow;
  def: CollectionDef;
  collectionName: string;
  q: string;
  weights: ChannelWeights;
  offset: number;
  /** Sanitised scope column → value (empty for unscoped collections). */
  scopeCols: Record<string, string>;
  nlq: Awaited<ReturnType<typeof parseNlq>>;
  explicitFilters: SearchFilters;
  mergedFilters: SearchFilters;
  filterOpts: FilterCompileOpts;
  semanticText: string;
  lexicalText: string;
  vector: number[] | null;
  aspectPlans: AspectPlan[];
  efSearch: number | null;
}

interface RetrieveRetryContext {
  original: Retrieval;
  query: string;
}

interface RankedRun {
  rows: Array<Record<string, unknown>>;
  totalCandidates: number;
  filterSql: string;
  filterParams: unknown[];
  relaxed: boolean;
  relaxedFields: string[];
  effectiveFilters: SearchFilters;
  relaxationSteps: Array<{ field: string; standaloneMatchCount: number; resultCount: number }>;
  gateEvidence: "retrieval" | "relevance_floor" | "none";
}

interface ResolvedExecution {
  retrieval: Retrieval;
  ranked: RankedRun;
  rows: Array<Record<string, unknown>>;
  cutoffDropped: number;
  rewritten?: RewriteRecord;
}

const MAX_OFFSET = 200;

function imageFingerprint(image: SearchOpts["image"]): string | null {
  if (!image) return null;
  if (image.url) return `url:${image.url}`;
  const payload = image.bytesBase64 ?? (image.bytes ? Buffer.from(image.bytes).toString("base64") : null);
  if (payload == null) return null;
  // djb2 over the payload keeps the key bounded for large base64 images.
  let h = 5381;
  for (let i = 0; i < payload.length; i++) h = ((h << 5) + h + payload.charCodeAt(i)) >>> 0;
  return `bytes:${image.mimeType ?? ""}:${payload.length}:${h.toString(36)}`;
}

function resultCacheKey(project: string, collection: string, opts: SearchOpts): SearchCacheKey {
  return {
    project,
    collection,
    query: opts.q,
    image: imageFingerprint(opts.image),
    filters: opts.filters ?? {},
    weights: opts.weights ?? {},
    mode: opts.mode ?? (opts.image ? "similar" : "intent"),
    limit: opts.limit ?? 20,
    offset: opts.offset ?? 0,
    facets: opts.facets ?? [],
    efSearch: opts.efSearch ?? null,
    scope: opts.scope ?? {},
    offers: opts.offers ?? null,
  };
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
    const table = collectionTableName(schemaName, collectionName);
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
      const rows = await ctx.storage.client("parameterized search query").unsafe(
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
  lexicalText: string,
  aspectPlans: AspectPlan[],
  filters: SearchFilters,
  filterOpts: FilterCompileOpts,
  weights: ChannelWeights,
  relevanceFloor: number | null,
  limit: number,
  offset: number,
  efSearch: number | null,
  scopeCols: Record<string, string>,
  mode: HybridRunMode = "search"
): Promise<{
  rows: Array<Record<string, unknown>>;
  softFieldsUsed: string[];
  totalCandidates: number;
  preFloorCandidates: number;
  postFloorCandidates: number;
  gateEvidence: "retrieval" | "relevance_floor" | "none";
  filterSql: string;
  filterParams: unknown[];
}> {
  const table = collectionTableName(schema, collection);
  const params: unknown[] = [];
  const addParam = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  const activePlans = aspectPlans.filter((plan) => plan.weight > 0 && plan.queryVector !== null);
  const hasFts = weights.fts > 0;
  const hasCos = activePlans.length > 0;
  const hasColumnAspect = activePlans.some((plan) => plan.embedding.evidence !== true);
  const needsBaseWhere = hasFts || hasColumnAspect;
  const hasRec = weights.recency > 0;
  const needCosFloor = relevanceFloor !== null && hasCos;
  const recField = sanitiseIdent(weights.recencyField);
  const fieldCols = Object.keys(def.fields).map((k) => `d.${sanitiseIdent(k)}`).join(", ");
  const dedupGroupCol = def.dedup ? sanitiseIdent(def.dedup.groupField ?? "product_group") : null;
  const extraCols = dedupGroupCol ? `, d.${dedupGroupCol}` : "";
  const qRef = hasFts ? addParam(lexicalText) : null;
  const vectorRefs = new Map<string, string>();
  for (const plan of activePlans) vectorRefs.set(plan.name, addParam(toVectorLiteral(plan.queryVector!)));

  const scopeCond = needsBaseWhere
    ? Object.entries(scopeCols)
        .map(([col, value]) => `${col} = ${addParam(value)}`)
        .join(" AND ")
    : "";
  const visibility = scopeCond
    ? `(pipeline_status = 'ready' OR pipeline_status IS NULL) AND ${scopeCond}`
    : "(pipeline_status = 'ready' OR pipeline_status IS NULL)";
  const compiled = buildFilterSql(filters, def, filterOpts, params.length + 1);
  const where = compiled.where === "true" ? visibility : `${compiled.where} AND ${visibility}`;
  if (needsBaseWhere) params.push(...compiled.params);
  const limitRef = addParam(limit);
  const offsetRef = addParam(offset);

  let query: string;
  if (!hasFts && !hasCos) {
    if (mode === "explain") {
      query = `
        SELECT d.id,
               NULL::int AS fts_rank,
               NULL::int AS cosine_rank,
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
        SELECT d.id, d.data, d.rerank_doc, ${fieldCols}${extraCols}, 0::float AS score,
               (SELECT count(*)::int FROM filtered) AS total_candidates
        FROM ${table} d
        JOIN filtered f ON f.id = d.id
        ORDER BY d.updated_at DESC
        LIMIT ${limitRef} OFFSET ${offsetRef}
      `;
    }
  } else {
    const ctes: string[] = [];
    const rankLegs: Array<{ name: string; cte: string; alias: string; weight: number }> = [];
    if (hasFts && qRef) {
      const lang = ftsLanguage(def);
      const andTsq = `websearch_to_tsquery('${lang}', unaccent(${qRef}))`;
      const orTsq = `nullif(replace(${andTsq}::text, '&', '|'), '')::tsquery`;
      const phonActive = !!def.search?.phonetic && !!ctx.phonetic;
      const phonTsq = phonActive
        ? `nullif(replace(plainto_tsquery('simple', ${sanitiseIdent(ctx.schema)}.samesake_phonetic_tokens(${qRef}))::text, '&', '|'), '')::tsquery`
        : null;
      ctes.push(`lex AS (
        SELECT id, row_number() OVER (
          ORDER BY ts_rank_cd(fts, ${andTsq}) DESC, ts_rank_cd(fts, ${orTsq}) DESC${phonTsq ? `, ts_rank_cd(fts_phon, ${phonTsq}) DESC` : ""}
        ) AS rn
        FROM ${table}
        WHERE (fts @@ ${orTsq}${phonTsq ? ` OR fts_phon @@ ${phonTsq}` : ""}) AND ${where}
        LIMIT ${CANDIDATES}
      )`);
      rankLegs.push({ name: "fts", cte: "lex", alias: "l", weight: weights.fts });
    }

    for (const plan of activePlans) {
      const allEntries = embeddingEntries(def);
      const index = allEntries.findIndex(([name]) => name === plan.name);
      const vecRef = vectorRefs.get(plan.name)!;
      const safe = sanitiseIdent(plan.name);
      const cte = activePlans.length === 1 ? "sem" : `aspect_${safe}`;
      const alias = activePlans.length === 1 ? "s" : `a_${safe}`;
      if (plan.embedding.evidence === true) {
        const evAspectRef = addParam(plan.name);
        const evScope = Object.entries(scopeCols)
          .map(([col, value]) => `e.${col} = ${addParam(value)}`)
          .join(" AND ");
        const innerCompiled = buildFilterSql(filters, def, { ...filterOpts, columnPrefix: "d" }, params.length + 1);
        params.push(...innerCompiled.params);
        const innerWhere = innerCompiled.where === "true" ? "true" : innerCompiled.where;
        const innerGuards = [
          `e.aspect = ${evAspectRef}`,
          `(d.pipeline_status = 'ready' OR d.pipeline_status IS NULL)`,
          evScope || "true",
          innerWhere,
        ].join(" AND ");
        ctes.push(`${cte} AS (
          SELECT e.doc_id AS id,
                 row_number() OVER (ORDER BY max(1 - (e.vec <=> ${vecRef}::halfvec)) DESC) AS rn,
                 max(1 - (e.vec <=> ${vecRef}::halfvec))::float AS cos
          FROM (
            SELECT e.doc_id, e.vec
            FROM ${evidenceTable(schema, collection)} e
            JOIN ${table} d ON d.id = e.doc_id
            WHERE ${innerGuards}
            ORDER BY e.vec <=> ${vecRef}::halfvec
            LIMIT ${CANDIDATES * EVIDENCE_OVERFETCH_FACTOR}
          ) e
          GROUP BY e.doc_id
          ORDER BY cos DESC
          LIMIT ${CANDIDATES}
        )`);
      } else {
        const column = embeddingColumn(plan.name, index);
        ctes.push(`${cte} AS (
          SELECT id, row_number() OVER (ORDER BY ${column} <=> ${vecRef}::halfvec) AS rn,
                 (1 - (${column} <=> ${vecRef}::halfvec))::float AS cos
          FROM ${table}
          WHERE ${column} IS NOT NULL AND ${where}
          ORDER BY ${column} <=> ${vecRef}::halfvec
          LIMIT ${CANDIDATES}
        )`);
      }
      rankLegs.push({ name: plan.name, cte, alias, weight: plan.weight });
    }

    const candidateUnion = rankLegs.map((leg) => `SELECT id FROM ${leg.cte}`).join(" UNION ");
    if (hasRec && candidateUnion) {
      ctes.push(`rec AS (
        SELECT t.id,
               row_number() OVER (ORDER BY exp(-ln(2) * extract(epoch FROM (now() - t.${recField})) / 86400.0 / ${weights.recencyHalfLife}) DESC) AS rn
        FROM (${candidateUnion}) c
        JOIN ${table} t ON t.id = c.id
      )`);
    }
    const scoreExprs = rankLegs.map((leg) => `COALESCE(${leg.weight}::float / (${RRF_K} + ${leg.alias}.rn), 0)`);
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
    const firstAspectLeg = rankLegs.find((leg) => leg.name !== "fts");
    const cosRankCol = firstAspectLeg ? `${firstAspectLeg.alias}.rn::int` : "NULL::int";
    const recRankCol = hasRec ? "r.rn::int" : "NULL::int";
    const explainAspects = embeddingEntries(def).length > 1;
    const aspectFields = explainAspects
      ? embeddingEntries(def).flatMap(([name]) => {
          const leg = rankLegs.find((candidate) => candidate.name === name);
          const safe = sanitiseIdent(name);
          return leg
            ? [`${leg.alias}.rn::int AS aspect_${safe}_rank`, `${leg.alias}.cos::float AS aspect_${safe}_cosine`]
            : [`NULL::int AS aspect_${safe}_rank`, `NULL::float AS aspect_${safe}_cosine`];
        })
      : [];
    if (mode === "explain") {
      query = `
        WITH ${ctes.join(", ")},
        fused AS (
          SELECT ${fusedId} AS id,
                 ${ftsRankCol} AS fts_rank,
                 ${cosRankCol} AS cosine_rank,
                 ${recRankCol} AS recency_rank,
                 (${scoreExprs.join(" + ")}) AS rrf_score${aspectFields.length ? `, ${aspectFields.join(", ")}` : ""}
          ${fusedFrom}
        )
        SELECT id, fts_rank, cosine_rank, recency_rank, rrf_score::float AS rrf_score${aspectFields.length ? `, ${aspectFields.map((field) => field.split(" AS ")[1]).join(", ")}` : ""}
        FROM fused
        WHERE id IS NOT NULL
        ORDER BY rrf_score DESC
        LIMIT ${limitRef} OFFSET ${offsetRef}
      `;
    } else {
      const floorRef = needCosFloor ? addParam(relevanceFloor) : null;
      const firstCos = firstAspectLeg ? `${firstAspectLeg.alias}.cos` : "NULL::float";
      const evidenceCols = `,
                 ${hasFts ? "(l.rn IS NOT NULL)" : "FALSE"} AS fts_present,
                 ${firstCos} AS cos_sim`;
      const floorWhere = needCosFloor ? ` AND (fts_present OR cos_sim >= ${floorRef})` : "";
      query = `
        WITH ${ctes.join(", ")},
        fused AS (
          SELECT ${fusedId} AS id,
                 (${scoreExprs.join(" + ")}) AS score${evidenceCols}
          ${fusedFrom}
        ),
        eligible AS (
          SELECT id, score, fts_present, cos_sim
          FROM fused
          WHERE id IS NOT NULL${floorWhere}
        ),
        metadata AS (
          SELECT
            (SELECT count(*)::int FROM fused WHERE id IS NOT NULL) AS pre_floor_candidates,
            (SELECT count(*)::int FROM eligible) AS post_floor_candidates
        ),
        ranked AS (
          SELECT id, score, fts_present, cos_sim
          FROM eligible
          ORDER BY score DESC
          LIMIT ${limitRef} OFFSET ${offsetRef}
        )
        SELECT d.id, d.data, d.rerank_doc, ${fieldCols}${extraCols}, r.score::float AS score,
               r.fts_present, r.cos_sim,
               m.pre_floor_candidates, m.post_floor_candidates,
               m.post_floor_candidates AS total_candidates
        FROM metadata m
        LEFT JOIN ranked r ON TRUE
        LEFT JOIN ${table} d ON d.id = r.id
        ORDER BY r.score DESC NULLS LAST
      `;
    }
  }

  const settings: string[] = [];
  if (hasCos) {
    const pgv = await ctx.storage.pgvectorVersion();
    if (pgv) {
      if (pgv[0] > 0 || pgv[1] >= 8) settings.push("SET LOCAL hnsw.iterative_scan = 'relaxed_order'");
      if (efSearch != null) settings.push(`SET LOCAL hnsw.ef_search = ${Math.max(10, Math.min(1000, Math.floor(efSearch)))}`);
    }
  }
  const rawRows = await ctx.storage.unsafeWithSettings("parameterized search query", settings, query, params);
  const preFloorCandidates = mode === "search"
    ? Number(rawRows[0]?.pre_floor_candidates ?? rawRows[0]?.total_candidates ?? rawRows.length)
    : rawRows.length;
  const postFloorCandidates = mode === "search"
    ? Number(rawRows[0]?.post_floor_candidates ?? rawRows[0]?.total_candidates ?? rawRows.length)
    : rawRows.length;
  const rows = mode === "search" ? rawRows.filter((row) => row.id != null) : rawRows;
  const gateTarget = Math.min(3, Math.max(1, limit));
  return {
    rows,
    softFieldsUsed: compiled.softFieldsUsed,
    totalCandidates: postFloorCandidates,
    preFloorCandidates,
    postFloorCandidates,
    gateEvidence:
      preFloorCandidates < gateTarget
        ? "retrieval"
        : postFloorCandidates < gateTarget
          ? "relevance_floor"
          : "none",
    filterSql: where,
    filterParams: compiled.params,
  };
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

    const table = collectionTableName(project.schema_name, collectionName);
    const fieldKeys = Object.keys(def.fields);
    const fieldCols = fieldKeys.map((k) => sanitiseIdent(k));
    const embEntries = embeddingEntries(def);
    const nonEvidenceEntries = embEntries.filter(([, embedding]) => embedding.evidence !== true);
    const evidence = evidenceEntries(def);
    const scopeCols = (def.scopes ?? []).map((scope) => `scope_${sanitiseIdent(scope)}`);
    const scopeValue = (row: IndexDocumentRow, column: string): string | null =>
      row.scope?.[column] ?? row.scope?.[column.slice("scope_".length)] ?? null;
    let indexed = 0;

    for (const row of rows) {
      const aspectColumns = nonEvidenceEntries.map(([name]) => embeddingColumn(name, embEntries.findIndex(([key]) => key === name)));
      const cols = [
        "id",
        "data",
        "enriched",
        "content_hash",
        "doc",
        "fts_src",
        "fts_src_a",
        ...aspectColumns,
        ...scopeCols,
        ...fieldCols,
      ];
      const firstName = embEntries[0]?.[0];
      const values: unknown[] = [
        row.id,
        JSON.stringify(row.data),
        row.enriched ? JSON.stringify(row.enriched) : null,
        row.content_hash ?? "test",
        row.doc ?? null,
        row.doc ?? null,
        null,
        ...nonEvidenceEntries.map(([name]) => {
          const vector = row.embeddings?.[name] ?? (name === firstName ? row.embedding : null);
          return vector ? toVectorLiteral(vector) : null;
        }),
        ...scopeCols.map((column) => scopeValue(row, column)),
        ...fieldKeys.map((name) => row.fields?.[name] ?? null),
      ];

      const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");
      const updateSet = cols
        .filter((c) => c !== "id")
        .map((c) => `${c} = EXCLUDED.${c}`)
        .join(", ");

      await ctx.storage.client("parameterized search query").unsafe(
        `INSERT INTO ${table} (${cols.join(", ")}, indexed_at, pipeline_status, updated_at)
         VALUES (${placeholders}, now(), 'ready', now())
         ON CONFLICT (id) DO UPDATE SET ${updateSet}, indexed_at = now(), pipeline_status = 'ready', updated_at = now()`,
        values
      );
      if (evidence.length > 0) {
        const evRows = Object.entries(row.evidence ?? {}).flatMap(([aspect, values]) =>
          values.map((value, ord) => ({ aspect, ord, src: value.src, vector: toVectorLiteral(value.vector) }))
        );
        const evTable = evidenceTable(project.schema_name, collectionName);
        await ctx.storage.client("parameterized search query").unsafe(`DELETE FROM ${evTable} WHERE doc_id = $1`, [row.id]);
        for (const ev of evRows) {
          const evColumns = [...scopeCols, "doc_id", "aspect", "ord", "vec", "src"];
          const evValues = [...scopeCols.map((column) => scopeValue(row, column)), row.id, ev.aspect, ev.ord, ev.vector, ev.src];
          await ctx.storage.client("parameterized search query").unsafe(
            `INSERT INTO ${evTable} (${evColumns.join(", ")}) VALUES (${evValues.map((_, index) => `$${index + 1}`).join(", ")})`,
            evValues
          );
        }
      }
      indexed++;
    }

    return { indexed };
  }

  async function retrieve(
    projectSlug: string,
    collectionName: string,
    opts: SearchOpts,
    retryContext?: RetrieveRetryContext
  ): Promise<Retrieval> {
    const project = await projectsService.getProject(projectSlug);
    if (!project) throw new Error(`project "${projectSlug}" not found`);
    const def = await getCollectionDef(projectSlug, collectionName);
    if (!def) throw new Error(`collection "${collectionName}" not found in project "${projectSlug}"`);

    const q = (retryContext?.query ?? opts.q)?.trim() ?? "";
    if (!q && !opts.image) throw new Error("search requires a non-empty q or image");

    const scopeCols = resolveScope(def, collectionName, opts.scope, "search");

    const offset = Math.min(Math.max(opts.offset ?? 0, 0), MAX_OFFSET);
    const hasImage = !!opts.image;
    const mode: SearchMode = opts.mode ?? (hasImage ? "similar" : "intent");
    const weights = parseSearchWeights(def, opts.weights, mode, hasImage);
    // Pure image similarity: an image query with no text has no meaningful text vector
    // (the cosine leg would embed the "image query" placeholder). Let the visual aspect carry
    // it. Explicit cosine override still wins.
    if (mode === "similar" && hasImage && !q && opts.weights?.cosine === undefined) {
      weights.cosine = 0;
      // Pure image query: text-kind aspect legs would embed the "image query" placeholder —
      // noise at full weight that drowns the visual leg (REQ-10 smoke). Only image-kind
      // aspects carry an image-only query; explicit per-query weights still override.
      for (const [name, embedding] of embeddingEntries(def)) {
        if (embedding.kind !== "image" && weights.aspects[name] !== undefined) {
          weights.aspects[name] = 0;
        }
      }
    }

    const nlq = retryContext?.original.nlq ?? await (async () => {
      const candidates = shouldSkipNlq(def, q)
        ? { available: true, candidates: {} }
        : await vocabCandidates(ctx, project.schema_name, collectionName, def, q, scopeCols);
      return parseNlq(ctx, def, q, {
        candidates,
        schema: project.schema_name,
        collection: collectionName,
        scopeCols,
      });
    })();
    const explicitFilters = retryContext?.original.explicitFilters ?? opts.filters ?? {};
    const mergedFilters = retryContext
      ? { ...retryContext.original.mergedFilters }
      : mergeFilters(nlq.filters, explicitFilters);
    if (!retryContext) {
      await resolveBudgetHints(ctx, project.schema_name, collectionName, def, nlq.budgetHints, mergedFilters);
    }
    const filterOpts: FilterCompileOpts = {
      soft: true,
      excludeTerms: nlq.excludeTerms,
    };

    const semanticText = retryContext ? q || "image query" : nlq.parsed.semantic_query || q || "image query";
    const lexicalText = retryContext
      ? q
      : !nlq.degraded && typeof nlq.parsed.lexical_query === "string" && nlq.parsed.lexical_query.trim()
        ? nlq.parsed.lexical_query.trim()
        : q;
    const imageVectors = await buildQueryAspectImageVectors(def, opts.image, embedService, ctx.groundImage);
    const aspectPlans = await resolveAspectPlans(
      def,
      weights,
      nlq,
      semanticText,
      q,
      mode,
      hasImage,
      imageVectors,
      embedService
    );
    const vector = aspectPlans[0]?.queryVector ?? null;

    return {
      project,
      def,
      collectionName,
      q,
      weights,
      offset,
      scopeCols,
      nlq,
      explicitFilters,
      mergedFilters,
      filterOpts,
      semanticText,
      lexicalText,
      vector,
      aspectPlans,
      efSearch: opts.efSearch ?? null,
    };
  }

  // Run the hybrid query for one mode, retrying once with soft filters dropped
  // when too few rows come back. Shared by the search and explain finishers.
  async function probeRelaxableFields(
    r: Retrieval,
    relaxableFields: string[]
  ): Promise<Map<string, number>> {
    const baseFilters: SearchFilters = Object.fromEntries(
      Object.entries(r.mergedFilters).filter(([field]) => !relaxableFields.includes(field))
    );
    const params: unknown[] = [];
    const selects: string[] = [];
    const table = collectionTableName(r.project.schema_name, r.collectionName);
    for (const field of relaxableFields) {
      const compiled = buildFilterSql(
        { ...baseFilters, [field]: r.mergedFilters[field] },
        r.def,
        r.filterOpts,
        params.length + 1
      );
      params.push(...compiled.params);
      const scope = Object.entries(r.scopeCols)
        .map(([column, value]) => {
          params.push(value);
          return `${column} = $${params.length}`;
        })
        .join(" AND ");
      const visibility = `(pipeline_status = 'ready' OR pipeline_status IS NULL)${scope ? ` AND ${scope}` : ""}`;
      const where = compiled.where === "true" ? visibility : `${compiled.where} AND ${visibility}`;
      selects.push(`SELECT '${field.replace(/'/g, "''")}'::text AS field, count(*)::int AS count FROM ${table} WHERE ${where}`);
    }
    if (!selects.length) return new Map();
    const rows = await ctx.storage.client("soft-filter probes").unsafe(selects.join(" UNION ALL "), params);
    return new Map(rows.map((row) => [String(row.field), Number(row.count ?? 0)]));
  }

  async function runRanked(
    r: Retrieval,
    limit: number,
    mode: "search" | "explain",
    allowRelaxation = true
  ): Promise<RankedRun> {
    // Structured-intent bypass: when NLQ derived hard filters, those filters define
    // relevance — skip the semantic floor so filter-dominated queries are not emptied.
    const effectiveFloor =
      Object.keys(r.nlq.filters).length > 0
        ? null
        : typeof r.def.search?.relevanceFloor === "number"
          ? r.def.search.relevanceFloor
          : null;
    let { rows, totalCandidates, filterSql, filterParams, gateEvidence } = await runHybridQuery(
      ctx,
      r.project.schema_name,
      r.def,
      r.collectionName,
      r.lexicalText,
      r.aspectPlans,
      r.mergedFilters,
      r.filterOpts,
      r.weights,
      effectiveFloor,
      limit,
      r.offset,
      r.efSearch,
      r.scopeCols,
      mode
    );

    let relaxed = false;
    let relaxedFields: string[] = [];
    let effectiveFilters = { ...r.mergedFilters };
    const relaxationSteps: Array<{ field: string; standaloneMatchCount: number; resultCount: number }> = [];
    const target = Math.min(3, Math.max(1, limit));
    const derivedSoftFields = new Set([
      ...Object.keys(r.nlq.filters),
      ...Object.keys(r.nlq.deterministicFilters),
    ]);
    const relaxableFields = Object.keys(r.mergedFilters)
      .filter((field) =>
        r.def.fields[field]?.soft === true &&
        derivedSoftFields.has(field) &&
        !Object.hasOwn(r.explicitFilters, field)
      )
      .sort();

    if (allowRelaxation && totalCandidates < target && gateEvidence === "retrieval" && relaxableFields.length > 0) {
      const probeCounts = await probeRelaxableFields(r, relaxableFields);
      // Declared relaxOrder wins over selectivity: contextual constraints (occasions) drop
      // before identity-bearing ones (colors) regardless of match counts — pure
      // least-selective-first inverts on real corpora (red=70 vs wedding=37 would have
      // dropped `colors` for "red dress for a wedding"; live finding 2026-07-19).
      const declaredOrder = r.def.search?.relaxOrder ?? [];
      const declaredPos = (field: string) => {
        const i = declaredOrder.indexOf(field);
        return i === -1 ? Number.POSITIVE_INFINITY : i;
      };
      const ordered = [...relaxableFields].sort(
        (a, b) =>
          declaredPos(a) - declaredPos(b) ||
          (probeCounts.get(b) ?? 0) - (probeCounts.get(a) ?? 0) ||
          a.localeCompare(b)
      );
      for (const field of ordered) {
        const nextFilters = { ...effectiveFilters };
        delete nextFilters[field];
        const retry = await runHybridQuery(
          ctx,
          r.project.schema_name,
          r.def,
          r.collectionName,
          r.lexicalText,
          r.aspectPlans,
          nextFilters,
          r.filterOpts,
          r.weights,
          effectiveFloor,
          limit,
          r.offset,
          r.efSearch,
          r.scopeCols,
          mode
        );
        effectiveFilters = nextFilters;
        rows = retry.rows;
        totalCandidates = retry.totalCandidates;
        filterSql = retry.filterSql;
        filterParams = retry.filterParams;
        gateEvidence = retry.gateEvidence;
        relaxed = true;
        relaxedFields.push(field);
        relaxationSteps.push({
          field,
          standaloneMatchCount: probeCounts.get(field) ?? 0,
          resultCount: retry.totalCandidates,
        });
        if (retry.totalCandidates >= target) break;
      }
    }

    return { rows, totalCandidates, filterSql, filterParams, relaxed, relaxedFields, effectiveFilters, relaxationSteps, gateEvidence };
  }

  function rowsToHits(r: Retrieval, rows: Array<Record<string, unknown>>): SearchHit[] {
    const fieldKeys = Object.keys(r.def.fields);
    return rows.map((row) => {
      const hit: SearchHit = {
        id: String(row.id),
        score: Number(row.score),
        data: (typeof row.data === "string" ? JSON.parse(row.data as string) : row.data) as Record<string, unknown>,
      };
      for (const k of fieldKeys) hit[k] = row[sanitiseIdent(k)] ?? row[k];
      if (r.def.dedup) {
        const groupColumn = sanitiseIdent(r.def.dedup.groupField ?? "product_group");
        if (row[groupColumn] != null) hit[groupColumn] = row[groupColumn];
      }
      if (row.rerank_doc != null) hit.rerank_doc = row.rerank_doc;
      return hit;
    });
  }

  function applySearchCutoff(
    r: Retrieval,
    ranked: RankedRun
  ): { rows: Array<Record<string, unknown>>; dropped: number } {
    const hits = rowsToHits(r, ranked.rows);
    const hasFilters = Object.keys(ranked.effectiveFilters).length > 0;
    const cutoffDef = r.def.search?.cutoff;
    const hasEvidence = ranked.rows.length > 0 && ("fts_present" in ranked.rows[0]! || "cos_sim" in ranked.rows[0]!);
    if (hasFilters || !hasEvidence || cutoffDef?.strategy === "none") return { rows: ranked.rows, dropped: 0 };
    const evidence: CutoffEvidence[] = ranked.rows.map((row, i) => ({
      ftsPresent: row.fts_present === true,
      cos: row.cos_sim == null ? null : Number(row.cos_sim),
      value: cutoffDef?.field ? hits[i]![cutoffDef.field] : undefined,
    }));
    const cut = applyCutoff(hits, evidence, cutoffDef);
    if (cut.dropped === 0) return { rows: ranked.rows, dropped: 0 };
    const kept = new Set(cut.hits.map((hit) => hit.id));
    return { rows: ranked.rows.filter((row) => kept.has(String(row.id))), dropped: cut.dropped };
  }

  function cosineSimilarity(left: number[], right: number[]): number {
    if (left.length !== right.length || left.length === 0) return -1;
    let dot = 0;
    let leftNorm = 0;
    let rightNorm = 0;
    for (let i = 0; i < left.length; i++) {
      dot += left[i]! * right[i]!;
      leftNorm += left[i]! * left[i]!;
      rightNorm += right[i]! * right[i]!;
    }
    return leftNorm === 0 || rightNorm === 0 ? -1 : dot / Math.sqrt(leftNorm * rightNorm);
  }

  async function primaryTextEmbedding(def: CollectionDef, query: string): Promise<number[] | null> {
    const primary = embeddingEntries(def)[0]?.[1];
    if (!primary || primary.kind === "image") return null;
    return embedService.embedQuery({
      text: query,
      model: primary.model,
      dim: primary.dim,
      taskType: primary.taskType ?? "RETRIEVAL_QUERY",
      inputType: "query",
    });
  }

  async function resolveExecution(r: Retrieval, opts: SearchOpts, limit: number): Promise<ResolvedExecution> {
    const ranked = await runRanked(r, limit, "search");
    const cut = applySearchCutoff(r, ranked);
    if (cut.dropped > 0) ctx.observability.inc("search_cutoff_dropped_total", cut.dropped);

    const target = Math.min(3, Math.max(1, limit));
    const zeroCause = cut.dropped > 0 ? "cutoff" : ranked.gateEvidence;
    const eligible =
      cut.rows.length < target &&
      zeroCause === "retrieval" &&
      r.q.trim().length > 0 &&
      !shouldSkipNlq(r.def, r.q) &&
      !r.nlq.degraded &&
      Object.keys(r.explicitFilters).length === 0;
    if (!eligible) return { retrieval: r, ranked, rows: cut.rows, cutoffDropped: cut.dropped };

    const originalVector = await primaryTextEmbedding(r.def, r.q);
    if (!originalVector) return { retrieval: r, ranked, rows: cut.rows, cutoffDropped: cut.dropped };

    const proposals = await proposeRewrites(ctx, r.def, r.q, cut.rows.length === 0 ? "empty" : "thin");
    for (const proposal of proposals) {
      const replacementVector = await primaryTextEmbedding(r.def, proposal.query);
      if (!replacementVector || cosineSimilarity(originalVector, replacementVector) < 0.6) continue;
      const retry = await retrieve(r.project.slug, r.collectionName, { ...opts, q: proposal.query }, {
        original: r,
        query: proposal.query,
      });
      const retryRanked = await runRanked(retry, limit, "search");
      const retryCut = applySearchCutoff(retry, retryRanked);
      if (retryCut.rows.length <= cut.rows.length) {
        return { retrieval: r, ranked, rows: cut.rows, cutoffDropped: cut.dropped };
      }
      return {
        retrieval: retry,
        ranked: retryRanked,
        rows: retryCut.rows,
        cutoffDropped: retryCut.dropped,
        rewritten: { type: proposal.type, from: r.q, to: proposal.query },
      };
    }
    return { retrieval: r, ranked, rows: cut.rows, cutoffDropped: cut.dropped };
  }

  async function finishSearch(
    input: Retrieval,
    opts: SearchOpts,
    t0: number,
    resolved?: ResolvedExecution
  ): Promise<SearchResult> {
    const execution = resolved ?? await resolveExecution(input, opts, opts.limit ?? 20);
    const r = execution.retrieval;
    const { totalCandidates, relaxed, relaxedFields, effectiveFilters, relaxationSteps } = execution.ranked;
    const rows = execution.rows;

    let facets: SearchResult["facets"];
    if (opts.facets?.length) {
      const compiled = buildFilterSql(effectiveFilters, r.def, r.filterOpts, 1);
      const scoped = appendScopeSql(compiled.where, compiled.params, r.scopeCols);
      facets = await ctx.storage.facets({
        table: collectionTableName(r.project.schema_name, r.collectionName),
        def: r.def,
        where: scoped.where,
        params: scoped.params,
        facetNames: opts.facets,
      });
    }

    const finalHits = rowsToHits(r, rows);

    const result: SearchResult = {
      hits: finalHits,
      constraintTrace: buildConstraintTrace(r.def, {
        semanticQuery: r.semanticText,
        derivedFilters: r.nlq.filters,
        explicitFilters: r.explicitFilters,
        appliedFilters: effectiveFilters,
        relaxedFields,
        relaxationSteps,
        deterministicFilters: r.nlq.deterministicFilters,
        groundedValues: r.nlq.groundedValues,
        rewritten: execution.rewritten,
        excludedTerms: r.nlq.excludeTerms,
        budgetHints: r.nlq.budgetHints,
      }),
      relaxed,
      relaxedFields,
      took_ms: Date.now() - t0,
      total_candidates: totalCandidates,
    };
    if (execution.cutoffDropped > 0) result.cutoff_dropped = execution.cutoffDropped;
    if (execution.rewritten) result.rewritten = execution.rewritten;

    if (r.def.search?.nlq && !shouldSkipNlq(r.def, r.q)) {
      result.parsed = r.nlq.parsed;
      if (r.nlq.degraded) {
        result.nlq_degraded = true;
        ctx.observability.inc("nlq_degraded_total");
      }
    } else if (Object.keys(r.nlq.filters).length || r.nlq.excludeTerms.length) {
      result.parsed = r.nlq.parsed;
    }

    if (facets) result.facets = facets;
    return result;
  }

  async function finishExplain(
    input: Retrieval,
    opts: SearchOpts,
    t0: number,
    resolved?: ResolvedExecution
  ): Promise<SearchExplainResult> {
    const execution = resolved ?? await resolveExecution(input, opts, Math.min(opts.limit ?? 20, 20));
    const r = execution.retrieval;
    const explainRetrieval = { ...r, mergedFilters: execution.ranked.effectiveFilters };
    const { rows, filterSql, filterParams } = await runRanked(
      explainRetrieval,
      Math.min(opts.limit ?? 20, 20),
      "explain",
      false
    );
    const { relaxed, relaxedFields, effectiveFilters, relaxationSteps } = execution.ranked;

    const docs: ExplainDocBreakdown[] = rows.map((row) => {
      const id = String(row.id);
      const breakdown: ExplainDocBreakdown = {
        id,
        fts_rank: row.fts_rank == null ? null : Number(row.fts_rank),
        cosine_rank: row.cosine_rank == null ? null : Number(row.cosine_rank),
        recency_rank: row.recency_rank == null ? null : Number(row.recency_rank),
        rrf_score: Number(row.rrf_score ?? 0),
      };
      if (embeddingEntries(r.def).length > 1) {
        const aspectRanks: Record<string, { rank: number | null; cosine: number | null }> = {};
        for (const [name] of embeddingEntries(r.def)) {
          const safe = sanitiseIdent(name);
          const rank = row[`aspect_${safe}_rank`];
          const cosine = row[`aspect_${safe}_cosine`];
          aspectRanks[name] = {
            rank: rank == null ? null : Number(rank),
            cosine: cosine == null ? null : Number(cosine),
          };
        }
        breakdown.aspect_ranks = aspectRanks;
      }
      return breakdown;
    });

    const explain: SearchExplainResult = {
      q: r.q,
      constraintTrace: buildConstraintTrace(r.def, {
        semanticQuery: r.semanticText,
        derivedFilters: r.nlq.filters,
        explicitFilters: r.explicitFilters,
        appliedFilters: effectiveFilters,
        relaxedFields,
        relaxationSteps,
        deterministicFilters: r.nlq.deterministicFilters,
        groundedValues: r.nlq.groundedValues,
        rewritten: execution.rewritten,
        excludedTerms: r.nlq.excludeTerms,
        budgetHints: r.nlq.budgetHints,
      }),
      relaxation: relaxed,
      relaxedFields,
      cache_hit: false,
      weights: r.weights,
      filters: { sql: filterSql, params: redactFilterParams(filterParams) },
      docs,
      took_ms: Date.now() - t0,
    };
    if (execution.rewritten) explain.rewritten = execution.rewritten;

    if (r.def.search?.nlq && !shouldSkipNlq(r.def, r.q)) {
      explain.parsed = r.nlq.parsed;
      if (r.nlq.degraded) {
        explain.nlq_degraded = true;
        ctx.observability.inc("nlq_degraded_total");
      }
    } else if (Object.keys(r.nlq.filters).length || r.nlq.excludeTerms.length) {
      explain.parsed = r.nlq.parsed;
    }

    return explain;
  }

  // Collapse near-duplicate variants (same variantGroup value) to the first — i.e.
  // best-scoring, since hits arrive score-sorted — per group. Missing/empty group
  // values are never collapsed.
  function diversifyHits(hits: SearchHit[], groupField: string): SearchHit[] {
    const seen = new Set<string>();
    const out: SearchHit[] = [];
    for (const h of hits) {
      const raw = h[groupField] ?? h[sanitiseIdent(groupField)];
      const key = raw == null ? "" : String(raw);
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      out.push(h);
    }
    return out;
  }

  // Attach cross-vendor offers to the final page. One batched query keyed on the
  // page's distinct cluster ids, restricted to ready+in-scope members and to the
  // declared offerFields (never raw `data`) — the owner controls what a search
  // response reveals (REQ-6, REQ-8, §10). Bounded by page_size × max_cluster_size.
  async function attachOffers(r: Retrieval, hits: SearchHit[]): Promise<void> {
    const cfg = r.def.dedup;
    if (!cfg) return;
    const group = sanitiseIdent(cfg.groupField ?? "product_group");
    const groups = [...new Set(hits.map((h) => h[group]).filter((v) => v != null && v !== ""))].map(String);
    if (!groups.length) return;

    const scoped = appendScopeSql(
      `${group} = ANY($1) AND (pipeline_status = 'ready' OR pipeline_status IS NULL)`,
      [groups],
      r.scopeCols
    );
    const offerCols = cfg.offerFields.map((f) => sanitiseIdent(f));
    const cols = [...new Set(["id", group, ...offerCols, ...Object.keys(r.scopeCols)])].join(", ");
    const table = collectionTableName(r.project.schema_name, r.collectionName);
    const rows = await ctx.storage
      .client("offers")
      .unsafe(`SELECT ${cols} FROM ${table} WHERE ${scoped.where}`, scoped.params);

    const byGroup = new Map<string, Array<Record<string, unknown>>>();
    for (const row of rows) {
      const g = String(row[group]);
      const offer: Record<string, unknown> = { id: String(row.id) };
      for (const f of cfg.offerFields) offer[f] = row[sanitiseIdent(f)];
      for (const sc of Object.keys(r.scopeCols)) offer[sc] = row[sc];
      const list = byGroup.get(g) ?? [];
      list.push(offer);
      byGroup.set(g, list);
    }
    for (const h of hits) {
      const gv = h[group];
      if (gv != null && String(gv) !== "") h.offers = byGroup.get(String(gv)) ?? [];
    }
  }

  // Second-stage rerank: blend retrieval position with reranker scores (never pure replace).
  // Unscored candidates keep their RRF slot; failures fall back to first-stage order.
  async function rerankHits(
    q: string,
    image: SearchOpts["image"],
    hits: SearchHit[],
    topK: number
  ): Promise<SearchHit[]> {
    if (!ctx.rerank) return hits;
    const candidates = hits.map((h) => ({
      id: h.id,
      text: rerankCandidateText(h),
      data: h.data,
      score: h.score,
    }));
    let ordered: Array<{ id: string; score: number }>;
    try {
      ordered = await ctx.rerank({
        query: q,
        image: image ? { url: image.url, bytes: image.bytes, mimeType: image.mimeType } : undefined,
        candidates,
        topK,
      });
    } catch (e) {
      ctx.observability.log("warn", "rerank", "reranker failed — first-stage order", {
        error: e instanceof Error ? e.message.slice(0, 200) : String(e),
      });
      return hits;
    }
    return mergeBlendedRerank(hits, ordered);
  }

  async function search(
    projectSlug: string,
    collectionName: string,
    opts: SearchOpts
  ): Promise<SearchResult> {
    const t0 = Date.now();
    ctx.observability.inc("searches_total");
    const cacheKey = opts.cache === true ? resultCacheKey(projectSlug, collectionName, opts) : null;
    if (cacheKey) {
      const hit = searchResultCache.get<SearchResult>(cacheKey);
      if (hit) {
        ctx.observability.inc("search_cache_hits");
        return { ...hit, took_ms: Date.now() - t0, cached: true };
      }
    }
    const retrieval = await retrieve(projectSlug, collectionName, opts);
    const limit = opts.limit ?? 20;
    // Collapse field: an explicit search.variantGroup wins; else a dedup-enabled
    // collection collapses on its cluster id by default (REQ-6). `diversify:false` opts out.
    const dedupGroup = retrieval.def.dedup
      ? sanitiseIdent(retrieval.def.dedup.groupField ?? "product_group")
      : null;
    const collapseField = retrieval.def.search?.variantGroup ?? dedupGroup;
    const wantDiversify = !!collapseField && opts.diversify !== false;
    const wantRerank = !!ctx.rerank && opts.rerank !== false;

    // Pull a deeper pool when a second stage will reorder/collapse it, so the final
    // top-`limit` is chosen from real candidates rather than a pre-truncated set.
    const poolLimit = wantDiversify || wantRerank ? Math.max(limit, RERANK_POOL) : limit;
    const execution = await resolveExecution(retrieval, { ...opts, limit: poolLimit }, poolLimit);
    const chosenRetrieval = execution.retrieval;
    const result = await finishSearch(chosenRetrieval, { ...opts, limit: poolLimit }, t0, execution);

    if (wantDiversify && collapseField) result.hits = diversifyHits(result.hits, collapseField);
    if (wantRerank && result.hits.length > 1) {
      result.hits = await rerankHits(chosenRetrieval.q, opts.image, result.hits, limit);
    }
    const rankingPolicy = chosenRetrieval.def.search?.rankingPolicy;
    if (rankingPolicy && result.hits.length > 0) {
      result.hits = applyRankingPolicy(result.hits, rankingPolicy).hits;
    }
    if (result.hits.length > limit) result.hits = result.hits.slice(0, limit);

    // Offers ride the final page: one batched query per page, only when the collection
    // declares dedup and the page carries clustered hits (REQ-6, REQ-8).
    if (chosenRetrieval.def.dedup && opts.offers !== false) {
      await attachOffers(chosenRetrieval, result.hits);
    }
    result.took_ms = Date.now() - t0;

    if (cacheKey && !chosenRetrieval.nlq.degraded) {
      searchResultCache.set(cacheKey, result);
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
    const retrieval = await retrieve(projectSlug, collectionName, opts);
    const execution = await resolveExecution(retrieval, opts, Math.min(opts.limit ?? 20, 20));
    return finishExplain(execution.retrieval, opts, t0, execution);
  }

  // Single-pass hits + explain: the expensive embed/image-fetch/NLQ work in retrieve()
  // runs once, then both mode-specific SQL projections are assembled from it.
  async function searchWithExplain(
    projectSlug: string,
    collectionName: string,
    opts: SearchOpts
  ): Promise<{ result: SearchResult; explain: SearchExplainResult }> {
    const t0 = Date.now();
    ctx.observability.inc("searches_total");
    const retrieval = await retrieve(projectSlug, collectionName, opts);
    const execution = await resolveExecution(retrieval, opts, Math.min(opts.limit ?? 20, 20));
    const [result, explain] = await Promise.all([
      finishSearch(execution.retrieval, opts, t0, execution),
      finishExplain(execution.retrieval, opts, t0, execution),
    ]);
    return { result, explain };
  }

  /**
   * Query-free aggregation over a collection's facetable fields. Unlike search(), this needs
   * no query — it's a pure GROUP BY / numeric-stats over the filtered rows. The primitive
   * consumers reach for to answer "count per brand" / "average price" without dropping to raw
   * SQL against the physical table (and coupling to its internal schema/name).
   */
  async function facets(
    projectSlug: string,
    collectionName: string,
    opts: { filters?: SearchFilters; facets: string[]; scope?: Record<string, string> }
  ): Promise<Record<string, import("../db/postgres/facets.ts").FacetResult>> {
    if (!opts.facets?.length) return {};
    const project = await projectsService.getProject(projectSlug);
    if (!project) throw new Error(`project "${projectSlug}" not found`);
    const def = await getCollectionDef(projectSlug, collectionName);
    if (!def) throw new Error(`collection "${collectionName}" not found in project "${projectSlug}"`);
    const scopeCols = resolveScope(def, collectionName, opts.scope, "facets");
    const compiled = buildFilterSql(opts.filters ?? {}, def, { soft: false }, 1);
    const scoped = appendScopeSql(compiled.where, compiled.params, scopeCols);
    return ctx.storage.facets({
      table: collectionTableName(project.schema_name, collectionName),
      def,
      where: scoped.where,
      params: scoped.params,
      facetNames: opts.facets,
    });
  }

  /**
   * A single document by id — its structured data plus the indexed text. The "read" primitive
   * for agents: search finds candidates, this returns the whole document. `offset`/`maxChars`
   * slice the (potentially long) text so large documents can be paged without shipping all of it.
   */
  async function getDocument(
    projectSlug: string,
    collectionName: string,
    id: string,
    opts: { offset?: number; maxChars?: number; scope?: Record<string, string> } = {}
  ): Promise<{ id: string; data: unknown; doc: string | null; enriched: unknown; indexedAt: unknown } | null> {
    const project = await projectsService.getProject(projectSlug);
    if (!project) throw new Error(`project "${projectSlug}" not found`);
    const def = await getCollectionDef(projectSlug, collectionName);
    if (!def) {
      throw new Error(`collection "${collectionName}" not found in project "${projectSlug}"`);
    }
    const scopeCols = resolveScope(def, collectionName, opts.scope, "getDocument");
    const scoped = appendScopeSql("id = $1", [id], scopeCols);
    const table = collectionTableName(project.schema_name, collectionName);
    const rows = (await ctx.storage
      .client("get document")
      .unsafe(
        `SELECT id, data, doc, enriched, indexed_at FROM ${table} WHERE ${scoped.where} LIMIT 1`,
        scoped.params
      )) as Record<string, unknown>[];
    if (!rows.length) return null;
    const r = rows[0]!;
    let doc = (r.doc as string | null) ?? null;
    if (doc !== null) {
      if (opts.offset) doc = doc.slice(opts.offset);
      if (opts.maxChars != null) doc = doc.slice(0, opts.maxChars);
    }
    return { id: String(r.id), data: r.data, doc, enriched: r.enriched ?? null, indexedAt: r.indexed_at };
  }

  /**
   * Regex-grep a single document's text (the indexed `doc`, else its data JSON), returning matches
   * with surrounding context — so an agent can drill into one document without pulling the whole
   * thing. Server-side so only the matches travel, not the full text.
   */
  async function grepDocument(
    projectSlug: string,
    collectionName: string,
    id: string,
    opts: { pattern: string; context?: number; maxMatches?: number; scope?: Record<string, string> }
  ): Promise<{ id: string; matches: { match: string; start: number; end: number; context: string }[] } | null> {
    const doc = await getDocument(projectSlug, collectionName, id, { scope: opts.scope });
    if (!doc) return null;
    const text = doc.doc && doc.doc.trim() ? doc.doc : JSON.stringify(doc.data ?? {});
    let re: RegExp;
    try {
      re = new RegExp(opts.pattern, "g");
    } catch {
      throw new Error(`invalid regex: ${opts.pattern}`);
    }
    const ctxChars = opts.context ?? 60;
    const cap = opts.maxMatches ?? 50;
    const matches: { match: string; start: number; end: number; context: string }[] = [];
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      matches.push({ match: m[0], start, end, context: text.slice(Math.max(0, start - ctxChars), Math.min(text.length, end + ctxChars)) });
      if (matches.length >= cap) break;
    }
    return { id: doc.id, matches };
  }

  return { search, searchExplain, searchWithExplain, indexDocuments, getCollectionDef, facets, getDocument, grepDocument };
}

export type SearchService = ReturnType<typeof makeSearchService>;
