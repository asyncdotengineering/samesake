// Store-agnostic facet result shapes. The exact-SQL facet engine (computeFacets)
// stays server-side (a retriever/backend capability); these output types are
// declared here so SearchResult.facets and the FacetResult port type resolve
// without a store dependency.

export interface FacetBucket {
  lo: number;
  hi: number;
  count: number;
}

export interface FacetRangeResult {
  count: number;
  min: number | null;
  max: number | null;
  avg: number | null;
  buckets: FacetBucket[];
}

export interface FacetCountResult {
  values: Array<{ value: string; count: number }>;
}

export type FacetResult = FacetCountResult | FacetRangeResult;
