---
title: Build Fashion Search
description: Wire a messy fashion catalog into Samesake visual-commerce search.
---

# Build Fashion Search

This guide shows the shape of a Samesake configuration for a messy fashion catalog. It is the practical path behind the positioning in [Samesake positioning](../positioning.md) and the measured proof in [Fashion Search Proof](../fashion-search-proof.md).

Use it when your catalog has weak titles, inconsistent attributes, image URLs, and shoppers who search by intent instead of product name.

## Catalog Shape

Start by normalizing each product into this minimum shape:

```ts
type FashionProduct = {
  id: string;
  title: string;
  brand?: string;
  price?: number;
  sizes?: string[];
  color?: string;
  material?: string;
  occasion?: string;
  style_tags?: string[];
  available?: boolean;
  image_url?: string;
  updated_at?: string;
};
```

Keep the raw catalog data in `data`. Samesake can extract searchable columns from paths and store the full JSON document for display/debugging.

## Copy-Paste Config

Create `samesake.config.ts`:

```ts
import { Channels, collection, f, fashionSearchPreset, pipeline, s, stage } from "@samesake/core";

// Fast path: use the preset, then override when your catalog needs custom fields.
export const presetProducts = fashionSearchPreset({
  textModel: "gemini-embedding-2",
  textDim: 768,
  imageModel: "gemini-embedding-2",
  imageDim: 768,
});

export const products = collection("products", {
  fields: {
    title: f.text({ searchable: true }),
    brand: f.text({ filterable: true, facet: true }),
    price: f.number({ filterable: true, facet: "range", budget: true }),
    sizes: f.array(f.enum(["XS", "S", "M", "L", "XL"]), { filterable: true, facet: true }),
    color: f.text({ filterable: true, facet: true }),
    material: f.text({ filterable: true, facet: true }),
    occasion: f.text({ filterable: true, facet: true, soft: true }),
    style_tags: f.array({ type: "text" }, { filterable: true, facet: true, soft: true }),
    available: f.boolean({ filterable: true }),
    image_url: f.text(),
  },
  enrich: pipeline(
    stage("fashion_attributes", {
      model: "gemini-3.1-flash-lite",
      prompt: ({ data }) =>
        `Extract fashion search attributes for this catalog item. Title: ${data.title}. Brand: ${data.brand ?? ""}.`,
      images: ({ data }) => (typeof data.image_url === "string" ? [data.image_url] : []),
      schema: () => ({
        type: "object",
        properties: {
          occasion: { type: "string" },
          material: { type: "string" },
          style_tags: { type: "array", items: { type: "string" } },
          confidence: { type: "number" },
        },
      }),
    })
  ),
  embeddings: {
    doc: {
      source: "$title $brand $color $material $occasion",
      model: "gemini-embedding-2",
      dim: 1536,
    },
  },
  spaces: {
    intent: s.text({
      source: "$title $brand $color $material $occasion",
      model: "gemini-embedding-2",
      dim: 768,
    }),
    visual: s.image({
      source: "$image_url",
      model: "gemini-embedding-2",
      dim: 768,
    }),
    price: s.number({ field: "price", mode: "closer", dims: 8, min: 0, max: 100000, scale: "log" }),
    freshness: s.recency({ field: "updated_at", halfLifeDays: 30, dims: 8 }),
  },
  search: {
    channels: [
      Channels.fts({ fields: ["title", "brand", "color", "material", "occasion"], weight: 1 }),
      Channels.cosine({ embedding: "doc", weight: 1 }),
      Channels.spaces({ weight: 1 }),
      Channels.recency({ field: "updated_at", halfLifeDays: 30, weight: 0.1 }),
    ],
    combiner: "rrf",
    defaultSpaceWeights: {
      intent: 1,
      visual: 1,
      price: 0.25,
      freshness: 0.1,
    },
    nlq: {
      enable: true,
      semanticRewrite: true,
      instructions:
        "Extract hard fashion filters such as brand, max_price, size, color, material, occasion, and availability. Leave style intent in semantic_query.",
    },
  },
});

export default {
  collections: [products],
  entities: [],
};
```

The total vector dimensions stay below pgvector's default HNSW `vector` limit of 2000 dimensions: `intent` 768 + `visual` 768 + `price` 8 + `freshness` 8 = 1552.

## Wire Runtime Capabilities

Image spaces require an embedder that can handle image inputs when indexing product images. Enrichment image inputs require `generate`.

