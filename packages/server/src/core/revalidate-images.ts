import type { CollectionDef, PipelineDef } from "@samesake/core";
import type { MatcherCtx } from "../types.ts";
import type { ProjectsService } from "./projects.ts";
import { probeRemoteImageSafe } from "./fetch-image.ts";
import { collectionTableName } from "./db-utils.ts";

function isPipeline(def: CollectionDef["enrich"]): def is PipelineDef {
  return !!def && typeof def === "object" && Array.isArray((def as PipelineDef).stages);
}

function enrichConsumesImages(def: CollectionDef): boolean {
  if (!isPipeline(def.enrich)) return false;
  return def.enrich.stages.some((s) => typeof s.images === "function");
}

export interface RevalidateImagesResult {
  checked: number;
  changed: number;
  unchanged: number;
  skipped: number;
}

export function makeRevalidateImagesService(ctx: MatcherCtx, projectsService: ProjectsService) {
  async function runRevalidateImages(
    projectSlug: string,
    collectionName: string,
    opts?: { limit?: number }
  ): Promise<RevalidateImagesResult> {
    const project = await projectsService.getProject(projectSlug);
    if (!project) throw new Error(`project "${projectSlug}" not found`);
    const def = await projectsService.getCollectionDef(projectSlug, collectionName);
    if (!def) throw new Error(`collection "${collectionName}" not found in project "${projectSlug}"`);

    const table = collectionTableName(project.schema_name, collectionName);
    const limit = opts?.limit ?? 100_000;
    const consumesImages = enrichConsumesImages(def);

    const rows = await ctx.storage.client("revalidate-images").unsafe(
      `SELECT id, data, image_etag
       FROM ${table}
       WHERE data->>'image_url' IS NOT NULL AND data->>'image_url' <> ''
       ORDER BY id
       LIMIT $1`,
      [limit]
    );

    let checked = 0;
    let changed = 0;
    let unchanged = 0;
    let skipped = 0;

    for (const row of rows) {
      const data =
        typeof row.data === "string"
          ? (JSON.parse(row.data as string) as Record<string, unknown>)
          : (row.data as Record<string, unknown>);
      const imageUrl = String(data.image_url ?? "").trim();
      if (!imageUrl) {
        skipped++;
        continue;
      }

      const prior = (row.image_etag as string | null | undefined) ?? null;
      const probe = await probeRemoteImageSafe(imageUrl, { priorValidator: prior });
      if (!probe.ok) {
        ctx.observability.log("warn", "revalidate-images", "probe failed", {
          id: row.id,
          reason: probe.reason,
          url: imageUrl.slice(0, 120),
        });
        skipped++;
        continue;
      }

      checked++;
      const hasPrior = prior != null && prior !== "";
      const imageChanged = hasPrior && !probe.unchanged;

      if (imageChanged) {
        changed++;
        await ctx.storage.client("revalidate-images").unsafe(
          `UPDATE ${table}
           SET indexed_at = NULL,
               enriched_at = CASE WHEN $1 THEN NULL ELSE enriched_at END,
               image_etag = $2,
               image_checked_at = now(),
               updated_at = now()
           WHERE id = $3`,
          [consumesImages, probe.validator, row.id]
        );
      } else {
        unchanged++;
        await ctx.storage.client("revalidate-images").unsafe(
          `UPDATE ${table}
           SET image_etag = $1,
               image_checked_at = now(),
               updated_at = now()
           WHERE id = $2`,
          [probe.validator, row.id]
        );
      }
    }

    return { checked, changed, unchanged, skipped };
  }

  async function revalidateImages(
    projectSlug: string,
    collectionName: string,
    opts?: { limit?: number }
  ): Promise<RevalidateImagesResult> {
    return ctx.jobs.run(
      `revalidate-images:${projectSlug}:${collectionName}`,
      { projectSlug, collectionName, ...opts },
      () => runRevalidateImages(projectSlug, collectionName, opts)
    );
  }

  return { revalidateImages };
}

export type RevalidateImagesService = ReturnType<typeof makeRevalidateImagesService>;
