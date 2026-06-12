# Migrating from Superlinked

Superlinked (Python) is archived. samesake carries the **typed spaces + query-time weights** idea into TypeScript with a config-driven, Postgres-only stack. This map is **as-built** — not aspirational.

## Concept mapping

| Superlinked | samesake |
|-------------|----------|
| `Space` (text, number, recency, categorical, …) | `s.text`, `s.number`, `s.recency`, `s.categorical`, `s.image` in `collection().spaces` |
| `Index` / concatenated vector | Single `space_vec` column + HNSW; built at index time (`embed-index`) |
| `Query` with param → weight | `matcher.search(..., { weights: { spaces: { style: 2 } } })` or HTTP `weights` param |
| `Executor` (in-memory runtime) | `createMatcher` + Postgres; three surfaces: in-process, `fetch`, Hono `app` |
| Multiple indices / stores | One Postgres project schema per `apply` |
| Model serving | **BYO** — you supply `embed` (and optional `generate` / `parse`) |

## Minimal port

Superlinked-style app sketch:

```python
# Superlinked (illustrative)
space = TextSimilaritySpace("description", ...)
index = Index([space])
query = index.query(...).find(description_param)
```

samesake equivalent:

```ts
import { collection, f, Channels, s } from "@samesake/core";
import { createMatcher } from "@samesake/server";

const products = collection("products", {
  fields: { title: f.text({ searchable: true }), price: f.number({ filterable: true }) },
  spaces: {
    style: s.text({ source: "$title", model: "your-model", dim: 768 }),
    price: s.number({ field: "price", mode: "closer", dims: 8, min: 0, max: 10000 }),
  },
  search: {
    channels: [Channels.fts({ fields: ["title"], weight: 1 }), Channels.spaces({ weight: 1 })],
    combiner: "rrf",
    defaultSpaceWeights: { style: 1, price: 0.5 },
  },
});

const matcher = createMatcher({ databaseUrl, apiKey, embed: yourEmbedFn });
await matcher.apply("shop", { entities: [], collections: [products] });
await matcher.pushDocuments("shop", "products", docs);
await matcher.index("shop", "products");
const hits = await matcher.search("shop", "products", {
  q: "linen shirt",
  weights: { spaces: { style: 2, price: 0 } },
});
```

## Three consumption surfaces

1. **In-process** — `matcher.search`, `matcher.match`, …
2. **HTTP** — `matcher.fetch(request)` for Bun, Workers, Vercel, Deno
3. **Compose** — `matcher.app` (Hono) mounted in an existing service

There is no separate query executor object — the matcher is the runtime.

## Not supported (honest list)

| Superlinked / Python ecosystem | samesake |
|-------------------------------|----------|
| Python SDK | TypeScript only |
| In-memory executor / no database | Postgres required |
| Dynamic spaces at runtime (add space without re-apply) | Spaces fixed in `collection()` config; change → migration + reindex |
| Built-in model serving | BYO embed/generate; no bundled models |
| Arbitrary vector DB (Pinecone, Qdrant, …) | pgvector only |
| Admin UI | HTTP + CLI only |
| Flat multi-index fan-out | Single hybrid search with RRF legs |

## Quality expectations

Spaces failed the fashion parity gate with flat default weights — capability ships **off by default**. Run your own golden-set eval before enabling `Channels.spaces`. See [`spaces-gate.md`](./spaces-gate.md) and [`spaces.md`](./spaces.md).

## Further reading

- [`spaces.md`](./spaces.md) — math, encodings, weight tuning
- [`production.md`](./production.md) — policy, metrics, migrations, keys
- [`examples/hello-spaces/run.ts`](../examples/hello-spaces/run.ts) — runnable weight-flip demo
