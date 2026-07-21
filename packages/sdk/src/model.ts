// Bring-your-own model closure contracts.
//
// The consumer supplies these functions; @samesake/core declares only their
// shapes. Every contract is model-, provider-, and platform-agnostic: `model`
// is an opaque pass-through the engine never inspects, and the only numeric
// coupling is `dim`, which the consumer chose and the engine merely honors.

/**
 * Inputs the matcher gives to the consumer's embed function.
 *   - `text`     — the string to embed (already trimmed / non-empty)
 *   - `model`    — the opaque model identifier from the entity's EmbeddingDef
 *   - `dim`      — the vector dimension the matcher expects back; throw or
 *                  the matcher will detect the mismatch and throw a clear error
 *   - `taskType` — opaque hint from EmbeddingDef.taskType. The consumer's
 *                  embedder decides which values it accepts. May be undefined.
 *   - `inputType`— "query" for a match-time query, "document" for an upsert.
 *                  Voyage cares; most providers don't. May be undefined.
 */
export interface EmbedImageInput {
  url?: string;
  bytes?: Uint8Array;
  mimeType?: string;
}

export interface EmbedRequest {
  text?: string;
  image?: EmbedImageInput;
  model: string;
  dim: number;
  taskType?: string;
  inputType?: "query" | "document";
}

export type EmbedFn = (req: EmbedRequest) => Promise<number[]>;

/**
 * Schema-constrained JSON generation. `schema` is a plain JSON Schema object
 * forwarded as-is; the consumer's function must return a value conforming to
 * it. Used by enrichment stages, natural-language-query understanding, and
 * evaluation.
 */
export interface GenerateRequest {
  model?: string;
  system?: string;
  prompt: string;
  images?: { mimeType: string; data: Uint8Array | string }[];
  schema: Record<string, unknown>;
}

export type GenerateFn = (req: GenerateRequest) => Promise<unknown>;

/**
 * Second-stage reranker. Given the query and the top-N first-stage candidates,
 * return a re-scored ordering. Candidates the function omits keep their original
 * relative order beneath the reranked ones. Wire a cross-encoder here; samesake
 * runs pure RRF when this is absent.
 */
export interface RerankCandidate {
  id: string;
  /** Best available text for the candidate (doc/title), for the cross-encoder. */
  text: string;
  data: Record<string, unknown>;
  /** First-stage (RRF) score. */
  score: number;
}
export interface RerankRequest {
  query: string;
  image?: EmbedImageInput;
  candidates: RerankCandidate[];
  topK: number;
}
/** Returned scores MUST be in [0, 1]; the search layer clamps at the boundary. */
export type RerankFn = (req: RerankRequest) => Promise<Array<{ id: string; score: number }>>;

/**
 * Visual grounding: crop/segment the salient product region from a catalog/query
 * image before it is embedded (VL-CLIP-style). Return null to pass the image
 * through unchanged. Applied to both index-time and query-time images.
 */
export interface GroundImageRequest {
  url?: string;
  bytes?: Uint8Array;
  mimeType?: string;
}
export interface GroundImageResult {
  bytes: Uint8Array;
  mimeType: string;
}
export type GroundImageFn = (req: GroundImageRequest) => Promise<GroundImageResult | null>;
