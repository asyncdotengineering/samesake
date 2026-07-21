// definePreset — the sanctioned authoring entry point for a bespoke domain preset
// (grocery, media, jobs, any consumer vertical). Validates shape + arity at authoring time so a
// hand-authored preset is shape-compatible with the engine before it is ever handed to the
// enrichment runtime. It binds no model, executes no pipeline, computes no runtime artifact.
import type { EnrichPreset } from "./types.ts";

const REQUIRED_FNS = ["fields", "enrich", "indexing", "evalAttributes"] as const;

export function definePreset(spec: EnrichPreset): EnrichPreset {
  if (!spec || typeof spec !== "object") {
    throw new Error("definePreset: spec must be an EnrichPreset object");
  }
  if (typeof spec.name !== "string" || spec.name.trim().length === 0) {
    throw new Error('definePreset: "name" must be a non-empty string');
  }
  for (const member of REQUIRED_FNS) {
    if (typeof (spec as unknown as Record<string, unknown>)[member] !== "function") {
      throw new Error(`definePreset: "${member}" must be a function`);
    }
  }
  if (spec.dedup !== undefined && typeof spec.dedup !== "function") {
    throw new Error('definePreset: "dedup" must be a function when present');
  }
  if (spec.nlq !== undefined && (typeof spec.nlq !== "object" || spec.nlq === null)) {
    throw new Error('definePreset: "nlq" must be an object when present');
  }
  return spec;
}
