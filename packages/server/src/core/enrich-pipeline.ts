import { createHash } from "node:crypto";
import type { CollectionDef, DerivedDocContext, DerivedDocDef, IndexingDef, PipelineDef, StageContext } from "@samesake/core";
import type { MatcherCtx } from "../types.ts";
import type { ProjectsService } from "./projects.ts";
import { imageVersionToken } from "../connectors/normalize.ts";
import { makeStageCacheService } from "../db/stage-cache.ts";
import { fetchRemoteImageSafe } from "./fetch-image.ts";
import { callWithRetry } from "./policy.ts";
import { collectionTableName } from "./db-utils.ts";
import {
  assertErrorRateWithinLimit,
  recordPipelineFailure,
  type ErrorRateOpts,
} from "./pipeline-failure.ts";
import { normalizeSchema } from "./schema-input.ts";

function isPipeline(def: CollectionDef["enrich"]): def is PipelineDef {
  return !!def && typeof def === "object" && Array.isArray((def as PipelineDef).stages);
}

function hasIndexing(def: CollectionDef): def is CollectionDef & { indexing: IndexingDef } {
  return !!def.indexing && typeof def.indexing.gate === "function";
}

interface IndexingPersistResult {
  doc: string | null;
  rerank_doc: string | null;
  fts_src: string | null;
  pipeline_status: "ready" | "quarantined";
  gate_reason: string | null;
}

function persistIndexingSurfaces(
  indexing: IndexingDef,
  ctx: DerivedDocContext
): IndexingPersistResult {
  let doc: string | null = null;
  let rerank_doc: string | null = null;
  let fts_src: string | null = null;

  for (const [key, surface] of Object.entries(indexing.surfaces) as Array<[string, DerivedDocDef]>) {
    const text = surface.build(ctx);
    if (text === "") {
      return {
        doc,
        rerank_doc,
        fts_src,
        pipeline_status: "quarantined",
        gate_reason: `empty:${key}`,
      };
    }
    if (surface.kind === "dense") doc = text;
    else if (surface.kind === "rerank") rerank_doc = text;
    else if (surface.kind === "fts") fts_src = text;
  }

  const gateResult = indexing.gate(ctx);
  if (!gateResult.index) {
    return {
      doc,
      rerank_doc,
      fts_src,
      pipeline_status: "quarantined",
      gate_reason: gateResult.reason ?? "gate-rejected",
    };
  }

  return { doc, rerank_doc, fts_src, pipeline_status: "ready", gate_reason: null };
}

function imageValidatorsForUrls(
  imageUrls: string[],
  data: Record<string, unknown>,
  rowImageEtag?: string | null
): string[] {
  const rowToken =
    rowImageEtag ??
    imageVersionToken({
      image_etag: data.image_etag,
      image_updated_at: data.image_updated_at,
      image_version: data.image_version,
    });
  return imageUrls.map(() => rowToken ?? "");
}

function stageCacheKey(
  stageName: string,
  model: string,
  prompt: string,
  imageUrls: string[],
  imageValidators: string[],
  schema: Record<string, unknown>
): string {
  const urlMaterial = imageUrls
    .map((url, i) => `${url}@${imageValidators[i] ?? ""}`)
    .join(",");
  const material = `${prompt}|${urlMaterial}|${JSON.stringify(schema)}`;
  const hash = createHash("sha1").update(material).digest("hex");
  return `stage:${stageName}:${model}:${hash}`;
}

