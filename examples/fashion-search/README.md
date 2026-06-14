# Fashion search proof example

Reference implementation of Samesake's visual-commerce wedge: fashion search for shoppers who use image inspiration, vague intent, constraints, and inventory reality instead of exact product names.

This example reproduces the ingest-first hybrid search pipeline and serves a spike-compatible `/search/v2` endpoint for the external eval harness. Read the public proof page first: [`docs/fashion-search-proof.md`](../../docs/fashion-search-proof.md).

## Prerequisites

- `.env` at repo root with `DATABASE_URL` (Neon + pgvector) and `GEMINI_API_KEY`
- LK dataset snapshots at `project-search-web-search/research/dataset/raw/` (54 JSON files)

## Commands

```bash
cd examples/fashion-search
bun --env-file=../../.env ingest.ts          # ingest ~4,555 products
bun --env-file=../../.env run-pipeline.ts    # full pipeline (ingest → enrich → compose → index)
bun run generate:synthetic                   # writes .samesake/synthetic-fashion-corpus/corpus.json
bun eval.ts                                  # deterministic fixture eval; writes .samesake/fashion-eval.*
bun --env-file=../../.env serve.ts           # HTTP on :8788 with /search/v2
```

First-class fashion API:

```bash
curl -X POST http://localhost:8788/v1/projects/fashionparity/collections/products/fashion-search \
  -H "authorization: Bearer $API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "q": "red cotton summer dress",
    "image": { "url": "https://example.com/reference.jpg" },
    "filters": { "available": true, "price": { "$lte": 15000 } },
    "rankingPolicy": { "weights": { "visual": 2, "availability": 1 } },
    "personalization": { "preferredBrands": ["Aster"], "priceBand": { "max": 15000 } },
    "debug": true,
    "recoverNoResults": true
  }'
```

Remote eval against the running API:

```bash
FASHION_SEARCH_BASE=http://localhost:8788 API_KEY=$API_KEY bun eval.ts
FASHION_DATASET_DIR=project-search-web-search/research/dataset/raw bun eval.ts
```

Synthetic local corpus:

```bash
bun run generate:synthetic
FASHION_DATASET_DIR=.samesake/synthetic-fashion-corpus bun eval.ts
```

Eval (from spike repo):

```bash
cd ../project-search-web-search
cp evals/results/v2-2026-06-10.json evals/results/v2-spike-baseline.json  # once
node scripts/eval-search.js --target v2 --base http://localhost:8788
```

## Project

Uses dedicated project slug `fashionparity` to avoid schema collisions with other tests.

## Optional spaces

- `SPACES=1` — enable style/price/freshness/category segmented vector leg (off by default; see `docs/spaces-gate.md`).
- `SPACES_VISUAL=1` (requires `SPACES=1`) — add `visual` image space (`s.image` on `$image_url`, Gemini multimodal embed). Off by default pending Q4 spike.

For a $0 image-embedding alternative (SigLIP on Modal), see the aggregator spike at `project-search-web-search/research/spikes/modal_fashionsiglip2.py` — not wired in this example.

## What to inspect

- [`PARITY.md`](./PARITY.md) for measured results and limitations.
- [`samesake.config.ts`](./samesake.config.ts) for the TypeScript catalog/search declaration.
- [`serve.ts`](./serve.ts) for the spike-compatible `/search/v2` surface.
- [`../../docs/demo-visual-commerce.md`](../../docs/demo-visual-commerce.md) for a concise demo script.
