// @samesake/query — the store-agnostic search query brain. Ports + plan
// contract plus the pure brain leaves: the SearchHit result type, the filter
// AST + normaliser, result cutoff, ranking policy, the constraint-trace
// builder, and the query-understanding brain (nlq parsing + aspect/image
// planning). Impure seams are injected as deps (see ./deps.ts); depends only
// on @samesake/core.
export type { Retriever, VocabProvider } from "./ports.ts";
export type { RetrievalPlan, RankedRow } from "./plan.ts";
export { normalizeFiltersToConstraintPredicates } from "./filters.ts";
export type { FilterOperator, FilterClause, SearchFilters } from "./filters.ts";
export type { SearchHit } from "./types.ts";
export { applyCutoff } from "./cutoff.ts";
export type { CutoffEvidence } from "./cutoff.ts";
export { applyRankingPolicy } from "./ranking.ts";
export type { RankingApplyContext, RankingFactorValue } from "./ranking.ts";
export { buildConstraintTrace } from "./constraint-trace.ts";

// ── NLQ + aspect-planning brain (Q3b) ─────────────────────────────────────
// Grounded query understanding + aspect/weight planner. The impure seams
// (generate / stage cache / embed / image fetch / vocab grounding) are injected
// as deps; @samesake/server builds them from its MatcherCtx.

// Pure def introspection + vocabulary-grounding types (single source for the
// brain and for @samesake/server's DB-bound vocab lookup/grounding).
export { embeddingEntries } from "./aspects.ts";
export {
  openVocabFieldNames,
  type VocabCandidates,
  type VocabLookup,
  type GroundedValueDecision,
} from "./vocab.ts";

// Injected-dependency seams (concrete impls live in @samesake/server).
export type {
  NlqStageCache,
  QueryFetchImage,
  QueryFetchImageResult,
  EmbedService,
  GroundVocabFn,
  ParseNlqDeps,
} from "./deps.ts";

// Natural-language query understanding (grounded parse → filters).
export {
  parseNlq,
  shouldSkipNlq,
  mergeFilters,
  nlqParsedToFilters,
  deriveEnumTokenFilters,
  deriveNlqSchema,
  aspectsSchemaFragment,
  dropUncorroboratedHardEnumFilters,
  mergeDeterministicSoftFilters,
  guardLexicalQuery,
  nlqCacheKey,
  type NlqParsed,
  type NlqParseResult,
  type ParseNlqOptions,
} from "./nlq.ts";

// Aspect routing + image-vector planning for a query.
export {
  parseSearchWeights,
  buildQueryAspectImageVectors,
  resolveAspectPlans,
  type ChannelWeights,
  type QueryImageInput,
  type AspectPlan,
} from "./search-query.ts";
