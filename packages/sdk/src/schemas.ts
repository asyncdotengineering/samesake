// Single source of truth for IO shapes that cross a boundary
// (HTTP response, queue payload, persisted JSON column).
//
// Pattern borrowed from trpc/orpc/zod: define each shape ONCE as a Zod schema,
// then derive the TypeScript type via `z.infer<typeof Schema>`. The schema
// doubles as a runtime validator, so we catch drift at the boundary (a server
// returns the wrong shape, a queued job arrives missing a field) instead of
// crashing several call frames later when an undefined field is dereferenced.
//
// Convention:
//   - SchemaName  = the Zod schema (use this to validate)
//   - Name        = z.infer<typeof SchemaName> (use this as a TS type)
//
// Internal helper types that never cross a boundary (e.g. a SQL row shape used
// only inside one module) stay as plain `type` declarations.
import { z } from "zod";

// ── Match: scoring channels + per-candidate components ──────────────────
export const MatchComponentsSchema = z.object({
  cosSim: z.number().nullable(),
  trgmSim: z.number(),
  phonEq: z.boolean(),
  phoneEq: z.boolean(),
  aliasHit: z.boolean(),
});
export type MatchComponents = z.infer<typeof MatchComponentsSchema>;

export const MatchCandidateSchema = z.object({
  entityId: z.string(),
  name: z.string(),
  combined: z.number(),
  rrfScore: z.number(),
  components: MatchComponentsSchema,
});
export type MatchCandidate = z.infer<typeof MatchCandidateSchema>;

export const ResolvedMatchSchema = z.object({
  entityId: z.string(),
  confidence: z.number(),
  source: z.literal("autolink"),
});
export type ResolvedMatch = z.infer<typeof ResolvedMatchSchema>;

export const MatchResultSchema = z.object({
  candidates: z.array(MatchCandidateSchema),
  queryTextNormalised: z.string(),
  resolved: ResolvedMatchSchema.optional(),
});
export type MatchResult = z.infer<typeof MatchResultSchema>;

// ── Calibration ─────────────────────────────────────────────────────────
export const CalibrationCurvePointSchema = z.object({
  threshold: z.number(),
  f1: z.number(),
  precision: z.number(),
  recall: z.number(),
});
export type CalibrationCurvePoint = z.infer<typeof CalibrationCurvePointSchema>;

export const CalibrateResultSchema = z.object({
  threshold: z.number(),
  f1: z.number(),
  precision: z.number(),
  recall: z.number(),
  sampleSize: z.number().int(),
  positives: z.number().int(),
  negatives: z.number().int(),
  curve: z.array(CalibrationCurvePointSchema),
});
export type CalibrateResult = z.infer<typeof CalibrateResultSchema>;
