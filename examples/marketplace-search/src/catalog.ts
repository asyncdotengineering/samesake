// A multi-vendor marketplace catalog: the same physical product is listed by many
// sellers, so we dedup across vendors (resolve) and expose facets for the sidebar.
import { collection, f, gates } from "@samesake/core";
import type { CollectionDef } from "@samesake/core";

export const products = collection("products", {
  fields: {
    title: f.text({ searchable: true }),
    brand: f.text({ filterable: true, facet: true }),
    color: f.text({ filterable: true, facet: true }),
    price: f.number({ filterable: true, budget: true }),
    available: f.boolean({ filterable: true }),
    gtin: f.text(),
    vendor: f.text(),
  },
  // A real extraction stage: the (stubbed) model reads each messy listing and returns
  // canonical attributes into `enriched`, which the surfaces below build from.
  enrich: {
    stages: [
      {
        name: "extract",
        prompt: (ctx) => JSON.stringify(ctx.data),
        schema: () => ({
          type: "object",
          properties: { title: { type: "string" }, brand: { type: "string" }, color: { type: "string" }, gtin: { type: "string" }, vendor: { type: "string" } },
          required: ["title", "brand"],
        }),
      },
    ],
  },
  indexing: {
    surfaces: {
      embed_doc: { kind: "dense", embedding: "doc", build: (c) => [c.enriched.title, c.enriched.brand, c.enriched.color].filter(Boolean).join(" ") },
      fts_doc: { kind: "fts", build: (c) => [c.enriched.title, c.enriched.brand].filter(Boolean).join(" ") },
    },
    gate: gates.always,
  },
  embeddings: { doc: { model: "stub", dim: 8 } },
  // Cross-vendor dedup: listings sharing a GTIN (or near-identical titles) cluster into
  // one product. resolve() returns the link decisions.
  dedup: {
    channels: [
      { kind: "exactKey", field: "gtin" },
      { kind: "trigram", field: "title", weight: 1 },
      { kind: "cosine", weight: 1 },
    ],
    autoLink: 0.9,
    suggest: 0.6,
    offerFields: ["vendor", "price"],
    groupField: "product_group",
  },
  search: {
    channels: [
      { kind: "fts", fields: ["title", "brand"], weight: 1 },
      { kind: "cosine", embedding: "doc", weight: 1 },
    ],
    combiner: "rrf",
    nlq: { enable: true },
  },
}) as CollectionDef;
