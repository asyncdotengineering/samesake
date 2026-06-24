import type { CollectionDef, ConstraintTrace, SearchMode, SearchWeightsInput } from "@samesake/core";
import type { MatcherCtx } from "../types.ts";
import { mergeBlendedRerank, rerankCandidateText } from "./rerank.ts";
import { applyRankingPolicy } from "./ranking.ts";
import type { EmbedService } from "./embed.ts";
import { toVectorLiteral } from "./embed.ts";
import { buildConstraintTrace, relaxedSoftFields } from "./constraint-trace.ts";
import { mergeFilters, parseNlq, shouldSkipNlq } from "./nlq.ts";
import type { ProjectsService, ProjectRow } from "./projects.ts";
import { sanitiseIdent } from "./schema-gen.ts";
import { collectionTableName } from "./db-utils.ts";
import { assembleQueryVector, weightedSegmentCosines } from "./spaces.ts";
import { searchResultCache, type SearchCacheKey } from "./search-cache.ts";
import { buildFilterSql, type FilterCompileOpts, type SearchFilters } from "./search-filter.ts";
import {
  buildQueryImageVectors,
  buildQuerySpaceSegments,
  parseSearchWeights,
  type ChannelWeights,
} from "./search-query.ts";

export { weightedSegmentCosines } from "./spaces.ts";
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
  constraintTrace: ConstraintTrace;
  nlq_degraded?: boolean;
  relaxed: boolean;
  took_ms: number;
  facets?: Record<string, import("../db/postgres/facets.ts").FacetResult>;
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
  constraintTrace: ConstraintTrace;
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
  nlq: Awaited<ReturnType<typeof parseNlq>>;
  explicitFilters: SearchFilters;
  mergedFilters: SearchFilters;
  filterOpts: FilterCompileOpts;
  semanticText: string;
  vector: number[] | null;
  spaceSegments: Awaited<ReturnType<typeof buildQuerySpaceSegments>> | null;
  spaceVector: number[] | null;
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
  q: string,
  vector: number[] | null,
  spaceVector: number[] | null,
  filters: SearchFilters,
  filterOpts: FilterCompileOpts,
  weights: ChannelWeights,
  relevanceFloor: number | null,
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
  const table = collectionTableName(schema, collection);
  const params: unknown[] = [];
  const addParam = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };

  const hasFts = weights.fts > 0;
  const hasCos = weights.cosine > 0 && vector !== null;
  const hasSpc = weights.spaces > 0 && spaceVector !== null;
  const hasRec = weights.recency > 0;
  // Absolute semantic floor (passed in by the caller, already gated to skip
  // structured-intent queries). A hit with no FTS keyword match must clear this
  // query–document cosine similarity, else it is dropped (suppresses no-match
  // padding). Only applies when a cosine leg is active.
  const needCosFloor = relevanceFloor !== null && hasCos;
  const recField = sanitiseIdent(weights.recencyField);
  const fieldCols = Object.keys(def.fields).map((k) => `d.${sanitiseIdent(k)}`).join(", ");

  const qRef = hasFts ? addParam(q) : null;
  const vecRef = hasCos && vector ? addParam(toVectorLiteral(vector)) : null;
  const spcRef = hasSpc && spaceVector ? addParam(toVectorLiteral(spaceVector)) : null;

  const compiled = buildFilterSql(filters, def, filterOpts, params.length + 1);
  const where =
    compiled.where === "true"
      ? "(pipeline_status = 'ready' OR pipeline_status IS NULL)"
      : `${compiled.where} AND (pipeline_status = 'ready' OR pipeline_status IS NULL)`;
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
        SELECT d.id, d.data, d.rerank_doc, ${fieldCols}, 0::float AS score,
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
      // AND-coverage-first, OR-fallback lexical match. websearch_to_tsquery ANDs bare terms, so a
      // multi-term query ("flowy black cocktail dress") matches nothing unless one doc carries
      // every term — the leg goes inert. We gate candidates with the OR rewrite (recall) but rank
      // by the strict AND query first, then the OR query: docs matching ALL terms stay on top
      // (precision preserved for exact queries like "linen shirt men"), and partial matches only
      // fill in when nothing matches everything (fixes the inert-on-long-queries failure).
      const andTsq = `websearch_to_tsquery('english', ${qRef})`;
      const orTsq = `nullif(replace(${andTsq}::text, '&', '|'), '')::tsquery`;
      ctes.push(`lex AS (
        SELECT id, row_number() OVER (
          ORDER BY ts_rank_cd(fts, ${andTsq}) DESC, ts_rank_cd(fts, ${orTsq}) DESC
        ) AS rn
        FROM ${table}
        WHERE fts @@ ${orTsq} AND ${where}
        LIMIT ${CANDIDATES}
      )`);
      rankLegs.push({ cte: "lex", alias: "l", weight: weights.fts });
    }

    if (hasCos && vecRef) {
      const cosCol = needCosFloor
        ? `, (1 - (embedding <=> ${vecRef}::vector))::float AS cos`
        : "";
      ctes.push(`sem AS (
        SELECT id, row_number() OVER (ORDER BY embedding <=> ${vecRef}::vector) AS rn${cosCol}
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
    } else {
      const floorRef = needCosFloor ? addParam(relevanceFloor) : null;
      const floorCols = needCosFloor
        ? `,
                 ${hasFts ? "(l.rn IS NOT NULL)" : "FALSE"} AS fts_present,
                 s.cos AS cos_sim`
        : "";
      const floorWhere = needCosFloor ? ` AND (fts_present OR cos_sim >= ${floorRef})` : "";
      query = `
        WITH ${ctes.join(", ")},
        fused AS (
          SELECT ${fusedId} AS id,
                 (${scoreExprs.join(" + ")}) AS score${floorCols}
          ${fusedFrom}
        ),
        ranked AS (
          SELECT id, score, count(*) OVER ()::int AS total_candidates
          FROM fused
          WHERE id IS NOT NULL${floorWhere}
          ORDER BY score DESC
          LIMIT ${limitRef} OFFSET ${offsetRef}
        )
        SELECT d.id, d.data, d.rerank_doc, ${fieldCols}, r.score::float AS score, r.total_candidates
        FROM ranked r
        JOIN ${table} d ON d.id = r.id
        ORDER BY r.score DESC
      `;
    }
  }

  const rows = await ctx.storage.client("parameterized search query").unsafe(query, params);
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

      await ctx.storage.client("parameterized search query").unsafe(
        `INSERT INTO ${table} (${cols.join(", ")}, indexed_at, pipeline_status, updated_at)
         VALUES (${placeholders}, now(), 'ready', now())
         ON CONFLICT (id) DO UPDATE SET ${updateSet}, indexed_at = now(), pipeline_status = 'ready', updated_at = now()`,
        values
      );
      indexed++;
    }

    return { indexed };
  }

  async function retrieve(
    projectSlug: string,
    collectionName: string,
    opts: SearchOpts
  ): Promise<Retrieval> {
    const project = await projectsService.getProject(projectSlug);
    if (!project) throw new Error(`project "${projectSlug}" not found`);
    const def = await getCollectionDef(projectSlug, collectionName);
    if (!def) throw new Error(`collection "${collectionName}" not found in project "${projectSlug}"`);

    const q = opts.q?.trim() ?? "";
    if (!q && !opts.image) throw new Error("search requires a non-empty q or image");

    const offset = Math.min(Math.max(opts.offset ?? 0, 0), MAX_OFFSET);
    const hasImage = !!opts.image;
    const mode: SearchMode = opts.mode ?? (hasImage ? "similar" : "intent");
    const weights = parseSearchWeights(def, opts.weights, mode, hasImage);
    // Pure image similarity: an image query with no text has no meaningful text vector
    // (the cosine leg would embed the "image query" placeholder). Let the visual space carry
    // it. Explicit cosine override still wins.
    if (mode === "similar" && hasImage && !q && opts.weights?.cosine === undefined) {
      weights.cosine = 0;
    }

    const nlq = await parseNlq(ctx, def, q);
    const explicitFilters = opts.filters ?? {};
    const mergedFilters = mergeFilters(nlq.filters, explicitFilters);
    await resolveBudgetHints(ctx, project.schema_name, collectionName, def, nlq.budgetHints, mergedFilters);
    const filterOpts: FilterCompileOpts = {
      soft: true,
      excludeTerms: nlq.excludeTerms,
    };

    const semanticText = nlq.parsed.semantic_query || q || "image query";
    const imageVectors = await buildQueryImageVectors(def, opts.image, embedService, ctx.groundImage);

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

    let spaceSegments: Awaited<ReturnType<typeof buildQuerySpaceSegments>> | null = null;
    let spaceVector: number[] | null = null;
    if (weights.spaces > 0 && def.spaces && Object.keys(def.spaces).length > 0) {
      spaceSegments = await buildQuerySpaceSegments(
        def,
        vector,
        imageVectors,
        mergedFilters,
        weights.spaceSegmentWeights,
        embedService,
        semanticText
      );
      if (spaceSegments) {
        spaceVector = assembleQueryVector(spaceSegments.segments, spaceSegments.weights, spaceSegments.dims);
      }
    }

    return {
      project,
      def,
      collectionName,
      q,
      weights,
      offset,
      nlq,
      explicitFilters,
      mergedFilters,
      filterOpts,
      semanticText,
      vector,
      spaceSegments,
      spaceVector,
    };
  }

  // Run the hybrid query for one mode, retrying once with soft filters dropped
  // when too few rows come back. Shared by the search and explain finishers.
  async function runRanked(
    r: Retrieval,
    limit: number,
    mode: "search" | "explain"
  ): Promise<{
    rows: Array<Record<string, unknown>>;
    totalCandidates: number;
    filterSql: string;
    filterParams: unknown[];
    relaxed: boolean;
    relaxedFields: string[];
  }> {
    // Structured-intent bypass: when NLQ derived hard filters, those filters define
    // relevance — skip the semantic floor so filter-dominated queries are not emptied.
    const effectiveFloor =
      Object.keys(r.nlq.filters).length > 0
        ? null
        : typeof r.def.search?.relevanceFloor === "number"
          ? r.def.search.relevanceFloor
          : null;
    let { rows, softFieldsUsed, totalCandidates, filterSql, filterParams } = await runHybridQuery(
      ctx,
      r.project.schema_name,
      r.def,
      r.collectionName,
      r.q,
      r.vector,
      r.spaceVector,
      r.mergedFilters,
      r.filterOpts,
      r.weights,
      effectiveFloor,
      limit,
      r.offset,
      mode
    );

    let relaxed = false;
    let relaxedFields: string[] = [];
    const hasSoftFilters =
      softFieldsUsed.length > 0 ||
      Object.keys(r.mergedFilters).some((k) => r.def.fields[k]?.soft);

    if (rows.length < 3 && hasSoftFilters) {
      const retry = await runHybridQuery(
        ctx,
        r.project.schema_name,
        r.def,
        r.collectionName,
        r.q,
        r.vector,
        r.spaceVector,
        r.mergedFilters,
        { ...r.filterOpts, excludeSoft: true },
        r.weights,
        effectiveFloor,
        limit,
        r.offset,
        mode
      );
      rows = retry.rows;
      totalCandidates = retry.totalCandidates;
      filterSql = retry.filterSql;
      filterParams = retry.filterParams;
      relaxed = true;
      relaxedFields = relaxedSoftFields(r.def, r.mergedFilters, softFieldsUsed);
    }

    return { rows, totalCandidates, filterSql, filterParams, relaxed, relaxedFields };
  }

  async function finishSearch(r: Retrieval, opts: SearchOpts, t0: number): Promise<SearchResult> {
    const { rows, totalCandidates, relaxed, relaxedFields } = await runRanked(r, opts.limit ?? 20, "search");

    let facets: SearchResult["facets"];
    if (opts.facets?.length) {
      const compiled = buildFilterSql(r.mergedFilters, r.def, r.filterOpts, 1);
      facets = await ctx.storage.facets({
        table: collectionTableName(r.project.schema_name, r.collectionName),
        def: r.def,
        where: compiled.where,
        params: compiled.params,
        facetNames: opts.facets,
      });
    }

    const fieldKeys = Object.keys(r.def.fields);
    const hits: SearchHit[] = rows.map((row) => {
      const hit: SearchHit = {
        id: String(row.id),
        score: Number(row.score),
        data: (typeof row.data === "string" ? JSON.parse(row.data as string) : row.data) as Record<
          string,
          unknown
        >,
      };
      for (const k of fieldKeys) {
        hit[k] = row[sanitiseIdent(k)] ?? row[k];
      }
      if (row.rerank_doc != null) hit.rerank_doc = row.rerank_doc;
      return hit;
    });

    const result: SearchResult = {
      hits,
      constraintTrace: buildConstraintTrace(r.def, {
        semanticQuery: r.semanticText,
        derivedFilters: r.nlq.filters,
        explicitFilters: r.explicitFilters,
        appliedFilters: r.mergedFilters,
        relaxedFields,
        excludedTerms: r.nlq.excludeTerms,
        budgetHints: r.nlq.budgetHints,
      }),
      relaxed,
      took_ms: Date.now() - t0,
      total_candidates: totalCandidates,
    };

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

  async function finishExplain(r: Retrieval, opts: SearchOpts, t0: number): Promise<SearchExplainResult> {
    const { rows, filterSql, filterParams, relaxed, relaxedFields } = await runRanked(
      r,
      Math.min(opts.limit ?? 20, 20),
      "explain"
    );

    const table = collectionTableName(r.project.schema_name, r.collectionName);
    const spaceCosinesById = new Map<string, Record<string, number>>();
    if (r.weights.spaces > 0 && r.spaceSegments && rows.length) {
      const segs = r.spaceSegments;
      const ids = rows.map((row) => String(row.id));
      const vecRows = await ctx.storage.client("parameterized search query").unsafe(
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
        const cosines = weightedSegmentCosines(docVec, segs.segments, segs.weights, segs.dims);
        const perSpace: Record<string, number> = {};
        segs.keys.forEach((k, i) => {
          perSpace[k] = cosines[i] ?? 0;
        });
        spaceCosinesById.set(id, perSpace);
      }
    }

    const docs: ExplainDocBreakdown[] = rows.map((row) => {
      const id = String(row.id);
      const breakdown: ExplainDocBreakdown = {
        id,
        fts_rank: row.fts_rank == null ? null : Number(row.fts_rank),
        cosine_rank: row.cosine_rank == null ? null : Number(row.cosine_rank),
        spaces_rank: row.spaces_rank == null ? null : Number(row.spaces_rank),
        recency_rank: row.recency_rank == null ? null : Number(row.recency_rank),
        rrf_score: Number(row.rrf_score ?? 0),
      };
      const sc = spaceCosinesById.get(id);
      if (sc) breakdown.space_cosines = sc;
      return breakdown;
    });

    const explain: SearchExplainResult = {
      q: r.q,
      constraintTrace: buildConstraintTrace(r.def, {
        semanticQuery: r.semanticText,
        derivedFilters: r.nlq.filters,
        explicitFilters: r.explicitFilters,
        appliedFilters: r.mergedFilters,
        relaxedFields,
        excludedTerms: r.nlq.excludeTerms,
        budgetHints: r.nlq.budgetHints,
      }),
      relaxation: relaxed,
      cache_hit: false,
      weights: r.weights,
      filters: { sql: filterSql, params: redactFilterParams(filterParams) },
      docs,
      took_ms: Date.now() - t0,
    };

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
    const variantGroup = retrieval.def.search?.variantGroup;
    const wantDiversify = !!variantGroup && opts.diversify !== false;
    const wantRerank = !!ctx.rerank && opts.rerank !== false;

    // Pull a deeper pool when a second stage will reorder/collapse it, so the final
    // top-`limit` is chosen from real candidates rather than a pre-truncated set.
    const poolLimit = wantDiversify || wantRerank ? Math.max(limit, RERANK_POOL) : limit;
    const result = await finishSearch(retrieval, { ...opts, limit: poolLimit }, t0);

    if (wantDiversify && variantGroup) result.hits = diversifyHits(result.hits, variantGroup);
    if (wantRerank && result.hits.length > 1) {
      result.hits = await rerankHits(retrieval.q, opts.image, result.hits, limit);
    }
    const rankingPolicy = retrieval.def.search?.rankingPolicy;
    if (rankingPolicy && result.hits.length > 0) {
      result.hits = applyRankingPolicy(result.hits, rankingPolicy).hits;
    }
    if (result.hits.length > limit) result.hits = result.hits.slice(0, limit);
    result.took_ms = Date.now() - t0;

    if (cacheKey && !retrieval.nlq.degraded) {
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
    return finishExplain(retrieval, opts, t0);
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
    const [result, explain] = await Promise.all([
      finishSearch(retrieval, opts, t0),
      finishExplain(retrieval, opts, t0),
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
    opts: { filters?: SearchFilters; facets: string[] }
  ): Promise<Record<string, import("../db/postgres/facets.ts").FacetResult>> {
    if (!opts.facets?.length) return {};
    const project = await projectsService.getProject(projectSlug);
    if (!project) throw new Error(`project "${projectSlug}" not found`);
    const def = await getCollectionDef(projectSlug, collectionName);
    if (!def) throw new Error(`collection "${collectionName}" not found in project "${projectSlug}"`);
    const compiled = buildFilterSql(opts.filters ?? {}, def, { soft: false }, 1);
    return ctx.storage.facets({
      table: collectionTableName(project.schema_name, collectionName),
      def,
      where: compiled.where,
      params: compiled.params,
      facetNames: opts.facets,
    });
  }

  return { search, searchExplain, searchWithExplain, indexDocuments, getCollectionDef, facets };
}

export type SearchService = ReturnType<typeof makeSearchService>;
