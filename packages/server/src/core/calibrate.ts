// F1 threshold calibration. Reads historic decisions, grid-searches the
// auto-link threshold, persists the F1-maximising threshold per scope.
import { eq, and, inArray, sql } from "drizzle-orm";
import {
  CalibrateResultSchema,
  type CalibrateResult,
  type CalibrationCurvePoint,
} from "@samesake/core/schemas";
import type { MatcherCtx } from "../types.ts";
import type { SchemaGen } from "./schema-gen.ts";
import { sanitiseIdent } from "./schema-gen.ts";
import { perProjectTables } from "../db/schema/per-project.ts";

export interface CalibrateInput {
  project: string;
  kind: string;
  scope: Record<string, string>;
  minSampleSize?: number;
}

export function makeCalibrateService(ctx: MatcherCtx, schemaGen: SchemaGen) {
  const db = ctx.storage.db;

  return {
    async runCalibrate(input: CalibrateInput): Promise<CalibrateResult> {
      const schema = schemaGen.projectSchemaName(input.project);
      const kind = sanitiseIdent(input.kind);
      const minSample = input.minSampleSize ?? 10;
      const t = perProjectTables(schema);

      const rows = await db
        .select({
          combinedScore: t.matchCandidate.combinedScore,
          outcome: t.matchCandidate.outcome,
        })
        .from(t.matchCandidate)
        .where(
          and(
            eq(t.matchCandidate.queryKind, kind),
            sql`${t.matchCandidate.scopeJson} = ${JSON.stringify(input.scope)}::jsonb`,
            inArray(t.matchCandidate.outcome, ["accepted", "declined", "ignored"])
          )
        );

      const positives = rows
        .filter((r) => r.outcome === "accepted")
        .map((r) => Number(r.combinedScore));
      const negatives = rows
        .filter((r) => r.outcome === "declined" || r.outcome === "ignored")
        .map((r) => Number(r.combinedScore));

      if (positives.length + negatives.length < minSample) {
        throw new Error(
          `not enough labelled decisions to calibrate (${positives.length + negatives.length} < ${minSample})`
        );
      }
      if (positives.length === 0) {
        throw new Error("no accepted decisions — cannot calibrate without true positives");
      }

      const curve: CalibrationCurvePoint[] = [];
      let best: CalibrationCurvePoint = { threshold: 0.92, f1: -1, precision: 0, recall: 0 };

      for (let th = 0.5; th <= 0.99 + 1e-9; th += 0.01) {
        const tRound = Math.round(th * 100) / 100;
        const tp = positives.filter((s) => s >= tRound).length;
        const fp = negatives.filter((s) => s >= tRound).length;
        const fn = positives.filter((s) => s < tRound).length;
        const prec = tp + fp === 0 ? 0 : tp / (tp + fp);
        const rec = tp + fn === 0 ? 0 : tp / (tp + fn);
        const f1 = prec + rec === 0 ? 0 : (2 * prec * rec) / (prec + rec);
        curve.push({ threshold: tRound, f1, precision: prec, recall: rec });
        if (f1 > best.f1) {
          best = { threshold: tRound, f1, precision: prec, recall: rec };
        }
      }

      const sampleSize = positives.length + negatives.length;
      await db
        .insert(t.scopeThresholds)
        .values({
          scopeJson: input.scope,
          entityKind: kind,
          autoLinkThreshold: best.threshold,
          suggestThreshold: 0.55,
          f1AtThreshold: best.f1,
          precisionAt: best.precision,
          recallAt: best.recall,
          sampleSize,
        })
        .onConflictDoUpdate({
          target: [t.scopeThresholds.scopeJson, t.scopeThresholds.entityKind],
          set: {
            autoLinkThreshold: best.threshold,
            f1AtThreshold: best.f1,
            precisionAt: best.precision,
            recallAt: best.recall,
            sampleSize,
            calibratedAt: sql`now()`,
          },
        });

      return CalibrateResultSchema.parse({
        threshold: best.threshold,
        f1: best.f1,
        precision: best.precision,
        recall: best.recall,
        sampleSize,
        positives: positives.length,
        negatives: negatives.length,
        curve,
      });
    },
  };
}

export type CalibrateService = ReturnType<typeof makeCalibrateService>;
