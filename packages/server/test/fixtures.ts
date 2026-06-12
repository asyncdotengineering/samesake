import { collection, f, Channels, type CollectionDef } from "../../sdk/src/index.ts";

export const testProductsCollection = collection("products", {
  fields: {
    title: f.text({ searchable: true }),
    brand: f.text({ filterable: true, facet: true }),
    price: f.number({ filterable: true, facet: "range" }),
    category: f.text({ filterable: true, facet: true }),
    colors: f.array(f.enum(["red", "blue", "green"] as const), {
      filterable: true,
      soft: true,
      facet: true,
    }),
    tag: f.text({ filterable: true, soft: true }),
    available: f.boolean({ filterable: true, facet: true }),
  },
  embeddings: {
    doc: { source: "$title", model: "test-embed", dim: 8, taskType: "RETRIEVAL_QUERY" },
  },
  search: {
    channels: [
      Channels.fts({ fields: ["title"], weight: 1 }),
      Channels.cosine({ embedding: "doc", weight: 1 }),
      Channels.recency({ field: "updated_at", halfLifeDays: 90, weight: 0 }),
    ],
    combiner: "rrf",
    nlq: {
      instructions: "Parse shopper queries. Prices in USD.",
      semanticRewrite: true,
    },
  },
}) as CollectionDef & { name: string };

export const nlqSchemaFixtureCollection = collection("nlq_fixture", {
  fields: {
    title: f.text({ searchable: true }),
    status: f.enum(["active", "draft"] as const, { filterable: true, facet: true }),
    price: f.number({ filterable: true, facet: "range" }),
    colors: f.array(f.enum(["red", "blue"] as const), { filterable: true, facet: true }),
    in_stock: f.boolean({ filterable: true, facet: true }),
    brand: f.text({ filterable: true }),
  },
  embeddings: {
    doc: { source: "$title", model: "test-embed", dim: 8 },
  },
  search: {
    channels: [
      Channels.fts({ fields: ["title"], weight: 1 }),
      Channels.cosine({ embedding: "doc", weight: 0 }),
    ],
    nlq: { instructions: "Test NLQ instructions" },
  },
}) as CollectionDef & { name: string };

export function stubEmbed(text: string | undefined, dim: number): number[] {
  const t = text ?? "";
  const out = new Array(dim).fill(0);
  for (let i = 0; i < t.length; i++) {
    out[i % dim] = (out[i % dim]! + t.charCodeAt(i) * 0.001) % 1;
  }
  const norm = Math.sqrt(out.reduce((s, x) => s + x * x, 0)) || 1;
  return out.map((x) => x / norm);
}
