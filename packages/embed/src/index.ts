// @samesake/embed — dual-form, provider-neutral embedder wrapper.
//
// One object: callable as a single-request EmbedFn AND exposing .many()
// (batch) and .caps. Provider closures supply transport and runtime behavior.
// EmbedRequest / EmbedImageInput are owned by @samesake/core and consumed
// verbatim — this package adds no request field.
export type { Embedder, EmbedderCaps } from "./types.ts";
export { createEmbedder, type EmbedderConfig } from "./embedder.ts";
