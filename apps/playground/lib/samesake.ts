import { collection, Channels, fashion, type CollectionDef } from "@samesake/core";
import { createMatcher } from "@samesake/server";
import { geminiEmbed } from "./embed";
import { geminiGenerate } from "./generate";

export const PROJECT = "playground";
export const COLLECTION = "products";

// The playground now dogfoods @samesake/core's fashion enrichment TEMPLATE (1.3.0):
//   - fashion.enrichPipeline(): classify (category/type/gender/is-apparel) → extract
//     (colors/pattern/material/fit/occasions/styles + per-category attrs + search_document),
//     image-aware via the BYO generate fn.
//   - fashion.fields(): declared attributes resolve from enriched.* (filled by the pipeline).
//   - fashion.spaces(): visual (image) + price + category + freshness segments.
//   - fashion.nlq: fashion-aware intent/budget parsing.
// The doc embedding reads $enriched.embed_doc, composed by composeEmbedDocs() after enrich.
export const products = collection(COLLECTION, {
  // brand lives on the raw doc as `brand` (not the template's default `vendor`).
  fields: fashion.fields({ brandPath: "brand" }),
  embeddings: {
    doc: { source: fashion.embedDocSource, model: "gemini-embedding-2", dim: 1536, taskType: "RETRIEVAL_DOCUMENT" },
  },
  spaces: fashion.spaces(),
  enrich: fashion.enrichPipeline(),
  search: {
    channels: [
      Channels.fts({ fields: ["title"], weight: 1 }),
      Channels.cosine({ embedding: "doc", weight: 1 }),
      Channels.spaces({ weight: 1 }),
    ],
    combiner: "rrf",
    nlq: {
      enable: true,
      semanticRewrite: true,
      instructions: fashion.nlq.instructions,
      schema: fashion.nlq.schema(),
    },
  },
}) as CollectionDef & { name: string };

let _matcher: ReturnType<typeof createMatcher> | null = null;
export function getMatcher() {
  if (_matcher) return _matcher;
  _matcher = createMatcher({
    databaseUrl: process.env.DATABASE_URL!,
    apiKey: process.env.API_KEY!,
    migrate: "eager",
    embed: geminiEmbed,
    generate: geminiGenerate,
  });
  return _matcher;
}
