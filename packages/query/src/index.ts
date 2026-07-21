// @samesake/query — the store-agnostic search query brain. Ports + plan
// contract plus the pure brain leaves: the SearchHit result type, the filter
// AST + normaliser, result cutoff, ranking policy, and constraint-trace
// builder. nlq/aspect-planning/rerank/createSearch land in later sub-slices.
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
