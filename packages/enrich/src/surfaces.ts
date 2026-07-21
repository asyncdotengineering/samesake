import { createHash } from "node:crypto";
import type { DerivedDocContext, DerivedDocDef, IndexingDef } from "@samesake/core";
import { imageVersionToken } from "@samesake/core";

export interface IndexingPersistResult {
  doc: string | null;
  denseByEmbedding: Record<string, string>;
  rerank_doc: string | null;
  fts_src: string | null;
  fts_src_a: string | null;
  pipeline_status: "ready" | "quarantined";
  gate_reason: string | null;
}

export function deriveSurfaces(
  indexing: IndexingDef,
  ctx: DerivedDocContext
): IndexingPersistResult {
  let doc: string | null = null;
  const denseByEmbedding: Record<string, string> = {};
  let rerank_doc: string | null = null;
  let fts_src: string | null = null;
  let fts_src_a: string | null = null;

  for (const [key, surface] of Object.entries(indexing.surfaces) as Array<[string, DerivedDocDef]>) {
    const text = surface.build(ctx);
    if (text === "") {
      return {
        doc,
        denseByEmbedding,
        rerank_doc,
        fts_src,
        fts_src_a,
        pipeline_status: "quarantined",
        gate_reason: `empty:${key}`,
      };
    }
    if (surface.kind === "dense") {
      doc = text;
      if (surface.embedding) denseByEmbedding[surface.embedding] = text;
    }
    else if (surface.kind === "rerank") rerank_doc = text;
    else if (surface.kind === "fts") {
      if (surface.weight === "A") fts_src_a = text;
      else fts_src = text;
    }
  }

  const gateResult = indexing.gate(ctx);
  if (!gateResult.index) {
    return {
      doc,
      denseByEmbedding,
      rerank_doc,
      fts_src,
      fts_src_a,
      pipeline_status: "quarantined",
      gate_reason: gateResult.reason ?? "gate-rejected",
    };
  }

  return { doc, denseByEmbedding, rerank_doc, fts_src, fts_src_a, pipeline_status: "ready", gate_reason: null };
}

export function imageValidatorsForUrls(
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

export function stageCacheKey(
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