```ts
import { createMatcher } from "@samesake/server";
import config from "./samesake.config.ts";

const matcher = createMatcher({
  databaseUrl: process.env.DATABASE_URL!,
  apiKey: process.env.SAMESAKE_API_KEY!,
  embed: async (input) => {
    // Call your embedding provider here.
    // Must support text query embeddings and image/document embeddings if visual spaces are enabled.
    return embedWithYourProvider(input);
  },
  generate: async ({ model, prompt, images, schema }) => {
    return generateJsonWithYourProvider({ model, prompt, images, schema });
  },
});

await matcher.apply("shop", config);
```

## Ingest, Enrich, Index

```ts
await matcher.pushDocuments("shop", "products", messyProducts);
await matcher.enrich("shop", "products");
await matcher.index("shop", "products");
```

For connector-based ingestion, use the Shopify/Woo/JSONL source primitives shown in [`examples/fashion-search/`](../../examples/fashion-search/).

## Search Modes

First-class fashion request:

```ts
await matcher.fashionSearch("shop", "products", {
  q: "modest wedding guest dress under 20000",
  image: { url: "https://example.com/reference-look.jpg" },
  filters: { available: true },
  rankingPolicy: { weights: { visual: 2, availability: 1 } },
  personalization: {
    size: "M",
    preferredBrands: ["Aster"],
    priceBand: { max: 20000 },
  },
  recoverNoResults: true,
  debug: true,
});
```

The response includes `hits`, `parsed`, `appliedFilters`, optional `fallback`, and debug explanations showing relevance, visual, availability, business, and personalization factors. Personalization is request-scoped; callers own identity/user data and Samesake does not persist shopper preferences unless the application explicitly stores them.

Text-only intent:

```ts
await matcher.search("shop", "products", {
  q: "modest wedding guest dress under 20000",
  filters: { available: true },
  facets: ["brand", "color", "sizes", "price"],
});
```

Visual-commerce weighting:

```ts
await matcher.search("shop", "products", {
  q: "similar look but cheaper and in black",
  filters: { available: true, color: "black" },
  weights: { spaces: { visual: 2, intent: 1, price: 0.5 } },
});
```

Debug the ranking:

```ts
await matcher.searchExplain("shop", "products", {
  q: "linen resort shirt under 15000",
  filters: { available: true },
  limit: 5,
});
```

Inspect `filters`, `weights`, per-leg ranks, and `space_cosines` to see whether visual, text, price, or freshness signals are doing the work.

## Eval

Run the packaged fixture eval:

```bash
cd examples/fashion-search
bun eval.ts
```

It writes `.samesake/fashion-eval.json` and `.samesake/fashion-eval.md` with relevance@k, constraint compliance, zero-result rate, latency, and cost. Set `FASHION_SEARCH_BASE=http://localhost:8788` plus `API_KEY` to evaluate a running Samesake API, and set `FASHION_DATASET_DIR=...` when running against the larger parity dataset snapshot.

The eval treats relevance and constraint satisfaction as separate gates. A result can be textually relevant and still fail the search if it violates price, availability, required color, excluded color, or another hard commerce constraint. The report therefore includes:

- `relevance@3` for ranking quality among intended products
- `constraint overall@5` for per-result hard-constraint satisfaction
- `perfect constraint@5` for whether every top-5 result satisfies every declared constraint
- per-type metrics such as `price@5`, `available@5`, `colorRequired@5`, and `colorExcluded@5`
- `zero-result rate` and `relaxation rate` so over-constrained searches are visible

`FASHION_DATASET_DIR` accepts `.json` or `.jsonl` files. Each file can contain `{ "products": [...], "queries": [...] }`, individual product/query records, or JSONL records shaped as `{ "type": "product", "data": ... }` and `{ "type": "query", "data": ... }`.

## Failure Paths

- **Missing image embed capability**: image spaces will fail lazily when indexing or querying needs image embeddings. Either provide an image-capable embedder or remove the `visual` space.
- **Missing API key**: `createMatcher` requires an API key for HTTP routes. Set `SAMESAKE_API_KEY` or pass `apiKey`.
- **Over-large dimensions**: pgvector HNSW `vector` indexes support up to 2000 dimensions. Samesake rejects oversized entity embeddings, collection embeddings, and combined spaces before DDL.
- **Unsafe image URL**: remote image fetching blocks localhost, private networks, metadata IPs, non-image content types, oversized responses, and redirects to blocked destinations.
- **No results**: first inspect hard filters and availability. Then use `searchExplain` to see whether FTS, cosine, spaces, or recency produced candidates.

## Proof Link

The measured parity path lives in [Fashion Search Proof](../fashion-search-proof.md). The full external-dataset example lives in [`examples/fashion-search/`](../../examples/fashion-search/).
