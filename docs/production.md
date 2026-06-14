# Production configuration

Production spine for `createMatcher` — policy, observability, jobs, schema migrations, and API keys. No Redis, no Elasticsearch.

## Policy

`config.policy` overrides retry/backoff/timeout defaults for LLM, embed, and connector calls:

```ts
const matcher = createMatcher({
  databaseUrl: process.env.DATABASE_URL!,
  apiKey: process.env.API_KEY!,
  embed: embedFn,
  policy: {
    llm: { retries: 6, backoffMs: 4000, timeoutMs: 5000 },
    embed: { retries: 2, backoffMs: 2000 },
    connector: { timeoutMs: 60_000 },
  },
});
```

Defaults match pre-policy behavior (`packages/server/src/core/policy.ts`). NLQ keeps its timeout + degrade semantics; enrich uses retry ladder without generation timeout unless you set `llm.timeoutMs`.

## Logger and metrics

```ts
const matcher = createMatcher({
  /* ... */
  logger: (event) => {
    // { level, scope, msg, fields? } — secrets redacted
    console.log(JSON.stringify(event));
  },
});
```

Counters exposed at `GET /v1/metrics` (master API key) and `matcher.metrics()`:

| Counter | Meaning |
|---------|---------|
| `searches_total` | Search requests |
| `search_cache_hits` | Opt-in in-process search result cache hits |
| `nlq_degraded_total` | NLQ timed out, fell back |
| `enrich_failures_total` | Enrichment stage failures |
| `embed_calls_total` / `embed_cache_hits` | Embedding API vs cache |

## Search explain

`POST /v1/projects/:p/collections/:c/search/explain` — per-channel ranks (FTS, cosine, spaces) plus per-space cosine contributions for debugging a single query.

CLI: `samesake search-explain --project=p --collection=c --q="..."`.

## Search result cache

Collection search reads fresh results by default. Callers can opt into the short-TTL in-process result cache per request with `cache: true`; cache keys include project, collection, query, filters, weights, limit, offset, and facets. Document writes, collection indexing, and review corrections invalidate the affected project/collection cache entries in the current process. Distributed cache invalidation is intentionally out of scope.

## Per-project API keys

System table `samesake_projects.api_key`. Collection/entity/match routes accept the master key **or** the project's key. Master-only: `/v1/metrics`, project CRUD, schema apply, `rotate-key`.

```bash
samesake rotate-key --project=shop   # prints new key (master auth)
```

## Job runner

`config.jobs?: JobRunner` — minimal `{ run(name, payload, fn) }` contract. Default: `inProcessRunner` (synchronous, today's behavior). Optional package `@samesake/jobs-pgboss` for Postgres-backed queues:

```ts
import { createPgBossRunner } from "@samesake/jobs-pgboss";

const matcher = createMatcher({
  /* ... */
  jobs: await createPgBossRunner({ connectionString: process.env.DATABASE_URL! }),
});
```

`ingest`, `enrich`, and `index` route through the runner. Use pg-boss on a long-lived process; Workers/serverless should trigger jobs via HTTP or external queue.

## Schema migrations

`samesake migrate --project=NAME --config=PATH --plan` — dry-run migration plan (additions, reindex marks, destructive changes).

`samesake migrate --project=NAME --config=PATH --apply` — apply diffs:

- New field → `ALTER TABLE ADD COLUMN` + backfill from `path`
- Embedding/spaces definition change → mark rows for reindex (`indexed_at = NULL`)
- Dimension change → drop/recreate vector column + index
- Destructive change (field removed, type changed) → **refused** unless `--allow-destructive`

`samesake dev` prints the plan on every apply (including config watch re-apply).

Deploy order: system DDL first (`samesake migrate --db=$URL`), then app boot or `dev`/`apply` for project schemas. In production, construct the app with `migrate: "manual"` after the deploy step; manual mode does not install request-time migration middleware. Use `migrate: "lazy"` for dev convenience when first-request migrations are acceptable, or `migrate: "eager"` plus `await matcher.migrate()` when a long-lived process should warm migrations before serving.

## Deploy

See [`deploy/README.md`](../deploy/README.md) for Fly, Docker, and Workers. Release checklist: [`release.md`](./release.md).
