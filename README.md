# samesake

A dev-first commerce search framework on a shared Postgres substrate. Config-as-code **search** (hybrid FTS + vector retrieval, filters, facets, NLQ, enrichment pipelines, connectors) and **match** (entity resolution, dedup, aliases) coexist in one factory — BYO embedding and generation models, web-standard `fetch`, no Redis or Elasticsearch.

Built on Bun + Hono + Postgres + pgvector. Two containers in production: Postgres and your app process.

## 60-second example

```ts
import { collection, f, Channels } from "@samesake/core";
import { createMatcher } from "@samesake/server";

const products = collection("products", {
  fields: {
    title: f.text({ searchable: true }),
    brand: f.text({ filterable: true }),
    price: f.number({ filterable: true }),
  },
  embeddings: {
    doc: { source: "$title", model: "gemini-embedding-2", dim: 1536 },
  },
  search: {
    channels: [
      Channels.fts({ fields: ["title"], weight: 1 }),
      Channels.cosine({ embedding: "doc", weight: 1 }),
    ],
    combiner: "rrf",
  },
});

const matcher = createMatcher({
  databaseUrl: process.env.DATABASE_URL!,
  apiKey: process.env.API_KEY!,
  embed: async ({ text, dim }) => /* your embed fn */,
});

await matcher.apply("shop", { entities: [], collections: [products] });
await matcher.pushDocuments("shop", "products", [{ id: "1", data: { title: "linen shirt", brand: "zara", price: 45 } }]);
await matcher.index("shop", "products");

const hits = await matcher.search("shop", "products", { q: "linen shirt", filters: { brand: "zara" }, limit: 10 });
```

Runnable without any LLM: [`bun examples/hello-search/run.ts`](./examples/hello-search/run.ts).

## Spaces (60 seconds)

Typed embedding spaces concatenate into one `space_vec` column; query-time `weights` rescale segments without reindexing. **Off by default** — the fashion parity gate did not pass with flat weights ([`docs/spaces-gate.md`](./docs/spaces-gate.md)).

```ts
import { collection, f, Channels, s } from "@samesake/core";

const products = collection("products", {
  fields: {
    title: f.text({ searchable: true }),
    price: f.number({ filterable: true }),
  },
  spaces: {
    style: s.text({ source: "$title", model: "gemini-embedding-2", dim: 768 }),
    price: s.number({ field: "price", mode: "closer", dims: 8, min: 0, max: 50000, scale: "log" }),
  },
  search: {
    channels: [
      Channels.fts({ fields: ["title"], weight: 1 }),
      Channels.spaces({ weight: 1 }), // enable only after your own eval gate
    ],
    combiner: "rrf",
    defaultSpaceWeights: { style: 1, price: 0.3 },
  },
});

const hits = await matcher.search("shop", "products", {
  q: "linen shirt",
  weights: { spaces: { style: 2, price: 0 } },
});
```

Runnable demo (stub embed, weight flip): [`bun examples/hello-spaces/run.ts`](./examples/hello-spaces/run.ts). Docs: [`docs/spaces.md`](./docs/spaces.md) · [`docs/migrating-from-superlinked.md`](./docs/migrating-from-superlinked.md) · [`docs/production.md`](./docs/production.md) · [`docs/release.md`](./docs/release.md).

## Three consumption surfaces

`createMatcher(config)` returns one object with three ways to call it:

| Surface | Use when |
|---------|----------|
| **In-process** — `matcher.search(...)`, `matcher.match(...)` | Hot paths inside your app; no HTTP overhead |
| **Web-standard** — `matcher.fetch(request)` | Bun.serve, Cloudflare Workers, Vercel, Deno |
| **Composable** — `matcher.app` (Hono) | Mount at `/v1` inside an existing Hono service |

## Capabilities

| Search | Match |
|--------|-------|
| Hybrid RRF (FTS + cosine ANN + optional recency) | Multi-channel scoring (cosine, trigram, phonetic, phone, alias) |
| Mongo-style filters pushed into SQL | Scope-isolated entity resolution |
| Facets (enum, array unnest, numeric ranges) | Dedup clusters + variant suggestions |
| NLQ → hard filters + semantic residual | Structured parse gates (brand, size, internal code) |
| Multi-stage enrichment pipeline + stage cache | Confirm / decline → alias active learning |
| Connectors (Shopify, Woo, JSONL) + document push | `/explain` per-channel score breakdown |
| Eval harness (golden queries + ESCI judge) | F1 threshold calibration per scope |
| Query-time channel weights | `/match-batch` for bulk workloads |

Search and match share embeddings, Postgres caches, and per-project runtime DDL.

## Quickstart