export function makeEnrichPipelineService(
  ctx: MatcherCtx,
  projectsService: ProjectsService
) {
  const stageCache = makeStageCacheService(ctx);

  function requireGenerate(def: CollectionDef): void {
    if (!isPipeline(def.enrich)) return;
    if (!ctx.generateConfigured) {
      throw new Error(
        "createMatcher's `generate` is not configured, but a collection declared an `enrich:` pipeline.\n\n" +
          "Wire it up by providing a function that calls your LLM with schema-constrained JSON output:\n\n" +
          "  createMatcher({\n" +
          "    /* ...db, apiKey, embed... */\n" +
          "    generate: async ({ model, prompt, images, schema }) => {\n" +
          "      // call Gemini / OpenAI / etc with responseSchema\n" +
          "      return parsedJson;\n" +
          "    },\n" +
          "  });\n\n" +
          "Or remove the `enrich:` block from collections that do not need enrichment."
      );
    }
  }

  async function runStage(
    stage: PipelineDef["stages"][number],
    stageCtx: StageContext,
    docId: string,
    rowImageEtag: string | null | undefined,
    fewShot = ""
  ): Promise<Record<string, unknown> | null> {
    if (stage.condition && !stage.condition(stageCtx)) return null;

    const prompt = stage.prompt(stageCtx) + fewShot;
    const imageUrls = stage.images?.(stageCtx) ?? [];
    const schema = normalizeSchema(stage.schema(stageCtx));
    const model = stage.model ?? "<default>";
    const imageValidators = imageValidatorsForUrls(imageUrls, stageCtx.data, rowImageEtag);
    const key = stageCacheKey(stage.name, model, prompt, imageUrls, imageValidators, schema);

    const cached = await stageCache.getStageCache(key);
    if (cached && typeof cached === "object") {
      return cached as Record<string, unknown>;
    }

    const images: { mimeType: string; data: string }[] = [];
    for (const url of imageUrls) {
      const fetched = await fetchRemoteImageSafe(url);
      if (fetched.ok) {
        images.push({
          mimeType: fetched.contentType,
          data: Buffer.from(fetched.bytes).toString("base64"),
        });
      } else {
        ctx.observability.log("warn", "enrich", "image fetch skipped", {
          reason: fetched.reason,
          url: url.slice(0, 120),
        });
      }
    }

    try {
      const result = await callWithRetry(
        () =>
          ctx.generate({
            model: stage.model,
            prompt,
            images: images.length ? images : undefined,
            schema,
          }),
        { ...ctx.policy.llm, timeoutMs: undefined }
      );
      const payload =
        result && typeof result === "object" ? (result as Record<string, unknown>) : { value: result };
      await stageCache.setStageCache(key, stage.name, payload, model);
      return payload;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.observability.inc("enrich_failures_total");
      ctx.observability.log("error", "enrich", `stage "${stage.name}" failed`, {
        docId,
        error: msg.slice(0, 200),
      });
      return null;
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
    requireGenerate(def);

    const data = row.data;
    const enriched: Record<string, unknown> = {};
    const stageCtx: StageContext = { data, enriched };

    for (const stage of def.enrich.stages) {
      const result = await runStage(stage, stageCtx, row.id, row.image_etag, fewShot);
      if (result) {
        Object.assign(enriched, result);
        enriched._stages = {
          ...(enriched._stages as Record<string, unknown> | undefined),
          [stage.name]: result,
        };
        stageCtx.enriched = enriched;
      }
    }

    const table = collectionTableName(schema, collectionName);
    try {
      if (hasIndexing(def)) {
        for (const [key, surface] of Object.entries(def.indexing.surfaces) as Array<[string, DerivedDocDef]>) {
          if (typeof surface.build !== "function") {
            throw new Error(`indexing surface "${key}" has no callable build`);
          }
        }
        if (typeof def.indexing.gate !== "function") {
          throw new Error("indexing gate is not callable");
        }

        const derivedCtx: DerivedDocContext = { data, enriched };
        const surfaces = persistIndexingSurfaces(def.indexing, derivedCtx);

        await ctx.storage.client("enrich").unsafe(
          `UPDATE ${table}
           SET enriched = $1::jsonb,
               enriched_at = now(),
               doc = $2,
               rerank_doc = $3,
               fts_src = $4,
               pipeline_status = $5,
               gate_reason = $6,
               updated_at = now()
           WHERE id = $7`,
          [
            JSON.stringify(enriched),
            surfaces.doc,
            surfaces.rerank_doc,
            surfaces.fts_src,
            surfaces.pipeline_status,
            surfaces.gate_reason,
            row.id,
          ]
        );
      } else {
        await ctx.storage.client("enrich").unsafe(
          `UPDATE ${table}
           SET enriched = $1::jsonb, enriched_at = now(), updated_at = now()
           WHERE id = $2`,
          [JSON.stringify(enriched), row.id]
        );
      }
    } catch (e) {
      await recordFailure(table, row.id, e);
      return false;
    }
    ctx.observability.inc("enrich_docs_total");
    return true;
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
    for (const stage of def.enrich.stages) {
      if (typeof stage.prompt !== "function" || typeof stage.schema !== "function") {
        throw new Error(
          `collection "${collectionName}" stage "${stage.name}" has no callable prompt/schema. ` +
            `Pipeline functions cannot be loaded from the database — pass this collection's config ` +
            `to createMatcher (or re-apply the project in-process) before calling enrich.`
        );
      }
    }
    if (hasIndexing(def)) {
      for (const [key, surface] of Object.entries(def.indexing.surfaces) as Array<[string, DerivedDocDef]>) {
        if (typeof surface.build !== "function") {
          throw new Error(
            `collection "${collectionName}" indexing surface "${key}" has no callable build. ` +
              `Indexing functions cannot be loaded from the database — pass this collection's config ` +
              `to createMatcher (or re-apply the project in-process) before calling enrich.`
          );
        }
      }
      if (typeof def.indexing.gate !== "function") {
        throw new Error(
          `collection "${collectionName}" has no callable indexing gate. ` +
            `Indexing functions cannot be loaded from the database — pass this collection's config ` +
            `to createMatcher (or re-apply the project in-process) before calling enrich.`
        );
      }
    } else {
      throw new Error(
        `collection "${collectionName}" has no callable indexing surfaces/gate. ` +
          `Indexing functions cannot be loaded from the database — pass this collection's config ` +
          `to createMatcher (or re-apply the project in-process) before calling enrich.`
      );
    }
    requireGenerate(def);

    const table = collectionTableName(project.schema_name, collectionName);
    const limit = opts?.limit ?? 100_000;
    const concurrency = opts?.concurrency ?? 8;

    // Few-shot guidance from human corrections (Q6 review loop) — fetched once per run.
    let fewShot = "";
    try {
      const { makeReviewService } = await import("./review.ts");
      const examples = await makeReviewService(ctx, projectsService).correctionExamples(projectSlug, collectionName, 3);
      if (examples.length) {
        fewShot = "\n\nCorrections from human review of similar products in this catalog (follow these patterns):\n" + examples.join("\n");
      }
    } catch {
      // corrections table may not exist on older deployments; few-shot is best-effort
    }

    const pending = await ctx.storage.client("enrich").unsafe(
      `SELECT id, data, image_etag FROM ${table}
       WHERE enriched_at IS NULL
       ORDER BY id
       LIMIT $1`,
      [limit]
    );

    let enriched = 0;
    let skipped = 0;
    let failed = 0;
    let processed = 0;
    let idx = 0;
    const errorRateOpts: ErrorRateOpts = {
      maxErrorRate: opts?.maxErrorRate,
      minSamples: opts?.minSamples,
    };

    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (idx < pending.length) {
          const row = pending[idx++]!;
          const data =
            typeof row.data === "string"
              ? (JSON.parse(row.data as string) as Record<string, unknown>)
              : (row.data as Record<string, unknown>);
          try {
            const ok = await enrichOne(
              def,
              {
                id: String(row.id),
                data,
                image_etag: (row.image_etag as string | null | undefined) ?? null,
              },
              project.schema_name,
              collectionName,
              fewShot
            );
            processed++;
            if (ok) enriched++;
            else {
              failed++;
              assertErrorRateWithinLimit(processed, failed, errorRateOpts);
            }
          } catch {
            processed++;
            failed++;
            assertErrorRateWithinLimit(processed, failed, errorRateOpts);
          }
        }
      })
    );

    return { enriched, skipped, failed };
  }

  return { enrichCollection, enrichOne, recordFailure, requireGenerate };
}

export type EnrichPipelineService = ReturnType<typeof makeEnrichPipelineService>;
