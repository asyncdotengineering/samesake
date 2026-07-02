import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MatcherCtx } from "../../types.ts";
import type { SearchExplainResult, SearchHit, SearchService } from "../search.ts";
import { getByPath } from "../db-utils.ts";
import { cacheOrJudge, makeFileJudgeCache, type JudgeCache } from "./cache.ts";
import {
  assertJudgeFamilySeparation,
  candidateSummary,
  ESCI_SOFT_POSITIVE_FLOOR,
  type JudgedHit,
  type RelevanceJudge,
} from "./judge.ts";
import {
  constraintViolations,
  hitAtK,
  mrr,
  ndcgAtK,
  nullRate,
  type ConstraintHit,
  type GoldenConstraints,
  type Grade,
} from "./metrics.ts";

export type MetricKey =
  | "hitAtK"
  | "ndcgAtK"
  | "mrr"
  | "nullRate"
  | "constraintViolationRate";

export interface GoldenQuery {
  id: string;
  type: string;
  query: string;
  constraints?: GoldenConstraints;
  grades?: Record<string, Grade>;
}

export interface EvalOpts {
  queries: GoldenQuery[];
  judge: RelevanceJudge;
  k?: number;
  /** ESCI gain a hit must reach to count as relevant. Default 2 — Substitute is a soft positive. */
  relevanceFloor?: 1 | 2 | 3;
  thresholds?: Partial<Record<MetricKey, number>>;
  artifactDir?: string;
  cacheDir?: string;
  timestamp?: string;
}

export interface PerQuery {
  id: string;
  type: string;
  hitAtK: number;
  ndcgAtK: number;
  mrr: number;
  nullResult: boolean;
  constraintViolations: number;
  channelAttribution: Record<string, number>;
}

export interface EvalResult {
  perQuery: PerQuery[];
  aggregate: Record<MetricKey, number> & { byType: Record<string, Record<MetricKey, number>> };
  judgeVersion: string;
  pass: boolean;
  failedThresholds: Array<{ metric: string; got: number; min: number }>;
  artifactPath: string;
}

// Constraint fields resolve against whatever the collection schema declares: the hit's
// projected columns first, then the raw document data by path.
function constraintHit(hit: SearchHit): ConstraintHit {
  return {
    id: hit.id,
    value: (field) => (field in hit ? hit[field] : getByPath(hit.data, field)),
  };
}

function candidateFromHit(hit: SearchHit): { id: string; text: string; data: Record<string, unknown> } {
  const enriched =
    (hit.data?.enriched as Record<string, unknown> | undefined) ??
    (hit.enriched as Record<string, unknown> | undefined);
  const rerankDoc = enriched?.rerank_doc;
  const text =
    typeof rerankDoc === "string" && rerankDoc.trim()
      ? rerankDoc
      : candidateSummary({ ...hit.data, ...hit }, hit.id);
  return { id: hit.id, text, data: hit.data };
}

function attributeWinsToChannels(
  graded: JudgedHit[],
  explain: SearchExplainResult,
  floor: number
): Record<string, number> {
  const attribution: Record<string, number> = {};
  const byId = new Map(explain.docs.map((d) => [d.id, d]));

  for (const g of graded) {
    if (g.grade < floor) continue;
    const doc = byId.get(g.id);
    if (!doc) continue;
    const ranks: Array<[string, number]> = [];
    if (doc.fts_rank != null) ranks.push(["fts", doc.fts_rank]);
    if (doc.cosine_rank != null) ranks.push(["cosine", doc.cosine_rank]);
    if (doc.spaces_rank != null) ranks.push(["spaces", doc.spaces_rank]);
    if (doc.recency_rank != null) ranks.push(["recency", doc.recency_rank]);
    if (ranks.length === 0) continue;
    ranks.sort((a, b) => a[1] - b[1]);
    const winner = ranks[0]![0];
    attribution[winner] = (attribution[winner] ?? 0) + 1;
  }
  return attribution;
}

function mean(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((s, n) => s + n, 0) / nums.length;
}

function aggregateMetrics(rows: PerQuery[]): Record<MetricKey, number> {
  return {
    hitAtK: mean(rows.map((r) => r.hitAtK)),
    ndcgAtK: mean(rows.map((r) => r.ndcgAtK)),
    mrr: mean(rows.map((r) => r.mrr)),
    nullRate: nullRate(rows.map((r) => r.nullResult)),
    constraintViolationRate: mean(rows.map((r) => r.constraintViolations)),
  };
}

