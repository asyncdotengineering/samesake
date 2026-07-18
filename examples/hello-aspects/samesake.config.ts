import { collection, f, Channels } from "@samesake/core";

export const products = collection("products", {
  fields: {
    title: f.text({ searchable: true }),
    brand: f.text({ filterable: true }),
    category: f.text({ filterable: true }),
  },
  embeddings: {
    doc: { source: "$title", model: "stub", dim: 8, taskType: "RETRIEVAL_DOCUMENT" },
    facets: {
      model: "stub",
      dim: 8,
      evidence: true,
      describe: "short attribute claims",
      extract: ({ enriched }: { enriched: Record<string, unknown> }) => {
        const claims = enriched.claims;
        return Array.isArray(claims) ? claims.map(String) : [];
      },
    },
    visual: {
      kind: "image",
      source: "$image_url",
      model: "stub",
      dim: 8,
      taskType: "RETRIEVAL_DOCUMENT",
      describe: "visual appearance",
    },
  } as const,
  search: {
    channels: [
      Channels.fts({ fields: ["title"], weight: 1 }),
      Channels.cosine({ embedding: "doc", weight: 1 }),
      Channels.cosine({ embedding: "facets", weight: 1 }),
      Channels.cosine({ embedding: "visual", weight: 1 }),
    ],
    combiner: "rrf",
    nlq: { enable: false },
  },
});
