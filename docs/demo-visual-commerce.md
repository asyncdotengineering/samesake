# Visual-Commerce Demo Script

This is a script for showing Samesake to a developer, founder, or investor without hand-waving. It is written as a markdown demo first; a recorded demo can follow later.

## Job

The shopper has a screenshot or inspiration image and vague fashion intent:

> "I want this kind of look for a wedding, but modest, available now, and under 20,000."

They do not know the product name. They care about visual similarity, occasion, constraints, price, and availability.

## Setup

Use the fashion example when the external dataset is available:

```bash
cd examples/fashion-search
bun --env-file=../../.env ingest.ts
bun --env-file=../../.env run-pipeline.ts
bun --env-file=../../.env serve.ts
```

For a smaller local explanation, use the config shape in [Build Fashion Search](./how-to/build-fashion-search.md).

## Scene 1: Text-Only Intent

Search:

```ts
await matcher.search("shop", "products", {
  q: "modest wedding guest dress under 20000",
  filters: { available: true },
  facets: ["brand", "color", "sizes", "price"],
  limit: 10,
});
```

Expected shape:

```ts
{
  hits: [
    {
      id: "sku_...",
      score: 0.032,
      brand: "...",
      price: 18900,
      available: true,
      data: { title: "...", image_url: "..." }
    }
  ],
  parsed: {
    semantic_query: "modest wedding guest dress",
    max_price: 20000,
    available: true
  },
  relaxed: false,
  facets: { brand: { values: [...] }, price: { min: ..., max: ..., buckets: [...] } }
}
```

What to say:

- The shopper typed intent, not an exact title.
- The LLM parser turns price and availability into hard filters.
- The remaining phrase stays as semantic intent for retrieval.

## Scene 2: Reverse-Image / Similar-Look Search

Search with visual weighting when visual spaces are configured:

```ts
await matcher.search("shop", "products", {
  q: "similar silhouette and vibe",
  weights: { spaces: { visual: 2, intent: 0.5, price: 0 } },
  limit: 10,
});
```

What to inspect in `searchExplain`:

```ts
await matcher.searchExplain("shop", "products", {
  q: "similar silhouette and vibe",
  weights: { spaces: { visual: 2, intent: 0.5, price: 0 } },
  limit: 5,
});
```

Look for:

- `weights.spaces`
- `docs[*].spaces_rank`
- `docs[*].space_cosines.visual`

What to say:

- Visual similarity is one retrieval space, not the entire ranking system.
- The developer can raise or lower visual influence without reindexing.

## Scene 3: Image + Constraint Refinement

Refine the visual search with commerce constraints:

```ts
await matcher.search("shop", "products", {
  q: "similar look, black, under 20000, available now",
  filters: {
    color: "black",
    available: true,
  },
  weights: { spaces: { visual: 2, intent: 1, price: 0.5 } },
  limit: 10,
});
```

What to say:

- The visual leg finds similar looks.
- Hard filters enforce color and availability.
- Budget parsing or explicit filters enforce price.
- Ranking policy decides how much visual similarity trades off against intent, price, and freshness.

## Developer Surface

Show the TypeScript config, not a dashboard toggle:

```ts
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
}
```

Show the search API call:

```ts
await matcher.search("shop", "products", {
  q,
  filters,
  weights,
  facets,
  limit: 10,
});
```

Show the explain API:

```ts
await matcher.searchExplain("shop", "products", { q, filters, weights, limit: 5 });
```

## Close With Proof

Use the measured claim from [Fashion Search Proof](./fashion-search-proof.md):

Samesake met the parity acceptance gate on the same 4,555-product fashion corpus and 50-query external harness used by the spike. It reproduced the spike's quality within tolerance, matched its price-violation rate, had zero result rate of 0.00 on that query set, and recorded lower median latency in that run.

Do not claim broader visual-search superiority, personalization, or production dominance without a new measured run.
