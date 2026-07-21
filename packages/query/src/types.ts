// The shared search result-hit type the query-brain modules operate on.
// Store-agnostic: `data` carries the document row; `offers` is the optional
// cross-vendor cluster payload for dedup-enabled collections. Lives here so
// cutoff/ranking/constraint-trace can depend on it without pulling in the
// server package.
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
