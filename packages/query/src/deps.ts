// Query-local structural dependency contracts. The query brain is store-agnostic:
// it owns the pure NLQ / aspect-planning logic but has no DB, no host context, no
// concrete cache or fetch impl. A store-backed backend builds these deps from its
// own context and injects them at the call site — the same port-injection seam
// enrich's runStage and query's Retriever/VocabProvider already use. Each type
// mirrors the actual shape of the corresponding host impl; query never imports the
// host, so a structural copy keeps the boundary clean while staying
// assignment-compatible.
import type { EmbedRequest, GenerateFn } from "@samesake/core";
import type { GroundedValueDecision } from "./vocab.ts";

/** Best-effort stage cache for NLQ parses. Omit to disable caching. Mirrors the
 *  subset of the host's stage-cache service that parseNlq touches. */
export interface NlqStageCache {
  getStageCache(key: string): Promise<unknown | null>;
  setStageCache(
    key: string,
    stageName: string,
    payload: object,
    model: string,
    ttlDays?: number
  ): Promise<void>;
}

/** Result of fetching a remote query image. Mirrors the narrowed shape of the host's
 *  safe image-fetch result that buildQueryAspectImageVectors reads (ok/bytes/
 *  contentType on success; reason on failure). The host's richer result (typed reason
 *  union, extra finalUrl/message fields) is assignment-compatible. */
export type QueryFetchImageResult =
  | { ok: true; bytes: Uint8Array; contentType: string; finalUrl: string }
  | { ok: false; reason: string; finalUrl?: string; message?: string };

/** Fetch a remote image by URL for an image query. The host injects its SSRF-safe
 *  fetcher; tests inject a stub. */
export type QueryFetchImage = (url: string) => Promise<QueryFetchImageResult>;

/** Embedding service: turns a query/doc request into a vector. Mirrors the embedQuery
 *  method of the host's embed service. */
export interface EmbedService {
  embedQuery(req: EmbedRequest): Promise<number[]>;
  embedMany?(reqs: EmbedRequest[]): Promise<number[][]>;
}

/** Ground parsed open-vocab filter values against the live corpus. Mirrors the host's
 *  value-grounding function minus the host context the shell threads in. Omit to leave
 *  ungrounded values dropped (degraded, no DB). */
export type GroundVocabFn = (
  schema: string,
  collection: string,
  values: Record<string, string[]>,
  scopeCols: Record<string, string>
) => Promise<{ available: boolean; decisions: Record<string, GroundedValueDecision[]> }>;

/** Deps parseNlq needs from its host. Every field once read off the host context
 *  (generate, generateConfigured, stage cache, metrics, llm timeout, vocab grounding)
 *  is now an explicit injection — query has zero knowledge of the host. */
export interface ParseNlqDeps {
  generate: GenerateFn;
  /** Defaults to true when generate is provided. */
  generateConfigured?: boolean;
  /** Omit to disable stage caching (the host gate becomes "cache provided?"). */
  stageCache?: NlqStageCache;
  /** Per-call LLM timeout; defaults to DEFAULT_NLQ_TIMEOUT_MS when omitted. */
  timeoutMs?: number;
  /** Metrics hook (increment a named counter). */
  onMetric?: (name: string) => void;
  /** Open-vocab grounding hook. */
  groundVocab?: GroundVocabFn;
}
