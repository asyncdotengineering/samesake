// Enrichment-accuracy evaluation service — the enrichment twin of evaluateSearch (calibrate-search.ts).
//
// The pure scoring core (scoreEnrichment + its types/helpers) now lives in @samesake/enrich
// (packages/enrich/src/eval.ts) so it is unit-testable without dragging the server runtime.
// This module keeps only the DB-fetching service wrapper: it reads `enriched` rows from
// Postgres and hands them to the pure scorer. The scorer and its types are re-exported here so
// existing @samesake/server importers keep resolving through this file unchanged.
import type { MatcherCtx } from "../types.ts";
import type { ProjectsService } from "./projects.ts";
import { collectionTableName } from "./db-utils.ts";
import { scoreEnrichment } from "@samesake/enrich";
import type {
  AttrKind,
  AttrSpec,
  GoldRow,
  PredictedRow,
  AttrMetrics,
  ProductDiff,
  EnrichEvalResult,
} from "@samesake/enrich";

export { scoreEnrichment };
export type {
  AttrKind,
  AttrSpec,
  GoldRow,
  PredictedRow,
  AttrMetrics,
  ProductDiff,
  EnrichEvalResult,
} from "@samesake/enrich";

export interface EvaluateEnrichInput {
  gold: GoldRow[];
  attributes: AttrSpec[];
}

/**
 * Service wrapper: reads the pipeline's `enriched` output for the gold ids straight from the
 * collection table and scores it. The first-class, on-matcher home for the enrichment loop —
 * mirrors evaluateSearch. Reproduces the pure scorer's numbers against live data.
 */
export function makeEvaluateEnrichService(ctx: MatcherCtx, projectsService: ProjectsService) {
  async function evaluateEnrichment(
    projectSlug: string,
    collectionName: string,
    input: EvaluateEnrichInput
  ): Promise<EnrichEvalResult> {
    const project = await projectsService.getProject(projectSlug);
    if (!project) throw new Error(`project "${projectSlug}" not found`);
    if (!input.gold.length) throw new Error("evaluateEnrichment requires a non-empty gold set");

    const table = collectionTableName(project.schema_name, collectionName);
    const ids = input.gold.map((g) => g.id);
    const rows = await ctx.storage.client("eval").unsafe(
      `SELECT id, enriched, pipeline_status, gate_reason FROM ${table} WHERE id = ANY($1)`,
      [ids]
    );

    const predicted: PredictedRow[] = rows.map((r) => {
      const raw = (r as Record<string, unknown>).enriched;
      const enriched =
        typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : (raw as Record<string, unknown> | null);
      return {
        id: String((r as Record<string, unknown>).id),
        enriched: enriched ?? null,
        pipeline_status: (r as Record<string, unknown>).pipeline_status as string | null,
        gate_reason: (r as Record<string, unknown>).gate_reason as string | null,
      };
    });

    return scoreEnrichment(input.gold, predicted, input.attributes);
  }

  return { evaluateEnrichment };
}

export type EvaluateEnrichService = ReturnType<typeof makeEvaluateEnrichService>;
