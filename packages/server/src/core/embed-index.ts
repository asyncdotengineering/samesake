import type { CollectionDef, CollectionFieldDef, PipelineDef } from "@samesake/core";
import type { MatcherCtx, GroundImageFn } from "../types.ts";
import type { Observability } from "./observability.ts";
import type { EmbedService } from "./embed.ts";
import { toVectorLiteral } from "./embed.ts";
import type { ProjectsService } from "./projects.ts";
import { sanitiseIdent } from "./schema-gen.ts";
import { fetchRemoteImageSafe } from "./fetch-image.ts";
import { searchResultCache } from "./search-cache.ts";
import { collectionTableName, getByPath, getPgClient } from "./db-utils.ts";
import {
  assembleDocVector,
  encodeCategorical,
  encodeImage,
  encodeNumber,
  encodeRecency,
  encodeText,
  spaceSegmentDim,
} from "./spaces.ts";

const BATCH_SIZE = 24;

function formatTemplateValue(v: unknown): string {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map(String).filter(Boolean).join(", ");
  return String(v);
}

export function resolveEmbedTemplate(
  template: string,
  data: Record<string, unknown>,
  enriched: Record<string, unknown> | null
): string {
  const merged = { ...data, enriched: enriched ?? {} };

  if (!template.includes("$")) {
    return formatTemplateValue(getByPath(merged, template));
  }

  const resolved = template.replace(/\$([\w]+(?:\.[\w]+)*)/g, (_m, token: string) => {
    if (token.startsWith("enriched.")) {
      const sub = token.slice("enriched.".length);
      return formatTemplateValue(getByPath(enriched ?? {}, sub));
    }
    return formatTemplateValue(getByPath(merged, token));
  });

  return resolved.replace(/\s+/g, " ").trim();
}

export function resolveFieldValue(
  fieldName: string,
  fieldDef: CollectionFieldDef,
  data: Record<string, unknown>,
  enriched: Record<string, unknown> | null
): unknown {
  const path = fieldDef.path ?? fieldName;
  if (path.startsWith("enriched.")) {
    return getByPath(enriched ?? {}, path.slice("enriched.".length));
  }
  return getByPath(data, path);
}

export function l2Renormalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1;
  return vec.map((x) => x / norm);
}

function hasEnrichPipeline(def: CollectionDef): boolean {
  const enrich = def.enrich as PipelineDef | undefined;
  return !!enrich?.stages?.length;
}

function hasIndexing(def: CollectionDef): boolean {
  return !!def.indexing?.surfaces && typeof def.indexing.gate === "function";
}

function hasSpaces(def: CollectionDef): boolean {
  return !!def.spaces && Object.keys(def.spaces).length > 0;
}

function spaceKeys(def: CollectionDef): string[] {
  return def.spaces ? Object.keys(def.spaces) : [];
}

function recencyAgeDays(
  fieldName: string,
  fieldDef: CollectionFieldDef | undefined,
  data: Record<string, unknown>,
  enriched: Record<string, unknown> | null,
  ingestedAt: Date | null
): number | null {
  if (fieldName === "ingested_at" && ingestedAt) {
    return (Date.now() - ingestedAt.getTime()) / 86_400_000;
  }
  if (!fieldDef) return null;
  const raw = resolveFieldValue(fieldName, fieldDef, data, enriched);
  if (raw == null) return null;
  const ts = raw instanceof Date ? raw : new Date(String(raw));
  if (Number.isNaN(ts.getTime())) return null;
  return (Date.now() - ts.getTime()) / 86_400_000;
}

