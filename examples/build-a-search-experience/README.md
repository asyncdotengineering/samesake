# build-a-search-experience

The runnable version of the [Build a search experience](https://samesake-docs.pages.dev/start/build-a-search-experience/) guide. Describe a catalog in TypeScript, enrich it, and search it with keywords + meaning + a hard budget filter — end to end on Postgres.

It proves the guide's central claim: searching `"light dress for a beach wedding under 15000"` returns the ivory linen dress and **excludes** the 28,000 sequin dress, because the budget is a hard filter (parsed from natural language via NLQ), not a score.

## Run it

Requires a Postgres with `pgvector`. `generate`/`embed` are deterministic stubs, so no API key is needed — the pipeline is identical to production, only the model closures differ.

```bash
SAMESAKE_DATABASE_URL=postgres://…/yourdb bun run src/run.ts
# or the assertion test:
SAMESAKE_DATABASE_URL=postgres://…/yourdb bun test
```

## Files

- `src/catalog.ts` — the collection (fields, enrich pipeline, indexing surfaces, embeddings, search channels + NLQ). Authored once, handed to `samesake()`.
- `src/stubs.ts` — deterministic `generate` (parses "under N" into a budget) + `embed`.
- `src/run.ts` — `samesake()` bundle → migrate → upsert → enrich → search, with the ivory-in/sequin-out assertion.
