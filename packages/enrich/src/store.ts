import type { EnrichedSurfaces, RawRow, DedupCandidateProvider, DedupFeedback } from "./types.ts";

// The minimal persisted shape written back by the store after a successful pass.
// The rich per-row transform output is EnrichResult (see types.ts); this is what
// survives to the row's `enriched` column.
export interface EnrichedRow {
  id: string;
  enriched: Record<string, unknown>;
  surfaces?: EnrichedSurfaces;
  status?: "ready" | "quarantined";
  gateReason?: string | null;
}

/**
 * EnrichStore is the ENTIRE Tier-2 durable state machine for enrich/resolve:
 * `dirty -> ready | quarantined | failed | dead` is expressed by these methods
 * and nowhere else. It carries all persistence coupling; the pure core owns no
 * retry, backoff, or dead-lettering.
 *
 * Ingest + enrich lifecycle (required): `upsert` ingests raw rows and applies
 * its own content-hash dirty-tracking (a re-upsert with an unchanged
 * `contentHash` is a no-op, a changed one re-dirties the row); `loadDirty`
 * returns rows needing enrichment; `writeEnriched` persists ready/quarantined
 * outcomes; `recordFailure` transitions a row to `failed` and owns the
 * exponential-backoff bookkeeping; `loadRetryable` returns `failed` rows whose
 * backoff window has elapsed; `markDead` retires a backoff-exhausted row.
 *
 * Readback + resolve lifecycle (optional — a pure-enrich store may omit these;
 * a store that omits `loadEnriched` makes `createEnricher(...).resolve()` and
 * `.evaluate()` throw a clear error rather than silently no-op): `loadEnriched`
 * returns previously-persisted enriched rows (resolve maps them to `DedupRow`,
 * evaluate maps them to a prediction set — one source serves both); `candidates`
 * is the dedup blocking probe co-located with the store; `feedback` is the
 * human-in-the-loop label plane (declined pairs, confirmed suggestions). This
 * mirrors entity-resolution prior art (Splink/Dedupe/Zingg): one data plane
 * owns records AND labels, and the pipeline is blocking (`candidates`) -> score
 * (`scoreBest`) -> cluster (`clusterBatch`). This package ships `memoryStore`;
 * production stores (durable relational or vector-backed implementations) are supplied
 * by the caller.
 */
export interface EnrichStore {
  upsert(rows: RawRow[]): Promise<void>;
  loadDirty(limit: number): Promise<RawRow[]>;
  writeEnriched(rows: EnrichedRow[]): Promise<void>;
  recordFailure(id: string, error: unknown): Promise<void>;
  loadRetryable(limit: number): Promise<RawRow[]>;
  markDead(id: string, reason: string): Promise<void>;
  // Readback + resolve support — optional (Interface Segregation): present only
  // on a store that retains enriched rows / serves dedup.
  loadEnriched?(limit: number): Promise<EnrichedRow[]>;
  candidates?: DedupCandidateProvider;
  feedback?: DedupFeedback;
}
