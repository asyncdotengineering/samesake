import { collection, f, Channels } from "@samesake/core";

export const products = collection("products", {
  fields: {
    title: f.text({ searchable: true }),
    brand: f.text({ filterable: true, facet: true }),
    price: f.number({ filterable: true }),
    category: f.text({ filterable: true }),
  },
  embeddings: {
    doc: { source: "$title", model: "stub", dim: 8, taskType: "RETRIEVAL_DOCUMENT" },
  },
  search: {
    channels: [
      Channels.fts({ fields: ["title"], weight: 1 }),
      Channels.cosine({ embedding: "doc", weight: 1 }),
    ],
    combiner: "rrf",
  },
});