function aggregateByType(rows: PerQuery[]): Record<string, Record<MetricKey, number>> {
  const types = [...new Set(rows.map((r) => r.type))];
  const out: Record<string, Record<MetricKey, number>> = {};
  for (const type of types) {
    out[type] = aggregateMetrics(rows.filter((r) => r.type === type));
  }
  return out;
}

function evaluateThresholds(
  aggregate: Record<MetricKey, number>,
  thresholds?: Partial<Record<MetricKey, number>>
): { pass: boolean; failedThresholds: Array<{ metric: string; got: number; min: number }> } {
  if (!thresholds || Object.keys(thresholds).length === 0) {
    return { pass: true, failedThresholds: [] };
  }
  const failed: Array<{ metric: string; got: number; min: number }> = [];
  for (const [metric, min] of Object.entries(thresholds) as Array<[MetricKey, number]>) {
    const got = aggregate[metric];
    if (got < min) failed.push({ metric, got, min });
  }
  return { pass: failed.length === 0, failedThresholds: failed };
}

export function makeEvalService(ctx: MatcherCtx, searchService: SearchService) {
  return {
    runEval: (project: string, collection: string, opts: EvalOpts) =>
      runEval(ctx, searchService, project, collection, opts),
  };
}

export async function runEval(
  ctx: MatcherCtx,
  searchService: SearchService,
  project: string,
  collection: string,
  opts: EvalOpts
): Promise<EvalResult> {
  const k = opts.k ?? 10;
  const floor = opts.relevanceFloor ?? ESCI_SOFT_POSITIVE_FLOOR;

  // Judge honesty gate: never grade a collection with a judge from the same model family
  // that wrote its enrichment (self-preference bias inflates every metric downstream).
  const def = await searchService.getCollectionDef(project, collection);
  const enrichModels = (def?.enrich?.stages ?? []).map((s) => s.model);
  if (enrichModels.length > 0) {
    assertJudgeFamilySeparation(opts.judge.model, enrichModels);
  }
  const cacheDir = opts.cacheDir ?? join(process.cwd(), "evals", ".cache");
  const artifactDir = opts.artifactDir ?? join(process.cwd(), "evals", "runs");
  const cache: JudgeCache = makeFileJudgeCache(cacheDir);
  const perQuery: PerQuery[] = [];

  for (const q of opts.queries) {
    try {
      const { result, explain } = await searchService.searchWithExplain(project, collection, {
        q: q.query,
        limit: k,
        cache: false,
      });
      const hits = result.hits.slice(0, k);
      const violations = constraintViolations(hits.map(constraintHit), q.constraints);
      const candidates = hits.map(candidateFromHit);
      const graded = await cacheOrJudge(opts.judge, q.query, candidates, cache);
      const grades = graded.map((g) => g.grade);
      const maxGrade = grades.length ? Math.max(...grades) : 0;
      const nullResult = hits.length === 0 || maxGrade < floor;

      perQuery.push({
        id: q.id,
        type: q.type,
        hitAtK: hitAtK(grades, floor, k),
        ndcgAtK: ndcgAtK(grades, k),
        mrr: mrr(grades, floor),
        nullResult,
        constraintViolations: violations,
        channelAttribution: attributeWinsToChannels(graded, explain, floor),
      });
    } catch (e) {
      ctx.observability.log(
        "warn",
        "eval",
        e instanceof Error ? e.message : String(e),
        { queryId: q.id }
      );
      perQuery.push({
        id: q.id,
        type: q.type,
        hitAtK: 0,
        ndcgAtK: 0,
        mrr: 0,
        nullResult: true,
        constraintViolations: 0,
        channelAttribution: {},
      });
    }
  }

  const baseAgg = aggregateMetrics(perQuery);
  const aggregate = { ...baseAgg, byType: aggregateByType(perQuery) };
  const { pass, failedThresholds } = evaluateThresholds(baseAgg, opts.thresholds);
  const ts = opts.timestamp ?? new Date().toISOString().replace(/[:.]/g, "-");
  const artifactName = `${ts}-${opts.judge.version}.json`;
  const artifactPath = join(artifactDir, artifactName);
  await mkdir(artifactDir, { recursive: true });
  await writeFile(
    artifactPath,
    JSON.stringify(
      {
        judgeVersion: opts.judge.version,
        k,
        relevanceFloor: floor,
        perQuery,
        aggregate,
        pass,
        failedThresholds,
      },
      null,
      2
    )
  );

  return {
    perQuery,
    aggregate,
    judgeVersion: opts.judge.version,
    pass,
    failedThresholds,
    artifactPath,
  };
}
