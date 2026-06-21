// Enrichment QA review loop (research F2 step 4 / Pixyle correction pattern):
// list low-confidence extractions, apply human corrections, feed corrections
// back into future enrichment prompts as few-shot guidance.
import { desc, eq, and } from "drizzle-orm";
import type { MatcherCtx } from "../types.ts";
import type { ProjectsService } from "./projects.ts";
import { searchResultCache } from "./search-cache.ts";
import { collectionTableName, getPgClient } from "./db-utils.ts";

export interface ReviewRow {
  id: string;
  title: string | null;
  category: string | null;
  confidence: number | null;
  uncertain_fields: string[];
  corrected: boolean;
}

export function makeReviewService(ctx: MatcherCtx, projectsService: ProjectsService) {
  const corrections = ctx.systemTables.samesakeCorrections;

  async function reviewList(
    projectSlug: string,
    collectionName: string,
    opts?: { limit?: number; maxConfidence?: number }
  ): Promise<ReviewRow[]> {
    const project = await projectsService.getProject(projectSlug);
    if (!project) throw new Error(`project "${projectSlug}" not found`);
    const limit = Math.min(opts?.limit ?? 20, 200);
    const maxConf = opts?.maxConfidence ?? 0.7;
    const rows = await ctx.storage.client("review").unsafe(
      `SELECT id, data->>'title' AS title, enriched->>'category' AS category,
              (enriched->>'confidence')::float AS confidence,
              coalesce(enriched->'uncertain_fields', '[]'::jsonb) AS uncertain_fields,
              (enriched ? '_corrected') AS corrected
       FROM ${collectionTableName(project.schema_name, collectionName)}
       WHERE enriched IS NOT NULL
         AND ((enriched->>'confidence')::float < $1
              OR jsonb_array_length(coalesce(enriched->'uncertain_fields', '[]'::jsonb)) > 0)
       ORDER BY (enriched->>'confidence')::float ASC NULLS LAST
       LIMIT $2`,
      [maxConf, limit]
    );
    return rows.map((r) => ({
      id: String(r.id),
      title: (r.title as string) ?? null,
      category: (r.category as string) ?? null,
      confidence: r.confidence == null ? null : Number(r.confidence),
      uncertain_fields: Array.isArray(r.uncertain_fields) ? (r.uncertain_fields as string[]) : [],
      corrected: r.corrected === true,
    }));
  }

  /**
   * Apply human corrections to a document's enrichment. Values merge into the
   * `enriched` jsonb, each correction is recorded for few-shot reuse, and
   * indexed_at is cleared so the next index run refreshes doc/columns/vector.
   */
  async function reviewCorrect(
    projectSlug: string,
    collectionName: string,
    docId: string,
    fields: Record<string, unknown>
  ): Promise<{ corrected: string[] }> {
    const project = await projectsService.getProject(projectSlug);
    if (!project) throw new Error(`project "${projectSlug}" not found`);
    if (!Object.keys(fields).length) throw new Error("no corrections supplied");
    const t = collectionTableName(project.schema_name, collectionName);
    const rows = await ctx.storage.client("review").unsafe(
      `SELECT data->>'title' AS title, enriched FROM ${t} WHERE id = $1`,
      [docId]
    );
    if (!rows.length) throw new Error(`document "${docId}" not found in ${collectionName}`);
    const enriched = (typeof rows[0].enriched === "string" ? JSON.parse(rows[0].enriched as string) : rows[0].enriched) as Record<string, unknown> | null;
    const title = (rows[0].title as string) ?? null;

    for (const [field, value] of Object.entries(fields)) {
      await ctx.storage.db.insert(corrections).values({
        project: projectSlug,
        collection: collectionName,
        docId,
        field,
        oldValue: enriched?.[field] ?? null,
        newValue: value as object,
        docTitle: title,
      });
    }

    await ctx.storage.client("review").unsafe(
      `UPDATE ${t}
       SET enriched = coalesce(enriched, '{}'::jsonb) || $1::jsonb || '{"_corrected": true}'::jsonb,
           indexed_at = NULL,
           updated_at = now()
       WHERE id = $2`,
      [JSON.stringify(fields), docId]
    );
    searchResultCache.invalidateProjectCollection(projectSlug, collectionName);
    return { corrected: Object.keys(fields) };
  }

  /** Few-shot guidance lines from recent corrections (used by enrich-pipeline). */
  async function correctionExamples(
    projectSlug: string,
    collectionName: string,
    limit = 3
  ): Promise<string[]> {
    const rows = await ctx.storage.db
      .select({
        field: corrections.field,
        oldValue: corrections.oldValue,
        newValue: corrections.newValue,
        docTitle: corrections.docTitle,
      })
      .from(corrections)
      .where(and(eq(corrections.project, projectSlug), eq(corrections.collection, collectionName)))
      .orderBy(desc(corrections.createdAt))
      .limit(limit);
    return rows.map(
      (r) =>
        `- For a product like "${r.docTitle ?? "unknown"}": ${r.field} was wrongly ${JSON.stringify(r.oldValue)}; the correct value is ${JSON.stringify(r.newValue)}.`
    );
  }

  return { reviewList, reviewCorrect, correctionExamples };
}

export type ReviewService = ReturnType<typeof makeReviewService>;
