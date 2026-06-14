import { collection, f, Channels, s, pipeline, stage } from "@samesake/core";
import { createMatcher } from "@samesake/server";
import { geminiEmbed } from "./embed";
import { geminiGenerate } from "./generate";

export const PROJECT = "playground";
export const COLLECTION = "products";

// Vision enrichment: read the actual colours/pattern off each product image instead of
// the junk heuristic (most products had no colour at all). The stage's JSON output is
// merged into the row's `enriched` jsonb and fed into the doc embedding below.
const VISION_SCHEMA = {
  type: "object",
  properties: {
    color_text: { type: "string", description: "dominant colours as a short phrase, e.g. 'black with white trim'" },
    colors: { type: "array", items: { type: "string" }, description: "individual colour words" },
    pattern: { type: "string", description: "solid | striped | floral | printed | checked | embroidered | colour-block | other" },
  },
  required: ["color_text"],
};

export const products = collection("products", {
  fields: {
    title: f.text({ searchable: true }),
    brand: f.text({ filterable: true }),
    category: f.text({ filterable: true }),
    price: f.number({ filterable: true, budget: true }),
    available: f.boolean({ filterable: true }),
    image_url: f.text(),
  },
  enrich: pipeline(
    stage("vision", {
      model: "gemini-3.1-flash-lite",
      images: (ctx) => (ctx.data.image_url ? [String(ctx.data.image_url)] : []),
      prompt: (ctx) =>
        `Look at this fashion product image${ctx.data.title ? ` ("${String(ctx.data.title)}")` : ""}. ` +
        `Return its colours and pattern as JSON. color_text is a short human phrase of the dominant colours.`,
      schema: () => VISION_SCHEMA,
    })
  ),
  embeddings: {
    // colour_text + pattern (from the image, via enrich) join the doc text, so "black dress
    // with white" cosine-matches genuinely black-and-white products.
    doc: { source: "$title $brand $category $enriched.color_text $enriched.pattern", model: "gemini-embedding-2", dim: 1536 },
  },
  // Visual space: image embedding (same multimodal model) for image / find-similar / cross-modal.
  spaces: { visual: s.image({ source: "$image_url", model: "gemini-embedding-2", dim: 768 }) },
  search: {
    channels: [
      Channels.fts({ fields: ["title", "brand", "category"], weight: 1 }),
      Channels.cosine({ embedding: "doc", weight: 1 }),
      Channels.spaces({ weight: 1 }),
    ],
    combiner: "rrf",
    defaultSpaceWeights: { visual: 1 },
    // Constrained NLQ: only extract intent + budget — never a hard colour filter (colour is
    // handled by the embedding + visual signals, so sparse tags can't dead-end a query).
    nlq: {
      enable: true,
      semanticRewrite: true,
      schema: {
        type: "object",
        properties: { semantic_query: { type: "string" }, max_price: { type: "number" } },
        required: ["semantic_query"],
      },
    },
  },
});

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
