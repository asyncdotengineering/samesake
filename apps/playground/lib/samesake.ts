import { collection, f, Channels } from "@samesake/core";
import { createMatcher } from "@samesake/server";
import { geminiEmbed } from "./embed";
import { geminiGenerate } from "./generate";

export const PROJECT = "playground";
export const COLLECTION = "products";

// The search shape for the fashion catalog. Mirrors the fields we sync out of Porulle.
export const products = collection("products", {
  fields: {
    title: f.text({ searchable: true }),
    brand: f.text({ filterable: true }),
    category: f.text({ filterable: true }),
    color: f.text({ filterable: true }),
    material: f.text({ filterable: true }),
    price: f.number({ filterable: true, budget: true }),
    available: f.boolean({ filterable: true }),
    image_url: f.text(),
  },
  embeddings: {
    doc: { source: "$title $brand $category $color $material", model: "gemini-embedding-2", dim: 1536 },
  },
  search: {
    channels: [
      Channels.fts({ fields: ["title", "brand", "category", "color", "material"], weight: 1 }),
      Channels.cosine({ embedding: "doc", weight: 1 }),
    ],
    combiner: "rrf",
    // Parse natural-language intent + budgets ("under 3000") into hard filters.
    // `price` is marked budget:true, so a stated cap becomes price <= cap.
    nlq: { enable: true, semanticRewrite: true },
  },
});

// samesake lives in the SAME database as Porulle (samesake_playground): it namespaces
// itself via samesake_* tables + a project_<slug> schema, so it coexists with Porulle's
// public-schema commerce tables without collision.
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
