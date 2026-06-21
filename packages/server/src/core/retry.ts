import type { CollectionDef, PipelineDef } from "@samesake/core";
import type { MatcherCtx } from "../types.ts";
import type { ProjectsService } from "./projects.ts";
import type { EnrichPipelineService } from "./enrich-pipeline.ts";
import type { EmbedIndexService } from "./embed-index.ts";
import { collectionTableName, getPgClient } from "./db-utils.ts";
import { DEFAULT_MAX_ATTEMPTS, recordPipelineFailure } from "./pipeline-failure.ts";

function isPipeline(def: CollectionDef["enrich"]): def is PipelineDef {
  return !!def && typeof def === "object" && Array.isArray((def as PipelineDef).stages);
}

export interface RetryFailedOpts {
  limit?: number;
  maxAttempts?: number;
}

export function makeRetryService(
  ctx: MatcherCtx,
  projectsService: ProjectsService,
  enrichService: EnrichPipelineService,
  embedIndexService: EmbedIndexService
) {
  async function retryFailed(
    projectSlug: string,
    collectionName: string,
    opts?: RetryFailedOpts
  ): Promise<{ retried: number; dead: number }> {
    return ctx.jobs.run(
      `retry:${projectSlug}:${collectionName}`,
      { projectSlug, collectionName, ...opts },
      () => runRetryFailed(projectSlug, collectionName, opts)
    );
  }

  async function runRetryFailed(
    projectSlug: string,
    collectionName: string,
    opts?: RetryFailedOpts
  ): Promise<{ retried: number; dead: number }> {
    const project = await projectsService.getProject(projectSlug);
    if (!project) throw new Error(`project "${projectSlug}" not found`);
    const def = await projectsService.getCollectionDef(projectSlug, collectionName);
    if (!def) throw new Error(`collection "${collectionName}" not found in project "${projectSlug}"`);

    const maxAttempts = opts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const limit = opts?.limit ?? 100_000;
    const table = collectionTableName(project.schema_name, collectionName);
    const hasEnrich = isPipeline(def.enrich);

    const deadRows = await ctx.storage.client("retry").unsafe(
      `UPDATE ${table}
       SET pipeline_status = 'dead', updated_at = now()
       WHERE pipeline_status = 'failed' AND attempt_count >= $1
       RETURNING id`,
      [maxAttempts]
    );
    const dead = deadRows.length;

    const retryable = await ctx.storage.client("retry").unsafe(
      `SELECT id, data, enriched, image_etag, enriched_at
       FROM ${table}
       WHERE pipeline_status = 'failed'
         AND next_attempt_at <= now()
         AND attempt_count < $1
       ORDER BY id
       LIMIT $2`,
      [maxAttempts, limit]
    );

    let retried = 0;
    for (const row of retryable) {
      const rowId = String(row.id);
      const data =
        typeof row.data === "string"
          ? (JSON.parse(row.data as string) as Record<string, unknown>)
          : (row.data as Record<string, unknown>);

      try {
        if (hasEnrich && row.enriched_at == null) {
          const ok = await enrichService.enrichOne(
            def,
            {
              id: rowId,
              data,
              image_etag: (row.image_etag as string | null | undefined) ?? null,
            },
            project.schema_name,
            collectionName
          );
          if (ok) retried++;
        } else {
          await embedIndexService.indexOne(projectSlug, collectionName, rowId);
          retried++;
        }
      } catch (e) {
        await recordPipelineFailure(ctx, table, rowId, e);
      }
    }

    return { retried, dead };
  }

  return { retryFailed };
}

export type RetryService = ReturnType<typeof makeRetryService>;
