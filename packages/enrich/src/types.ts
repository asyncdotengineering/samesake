import type { PipelineDef, IndexingDef, CollectionDedupDef, DerivedDocContext, GenerateFn } from "@samesake/core";

export interface RawRow {
  id: string;
  data: Record<string, unknown>;
  imageEtag?: string | null;
  scope?: Record<string, string>;
}

export interface EnrichedSurfaces {
  doc: string | null;
  denseByEmbedding: Record<string, string>;
  rerank_doc: string | null;
  fts_src: string | null;
  fts_src_a: string | null;
}

// The RICH per-row transform output (renamed from EnrichedRow to avoid the @samesake/core clash).
export interface EnrichResult {
  id: string;
  enriched: Record<string, unknown>;      // merged stage output, includes _stages
  surfaces: EnrichedSurfaces;
  status: "ready" | "quarantined";
  gateReason: string | null;
  ok: boolean;
  error?: string;
}

export interface StageCachePort { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void>; }
export type FetchImageFn = (url: string) => Promise<{ ok: true; mimeType: string; bytes: Uint8Array } | { ok: false }>;

export interface EnrichConfig { pipeline: PipelineDef; indexing: IndexingDef; }
export interface EnrichDeps { generate: GenerateFn; stageCache?: StageCachePort; fetchImage?: FetchImageFn; fewShot?: string; concurrency?: number; onError?: (row: RawRow, err: unknown) => void; }

// Dedup seam (dedup-specific; distinct from @samesake/core's generic CandidateProvider).
export interface DedupRow { id: string; fields: Record<string, unknown>; embedding?: number[] | null; scope?: Record<string, string>; }
export interface DedupCandidate { id: string; group: string | null; fields: Record<string, unknown>; trgm: Record<string, number>; cos: number | null; }
export type DedupCandidateProvider = (row: DedupRow) => Promise<DedupCandidate[]>;
export interface DedupFeedback { isDeclined(a: string, b: string): Promise<boolean>; suggestionStatus(rowId: string, group: string): Promise<string | null>; }
export interface ClusterDecision { rowId: string; outcome: "link" | "suggest" | "found"; group: string; score: number | null; }
