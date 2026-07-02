# Running Samesake in production

Deployment templates (Fly.io, Cloudflare Workers, Docker) live in [`deploy/`](../deploy/README.md).
This guide covers what those templates assume: requirements, environment, migration policy, auth,
pipeline durability, and observability.

## Topology

Production is **two processes**: Postgres and your app embedding the matcher (`createMatcher()` —
serve `matcher.app`, mount `matcher.fetch`, or call in-process). There is no queue, no Redis, no
sidecar. The reference HTTP runner is [`apps/matcher`](../apps/matcher) (~40 lines).

## Requirements

- **Postgres 15+** (16 recommended) with extensions available: `vector` (pgvector **≥ 0.7** —
  `halfvec` columns are the default; **0.8** recommended, enabling iterative index scans),
  `pg_trgm`, `unaccent`, `fuzzystrmatch`. All four ship with the
  [`pgvector/pgvector`](https://hub.docker.com/r/pgvector/pgvector) image and with most managed
  providers (Neon, Supabase, RDS). `migrate()` runs `CREATE EXTENSION IF NOT EXISTS` for each.
- **Bun 1.2+** for the standalone runner. On serverless (Workers/Vercel) use `matcher.fetch` —
  no `Bun.serve`.
- A database role that may run DDL in its database: the runtime creates one schema per project.

## Environment

| Variable | Meaning |
|---|---|
| `SAMESAKE_DATABASE_URL` | Postgres connection string (use the **pooled** URL on Neon/pgBouncer) |
| `SAMESAKE_API_KEY` | Master Bearer key for the HTTP surface — generate with `openssl rand -hex 24` |
| provider keys | Only your own `embed`/`generate`/`rerank` closures read these (`GEMINI_API_KEY`, `OPENAI_API_KEY`, …) — the framework never holds them |

No fallback aliases exist; these two names are the whole contract.

## Migrations & schema policy

Three modes on `createMatcher({ migrate })`:

- `"lazy"` (default) — system DDL applied on first request via middleware.
- `"eager"` — migrations start during `createMatcher()`; `await matcher.migrate()` is the hard gate.
- `"manual"` — never automatic; you call `matcher.migrate()` explicitly.

For deploy pipelines, prefer running [`prepareMigrations`](../packages/server/src/prepare-migrations.ts)
from CI **before** booting the app — it applies the idempotent system DDL without constructing a
matcher.

Collection schema changes go through `matcher.apply(project, …)`, which diffs the declared config
against the live schema and **refuses destructive changes** (field removal, type change, embedding
dimension change) unless you pass `allowDestructive: true`. Additive changes apply online;
reindex-requiring changes are reported in the plan.

## Auth & keys

Every `/v1` route requires a Bearer key: the master `SAMESAKE_API_KEY` or a per-project key
(scoped to one project's data). Use per-project keys when several tenants share one matcher
process. Never expose the HTTP surface without auth — it can run DDL-adjacent operations
(apply, ingest, delete).

## Pipeline durability

Ingest → enrich → embed/index stages run **inline** — durability is deliberately the caller's
platform, not an internal queue. For anything beyond small catalogs, wrap the stage calls in your
job runner; there are step-by-step guides for
[Inngest](../apps/docs/src/content/docs/guides/pipeline-inngest.mdx),
[Upstash](../apps/docs/src/content/docs/guides/pipeline-upstash.mdx),
[Cloudflare Workflows](../apps/docs/src/content/docs/guides/pipeline-cloudflare-workflows.mdx), and
[Vercel Workflows](../apps/docs/src/content/docs/guides/pipeline-vercel-workflows.mdx)
(overview: [pipeline lifecycle](../apps/docs/src/content/docs/guides/pipeline-lifecycle.mdx)).

Failure handling is built in regardless of runner: per-row attempt counts with exponential
backoff, dead-lettering, an error-rate circuit breaker that aborts a run when the failure ratio
spikes, and quarantine (`pipeline_status='quarantined'` + `gate_reason`) that keeps low-confidence
rows out of search — inspect and correct them via the review endpoints.

## Observability

- `GET /v1/metrics` — counters and timings for search/pipeline operations.
- `createMatcher({ logger })` — structured log seam; plug your own sink.
- `searchExplain` / `POST /v1/.../search/explain` — per-leg ranks, RRF scores, per-space cosines
  for relevance debugging.

## Caching

An opt-in in-process TTL search cache exists and is invalidated on ingest/index/catalog-sync.
It is per-process — with multiple replicas each holds its own; there is deliberately no shared
cache tier at this stage. Enrichment/embedding/NLQ results are cached durably in Postgres
(`samesake_*_cache` tables), so re-runs never re-pay LLM calls for unchanged content.

## Scale expectations

Designed for catalogs **well under 10M SKUs** — at 100k–1M products, HNSW indexes fit comfortably
in RAM on ordinary instances. If you are past that, you are past the stage this toolkit targets.
