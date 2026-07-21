import type { CollectionDef, IndexingDef, PipelineDef } from "@samesake/core";
import {
  enrich,
  type EnrichResult,
  type IndexingPersistResult,
  type RawRow,
} from "@samesake/enrich";
import type { MatcherCtx } from "../types.ts";
import type { ProjectsService } from "./projects.ts";
import { fetchRemoteImageSafe } from "./fetch-image.ts";
import { callWithRetry } from "./policy.ts";
import { collectionTableName } from "./db-utils.ts";
import {
  assertErrorRateWithinLimit,
  recordPipelineFailure,
  type ErrorRateOpts,
} from "./pipeline-failure.ts";
import { pgStageCache } from "../db/stage-cache.ts";

function isPipeline(def: CollectionDef["enrich"]): def is PipelineDef {
  return !!def && typeof def === "object" && Array.isArray((def as PipelineDef).stages);
}

function hasIndexing(def: CollectionDef): def is CollectionDef & { indexing: IndexingDef } {
  return !!def.indexing && typeof def.indexing.gate === "function";
}

export { deriveSurfaces as persistIndexingSurfaces, type IndexingPersistResult } from "@samesake/enrich";

export function toRawRow(row: {
  id: string;
  data: unknown;
  image_etag?: string | null;
}): RawRow {
  const data = typeof row.data === "string"
    ? JSON.parse(row.data) as Record<string, unknown>
    : row.data as Record<string, unknown>;
  return {
    id: String(row.id),
    data,
    imageEtag: row.image_etag ?? null,
  };
}

export function toIndexingPersistResult(result: EnrichResult): IndexingPersistResult {
  return {
    doc: result.surfaces.doc,
    denseByEmbedding: result.surfaces.denseByEmbedding,
    rerank_doc: result.surfaces.rerank_doc,
    fts_src: result.surfaces.fts_src,
    fts_src_a: result.surfaces.fts_src_a,
    pipeline_status: result.status,
    gate_reason: result.gateReason,
  };
}

function enrichDeps(ctx: MatcherCtx, fewShot: string, concurrency?: number) {
  return {
    generate: (request: Parameters<MatcherCtx["generate"]>[0]) =>
      callWithRetry(() => ctx.generate(request), { ...ctx.policy.llm, timeoutMs: undefined }),
    stageCache: pgStageCache(ctx),
    fetchImage: async (url: string) => {
      const fetched = await fetchRemoteImageSafe(url);
      return fetched.ok
        ? { ok: true as const, mimeType: fetched.contentType, bytes: fetched.bytes }
        : { ok: false as const };
    },
    fewShot,
    concurrency,
    onError: (row: RawRow, error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      ctx.observability.inc("enrich_failures_total");
      ctx.observability.log("error", "enrich", "enrichment core failed", {
        docId: row.id,
        error: message.slice(0, 200),
      });
    },
  };
}

async function persistResult(
  ctx: MatcherCtx,
  table: string,
  result: EnrichResult
): Promise<void> {
  if (!result.ok) {
    await recordPipelineFailure(ctx, table, result.id, result.error ?? "enrich failed");
    return;
  }
  await ctx.storage.persistEnrichment(
    table,
    result.id,
    JSON.stringify(result.enriched),
    toIndexingPersistResult(result)
  );
  ctx.observability.inc("enrich_docs_total");
}

export function makeEnrichPipelineService(
  ctx: MatcherCtx,
  projectsService: ProjectsService
) {
  const stageCache = pgStageCache(ctx);

  function requireGenerate(def: CollectionDef): void {
    if (!isPipeline(def.enrich)) return;
    if (!ctx.generateConfigured) {
      throw new Error(
        "createMatcher's `generate` is not configured, but a collection declared an `enrich:` pipeline."
      );
    }
  }

  async function recordFailure(table: string, rowId: string, error: unknown): Promise<void> {
    await recordPipelineFailure(ctx, table, rowId, error);
  }

  async function enrichOne(
    def: CollectionDef,
    row: { id: string; data: Record<string, unknown>; image_etag?: string | null },
    schema: string,
    collectionName: string,
    fewShot = ""
  ): Promise<boolean> {
    if (!isPipeline(def.enrich)) return false;
    if (!hasIndexing(def)) throw new Error("enrich requires indexing surfaces and gate");
    requireGenerate(def);
    const [result] = await enrich(
      [toRawRow(row)],
      { pipeline: def.enrich, indexing: def.indexing },
      { ...enrichDeps(ctx, fewShot, 1), stageCache }
    );
    if (!result) return false;
    const table = collectionTableName(schema, collectionName);
    try {
      await persistResult(ctx, table, result);
      return result.ok;
    } catch (error) {
      await recordFailure(table, result.id, error);
      return false;
    }
  }

  async function enrichCollection(
    projectSlug: string,
    collectionName: string,
    opts?: { concurrency?: number; limit?: number } & ErrorRateOpts
  ): Promise<{ enriched: number; skipped: number; failed: number }> {
    return runEnrichCollection(projectSlug, collectionName, opts);
  }

  async function runEnrichCollection(
    projectSlug: string,
    collectionName: string,
    opts?: { concurrency?: number; limit?: number } & ErrorRateOpts
  ): Promise<{ enriched: number; skipped: number; failed: number }> {
    const project = await projectsService.getProject(projectSlug);
    if (!project) throw new Error(`project "${projectSlug}" not found`);
    const def = await projectsService.getCollectionDef(projectSlug, collectionName);
    if (!def) throw new Error(`collection "${collectionName}" not found in project "${projectSlug}"`);
    if (!isPipeline(def.enrich)) {
      throw new Error(`collection "${collectionName}" has no enrich pipeline configured`);
    }
    if (!hasIndexing(def)) {
      throw new Error(`collection "${collectionName}" has no callable indexing surfaces/gate`);
    }
    requireGenerate(def);

    let fewShot = "";
    try {
      const { makeReviewService } = await import("./review.ts");
      const examples = await makeReviewService(ctx, projectsService).correctionExamples(projectSlug, collectionName, 3);
      if (examples.length) {
        fewShot = "\n\nCorrections from human review of similar products in this catalog (follow these patterns):\n" + examples.join("\n");
      }
    } catch {
      fewShot = "";
    }

    const table = collectionTableName(project.schema_name, collectionName);
    const pending = await ctx.storage.pendingForEnrich(table, opts?.limit ?? 100_000);
    const results = await enrich(
      pending.map(toRawRow),
      { pipeline: def.enrich, indexing: def.indexing },
      { ...enrichDeps(ctx, fewShot, opts?.concurrency ?? 8), stageCache }
    );
    const errorRateOpts: ErrorRateOpts = {
      maxErrorRate: opts?.maxErrorRate,
      minSamples: opts?.minSamples,
    };
    let enriched = 0;
    let failed = 0;
    let processed = 0;
    for (const result of results) {
      processed++;
      try {
        await persistResult(ctx, table, result);
        if (result.ok) enriched++;
        else {
          failed++;
          assertErrorRateWithinLimit(processed, failed, errorRateOpts);
        }
      } catch (error) {
        failed++;
        await recordFailure(table, result.id, error);
        assertErrorRateWithinLimit(processed, failed, errorRateOpts);
      }
    }

    return { enriched, skipped: 0, failed };
  }

  return { enrichCollection, enrichOne, recordFailure, requireGenerate };
}

export type EnrichPipelineService = ReturnType<typeof makeEnrichPipelineService>;
