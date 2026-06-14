# Premise

samesake exists because every product that captures names — customer records, supplier ledgers, invoice line items, OCR'd handwritten pages — eventually faces the same question, and nobody has built a good open-source answer to it:

> *Is this name a new entity, or one we already know?*

This document is the load-bearing context for everyone (humans and AI agents) working on samesake. Read it before reasoning about feature choices, scope, or trade-offs. When you are deciding *what to build*, this premise wins over local convenience. When you are deciding *how to build it*, the [PRODUCT-BIBLE.md](./PRODUCT-BIBLE.md) wins over personal preference.

## Origin

samesake was extracted from the matching layer of a Sri Lankan SME bookkeeping app. Shopkeepers there photograph handwritten credit-book pages in Sinhala, Tamil, and English (often code-mixed within a single line). An LLM OCR step extracts the names. Then the app has to decide: is this an existing customer, or a new one?

We tried the obvious things first:

- **Search engines** (Algolia, Typesense, Elasticsearch) — they are search engines, not entity resolvers. Wrong shape for the task.
- **Vector stores** (Pinecone, Qdrant, LanceDB) — generic ANN. No opinion on what makes two names "the same person".
- **Entity-resolution research libraries** (Splink, dedupe, Zingg) — batch-oriented, no online API, no multilingual support out of the box, no place for an LLM in the pipeline.
- **Enterprise products** (Senzing, Reltio, IBM InfoSphere) — priced for Fortune 500 sales cycles, closed source, opaque scoring.

Nothing fit. So we built the "roll-your-own pgvector + scoring code" pattern into a self-hostable service, and open-sourced it under Apache 2.0.

## What we are building

A **service** (not a library) that any product can call to:

1. **Match** — given a name string and a scope (e.g., tenant), return ranked candidates with per-channel scores. Single-query and batched (`/match-batch`) variants ship.
2. **Confirm / Decline** — record user decisions; future matches improve from the feedback.
3. **Dedup** — find probable-duplicate clusters in existing data.
4. **Variant-suggest** — for product catalogues, surface "these N rows look like variants of one product".
5. **Explain + Calibrate** — per-channel scoring breakdown for any (query, candidate) pair, and F1-optimised per-scope threshold calibration from historic confirms/declines.

The service is described to consumers via a TypeScript SDK (Eden gives them end-to-end types). Per-project schema is generated at runtime from a config file the consumer ships — there is no "samesake user table"; consumers declare their own entities, scopes, embeddings, and scoring channels.

**Bulk import is a consumer concern, not a matcher concern.** Spreadsheet upload, an N-wave matcher waterfall, and a human resolution flow are bundled as an *example* at [`examples/bulk-import/`](../examples/bulk-import/) — a standalone Bun service that composes the matcher's primitives (`/match-batch`, `/entities/.../upsert`, `/confirm`) into an opinionated import service with its own queue. The example was extracted from core in v1.2 to keep the matcher truly stateless and serverless-friendly. Fork it and adapt — swap pg-boss for Cloudflare Queues, swap xlsx for csv-only, plug in your own operator UI. Same primitives, different shape.

## What we are *not* building

Saying no is the discipline that lets a small service stay coherent. samesake does not, and will not:

- **Replace your database.** Your customers, suppliers, products live in *your* DB. samesake holds a parallel match-state table per entity (embeddings, normalised names, phonetic hashes) keyed by your external id.
- **Be a generic search engine.** No full-text query DSL, no faceted browse, no relevance tuning UI. If you need search, use a search engine.
- **Be an LLM agent framework.** The LLM (Gemini Flash-Lite by default) is used in two narrow places: per-product structured parse, and embedding the query string. Everything else is deterministic SQL.
- **Bundle a UI.** The service ships a JSON HTTP API and a thin CLI for ops. UIs are the consumer's responsibility.
- **Be a multi-tenant SaaS.** samesake is self-hostable by design. There is no signup page, no billing, no "samesake Cloud".
- **Be batteries-included for every embedding provider.** We support Gemini, Voyage, and OpenAI today; new providers are a contributor PR away, not a roadmap promise.
- **Be a vector database.** We use pgvector inside Postgres because we already have Postgres. We will not abstract over Pinecone / Weaviate / Chroma — that would force the matcher to lose features (e.g., joining against `name_alias` and `pair_history` in one SQL statement).

## Architectural commitments

These are the load-bearing decisions. Changing one is a project-level conversation, not a PR:

1. **Two containers.** Postgres (+ `pgvector`, `pg_trgm`, `unaccent`, `fuzzystrmatch`) and a Bun process. No Redis, no Elasticsearch, no LanceDB, no message broker.
2. **Per-project schema at runtime.** Consumers declare entities in TypeScript; the service generates DDL on `apply`. There is no Drizzle/Prisma static schema because the schema is consumer-defined.
3. **Probabilistic-OR scoring over consumer-declared channels.** Each channel produces a number in `[0, 1]`. The combiner is fixed; the channels and their weights are consumer-defined.
4. **Cache everything in Postgres.** Embeddings (90-day TTL), parse results (90-day TTL), pair-history. No external cache layer.
5. **Apache 2.0, forever.** The value is the codebase, not a closed-source moat.

## How to use this document

When you are about to make a design decision and you can hear yourself saying any of the following, **stop and re-read the relevant section above**:

- *"Let's also add a small UI for…"* — see [What we are *not* building](#what-we-are-not-building).
- *"We should support [other vector DB] in case…"* — see [Architectural commitments](#architectural-commitments) point 1.
- *"This LLM agent loop would let us…"* — see [What we are *not* building](#what-we-are-not-building).
- *"Drizzle would be cleaner than raw SQL here…"* — see [Architectural commitments](#architectural-commitments) point 2.

When a section above no longer reflects what we are actually building, the right response is to update this document in the same PR that changes direction — not to silently drift. The premise is the contract.

## See also

- [PRODUCT-BIBLE.md](./PRODUCT-BIBLE.md) — the architectural North Star, with stack decisions and ADRs.
- [rfcs/](./rfcs/) — six RFCs covering the matching foundation, people matcher, product matcher, async import pipeline, and operator affordances.
- [prior-art/](./prior-art/) — research on midday-ai, Splink, and the broader entity-resolution landscape.
- [../README.md](../README.md) — what a user sees first.
- [tutorial.md](./tutorial.md) — fifteen minutes from clone to first match.
# OBSOLETE: historical premise

This document is archived for history only. It describes removed architecture and
must not be used as the current product, deployment, or API contract.
