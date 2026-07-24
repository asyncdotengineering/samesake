// The catalog from the "Build a search experience" guide, verbatim.
// Read it like a sentence: products have a searchable title, a filterable brand/
// price/color/availability, and we search them with keywords (fts) + meaning (cosine).
import { collection, f, Channels, gates } from "@samesake/core";

export const products = collection("products", {
  fields: {
    title: f.text({ searchable: true }),
    brand: f.text({ filterable: true }),
    price: f.number({ filterable: true, budget: true }),
    color: f.text({ filterable: true }),
    available: f.boolean({ filterable: true }),
  },
  // An enrich pipeline is required for the enrich/index step. This catalog's data is
  // already clean, so the pipeline is empty (no LLM extraction) and the indexing
  // surfaces below read the raw `data` directly. A messier catalog would add stages
  // here to parse structured attributes first.
  enrich: { stages: [] },
  indexing: {
    surfaces: {
      embed_doc: {
        kind: "dense",
        embedding: "doc",
        build: ({ data }) => `${data.title} ${data.brand} ${data.color}`.trim(),
      },
      fts_doc: {
        kind: "fts",
        build: ({ data }) => `${data.title} ${data.brand}`.trim(),
      },
    },
    gate: gates.always,
  },
  embeddings: {
    // "meaning" vectors read from indexing.surfaces.embed_doc
    doc: { model: "gemini-embedding-2", dim: 1536 },
  },
  search: {
    channels: [
      Channels.fts({ fields: ["title", "brand", "color"], weight: 1 }), // keywords
      Channels.cosine({ embedding: "doc", weight: 1 }), // meaning
    ],
    combiner: "rrf", // merge the two rankings fairly
    // NLQ turns natural-language phrasing ("under 15000") into hard filters. Without
    // this block the query text is treated as keywords only and budgets are not parsed.
    nlq: { instructions: "Shopping queries for a fashion catalog. Extract price budgets and attributes." },
  },
});