| Path | Time | LLM required |
|------|------|--------------|
| [Search quickstart](./docs/quickstart-search.md) — collection → push → index → search | ~15 min | No (stub embed) |
| [Match tutorial](./docs/tutorial.md) — entity → seed → match | ~15 min | Yes (Gemini embed) |
| [`examples/hello-search/`](./examples/hello-search/) — minimal search smoke | 30 sec | No |
| [`examples/hello-spaces/`](./examples/hello-spaces/) — spaces weight-flip demo | 30 sec | No |
| [`examples/hello/`](./examples/hello/) — match smoke (19 assertions) | 30 sec | Yes |
| [`examples/fashion-search/`](./examples/fashion-search/) — full pipeline + parity eval | hours | Yes |

```bash
bun install
cp .env.example .env   # DATABASE_URL + API keys

# Search (no LLM)
bun examples/hello-search/run.ts
bun examples/hello-spaces/run.ts

# Dev server (config watch + re-apply)
bun packages/cli/src/index.ts dev --config examples/hello-search/samesake.config.ts --project dev

# Match (needs running server + Gemini)
bun run dev            # terminal 1
bun run examples:hello # terminal 2
```

## Architecture

```
samesake.config.ts          # collection() + entity() declarations
        │
        ▼
createMatcher({ embed, generate?, ... })
        │
        ├── collections-schema-gen  →  per-project search tables (fts, vector, filter cols)
        ├── schema-gen              →  per-project entity tables (match)
        ├── ingest / enrich / index →  connectors, pipeline, embeddings
        ├── search / facets / nlq   →  hybrid RRF retrieval
        └── match / dedup / explain →  entity resolution
        │
        ▼
Postgres (pgvector + pg_trgm + unaccent + fuzzystrmatch)
```

One factory, two capabilities. Fashion is the first vertical preset — see [`examples/fashion-search/PARITY.md`](./examples/fashion-search/PARITY.md).

## Match in brief

Entity resolution still ships unchanged. Declare `entity()` with scoring channels; the matcher returns ranked candidates with per-channel transparency:

```ts
import { entity, fields, Scorers } from "@samesake/core";

export const customer = entity("customer", {
  fields: {
    name: fields.text({ required: true }),
    phone: fields.text({ optional: true }),
  },
  scopes: ["tenantId"],
  embeddings: {
    name_emb: { source: "name", model: "gemini-embedding-001", dim: 768 },
  },
  scoring: {
    channels: [
      Scorers.phoneExact({ field: "phone", weight: 1.0 }),
      Scorers.cosine({ embedding: "name_emb", weight: 0.6 }),
      Scorers.trigram({ field: "name", weight: 0.25 }),
      Scorers.aliasHit({ weight: 0.4 }),
    ],
  },
});
```

Cross-script matching, product parse gates, and the 19-assertion smoke test live in [`examples/hello/`](./examples/hello/).

## Stack

| Layer | Choice |
|-------|--------|
| Runtime | [Bun](https://bun.sh) 1.3+ |
| HTTP | [Hono](https://hono.dev/) — universal `fetch` handler |
| Database | Postgres 15+ with [pgvector](https://github.com/pgvector/pgvector) + `pg_trgm` + `unaccent` + `fuzzystrmatch` |
| Driver | [postgres-js](https://github.com/porsager/postgres) via Drizzle (raw SQL; schema generated per project at runtime) |
| Validation | [Zod](https://zod.dev) |
| AI | BYO — consumer supplies `embed` and optional `generate` / `parse` |

No Redis. No Elasticsearch. No LanceDB. No ORM with static schemas.

## Setup

```bash
git clone <repo>
cd samesake
bun install

createdb samesake_dev
psql samesake_dev -c "CREATE EXTENSION vector; CREATE EXTENSION pg_trgm; CREATE EXTENSION unaccent; CREATE EXTENSION fuzzystrmatch;"

cp .env.example .env
bun run dev
curl localhost:3030/v1/healthz
```

Deploy: see [`deploy/`](./deploy/) (Fly.io, Cloudflare Workers, local `bun run dev`).

## Examples

| Example | Status | Command |
|---------|--------|---------|
| [`hello-search`](./examples/hello-search/) | Release gate | `bun examples/hello-search/run.ts` |
| [`hello-spaces`](./examples/hello-spaces/) | Release gate | `bun examples/hello-spaces/run.ts` |
| [`hello`](./examples/hello/) | Release gate (needs Gemini) | `bun examples/hello/run.ts` |
| [`quickstart`](./examples/quickstart/) | Runnable | `bun examples/quickstart/run.ts` |
| [`fashion-search`](./examples/fashion-search/) | External dataset required | Set `FASHION_DATASET_DIR` — see README |

`@samesake/jobs-pgboss` is **experimental** — optional pg-boss adapter; not part of the core 1.0 gate.

## Status & naming

NPM packages: **`@samesake/core`** (SDK), **`@samesake/server`**, **`@samesake/cli`** at **1.0.0**. This project was formerly **samesake** / **linkable** (entity resolution) before the commerce search framework work. The HTTP app still lives at `apps/matcher/`.

Search and match share embeddings, Postgres caches, and per-project runtime DDL.

## License

MIT. See [LICENSE](./LICENSE).
