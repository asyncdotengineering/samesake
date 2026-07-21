// The search-side ports — store-agnostic seams; interfaces only, @samesake/query
// supplies no implementation. A backend (@samesake/postgres, a D1 + LanceDB
// store) provides a concrete `Retriever`, and `createSearch` accepts it by
// interface. These live with the search domain that gives them meaning; every
// implementer already depends on @samesake/query to compose createSearch, so
// ownership here adds no coupling.
import type { Scope } from "@samesake/core";
import type { RankedRow, RetrievalPlan } from "./plan.ts";

/**
 * Executes a resolved `RetrievalPlan` against whatever store backs it and
 * returns fused `RankedRow[]` ordered by descending `rrf_score`, at most
 * `plan.limit` rows. The retriever owns leg execution and reciprocal-rank
 * fusion; cutoff, reranking, and ranking-policy application layer above it.
 */
export interface Retriever {
  (plan: RetrievalPlan): Promise<RankedRow[]>;
}

/**
 * Supplies the known value vocabulary for a declared field, optionally within
 * a tenancy scope, so grounded query understanding maps parsed constraint
 * values onto values actually present in the corpus.
 */
export interface VocabProvider {
  (field: string, scope?: Scope): Promise<string[]>;
}
