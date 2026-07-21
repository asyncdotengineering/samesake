export * from "./types.ts";
export {
  scoreEnrichment,
  type AttrKind,
  type AttrSpec,
  type GoldRow,
  type PredictedRow,
  type AttrMetrics,
  type ProductDiff,
  type EnrichEvalResult,
} from "./eval.ts";
export {
  deriveSurfaces,
  stageCacheKey,
  imageValidatorsForUrls,
  type IndexingPersistResult,
} from "./surfaces.ts";
export { enrich, enrichRow } from "./enrich.ts";
export { contentHash, selectDirty } from "./dirty.ts";
export { scoreCandidate, scoreBest } from "./dedup-score.ts";
export { clusterBatch } from "./cluster.ts";
