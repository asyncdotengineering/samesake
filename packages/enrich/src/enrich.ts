import type {
  RawRow,
  EnrichConfig,
  EnrichDeps,
  EnrichResult,
  EnrichedSurfaces,
} from "./types.ts";
import type { GenerateRequest, IndexingDef, PipelineDef, StageContext } from "@samesake/core";
import { normalizeSchema } from "@samesake/core";
import { deriveSurfaces, imageValidatorsForUrls, stageCacheKey } from "./surfaces.ts";

const EMPTY_SURFACES: EnrichedSurfaces = {
  doc: null,
  denseByEmbedding: {},
  rerank_doc: null,
  fts_src: null,
  fts_src_a: null,
};

// Generate failure returns null (stage skipped), signaling via deps.onError.
async function runStage(
  stage: PipelineDef["stages"][number],
  stageCtx: StageContext,
  row: RawRow,
  deps: EnrichDeps
): Promise<Record<string, unknown> | null> {
  if (stage.condition && !stage.condition(stageCtx)) return null;

  const fewShot = deps.fewShot ?? "";
  const prompt = stage.prompt(stageCtx) + fewShot;
  const imageUrls = stage.images?.(stageCtx) ?? [];
  const schema = normalizeSchema(stage.schema(stageCtx));
  const model = stage.model ?? "<default>";
  const imageValidators = imageValidatorsForUrls(imageUrls, stageCtx.data, row.imageEtag);
  const key = stageCacheKey(stage.name, model, prompt, imageUrls, imageValidators, schema);

  const cached = deps.stageCache ? await deps.stageCache.get(key) : undefined;
  if (cached && typeof cached === "object") {
    return cached as Record<string, unknown>;
  }

  const images: { mimeType: string; data: string }[] = [];
  if (deps.fetchImage) {
    for (const url of imageUrls) {
      const fetched = await deps.fetchImage(url);
      if (fetched.ok) {
        images.push({
          mimeType: fetched.mimeType,
          data: Buffer.from(fetched.bytes).toString("base64"),
        });
      }
    }
  }

  try {
    const req: GenerateRequest = {
      model: stage.model,
      prompt,
      images: images.length ? images : undefined,
      schema,
    };
    const result = await deps.generate(req);
    const payload =
      result && typeof result === "object" ? (result as Record<string, unknown>) : { value: result };
    await deps.stageCache?.set(key, payload);
    return payload;
  } catch (e) {
    deps.onError?.(row, e);
    return null;
  }
}

export async function enrichRow(
  row: RawRow,
  cfg: EnrichConfig,
  deps: EnrichDeps
): Promise<EnrichResult> {
  const enriched: Record<string, unknown> = {};
  const stageCtx: StageContext = { data: row.data, enriched };
  try {
    for (const stage of cfg.pipeline.stages) {
      const out = await runStage(stage, stageCtx, row, deps);
      if (out) {
        Object.assign(enriched, out);
        enriched._stages = {
          ...(enriched._stages as Record<string, unknown> | undefined),
          [stage.name]: out,
        };
        stageCtx.enriched = enriched;
      }
    }
    const s = deriveSurfaces(cfg.indexing, { data: row.data, enriched });
    return {
      id: row.id,
      enriched,
      surfaces: {
        doc: s.doc,
        denseByEmbedding: s.denseByEmbedding,
        rerank_doc: s.rerank_doc,
        fts_src: s.fts_src,
        fts_src_a: s.fts_src_a,
      },
      status: s.pipeline_status,
      gateReason: s.gate_reason,
      ok: true,
    };
  } catch (err) {
    deps.onError?.(row, err);
    return {
      id: row.id,
      enriched,
      surfaces: EMPTY_SURFACES,
      status: "quarantined",
      gateReason: null,
      ok: false,
      error: String(err),
    };
  }
}

export async function enrich(
  rows: RawRow[],
  cfg: EnrichConfig,
  deps: EnrichDeps
): Promise<EnrichResult[]> {
  const concurrency = deps.concurrency ?? 8;
  const results: EnrichResult[] = new Array(rows.length);
  let idx = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (idx < rows.length) {
        const i = idx++;
        results[i] = await enrichRow(rows[i]!, cfg, deps);
      }
    })
  );
  return results;
}
