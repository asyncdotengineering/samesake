# Search quickstart

Get from zero to hybrid search in under 15 minutes. No LLM API key required for this path — we use a deterministic stub embedder.

## Prerequisites

- Bun 1.3+
- Postgres 15+ with `vector`, `pg_trgm`, `unaccent`, `fuzzystrmatch`
- `DATABASE_URL` in `.env` at the repo root

```bash
cp .env.example .env
# set DATABASE_URL=postgresql://...
```

## 1. Install

From the repo root:

```bash
bun install
```

Workspace packages `@samesake/core` (SDK) and `@samesake/server` (runtime) link automatically.

## 2. Declare a collection

Create `samesake.config.ts` (or copy from [`examples/hello-search/samesake.config.ts`](../examples/hello-search/samesake.config.ts)):

```ts
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
```

`Channels.cosine({ embedding: "doc" })` must reference a key in `embeddings` — typos fail at compile time.

## 3. Wire `createMatcher`

```ts
import { createMatcher } from "@samesake/server";
import { products } from "./samesake.config.ts";

function stubEmbed(text: string, dim: number): number[] {
  const out = new Array(dim).fill(0);
  for (let i = 0; i < text.length; i++) {
    out[i % dim] = (out[i % dim]! + text.charCodeAt(i) * 0.001) % 1;
  }
  const norm = Math.sqrt(out.reduce((s, x) => s + x * x, 0)) || 1;
  return out.map((x) => x / norm);
}

const matcher = createMatcher({
  databaseUrl: process.env.DATABASE_URL!,
  apiKey: "dev-key",
  migrate: "eager",
  embed: async ({ text, dim }) => stubEmbed(text, dim),
});

await matcher.migrate();
await matcher.apply("demo", { entities: [], collections: [products] });
```

## 4. Push documents and index

```ts
await matcher.pushDocuments("demo", "products", [
  { id: "1", data: { title: "red running shoes", brand: "nike", price: 120, category: "shoes" } },
  { id: "2", data: { title: "blue casual sneakers", brand: "adidas", price: 90, category: "shoes" } },
  { id: "3", data: { title: "leather wallet", brand: "nike", price: 45, category: "accessories" } },
]);

await matcher.index("demo", "products");
```

`pushDocuments` is the in-process equivalent of `POST /v1/projects/:p/collections/:c/documents`. `index` resolves the embedding template, calls your `embed` function, and writes vectors + filter columns.

## 5. Search

```ts
const result = await matcher.search("demo", "products", {
  q: "running shoes",
  filters: { brand: "nike" },
  limit: 5,
});

console.log(result.hits.map((h) => ({ id: h.id, title: h.title, score: h.score })));
```

Or over HTTP:

```bash
curl -H "Authorization: Bearer dev-key" \
  "http://localhost:3030/v1/projects/demo/collections/products/search?q=wallet&limit=5"
```

Filters use Mongo-style operators (`$eq`, `$gt`, `$in`, `$contains`, …). Unknown filter keys throw at call time.

## Runnable example

The repo ships a self-contained smoke test:

```bash
bun examples/hello-search/run.ts
```

Expected output:

```
hello-search — hybrid search smoke
project: hello_search_xxxxxx

▸ apply collection schema... ✓ (project_hello_search_xxxxxx)
▸ push 5 documents... ✓
▸ index with stub embed... ✓
▸ hybrid search + brand filter... ✓
  top: "red running shoes" (score 0.0328)
▸ GET /collections/.../search route... ✓

5 passed, 0 failed

✓ hello-search is green.
```

## Next steps

| Goal | Where |
|------|-------|
| Full pipeline (ingest → enrich → index → NLQ) | [`examples/fashion-search/`](../examples/fashion-search/) |
| Entity resolution (match, dedup, aliases) | [`examples/hello/`](../examples/hello/) + [`docs/tutorial.md`](./tutorial.md) |
| Three consumption surfaces (in-process / fetch / Hono) | [`docs/usage-patterns.md`](./usage-patterns.md) |
| Eval contract + quality methodology | [`docs/QUALITY.md`](./QUALITY.md) · [`BENCHMARKS.md`](../BENCHMARKS.md) |

To add NLQ and enrichment, supply a `generate` function to `createMatcher` and declare `enrich:` / `search.nlq` on your collection — see `examples/fashion-search/samesake.config.ts`.
