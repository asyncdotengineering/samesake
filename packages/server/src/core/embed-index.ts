import type { CollectionDef, CollectionFieldDef, DerivedDocContext, PipelineDef } from "@samesake/core";
import type { MatcherCtx } from "../types.ts";
import type { EmbedService } from "./embed.ts";
import { toVectorLiteral } from "./embed.ts";
import { sql } from "drizzle-orm";
import type { ProjectsService } from "./projects.ts";
import { sanitiseIdent } from "./schema-gen.ts";
import { fetchRemoteImageSafe } from "./fetch-image.ts";
import { searchResultCache } from "./search-cache.ts";
import { collectionTableName, getByPath } from "./db-utils.ts";
import {
  assertErrorRateWithinLimit,
  recordPipelineFailure,
  type ErrorRateOpts,
} from "./pipeline-failure.ts";
import { persistIndexingSurfaces } from "./enrich-pipeline.ts";
import { embeddingColumn, embeddingEntries, evidenceEntries, evidenceTable, EVIDENCE_MAX_ROWS } from "./aspects.ts";

const BATCH_SIZE = 24;

export class ImagePipelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImagePipelineError";
  }
}

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

/**
 * Indexing surfaces for collections with no enrich pipeline: the embedded doc
 * comes from the embedding's `source` template (fallback: searchable fields),
 * and the lexical surfaces from `searchable` text fields (ftsWeight "A" →
 * fts_src_a, else fts_src). Collections WITH an enrich pipeline build these in
 * persistIndexingSurfaces instead.
 */
export function composeDefaultSurfaces(
  def: CollectionDef,
  embSource: string | undefined,
  data: Record<string, unknown>,
  enriched: Record<string, unknown> | null
): { doc: string; ftsSrc: string | null; ftsSrcA: string | null } {
  const byWeight: Record<"A" | "B", string[]> = { A: [], B: [] };
  for (const [name, fdef] of Object.entries(def.fields)) {
    if (fdef.type !== "text" || !fdef.searchable) continue;
    const text = formatTemplateValue(resolveFieldValue(name, fdef, data, enriched)).trim();
    if (!text) continue;
    byWeight[fdef.ftsWeight === "A" ? "A" : "B"].push(text);
  }
  const searchable = [...byWeight.A, ...byWeight.B].join(" ").trim();
  const doc =
    (embSource ? resolveEmbedTemplate(embSource, data, enriched) : "").trim() || searchable;
  return {
    doc,
    ftsSrc: byWeight.B.length ? byWeight.B.join(" ") : null,
    ftsSrcA: byWeight.A.length ? byWeight.A.join(" ") : null,
  };
}

function embeddingText(
  name: string,
  source: string | undefined,
  fallbackDoc: string,
  data: Record<string, unknown>,
  enriched: Record<string, unknown> | null
): string {
  return (source ? resolveEmbedTemplate(source, data, enriched) : fallbackDoc).trim();
}

async function embedDocumentValue(
  embedding: NonNullable<CollectionDef["embeddings"]>[string],
  value: string,
  embedService: EmbedService,
  groundImage?: MatcherCtx["groundImage"]
): Promise<number[]> {
  if (embedding.kind !== "image") {
    return l2Renormalize(await embedService.embedQuery({
      text: value,
      model: embedding.model,
      dim: embedding.dim,
      taskType: embedding.taskType ?? "RETRIEVAL_DOCUMENT",
      inputType: "document",
    }));
  }
  const fetched = await fetchRemoteImageSafe(value);
  if (!fetched.ok) throw new ImagePipelineError(`image fetch failed: ${fetched.reason}`);
  let bytes = fetched.bytes;
  let mimeType = fetched.contentType;
  let url: string | undefined = value;
  if (groundImage) {
    const grounded = await groundImage({ url, bytes, mimeType });
    if (grounded) {
      bytes = grounded.bytes;
      mimeType = grounded.mimeType;
      url = undefined;
    }
  }
  return l2Renormalize(await embedService.embedQuery({
    image: { url, bytes, mimeType },
    model: embedding.model,
    dim: embedding.dim,
    taskType: embedding.taskType ?? "RETRIEVAL_DOCUMENT",
    inputType: "document",
  }));
}

