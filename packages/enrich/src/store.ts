import type { RawRow, DedupCandidateProvider } from "./types.ts";

// The minimal persisted shape written back by the store after a successful pass.
// The rich per-row transform output is EnrichResult (see types.ts); this is what
// survives to the row's `enriched` column.
export interface EnrichedRow {
  id: string;
  enriched: Record<string, unknown>;
}

/**
 * EnrichStore is the ENTIRE Tier-2 durable state machine for enrich/resolve:
 * `dirty -> ready | quarantined | failed | dead` is expressed by these methods
 * and nowhere else. It carries all persistence coupling; the pure core owns no
 * retry, backoff, or dead-lettering. `loadDirty` returns rows needing
 * enrichment (the store applies its own selectDirty / content-hash filter);
 * `writeEnriched` persists ready/quarantined outcomes; `recordFailure`
 * transitions a row to `failed` and owns the exponential-backoff bookkeeping;
 * `loadRetryable` returns `failed` rows whose backoff window has elapsed;
 * `markDead` retires a backoff-exhausted row. The optional `candidates`
 * provider co-locates the dedup blocking probe with the store when one data
 * plane serves both. This package ships `memoryStore`; production stores
 * (a Postgres shell store, a D1 + LanceDB store) are supplied by the caller.
 */
export interface EnrichStore {
  loadDirty(limit: number): Promise<RawRow[]>;
  writeEnriched(rows: EnrichedRow[]): Promise<void>;
  recordFailure(id: string, error: unknown): Promise<void>;
  loadRetryable(limit: number): Promise<RawRow[]>;
  markDead(id: string, reason: string): Promise<void>;
  candidates?: DedupCandidateProvider;
}
