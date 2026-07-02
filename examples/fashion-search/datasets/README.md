# Demo store — reproducible 50-product fashion shop

A hand-curated single-store catalog (subset of the public Myntra
`ashraq/fashion-product-images-small` dataset), already run through samesake's
**2-stage fashion enrichment gate** and **indexed** (`gemini-embedding-2`). It is
shipped as a SQL seed so anyone can reproduce the search-credibility and
quarantine behaviour **without spending any enrichment LLM calls**.

- **40 ready** products (apparel, footwear, bags, watches, accessories…)
- **10 quarantined** by the gate — non-apparel (deodorant, perfume, a laptop
  sleeve), low-confidence, or cross-signal-disagree — so they never surface in search.

## Seed it

```bash
# 1. Bootstrap samesake's system tables once (any of: run the app, the CLI, or matcher.migrate()).
# 2. Load the seed:
psql "$SAMESAKE_DATABASE_URL" -f examples/fashion-search/datasets/demo-store-seed.sql
```

This creates schema `project_demo_store`, loads the 50 enriched + embedded rows,
and registers the project as `demo_store` in `samesake_projects`.

## See it work

```bash
cd examples/fashion-search
bun --env-file=../../.env seed-demo-store.ts
```

Positive intents ("navy blue shirt for men", "silver watch for women", "black
formal shoes") return credible matches; negatives ("deodorant", "perfume") return
no actual deodorant/perfume because those rows are **quarantined**.

> The 50 products' enrichment and document embeddings are baked into the seed, so
> reproduction needs **no enrichment**. Intent/cosine search still embeds the
> *query* text at run time, so `seed-demo-store.ts` needs `GEMINI_API_KEY`.
> Pure FTS queries need no key.

## Provenance & regeneration

- `demo-store-products.json` — the curated raw catalog (50 items, source attributes
  kept under `_truth` for reference). Image URLs are the HF datasets-server assets.
- `rebuild-demo-store.ts` — rebuilds the store from scratch (apply → push → **enrich
  via Gemini** → index). Run with `SPACES_VISUAL=0` (the HF dataset images are served
  as `binary/octet-stream`, which the image fetcher rejects, so enrichment is text-only
  and the visual space is off).

Regenerate the seed after a collection-schema change:

```bash
cd examples/fashion-search
SPACES_VISUAL=0 bun --env-file=../../.env rebuild-demo-store.ts   # rebuilds project_demo_store
# then re-dump (pg_dump >= server version), strip pg18 \restrict lines, rename slug → demo_store:
pg_dump "$SAMESAKE_DATABASE_URL" --schema=project_demo_store --no-owner --no-privileges --no-comments \
  | sed '/^\\restrict/d; /^\\unrestrict/d' > /tmp/schema.sql
# prepend the CREATE EXTENSION / DROP SCHEMA header and append the samesake_projects row (see git history).
```
