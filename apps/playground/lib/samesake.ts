import { collection, Channels, f, fashion, type CollectionDef, type CollectionFieldDef } from "@samesake/core";
import { createMatcher } from "@samesake/server";
import { geminiEmbedder, geminiGenerator } from "@samesake/providers";

export const PROJECT = "playground";
export const COLLECTION = "products";
const productFields: Record<string, CollectionFieldDef> = {
  ...fashion.fields({ brandPath: "brand" }),
  content_hash: f.text({ path: "content_hash" }),
};

// The playground dogfoods @samesake/core's fashion enrichment TEMPLATE: enrichPipeline,
// fields, spaces, nlq, and indexing() — surfaces + gate persist at enrich time.
export const products = collection(COLLECTION, {
  fields: productFields,
  indexing: fashion.indexing(),
  embeddings: {
    doc: { model: "gemini-embedding-2", dim: 1536, taskType: "RETRIEVAL_DOCUMENT" },
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
    variantGroup: "content_hash",
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
    databaseUrl: process.env.SAMESAKE_DATABASE_URL!,
    apiKey: process.env.SAMESAKE_API_KEY!,
    migrate: "eager",
    embed: geminiEmbedder(),
    generate: geminiGenerator(),
  });
  return _matcher;
}
