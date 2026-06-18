# samesake

Samesake is a TypeScript-first search engine compiler for visual commerce, starting with fashion.

It is built for shoppers who do not know the product name: screenshots, similar-look search, vague intent, budget constraints, occasion, size, availability, and merchant ranking policy. You declare the catalog and retrieval spaces in TypeScript; Samesake compiles them into a Postgres-backed search layer you can run inside your app.

Proof and positioning:

- [Positioning contract](./docs/positioning.md)
- [Fashion search proof](./docs/fashion-search-proof.md)
- [Build fashion search from a messy catalog](./docs/how-to/build-fashion-search.md)
- [Agentic commerce retrieval direction](./docs/agentic-commerce-direction.md)
- [Visual-commerce demo script](./docs/demo-visual-commerce.md)

## 60-second fashion search

```ts
import { collection, f, Channels, s } from "@samesake/core";
import { createMatcher } from "@samesake/server";

const products = collection("products", {
  fields: {
    title: f.text({ searchable: true }),
    brand: f.text({ filterable: true, facet: true }),
    price: f.number({ filterable: true, facet: "range", budget: true }),
    color: f.text({ filterable: true, facet: true }),
    occasion: f.text({ filterable: true, soft: true }),
    available: f.boolean({ filterable: true }),
    image_url: f.text(),
  },
  embeddings: {
    doc: { source: "$title $brand $color $occasion", model: "gemini-embedding-2", dim: 1536 },
  },
  spaces: {
    intent: s.text({ source: "$title $brand $color $occasion", model: "gemini-embedding-2", dim: 768 }),
    visual: s.image({ source: "$image_url", model: "gemini-embedding-2", dim: 768 }),
    price: s.number({ field: "price", mode: "closer", dims: 8, min: 0, max: 100000, scale: "log" }),
  },
  search: {
    channels: [
      Channels.fts({ fields: ["title", "brand", "color", "occasion"], weight: 1 }),
      Channels.cosine({ embedding: "doc", weight: 1 }),
      Channels.spaces({ weight: 1 }),
    ],
    combiner: "rrf",
    defaultSpaceWeights: { intent: 1, visual: 1, price: 0.25 },
    nlq: { enable: true, semanticRewrite: true },
  },
});

const matcher = createMatcher({
  databaseUrl: process.env.DATABASE_URL!,
  apiKey: process.env.API_KEY!,
  embed: async ({ text, dim }) => /* your embed fn */,
});

await matcher.apply("shop", { entities: [], collections: [products] });
await matcher.pushDocuments("shop", "products", [{
  id: "1",
  data: {
    title: "black linen wedding guest dress",
    brand: "atelier",
    price: 18900,
    color: "black",
    occasion: "wedding",
    available: true,
    image_url: "https://cdn.example.com/dress.jpg",
  },
}]);
await matcher.index("shop", "products");

const hits = await matcher.search("shop", "products", {
  q: "similar wedding guest look under 20000 in black",
  filters: { available: true },
  weights: { spaces: { visual: 2, intent: 1, price: 0.5 } },
  limit: 10,
});
```

For a no-LLM smoke test, run [`bun examples/hello-search/run.ts`](./examples/hello-search/run.ts). For the external fashion corpus and eval path, see [`examples/fashion-search/`](./examples/fashion-search/) and [Fashion Search Proof](./docs/fashion-search-proof.md).

## What Makes It Different

Samesake is not a hosted vector DB, a generic RAG framework, or only keyword search. It is a typed retrieval layer for commerce catalogs where:

- image similarity, text intent, structured attributes, price, freshness, and availability are separate signals
- hard filters stay hard, so "under 20000" and "available now" are not soft semantic vibes
- query-time weights let you tune visual, intent, price, and freshness influence without reindexing
- **search has a `mode`**: `"intent"` (default for text) keeps keyword as a *tiebreaker* under semantics + NLQ filters; `"similar"` (default when a query image is present) turns keyword off so genuine visual + semantic similarity decides. "Similar" means look/feel, not shared words.
- `/search/explain` shows per-leg ranks and space cosines for debugging
- the same factory also supports entity resolution and deduplication for catalog/customer records

Built on Bun + Hono + Postgres + pgvector. Two containers in production: Postgres and your app process. BYO embedding and generation models; no Redis or Elasticsearch.

## Search modes: intent vs similar

Intent retrieval and similarity retrieval are different problems and need different channel weighting — a single flat weighting serves neither well. Samesake picks the right one per query.