async function buildDocSpaceSegments(
  def: CollectionDef,
  data: Record<string, unknown>,
  enriched: Record<string, unknown> | null,
  ingestedAt: Date | null,
  docEmbedding: number[] | null,
  embedService: EmbedService,
  textEmbedCache: Map<string, number[]>,
  imageEmbedCache: Map<string, number[]>,
  observability: Observability,
  groundImage?: GroundImageFn
): Promise<{ segments: Array<number[] | null>; dims: number[] }> {
  const keys = spaceKeys(def);
  const segments: Array<number[] | null> = [];
  const dims: number[] = [];
  const embKey = def.embeddings ? Object.keys(def.embeddings)[0] : null;
  const embDef = embKey ? def.embeddings![embKey]! : null;

  for (const name of keys) {
    const sdef = def.spaces![name]!;
    dims.push(spaceSegmentDim(sdef));
    if (sdef.kind === "text") {
      const reuseDoc =
        embDef &&
        sdef.source === embDef.source &&
        docEmbedding &&
        docEmbedding.length === sdef.dim;
      if (reuseDoc) {
        segments.push(encodeText(docEmbedding));
        continue;
      }
      let docText = resolveEmbedTemplate(sdef.source, data, enriched).trim();
      if (!docText) docText = String(data.title ?? "").trim();
      if (!docText) {
        segments.push(null);
        continue;
      }
      const cacheKey = `${sdef.model}|${sdef.dim}|${docText}`;
      let vec = textEmbedCache.get(cacheKey);
      if (!vec) {
        vec = await embedService.embedQuery({
          text: docText,
          model: sdef.model,
          dim: sdef.dim,
          taskType: sdef.taskType ?? "RETRIEVAL_DOCUMENT",
          inputType: "document",
        });
        vec = l2Renormalize(vec);
        textEmbedCache.set(cacheKey, vec);
      }
      segments.push(encodeText(vec));
      continue;
    }
    if (sdef.kind === "image") {
      const imageUrl = resolveEmbedTemplate(sdef.source, data, enriched).trim();
      if (!imageUrl) {
        segments.push(new Array(sdef.dim).fill(0));
        continue;
      }
      const cacheKey = `${sdef.model}|${sdef.dim}|img|${imageUrl}`;
      let vec = imageEmbedCache.get(cacheKey);
      if (!vec) {
        const fetched = await fetchRemoteImageSafe(imageUrl);
        if (!fetched.ok) {
          observability.log("warn", "embed-index", "image fetch failed — zero vector", {
            space: name,
            reason: fetched.reason,
            url: imageUrl.slice(0, 120),
          });
          segments.push(new Array(sdef.dim).fill(0));
          continue;
        }
        try {
          // Visual grounding: crop the salient product region before embedding (VL-CLIP-style).
          let imgBytes = fetched.bytes;
          let imgMime = fetched.contentType;
          let imgUrl: string | undefined = imageUrl;
          if (groundImage) {
            const grounded = await groundImage({ url: imageUrl, bytes: fetched.bytes, mimeType: fetched.contentType });
            if (grounded) {
              imgBytes = grounded.bytes;
              imgMime = grounded.mimeType;
              imgUrl = undefined;
            }
          }
          vec = await embedService.embedQuery({
            image: {
              url: imgUrl,
              bytes: imgBytes,
              mimeType: imgMime,
            },
            model: sdef.model,
            dim: sdef.dim,
            taskType: sdef.taskType ?? "RETRIEVAL_DOCUMENT",
            inputType: "document",
          });
          vec = l2Renormalize(vec);
          imageEmbedCache.set(cacheKey, vec);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes("s.image space")) throw e;
          observability.log("warn", "embed-index", "image embed failed — zero vector", {
            space: name,
            error: msg.slice(0, 200),
          });
          segments.push(new Array(sdef.dim).fill(0));
          continue;
        }
      }
      segments.push(encodeImage(vec));
      continue;
    }
    if (sdef.kind === "number") {
      const fieldDef = def.fields[sdef.field];
      const raw = fieldDef
        ? resolveFieldValue(sdef.field, fieldDef, data, enriched)
        : data[sdef.field];
      const num = raw == null ? null : Number(raw);
      segments.push(encodeNumber(num, sdef));
      continue;
    }
    if (sdef.kind === "recency") {
      const fieldDef = def.fields[sdef.field];
      segments.push(
        encodeRecency(recencyAgeDays(sdef.field, fieldDef, data, enriched, ingestedAt), sdef)
      );
      continue;
    }
    if (sdef.kind === "categorical") {
      const fieldDef = def.fields[sdef.field];
      const raw = fieldDef
        ? resolveFieldValue(sdef.field, fieldDef, data, enriched)
        : data[sdef.field];
      segments.push(encodeCategorical(raw == null ? null : String(raw), sdef));
      continue;
    }
    segments.push(null);
  }

  return { segments, dims };
}

