// The shared search result-hit type the query-brain modules operate on.
// Store-agnostic: `data` carries the document row; `offers` is the optional
// cross-vendor cluster payload for dedup-enabled collections. Lives here so
// cutoff/ranking/constraint-trace can depend on it without pulling in the
// server package.
import type {
  ConstraintTrace,
  SearchMode,
  SearchWeightsInput,
} from "@samesake/core";
import type { FacetResult } from "./facets.ts";
import type { RewriteRecord } from "./query-rewrite.ts";
import type { ChannelWeights } from "./search-query.ts";
import type { SearchFilters } from "./filters.ts";

export interface SearchHit {
  id: string;
  score: number;
  data: Record<string, unknown>;
  /**
   * Cross-vendor offers for this hit's cluster (dedup-enabled collections only): one
   * entry per ready cluster member, restricted to the collection's declared
   * `dedup.offerFields` + `id` (+ scope keys on scoped collections). Absent when the
   * collection declares no `dedup` or the hit carries no cluster id.
   */
  offers?: Array<Record<string, unknown>>;
  [field: string]: unknown;
}

export interface SearchResult {
  hits: SearchHit[];
  parsed?: Record<string, unknown>;
  constraintTrace: ConstraintTrace;
  nlq_degraded?: boolean;
  relaxed: boolean;
  relaxedFields: string[];
  took_ms: number;
  facets?: Record<string, FacetResult>;
  total_candidates?: number;
  /** hits removed by the result-cutoff strategy (honest zero-results); absent when 0 */
  cutoff_dropped?: number;
  /** true when served from the in-process result cache */
  cached?: boolean;
  rewritten?: RewriteRecord;
}

export interface ExplainDocBreakdown {
  id: string;
  fts_rank: number | null;
  cosine_rank: number | null;
  recency_rank: number | null;
  rrf_score: number;
  aspect_ranks?: Record<string, { rank: number | null; cosine: number | null }>;
}

export interface SearchExplainResult {
  q: string;
  parsed?: Record<string, unknown>;
  constraintTrace: ConstraintTrace;
  nlq_degraded?: boolean;
  filters: { sql: string; params: Array<{ index: number; type: string }> };
  relaxation: boolean;
  relaxedFields: string[];
  cache_hit: boolean;
  weights: ChannelWeights;
  docs: ExplainDocBreakdown[];
  took_ms: number;
  rewritten?: RewriteRecord;
}

export interface SearchOpts {
  /**
   * The query text. `createSearch` takes `q` as its first positional arg (per the
   * contract: `search(q, opts)`), NOT from here. This optional field exists only
   * for the legacy `@samesake/server` search API (makeSearchService), which carries
   * `q` inside opts; it is removed once the server migrates to `createSearch`.
   */
  q?: string;
  image?: {
    url?: string;
    bytes?: Uint8Array;
    bytesBase64?: string;
    mimeType?: string;
  };
  filters?: SearchFilters;
  weights?: SearchWeightsInput;
  /**
   * Retrieval objective. Omit to auto-resolve: "similar" when an image is present, else
   * "intent". "intent" keeps keyword as a tiebreaker; "similar" turns keyword off so
   * semantic + visual decide. Explicit `weights` still override the mode's defaults.
   */
  mode?: SearchMode;
  limit?: number;
  offset?: number;
  facets?: string[];
  /** Set true to opt into the short-TTL in-process result cache. */
  cache?: boolean;
  /**
   * Second-stage reranking. Defaults to on when a `rerank` fn is configured on the
   * matcher. Set false to force pure first-stage (RRF) order.
   */
  rerank?: boolean;
  /**
   * Collapse near-duplicate variants (same `search.variantGroup` value) to the
   * best-scoring item per group. Defaults to on when the collection declares
   * `variantGroup`. Set false to return every variant.
   */
  diversify?: boolean;
  /**
   * ANN recall/latency dial, clamped by the selected backend.
   * Higher values generally improve recall at the cost of latency.
   */
  efSearch?: number;
  /**
   * Tenancy scope. REQUIRED (all declared keys) when the collection declares
   * `scopes` — every query runs inside exactly one scope; there is no
   * cross-scope search. Rejected on unscoped collections.
   */
  scope?: Record<string, string>;
  /**
   * Attach cross-vendor `offers` to each hit (dedup-enabled collections only). Defaults
   * to on when the collection declares `dedup`; set false to skip the batched offers
   * query. No effect on collections without `dedup`.
   */
  offers?: boolean;
}
