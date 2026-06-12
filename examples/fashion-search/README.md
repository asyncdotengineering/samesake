# Fashion search parity example

Reference implementation of the fashion vertical on the samesake framework. Reproduces the ingest-first hybrid search pipeline and serves a spike-compatible `/search/v2` endpoint for the external eval harness.

## Prerequisites

- `.env` at repo root with `DATABASE_URL` (Neon + pgvector) and `GEMINI_API_KEY`
- LK dataset snapshots at `project-search-web-search/research/dataset/raw/` (54 JSON files)

## Commands

```bash
cd examples/fashion-search
bun --env-file=../../.env ingest.ts          # ingest ~4,555 products
bun --env-file=../../.env run-pipeline.ts    # full pipeline (ingest → enrich → compose → index)
bun --env-file=../../.env serve.ts           # HTTP on :8788 with /search/v2
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
