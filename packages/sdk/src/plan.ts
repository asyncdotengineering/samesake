// Retrieval plan and result types — the store-agnostic description of one
// hybrid-retrieval execution, produced upstream by query understanding and
// consumed by a `Retriever`.
import type { Scope } from "./ports.ts";
import type { ConstraintPredicate } from "./types.ts";

export interface RetrievalPlan {
  query: string | null;
  vectors: { embedding: string; vec: number[] }[];
  filters: ConstraintPredicate[];
  weights: Record<string, number>;
  scope?: Scope;
  limit: number;
}

export interface RankedRow {
  id: string;
  data: Record<string, unknown>;
  rrf_score: number;
  legRanks?: Record<string, number>;
}
