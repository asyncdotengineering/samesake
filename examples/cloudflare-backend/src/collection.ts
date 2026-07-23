// The collection definition shared by the enrich + search call sites. This is the
// ONLY piece of config the consumer authors; the same `products` CollectionDef is
// handed to createEnricher and createSearch unchanged. The backend is injected
// purely through the store, retriever, and vocabulary ports.
import type { CollectionDef } from "@samesake/core";
import { collection, f, gates } from "@samesake/core";

export const products = collection("products", {
  fields: {
    title: f.text({ searchable: true }),
    brand: f.text({ filterable: true }),
    color: f.text({ filterable: true }),
    category: f.text({ filterable: true }),
    vendor: f.text(),
    gtin: f.text(),
    price: f.number({ filterable: true }),
    available: f.boolean(),
  },
  embeddings: {
    // gemini/768 are EXAMPLES, not defaults. This harness stubs the embedder to a
    // deterministic 8-dim projection — the point is to prove the STORE + RETRIEVER
    // ports, not the model. A real consumer swaps in any model/dim here.
    doc: { model: "stub-embed", dim: 8 },
  },
  enrich: {
    stages: [
      {
        name: "extract",
        // The row's raw data is serialised into the prompt; the (stubbed) generate
        // closure reads it back and returns canonical structured attributes. A real
        // consumer wires an LLM here — the enrich pipeline shape is identical.
        prompt: (ctx) => JSON.stringify(ctx.data),
        schema: () => ({
          type: "object",
          properties: {
            title: { type: "string" },
            brand: { type: "string" },
            color: { type: "string" },
            category: { type: "string" },
            vendor: { type: "string" },
            gtin: { type: "string" },
          },
          required: ["title", "brand", "color", "category", "vendor", "gtin"],
        }),
      },
    ],
  },
  indexing: {
    surfaces: {
      doc: {
        kind: "dense",
        embedding: "doc",
        build: (ctx) =>
          [ctx.enriched.title, ctx.enriched.brand, ctx.enriched.color, ctx.enriched.category]
            .filter((s) => s != null && s !== "")
            .join(" "),
      },
      fts: {
        kind: "fts",
        build: (ctx) =>
          [ctx.enriched.title, ctx.enriched.brand, ctx.enriched.color, ctx.enriched.category]
            .filter((s) => s != null && s !== "")
            .join(" "),
      },
    },
    gate: gates.always,
  },
  dedup: {
    channels: [
      { kind: "exactKey", field: "gtin" },
      { kind: "trigram", field: "title", weight: 1 },
      { kind: "cosine", weight: 1 },
    ],
    autoLink: 0.9,
    suggest: 0.6,
    offerFields: ["vendor", "price", "available"],
    groupField: "product_group",
  },
  search: {
    channels: [
      { kind: "fts", fields: ["title"], weight: 1 },
      { kind: "cosine", embedding: "doc", weight: 1 },
    ],
    combiner: "rrf",
    nlq: { enable: true },
  },
}) as CollectionDef;

export type ProductRow = {
  id: string;
  data: {
    title: string;
    brand: string;
    color: string;
    category: string;
    vendor: string;
    gtin: string;
    price: number;
    available: boolean;
  };
};

// ~10 products with cross-vendor duplicates (same gtin, different vendor). gtin 1001
// is listed by three vendors; 2002 by two; the rest are singletons. Deterministic.
export const CATALOG: ProductRow[] = [
  { id: "p1", data: { title: "Red Running Shoes", brand: "Nike", color: "red", category: "footwear", vendor: "Footlocker", gtin: "1001", price: 120, available: true } },
  { id: "p2", data: { title: "Red Runing Shoe", brand: "Nike", color: "red", category: "footwear", vendor: "Amazon", gtin: "1001", price: 115, available: true } },
  { id: "p3", data: { title: "Black Leather Wallet", brand: "Gucci", color: "black", category: "accessories", vendor: "Footlocker", gtin: "2002", price: 300, available: true } },
  { id: "p4", data: { title: "Blk Leather Wallets", brand: "Gucci", color: "black", category: "accessories", vendor: "eBay", gtin: "2002", price: 290, available: false } },
  { id: "p5", data: { title: "Blue Denim Jacket", brand: "Levis", color: "blue", category: "apparel", vendor: "Footlocker", gtin: "3003", price: 90, available: true } },
  { id: "p6", data: { title: "Green Canvas Sneakers", brand: "Converse", color: "green", category: "footwear", vendor: "Zappos", gtin: "4004", price: 70, available: true } },
  { id: "p7", data: { title: "White Cotton T-Shirt", brand: "Hanes", color: "white", category: "apparel", vendor: "Amazon", gtin: "5005", price: 15, available: true } },
  { id: "p8", data: { title: "Nike Red Runner", brand: "Nike", color: "red", category: "footwear", vendor: "Walmart", gtin: "1001", price: 125, available: true } },
  { id: "p9", data: { title: "Grey Wool Scarf", brand: "Uniqlo", color: "grey", category: "accessories", vendor: "Zappos", gtin: "6006", price: 25, available: true } },
  { id: "p10", data: { title: "Yellow Rain Coat", brand: "Patagonia", color: "yellow", category: "apparel", vendor: "eBay", gtin: "7007", price: 140, available: true } },
];
