# marketplace-search

A multi-vendor marketplace, end to end on Postgres: **enrich** messy listings → **resolve** (cross-vendor dedup: the same GTIN listed by two sellers clusters into one product) → **facets** (per-value counts for the sidebar) → **search**.

Requires a Postgres with `pgvector`. `generate`/`embed` are deterministic stubs — no API key.

```bash
SAMESAKE_DATABASE_URL=postgres://…/yourdb bun run src/run.ts
SAMESAKE_DATABASE_URL=postgres://…/yourdb bun test
```
