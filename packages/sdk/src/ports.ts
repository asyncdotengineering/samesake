// The four ports — the substitution seams that make samesake general across
// stores and backends. Interfaces only; @samesake/core supplies no
// implementation. A backend package (or a consumer) provides a concrete
// implementation, and the primitive factories accept it by interface.
import type { RankedRow, RetrievalPlan } from "./plan.ts";

export type Scope = Record<string, string>;

/**
 * Executes a resolved `RetrievalPlan` against whatever store backs it and
 * returns fused `RankedRow[]` ordered by descending `rrf_score`, at most
 * `plan.limit` rows. The retriever owns leg execution and reciprocal-rank
 * fusion; cutoff, reranking, and ranking-policy application layer above it.
 */
export interface Retriever {
  (plan: RetrievalPlan): Promise<RankedRow[]>;
}

// EnrichStore (the enrich Tier-2 state machine) and the dedup CandidateProvider
// are domain ports, not base-layer contracts: they live in @samesake/enrich
// alongside the state machine they model and use its native RawRow/DedupCandidate
// types directly, so @samesake/core carries no parallel StoredRow/Candidate
// hierarchy. Every implementer (@samesake/postgres, a D1 store) already depends
// on @samesake/enrich via createEnricher, so ownership there adds no coupling.

/**
 * Supplies the known value vocabulary for a declared field, optionally within
 * a tenancy scope, so grounded query understanding maps parsed constraint
 * values onto values actually present in the corpus.
 */
export interface VocabProvider {
  (field: string, scope?: Scope): Promise<string[]>;
}
