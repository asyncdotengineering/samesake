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

export interface StoredRow {
  id: string;
  collection: string;
  scope?: Scope;
  data: Record<string, unknown>;
  enriched?: Record<string, unknown>;
  attempts?: number;
}

export interface EnrichedRow {
  id: string;
  enriched: Record<string, unknown>;
}

export interface EnrichFailure {
  stage?: string;
  message: string;
  retryable: boolean;
  at: number;
}

/**
 * Persistence seam for the `enrich` primitive's lifecycle: `loadDirty` returns
 * rows needing enrichment, `writeEnriched` persists a batch, `recordFailure`
 * records an attempt (the store increments the attempt count), `loadRetryable`
 * returns rows whose retryable failure's backoff has elapsed relative to `now`,
 * and `markDead` retires a row from the retry loop. The optional `candidates`
 * method lets a store double as a coarse resolve-time candidate source.
 */
export interface EnrichStore {
  loadDirty(opts: { collection: string; scope?: Scope; limit: number }): Promise<StoredRow[]>;
  writeEnriched(rows: EnrichedRow[]): Promise<void>;
  recordFailure(id: string, failure: EnrichFailure): Promise<void>;
  loadRetryable(opts: {
    collection: string;
    scope?: Scope;
    limit: number;
    now: number;
  }): Promise<StoredRow[]>;
  markDead(id: string, reason: string): Promise<void>;
  candidates?(row: StoredRow): Promise<Candidate[]>;
}

export interface Candidate {
  id: string;
  data: Record<string, unknown>;
  score?: number;
}

/**
 * Candidate-generation seam for the `resolve` primitive: given a row, return
 * the candidates that might be the same entity / same physical product across
 * vendors. The optional `score` is a coarse pre-score; the authoritative score
 * is computed by `resolve` itself.
 */
export interface CandidateProvider {
  (row: StoredRow): Promise<Candidate[]>;
}

/**
 * Supplies the known value vocabulary for a declared field, optionally within
 * a tenancy scope, so grounded query understanding maps parsed constraint
 * values onto values actually present in the corpus.
 */
export interface VocabProvider {
  (field: string, scope?: Scope): Promise<string[]>;
}
