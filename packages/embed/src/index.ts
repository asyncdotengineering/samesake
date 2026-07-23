// @samesake/embed — dual-form, multimodal, provider-neutral embedder.
//
// One object: callable as a single-request EmbedFn AND exposing .many()
// (batch) and .caps. Plain fetch, zero runtime dependencies, edge/Workers-safe.
// EmbedRequest / EmbedImageInput are owned by @samesake/core and consumed
// verbatim — this package adds no request field.
export type { Embedder, EmbedderCaps } from "./types.ts";
export { gemini, voyage } from "./embedder.ts";
