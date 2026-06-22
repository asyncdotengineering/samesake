import { z } from "zod";
import { collection, f, Channels, gates } from "@samesake/core";
import { createMatcher } from "@samesake/server";
import { geminiEmbed, geminiGenerate } from "./providers.ts";

// The samesake side of the recipe. The Weaviate version creates an "ECommerce" and a
// "Brands" collection with text2vec vectors; here those become two samesake collection()s
// with gemini-embedding-2 doc vectors + Postgres FTS, combined with RRF.
export const PROJECT = "qa-ecommerce";
export const PRODUCTS = "products";
export const BRANDS = "brands";

// Physical Postgres location samesake compiles the products collection to. Aggregations
// (COUNT/AVG) query this table directly — samesake's search() is retrieval-only and needs a
// query, so it can't express a GROUP BY. Mirrors the recipe's Query Agent running aggregations.
export const SCHEMA = "project_qa_ecommerce";
export const PRODUCTS_TABLE = `${SCHEMA}.c_${PRODUCTS}`;

// ECommerce: clothing items, their brands, prices, reviews, etc.
// Field descriptions matter the same way they do in the Weaviate recipe — they steer the
// agent's tool use (e.g. "price is in USD"). We surface them in the tool descriptions.
export const products = collection(PRODUCTS, {
  fields: {
    name: f.text({ searchable: true }),
    description: f.text({ searchable: true }),
    brand: f.text({ searchable: true, filterable: true, facet: true }),
    category: f.text({ filterable: true, facet: true }),
    subcategory: f.text({ filterable: true, facet: true }),
    collection: f.text({ filterable: true, facet: true }),
    price: f.number({ filterable: true, facet: "range", budget: true }),
    image_url: f.text(),
  },
  embeddings: {
    doc: { model: "gemini-embedding-2", dim: 1536 },
  },
  indexing: {
    surfaces: {
      embed_doc: {
        kind: "dense",
        embedding: "doc",
        build: ({ data }) =>
          [data.name, data.description, data.brand, data.category, data.subcategory].filter(Boolean).join(" "),
      },
      fts_doc: {
        kind: "fts",
        build: ({ data }) => [data.name, data.description, data.brand].filter(Boolean).join(" "),
      },
    },
    gate: gates.always,
  },
  search: {
    channels: [
      Channels.fts({ fields: ["name", "description", "brand"], weight: 1 }),
      Channels.cosine({ embedding: "doc", weight: 1 }),
    ],
    combiner: "rrf",
    // NLQ turns "less than $200" / "same budget as before" into a hard max_price filter.
    nlq: {
      enable: true,
      semanticRewrite: true,
      schema: z.object({ semantic_query: z.string(), max_price: z.number().optional() }),
    },
  },
});

// Brands: parent/child hierarchy, country, rating, founding year.
export const brands = collection(BRANDS, {
  fields: {
    name: f.text({ searchable: true, filterable: true, facet: true }),
    parent_brand: f.text({ filterable: true }),
    description: f.text({ searchable: true }),
    country: f.text({ filterable: true, facet: true }),
    avg_customer_rating: f.number({ filterable: true, facet: "range" }),
    foundation_year: f.number({ filterable: true }),
  },
  embeddings: {
    doc: { model: "gemini-embedding-2", dim: 1536 },
  },
  indexing: {
    surfaces: {
      embed_doc: {
        kind: "dense",
        embedding: "doc",
        build: ({ data }) => [data.name, data.description, data.country].filter(Boolean).join(" "),
      },
      fts_doc: {
        kind: "fts",
        build: ({ data }) => [data.name, data.description, data.country].filter(Boolean).join(" "),
      },
    },
    gate: gates.always,
  },
  search: {
    channels: [
      Channels.fts({ fields: ["name", "description", "country"], weight: 1 }),
      Channels.cosine({ embedding: "doc", weight: 1 }),
    ],
    combiner: "rrf",
  },
});

let _matcher: ReturnType<typeof createMatcher> | null = null;
export function getMatcher() {
  if (_matcher) return _matcher;
  _matcher = createMatcher({
    databaseUrl: process.env.DATABASE_URL!,
    apiKey: process.env.API_KEY ?? "dev-key-please-change",
    migrate: "eager",
    embed: geminiEmbed,
    generate: geminiGenerate,
  });
  return _matcher;
}