async function embedEvidenceValue(
  embedding: NonNullable<CollectionDef["embeddings"]>[string],
  value: string,
  embedService: EmbedService,
  groundImage?: MatcherCtx["groundImage"]
): Promise<number[]> {
  return embedDocumentValue(embedding, value, embedService, groundImage);
}

async function replaceEvidenceRows(
  ctx: MatcherCtx,
  schema: string,
  collectionName: string,
  docId: string,
  scope: Record<string, string>,
  data: Record<string, unknown>,
  enriched: Record<string, unknown> | null,
  def: CollectionDef,
  embedService: EmbedService
): Promise<void> {
  const evidence = embeddingEntries(def).filter(([, embedding]) => embedding.evidence === true);
  if (!evidence.length) return;
  const table = evidenceTable(schema, collectionName);
  const scopeCols = Object.keys(scope);
  const pending: Array<{ aspect: string; ord: number; src: string; vec: string }> = [];
  for (const [aspect, embedding] of evidence) {
    const units = embedding.extract!({ data, enriched: enriched ?? {} } satisfies DerivedDocContext);
    if (units.length > EVIDENCE_MAX_ROWS) {
      ctx.observability.log("warn", "embed-index", "evidence rows truncated", {
        docId,
        aspect,
        cap: EVIDENCE_MAX_ROWS,
      });
    }
    for (const [ord, raw] of units.slice(0, EVIDENCE_MAX_ROWS).entries()) {
      const src = String(raw ?? "").trim();
      if (!src) continue;
      const vec = await embedEvidenceValue(embedding, src, embedService, ctx.groundImage);
      pending.push({ aspect, ord, src, vec: toVectorLiteral(vec) });
    }
  }

  await ctx.storage.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM ${sql.raw(table)} WHERE doc_id = ${docId}`);
    const columns = [...scopeCols, "doc_id", "aspect", "ord", "vec", "src"];
    for (const row of pending) {
      const values: unknown[] = [
        ...scopeCols.map((column) => scope[column]),
        docId,
        row.aspect,
        row.ord,
        row.vec,
        row.src,
      ];
      await tx.execute(
        sql`INSERT INTO ${sql.raw(table)} (${sql.join(columns.map((column) => sql.identifier(column)), sql`, `)})
            VALUES (${sql.join(values.map((value) => sql`${value}`), sql`, `)})`
      );
    }
  });
}

export function makeEmbedIndexService(
  ctx: MatcherCtx,
  embedService: EmbedService,
  projectsService: ProjectsService
) {
  async function indexCollection(
    projectSlug: string,
    collectionName: string,
    opts?: { limit?: number } & ErrorRateOpts
  ): Promise<{ indexed: number }> {
    return runIndexCollection(projectSlug, collectionName, opts);
  }

  async function runIndexCollection(
    projectSlug: string,
    collectionName: string,
    opts?: { limit?: number } & ErrorRateOpts
  ): Promise<{ indexed: number }> {
    const project = await projectsService.getProject(projectSlug);
    if (!project) throw new Error(`project "${projectSlug}" not found`);
    const projectSchema = project.schema_name;
    const def = await projectsService.getCollectionDef(projectSlug, collectionName);
    if (!def) throw new Error(`collection "${collectionName}" not found in project "${projectSlug}"`);
    const embEntries = embeddingEntries(def);
    const hasEmb = embEntries.length > 0;
    if (!hasEmb) throw new Error(`collection "${collectionName}" has no embeddings configured`);
    const table = collectionTableName(project.schema_name, collectionName);
    const limit = opts?.limit ?? 100_000;
    const needsEnrich = hasEnrichPipeline(def);
    const staleClause = needsEnrich
      ? "pipeline_status = 'ready' AND enriched_at IS NOT NULL AND (indexed_at IS NULL OR indexed_at < enriched_at)"
      : "indexed_at IS NULL OR (enriched_at IS NOT NULL AND indexed_at < enriched_at)";

    const scopeKeys = (def.scopes ?? []).map((key) => `scope_${key}`);
    const hasEvidence = evidenceEntries(def).length > 0;
    const selectScopeCols = scopeKeys.length ? `, ${scopeKeys.join(", ")}` : "";

    const pending = await ctx.storage.client("embed-index").unsafe(
      `SELECT id, data, enriched, ingested_at, doc${selectScopeCols} FROM ${table}
       WHERE (${staleClause})
       ORDER BY id LIMIT $1`,
      [limit]
    );

    const fieldCols = Object.entries(def.fields);
    let indexed = 0;
    async function markIndexSkipped(id: string): Promise<void> {
      const nullColumns = embEntries
        .map(([name, embedding], index) => index === 0 || embedding.evidence ? null : `${embeddingColumn(name, index)} = NULL`)
        .filter((value): value is string => value !== null);
      const setParts = ["indexed_at = now()", "doc = NULL", "embedding = NULL", ...nullColumns];
      await ctx.storage.client("embed-index").unsafe(
        `UPDATE ${table}
         SET ${setParts.join(", ")}, updated_at = now()
         WHERE id = $1`,
        [id]
      );
      if (hasEvidence) {
        await ctx.storage.client("embed-index").unsafe(
          `DELETE FROM ${evidenceTable(projectSchema, collectionName)} WHERE doc_id = $1`,
          [id]
        );
      }
    }

    let processed = 0;
    let failed = 0;
    const errorRateOpts: ErrorRateOpts = {
      maxErrorRate: opts?.maxErrorRate,
      minSamples: opts?.minSamples,
    };

    function onRowFailure(error: unknown): void {
      processed++;
      failed++;
      assertErrorRateWithinLimit(processed, failed, errorRateOpts);
    }

    console.log(`[timing] pending=${pending.length} batchSize=${BATCH_SIZE}`);
    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      console.log(`[timing] chunk offset=${i}`);
      const chunk = pending.slice(i, i + BATCH_SIZE);
      const rows: Array<{
        id: string;
        doc: string;
        data: Record<string, unknown>;
        enriched: Record<string, unknown> | null;
        surfaces: { ftsSrc: string | null; ftsSrcA: string | null } | null;
        denseSurfaces: Record<string, string>;
        scope: Record<string, string>;
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
        const rowId = String(row.id);

        // Enrich-owning collections read the surfaces enrich persisted. Without
        // an enrich pipeline, build declared indexing surfaces inline, or fall
        // back to source-template/searchable-field defaults — so plain
        // push → index → search works alone.
        let inline: { doc: string | null; ftsSrc: string | null; ftsSrcA: string | null } | null =
          null;
        let denseSurfaces: Record<string, string> = {};
        if (!needsEnrich) {
          if (def.indexing) {
            const built = persistIndexingSurfaces(def.indexing, { data, enriched: enriched ?? {} });
            if (built.pipeline_status === "quarantined") {
              await markIndexSkipped(rowId);
              continue;
            }
            inline = { doc: built.doc, ftsSrc: built.fts_src, ftsSrcA: built.fts_src_a };
            denseSurfaces = built.denseByEmbedding;
          } else {
            const d = composeDefaultSurfaces(def, embEntries[0]?.[1].source, data, enriched);
            inline = { doc: d.doc, ftsSrc: d.ftsSrc, ftsSrcA: d.ftsSrcA };
            denseSurfaces = {};
          }
        }

          const needsTextDocument = embEntries.some(
            ([, embedding]) => embedding.evidence !== true && embedding.kind !== "image"
          );
          if (needsTextDocument) {
            const docText = needsEnrich
              ? String(row.doc ?? "").trim()
              : (inline!.doc ?? "").trim();
            if (!docText) {
              ctx.observability.log("warn", "embed-index", "skipping doc — empty embedding document", {
                docId: rowId,
              });
              await markIndexSkipped(rowId);
              continue;
            }
          }

          rows.push({
          id: rowId,
          doc: needsEnrich ? String(row.doc ?? "").trim() : (inline?.doc ?? "").trim(),
          data,
          enriched,
          surfaces: inline ? { ftsSrc: inline.ftsSrc, ftsSrcA: inline.ftsSrcA } : null,
          denseSurfaces,
          scope: Object.fromEntries(scopeKeys.map((key) => [key, String(row[key] ?? "")])),
        });
      }

      // Bounded per-doc concurrency: a doc's indexing is ~1 visual + ~10 evidence embed calls,
      // all row-scoped — serial processing makes backfill wall-clock scale with API latency.
      const processRow = async (row: (typeof rows)[number]) => {
        console.log(`[timing] start doc=${row.id}`);
        const tRow = Date.now();
        let tEmbeds = 0;
        let tEvidence = 0;
        try {
          const fieldValues = fieldCols.map(([name, fdef]) => {
            const v = resolveFieldValue(name, fdef, row.data, row.enriched);
            return v === undefined ? null : v;
          });
          const colNames: string[] = [];
          const params: unknown[] = [];

          const vectors = new Map<string, number[]>();
          for (const [index, [name, embedding]] of embEntries.entries()) {
            if (embedding.evidence === true) continue;
            const value = embeddingText(
              name,
              row.denseSurfaces[name] ? undefined : embedding.source,
              row.denseSurfaces[name] ?? row.doc,
              row.data,
              row.enriched
            );
            if (!value) throw new ImagePipelineError(`embedding source is empty for aspect "${name}"`);
            const tE = Date.now();
            vectors.set(name, await embedDocumentValue(embedding, value, embedService, ctx.groundImage));
            tEmbeds += Date.now() - tE;
            if (index === 0) {
              colNames.push("doc", embeddingColumn(name, index));
              params.push(value, toVectorLiteral(vectors.get(name)!));
            } else {
              colNames.push(embeddingColumn(name, index));
              params.push(toVectorLiteral(vectors.get(name)!));
            }
          }

          if (row.surfaces) {
            colNames.push("fts_src", "fts_src_a");
            params.push(row.surfaces.ftsSrc, row.surfaces.ftsSrcA);
          }

          colNames.push(...fieldCols.map(([n]) => sanitiseIdent(n)));
          params.push(...fieldValues, row.id);
          const setClause = colNames.map((c, k) => `${c} = $${k + 1}`).join(", ");

          await ctx.storage.client("embed-index").unsafe(
            `UPDATE ${table}
             SET ${setClause}, indexed_at = now(), pipeline_status = 'ready', last_error = NULL, updated_at = now()
             WHERE id = $${params.length}`,
            params
          );
          const tEv = Date.now();
          await replaceEvidenceRows(ctx, project.schema_name, collectionName, row.id, row.scope, row.data, row.enriched, def, embedService);
          tEvidence = Date.now() - tEv;
          ctx.observability.inc("index_docs_total");
          indexed++;
          processed++;
          // Temporary C9-backfill instrumentation: per-doc phase timing (remove after gate).
          console.log(`[timing] doc=${row.id} total=${Date.now() - tRow}ms embeds=${tEmbeds}ms evidence=${tEvidence}ms`);
        } catch (e) {
          if (e instanceof ImagePipelineError) {
            await recordPipelineFailure(ctx, table, row.id, e);
            onRowFailure(e);
            return;
          }
          throw e;
        }
      };
      // Env-tunable for backfills; default is conservative for unknown embed-API tiers.
      const INDEX_CONCURRENCY = Math.max(1, Number(process.env.SAMESAKE_INDEX_CONCURRENCY ?? 8));
      // Per-doc watchdog: vendor catalogs are arbitrary input, and a single doc that wedges
      // (hung stream, pathological payload) must become a recorded pipeline failure, not a
      // stuck indexer. The stuck task is orphaned, not cancelled — acceptable: the pool moves
      // on and the row is marked for retry/inspection.
      const ROW_TIMEOUT_MS = Math.max(30_000, Number(process.env.SAMESAKE_INDEX_ROW_TIMEOUT_MS ?? 120_000));
      const processRowSafe = async (row: (typeof rows)[number]) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<"timeout">((resolveTimeout) => {
          timer = setTimeout(() => resolveTimeout("timeout"), ROW_TIMEOUT_MS);
        });
        const outcome = await Promise.race([processRow(row).then(() => "done" as const), timeout]);
        clearTimeout(timer);
        if (outcome === "timeout") {
          const err = new ImagePipelineError(`indexing timed out after ${ROW_TIMEOUT_MS}ms`);
          await recordPipelineFailure(ctx, table, row.id, err);
          onRowFailure(err);
        }
      };
      // Rolling pool (no chunk barrier): one slow doc must not idle the other workers.
      let cursor = 0;
      await Promise.all(
        Array.from({ length: Math.min(INDEX_CONCURRENCY, rows.length) }, async () => {
          while (cursor < rows.length) {
            const next = rows[cursor++]!;
            await processRowSafe(next);
          }
        })
      );
    }

    if (indexed > 0) {
      searchResultCache.invalidateProjectCollection(projectSlug, collectionName);
    }

    return { indexed };
  }

  async function indexOne(
    projectSlug: string,
    collectionName: string,
    rowId: string
  ): Promise<boolean> {
    const project = await projectsService.getProject(projectSlug);
    if (!project) throw new Error(`project "${projectSlug}" not found`);
    const def = await projectsService.getCollectionDef(projectSlug, collectionName);
    if (!def) throw new Error(`collection "${collectionName}" not found in project "${projectSlug}"`);
    const embEntries = embeddingEntries(def);
    if (!embEntries.length) return false;
    const table = collectionTableName(project.schema_name, collectionName);
    const fieldCols = Object.entries(def.fields);
    const scopeKeys = (def.scopes ?? []).map((key) => `scope_${key}`);

    const rows = await ctx.storage.client("embed-index").unsafe(
      `SELECT id, data, enriched, ingested_at, doc${scopeKeys.length ? `, ${scopeKeys.join(", ")}` : ""} FROM ${table} WHERE id = $1`,
      [rowId]
    );
    if (!rows.length) return false;

    const row = rows[0]!;
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
    const needsEnrich = hasEnrichPipeline(def);
    let defaultSurfaces: { doc: string | null; ftsSrc: string | null; ftsSrcA: string | null } | null =
      null;
    let denseSurfaces: Record<string, string> = {};
    if (!needsEnrich) {
      if (def.indexing) {
        const built = persistIndexingSurfaces(def.indexing, { data, enriched: enriched ?? {} });
        if (built.pipeline_status === "quarantined") return false;
        defaultSurfaces = { doc: built.doc, ftsSrc: built.fts_src, ftsSrcA: built.fts_src_a };
        denseSurfaces = built.denseByEmbedding;
      } else {
        const d = composeDefaultSurfaces(def, embEntries[0]?.[1].source, data, enriched);
        defaultSurfaces = { doc: d.doc, ftsSrc: d.ftsSrc, ftsSrcA: d.ftsSrcA };
      }
    }

    const firstValue = (needsEnrich ? String(row.doc ?? "") : (defaultSurfaces?.doc ?? "")).trim();
    if (!firstValue) return false;
    const colNames: string[] = [];
    const params: unknown[] = [];
    for (const [index, [name, embedding]] of embEntries.entries()) {
      if (embedding.evidence === true) continue;
      const value = index === 0
        ? firstValue
        : embeddingText(name, denseSurfaces[name] ? undefined : embedding.source, denseSurfaces[name] ?? firstValue, data, enriched);
      if (!value) return false;
      const vec = await embedDocumentValue(embedding, value, embedService, ctx.groundImage);
      if (index === 0) {
        colNames.push("doc", embeddingColumn(name, index));
        params.push(value, toVectorLiteral(vec));
      } else {
        colNames.push(embeddingColumn(name, index));
        params.push(toVectorLiteral(vec));
      }
    }
    if (defaultSurfaces) {
      colNames.push("fts_src", "fts_src_a");
      params.push(defaultSurfaces.ftsSrc, defaultSurfaces.ftsSrcA);
    }
    const fieldValues = fieldCols.map(([name, fdef]) => {
      const v = resolveFieldValue(name, fdef, data, enriched);
      return v === undefined ? null : v;
    });
    colNames.push(...fieldCols.map(([n]) => sanitiseIdent(n)));
    params.push(...fieldValues, String(row.id));
    const setClause = colNames.map((c, k) => `${c} = $${k + 1}`).join(", ");
    await ctx.storage.client("embed-index").unsafe(
      `UPDATE ${table}
       SET ${setClause}, indexed_at = now(), pipeline_status = 'ready', last_error = NULL, updated_at = now()
       WHERE id = $${params.length}`,
      params
    );
    await replaceEvidenceRows(
      ctx,
      project.schema_name,
      collectionName,
      String(row.id),
      Object.fromEntries(scopeKeys.map((key) => [key, String(row[key] ?? "")])),
      data,
      enriched,
      def,
      embedService
    );

    ctx.observability.inc("index_docs_total");
    searchResultCache.invalidateProjectCollection(projectSlug, collectionName);
    return true;
  }

  return { indexCollection, indexOne, resolveEmbedTemplate, resolveFieldValue, l2Renormalize };
}

export type EmbedIndexService = ReturnType<typeof makeEmbedIndexService>;
