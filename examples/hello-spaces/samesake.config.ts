import { collection, f, Channels, s } from "@samesake/core";

export const products = collection("products", {
  fields: {
    title: f.text({ searchable: true }),
    brand: f.text({ filterable: true }),
    price: f.number({ filterable: true }),
    category: f.text({ filterable: true }),
  },
  embeddings: {
    doc: { source: "$title", model: "stub", dim: 8, taskType: "RETRIEVAL_DOCUMENT" },
  },
  spaces: {
    style: s.text({ source: "$title", model: "stub", dim: 8 }),
    price: s.number({ field: "price", mode: "min", dims: 8, min: 0, max: 200, scale: "linear" }),
  },
  search: {
    channels: [
      Channels.fts({ fields: ["title"], weight: 0 }),
      Channels.cosine({ embedding: "doc", weight: 0 }),
      Channels.spaces({ weight: 1 }),
    ],
    combiner: "rrf",
    defaultSpaceWeights: { style: 1, price: 1 },
  },
});
