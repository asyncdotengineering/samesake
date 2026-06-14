import type { CollectionDef, ConstraintTrace, SearchWeightsInput } from "@samesake/core";
import type { MatcherCtx } from "../types.ts";
import type { EmbedService } from "./embed.ts";
import { toVectorLiteral } from "./embed.ts";
import { computeFacets } from "./facets.ts";
import { buildConstraintTrace, relaxedSoftFields } from "./constraint-trace.ts";
import { mergeFilters, parseNlq, shouldSkipNlq } from "./nlq.ts";
import type { ProjectsService } from "./projects.ts";
import { sanitiseIdent } from "./schema-gen.ts";
import { collectionTableName, getPgClient } from "./db-utils.ts";
import { assembleQueryVector, weightedSegmentCosines } from "./spaces.ts";
import { searchResultCache, type SearchCacheKey } from "./search-cache.ts";
import { buildFilterSql, type FilterCompileOpts, type SearchFilters } from "./search-filter.ts";
import {
  buildQueryImageVectors,
  buildQuerySpaceSegments,
  buildQuerySpaceVector,
  parseSearchWeights,
  type ChannelWeights,
} from "./search-query.ts";

export { weightedSegmentCosines } from "./spaces.ts";
export {
  buildFilterSql,
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
  limit?: number;
  offset?: number;
  facets?: string[];
  /** Set true to opt into the short-TTL in-process result cache. */
  cache?: boolean;
}

const MAX_OFFSET = 200;

function resultCacheKey(project: string, collection: string, opts: SearchOpts): SearchCacheKey {
  return {
    project,
    collection,
    query: opts.q,
    filters: opts.filters ?? {},
    weights: opts.weights ?? {},
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
      const rows = await getPgClient(ctx.db, "parameterized search query").unsafe(
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

  const rows = await getPgClient(ctx.db, "parameterized search query").unsafe(query, params);
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

      await getPgClient(ctx.db, "parameterized search query").unsafe(
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
    const cacheKey = opts.cache === true ? resultCacheKey(projectSlug, collectionName, opts) : null;
    if (cacheKey) {
      const hit = searchResultCache.get<SearchResult>(cacheKey);
      if (hit) {
        ctx.observability.inc("search_cache_hits");
        return { ...hit, took_ms: Date.now() - t0, cached: true };
      }
    }
    const project = await projectsService.getProject(projectSlug);
    if (!project) throw new Error(`project "${projectSlug}" not found`);
    const def = await getCollectionDef(projectSlug, collectionName);
    if (!def) throw new Error(`collection "${collectionName}" not found in project "${projectSlug}"`);

    const q = opts.q?.trim() ?? "";
    if (!q && !opts.image) throw new Error("search requires a non-empty q or image");

    const limit = opts.limit ?? 20;
    const offset = Math.min(Math.max(opts.offset ?? 0, 0), MAX_OFFSET);
    const weights = parseSearchWeights(def, opts.weights);

    const nlq = await parseNlq(ctx, def, q);
    const explicitFilters = opts.filters ?? {};
    const mergedFilters = mergeFilters(nlq.filters, explicitFilters);
    await resolveBudgetHints(ctx, project.schema_name, collectionName, def, nlq.budgetHints, mergedFilters);
    const filterOpts: FilterCompileOpts = {
      soft: true,
      excludeTerms: nlq.excludeTerms,
    };

    const semanticText = nlq.parsed.semantic_query || q || "image query";
    const imageVectors = await buildQueryImageVectors(def, opts.image, embedService);

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
        imageVectors,
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
    let relaxedFields: string[] = [];
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
      relaxedFields = relaxedSoftFields(def, mergedFilters, softFieldsUsed);
    }

    let facets: SearchResult["facets"];
    if (opts.facets?.length) {
      const compiled = buildFilterSql(mergedFilters, def, filterOpts, 1);
      facets = await computeFacets(
        ctx.db,
        collectionTableName(project.schema_name, collectionName),
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
      constraintTrace: buildConstraintTrace(def, {
        semanticQuery: semanticText,
        derivedFilters: nlq.filters,
        explicitFilters,
        appliedFilters: mergedFilters,
        relaxedFields,
        excludedTerms: nlq.excludeTerms,
        budgetHints: nlq.budgetHints,
      }),
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
    const cacheKey = opts.cache === true ? resultCacheKey(projectSlug, collectionName, opts) : null;
    let cacheHit = false;
    if (cacheKey) {
      const hit = searchResultCache.get<SearchResult>(cacheKey);
      if (hit) {
        cacheHit = true;
        ctx.observability.inc("search_cache_hits");
      }
    }

    const project = await projectsService.getProject(projectSlug);
    if (!project) throw new Error(`project "${projectSlug}" not found`);
    const def = await getCollectionDef(projectSlug, collectionName);
    if (!def) throw new Error(`collection "${collectionName}" not found in project "${projectSlug}"`);

    const q = opts.q?.trim() ?? "";
    if (!q && !opts.image) throw new Error("search explain requires a non-empty q or image");

    const limit = Math.min(opts.limit ?? 20, 20);
    const offset = Math.min(Math.max(opts.offset ?? 0, 0), MAX_OFFSET);
    const weights = parseSearchWeights(def, opts.weights);

    const nlq = await parseNlq(ctx, def, q);
    const explicitFilters = opts.filters ?? {};
    const mergedFilters = mergeFilters(nlq.filters, explicitFilters);
    await resolveBudgetHints(ctx, project.schema_name, collectionName, def, nlq.budgetHints, mergedFilters);
    const filterOpts: FilterCompileOpts = {
      soft: true,
      excludeTerms: nlq.excludeTerms,
    };

    const semanticText = nlq.parsed.semantic_query || q || "image query";
    const imageVectors = await buildQueryImageVectors(def, opts.image, embedService);

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
      imageVectors,
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
    let relaxedFields: string[] = [];
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
      relaxedFields = relaxedSoftFields(def, mergedFilters, softFieldsUsed);
    }

    const table = collectionTableName(project.schema_name, collectionName);
    const spaceCosinesById = new Map<string, Record<string, number>>();
    if (weights.spaces > 0 && spaceSegments && rows.length) {
      const ids = rows.map((r) => String(r.id));
      const vecRows = await getPgClient(ctx.db, "parameterized search query").unsafe(
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
      constraintTrace: buildConstraintTrace(def, {
        semanticQuery: semanticText,
        derivedFilters: nlq.filters,
        explicitFilters,
        appliedFilters: mergedFilters,
        relaxedFields,
        excludedTerms: nlq.excludeTerms,
        budgetHints: nlq.budgetHints,
      }),
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
