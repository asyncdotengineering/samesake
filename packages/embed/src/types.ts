// Public type surface for @samesake/embed.
//
// EmbedRequest is owned by @samesake/core and imported verbatim — this package
// adds no request field. An Embedder is the dual-form primitive: simultaneously
// callable as a single-request EmbedFn (the search hot path) and a batch
// interface (the ingest throughput path), governed by one capability descriptor.
import type { EmbedRequest } from "@samesake/core";

export interface EmbedderCaps {
  /** True if this embedder honors EmbedRequest.image. */
  image: boolean;
  /** True if a single request may carry interleaved text + image parts. */
  interleaved: boolean;
  /** Supported output dimensionalities, or "any" if the provider is dim-flexible. */
  dims: number[] | "any";
  /** Hard cap on requests per batch call; `many` chunks to this. */
  maxBatch: number;
}

export interface Embedder {
  // SINGLE form — the hot path. One request, one vector. Routes to the
  // provider's single-content endpoint. This call signature makes an Embedder
  // assignable to EmbedFn (drop-in for createSearch / createEnricher).
  (req: EmbedRequest): Promise<number[]>;

  // BATCH form — the throughput path. N requests, N vectors, order-preserved.
  // Routes to the provider's batch endpoint and auto-chunks the input into
  // slices of at most caps.maxBatch. Never a loop over the single endpoint.
  many(reqs: EmbedRequest[]): Promise<number[][]>;

  // Capability descriptor. Immutable for the lifetime of the embedder.
  readonly caps: EmbedderCaps;
}