```ts
// Intent (default for text): "find items that match this need".
// Keyword is a tiebreaker beneath semantic; NLQ turns "under 20000" into a hard filter.
await matcher.search("shop", "products", { q: "linen shirt for the office under 20000" });

// Similar (default when an image is present): "find items that look/feel like this".
// Keyword is OFF — a "black cocktail dress" graphic tee will NOT rank for a black-dress look.
await matcher.search("shop", "products", { q: "flowy black cocktail dress", mode: "similar" });
await matcher.search("shop", "products", { image: { url: screenshotUrl } }); // mode auto = "similar"
```

Why a mode and not one global weighting: with flat `fts = cosine`, a keyword-only match gets a guaranteed top seat in RRF, so word-decoys outrank genuinely similar items ("similar" collapses into keyword matching). Dropping keyword entirely instead regresses intent exactness ("linen shirt **men**"). `mode` resolves the tension — keyword is a tiebreaker for intent and off for similarity. Explicit `weights` still override the mode. See [`examples/fashion-search/repro-similar.ts`](./examples/fashion-search/repro-similar.ts), [`repro-visual.ts`](./examples/fashion-search/repro-visual.ts), and [`eval-configs-lk.ts`](./examples/fashion-search/eval-configs-lk.ts) for the live evidence.

### Retrieval defaults & seams (zero-config by default)

Six fashion/e-commerce primitives are baked into the core, on the principle of great defaults with no required config:

| Primitive | Behavior | Config |
|---|---|---|
| **FTS soft-OR** | Lexical leg ranks AND-coverage first, falls back to OR so multi-term queries aren't inert | on, none |
| **Mode (intent/similar)** | Objective-aware weighting; keyword tiebreaker vs off | auto from query/image |
| **Composed query** | `mode:"similar"` + `image` + `q` = visual anchor + text modifier ("like this, but black") | pass both |
| **Cross-encoder rerank** | Reranks top-N RRF pool when a `rerank` fn is wired; pure RRF otherwise | BYO `rerank`; `rerank:false` to disable |
| **Visual grounding** | Crops the product region before embedding (index + query) when `groundImage` is wired | BYO `groundImage` |
| **Variant diversification** | Collapses variants to the best per `search.variantGroup` | declare `variantGroup`; `diversify:false` to disable |

Self-tuning: `matcher.evaluateSearch(...)` scores graded relevance@k / nDCG@k (caller labels or the configured LLM as judge), and `matcher.calibrateSearch(...)` sweeps a mode/weight grid and returns the recommended default — so "no config" can mean samesake calibrates itself.

### Fashion enrichment template (best defaults)

Attribute-aware search needs structured attributes (a "Crimson" title should be findable under "red dress"). `@samesake/core` ships a fashion enrichment template so you get that without hand-writing a taxonomy + schemas:

```ts
import { collection, Channels, fashion } from "@samesake/core";

const products = collection("products", {
  fields: fashion.fields(),                     // category, colors, occasions, gender, material, fit… (resolve from enriched.*)
  embeddings: { doc: { source: fashion.embedDocSource, model: "gemini-embedding-2", dim: 1536 } },
  spaces: fashion.spaces(),                      // visual + price + category + freshness
  enrich: fashion.enrichPipeline(),             // classify → extract (BYO generate; image-aware)
  search: {
    channels: [Channels.fts({ fields: ["title"] }), Channels.cosine({ embedding: "doc" }), Channels.spaces({})],
    combiner: "rrf",
    nlq: { instructions: fashion.nlq.instructions, schema: fashion.nlq.schema() },
  },
});
// after enrich, compose the embed doc: fashion.composeEmbedDoc(data, enriched) → enriched.embed_doc
```

Region-neutral and parametrized (`fashion.enrichPipeline({ titleKey, imageKey, classifyModel, … })`); `examples/fashion-search` consumes it and appends Sri-Lanka-specific NLQ vocab on top.

## Spaces (60 seconds)

Typed embedding spaces concatenate into one `space_vec` column; query-time `weights` rescale segments without reindexing. The fashion example enables them (incl. the `visual` image space) **by default** — this is now intent-safe because `mode: "intent"` (the default for text queries) does not weight the spaces/visual leg, so the intent parity gate is unaffected, while `mode: "similar"` and image queries get genuine visual + semantic similarity. Historically spaces were off because flat weights failed the parity gate ([`docs/spaces-gate.md`](./docs/spaces-gate.md)); `mode` is what makes them safe to ship on.

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

One factory, two capabilities. Fashion is the first public proof path — see [Fashion Search Proof](./docs/fashion-search-proof.md) and [`examples/fashion-search/PARITY.md`](./examples/fashion-search/PARITY.md).

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

NPM packages: **`@samesake/core`** (SDK), **`@samesake/server`**, **`@samesake/cli`** at **1.0.0**. The current public name is **Samesake**. The HTTP app still lives at `apps/matcher/`.

Search and match share embeddings, Postgres caches, and per-project runtime DDL.

## License

MIT. See [LICENSE](./LICENSE).