export function makeEmbedIndexService(
  ctx: MatcherCtx,
  embedService: EmbedService,
  projectsService: ProjectsService
) {
  async function indexCollection(
    projectSlug: string,
    collectionName: string,
    opts?: { limit?: number }
  ): Promise<{ indexed: number }> {
    return ctx.jobs.run(
      `index:${projectSlug}:${collectionName}`,
      { projectSlug, collectionName, limit: opts?.limit },
      () => runIndexCollection(projectSlug, collectionName, opts)
    );
  }

  async function runIndexCollection(
    projectSlug: string,
    collectionName: string,
    opts?: { limit?: number }
  ): Promise<{ indexed: number }> {
    const project = await projectsService.getProject(projectSlug);
    if (!project) throw new Error(`project "${projectSlug}" not found`);
    const def = await projectsService.getCollectionDef(projectSlug, collectionName);
    if (!def) throw new Error(`collection "${collectionName}" not found in project "${projectSlug}"`);
    const hasEmb = !!def.embeddings && Object.keys(def.embeddings).length > 0;
    const hasSpace = hasSpaces(def);
    if (!hasEmb && !hasSpace) {
      throw new Error(
        `collection "${collectionName}" has no embeddings or spaces configured`
      );
    }

    const embKey = hasEmb ? Object.keys(def.embeddings!)[0]! : null;
    const embDef = embKey ? def.embeddings![embKey]! : null;
    const table = collectionTableName(project.schema_name, collectionName);
    const limit = opts?.limit ?? 100_000;
    const needsEnrich = hasEnrichPipeline(def);
    const usesIndexing = hasIndexing(def);

    const staleClause = usesIndexing
      ? "pipeline_status = 'ready' AND enriched_at IS NOT NULL AND (indexed_at IS NULL OR indexed_at < enriched_at)"
      : needsEnrich
        ? "enriched_at IS NOT NULL AND (indexed_at IS NULL OR indexed_at < enriched_at)"
        : "indexed_at IS NULL OR (enriched_at IS NOT NULL AND indexed_at < enriched_at)";
    const spaceBackfill = hasSpace ? " OR space_vec IS NULL" : "";

    const pending = await getPgClient(ctx.db, "embed-index").unsafe(
      `SELECT id, data, enriched, ingested_at, doc FROM ${table}
       WHERE (${staleClause}${spaceBackfill})
       ORDER BY id LIMIT $1`,
      [limit]
    );

    const fieldCols = Object.entries(def.fields);
    let indexed = 0;
    const textEmbedCache = new Map<string, number[]>();
    const imageEmbedCache = new Map<string, number[]>();

    async function markIndexSkipped(id: string): Promise<void> {
      await getPgClient(ctx.db, "embed-index").unsafe(
        `UPDATE ${table}
         SET indexed_at = now(), doc = NULL, embedding = NULL, updated_at = now()
         WHERE id = $1`,
        [id]
      );
    }

    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      const chunk = pending.slice(i, i + BATCH_SIZE);
      const docs: string[] = [];
      const rows: Array<{
        id: string;
        data: Record<string, unknown>;
        enriched: Record<string, unknown> | null;
        ingestedAt: Date | null;
      }> = [];

      for (const row of chunk) {
        const data =
          typeof row.data === "string"
            ? (JSON.parse(row.data as string) as Record<string, unknown>)
            : (row.data as Record<string, unknown>);
        const enrichedRaw = row.enriched;
        const enriched =
          enrichedRaw == null
            ? null
            : typeof enrichedRaw === "string"
              ? (JSON.parse(enrichedRaw as string) as Record<string, unknown>)
              : (enrichedRaw as Record<string, unknown>);
        const ingestedAt =
          row.ingested_at == null
            ? null
            : row.ingested_at instanceof Date
              ? row.ingested_at
              : new Date(String(row.ingested_at));

        const rowId = String(row.id);

        if (needsEnrich && enriched && !usesIndexing) {
          const isApparel = enriched.is_apparel_product ?? enriched.is_apparel;
          if (isApparel === false || enriched.category === "other") {
            await markIndexSkipped(rowId);
            continue;
          }
        }

        if (embDef) {
          let docText: string;
          if (usesIndexing) {
            docText = String(row.doc ?? "").trim();
          } else {
            docText = resolveEmbedTemplate(embDef.source ?? "", data, enriched).trim();
            if (!docText) docText = String(data.title ?? "").trim();
          }
          if (!docText) {
            ctx.observability.log("warn", "embed-index", "skipping doc — empty embedding document", {
              docId: rowId,
            });
            await markIndexSkipped(rowId);
            continue;
          }
          docs.push(docText);
        } else if (!hasSpace) {
          await markIndexSkipped(rowId);
          continue;
        }

        rows.push({
          id: rowId,
          data,
          enriched,
          ingestedAt,
        });
      }

      const vectors: number[][] = [];
      if (embDef) {
        for (const text of docs) {
          const vec = await embedService.embedQuery({
            text,
            model: embDef.model,
            dim: embDef.dim,
            taskType: embDef.taskType ?? "RETRIEVAL_DOCUMENT",
            inputType: "document",
          });
          vectors.push(l2Renormalize(vec));
        }
      }

      for (let j = 0; j < rows.length; j++) {
        const row = rows[j]!;
        const fieldValues = fieldCols.map(([name, fdef]) => {
          const v = resolveFieldValue(name, fdef, row.data, row.enriched);
          return v === undefined ? null : v;
        });
        const colNames: string[] = [];
        const params: unknown[] = [];

        if (embDef) {
          colNames.push("doc", "embedding");
          params.push(docs[j], toVectorLiteral(vectors[j]!));
        }

        if (hasSpace) {
          const docEmb = embDef ? vectors[j]! : null;
          const { segments, dims } = await buildDocSpaceSegments(
            def,
            row.data,
            row.enriched,
            row.ingestedAt,
            docEmb,
            embedService,
            textEmbedCache,
            imageEmbedCache,
            ctx.observability,
            ctx.groundImage
          );
          const spaceVec = assembleDocVector(segments, dims);
          colNames.push("space_vec");
          params.push(toVectorLiteral(spaceVec));
        }

        colNames.push(...fieldCols.map(([n]) => sanitiseIdent(n)));
        params.push(...fieldValues, row.id);
        const setClause = colNames.map((c, k) => `${c} = $${k + 1}`).join(", ");

        await getPgClient(ctx.db, "embed-index").unsafe(
          `UPDATE ${table}
           SET ${setClause}, indexed_at = now(), pipeline_status = 'ready', updated_at = now()
           WHERE id = $${params.length}`,
          params
        );
        ctx.observability.inc("index_docs_total");
        indexed++;
      }
    }

    if (indexed > 0) {
      searchResultCache.invalidateProjectCollection(projectSlug, collectionName);
    }

    return { indexed };
  }

  return { indexCollection, resolveEmbedTemplate, resolveFieldValue, l2Renormalize };
}

export type EmbedIndexService = ReturnType<typeof makeEmbedIndexService>;
