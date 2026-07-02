// @samesake/providers — ready-made adapters for samesake's BYO model seams.
// Each factory returns exactly the closure createMatcher() accepts:
//
//   createMatcher({
//     embed: geminiEmbedder(),        // EmbedFn   (multimodal)
//     generate: geminiGenerator(),    // GenerateFn (NLQ, enrichment)
//     parse: geminiParser(),          // ParseFn   (entity parsing)
//     rerank: cohereReranker(),       // RerankFn  (optional second stage)
//   });
//
// BYO stays first-class: anything satisfying the @samesake/server function
// types works — these adapters just delete the boilerplate.
export type { ProviderOptions } from "./shared.ts";
export { geminiEmbedder, geminiGenerator, geminiParser } from "./gemini.ts";
export { openaiEmbedder, openaiGenerator, openaiParser } from "./openai.ts";
export { voyageEmbedder, voyageReranker } from "./voyage.ts";
export { cohereEmbedder, cohereReranker } from "./cohere.ts";
