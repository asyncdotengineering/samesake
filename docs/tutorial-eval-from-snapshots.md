# Tutorial: from raw search snapshots to a live eval

This guide takes you from a folder of raw fashion search snapshots to a **running eval
harness** — first offline (zero dependencies), then against the live hybrid search engine.
You end with a reproducible relevance/constraint scorecard you can use to compare engines.

Everything here uses the `examples/fashion-search/` harness and a 30-product subset built
from real Sri-Lankan (LK) fashion search snapshots.

```
raw snapshots  ─►  subset corpus  ─►  offline eval (keyword)  ─►  live ingest  ─►  live eval (hybrid)
   q*.json          corpus.json        localSearch                 enrich+index      /fashion-search
```

## 0. What you start with

A directory of search snapshots, one JSON per query:

```jsonc
// search-snapshots/q1.json
{
  "query": "red dress",
  "country": "LK",
  "expansions": ["red evening gown", "short formal dresses", "holiday party wear"],
  "results": [
    { "title": "Red Mirage Shift Dress", "vendor": "Avirate", "price_numeric": 5280,
      "available": true, "image": "https://cdn.shopify.com/...", "tags": ["Occasion wear"],
      "product_type": null, "url": "https://www.aviratefashion.com/products/red-mirage-shift-dress" }
    // ... ~50 more
  ]
}
```

Ten files (`q1.json`–`q10.json`) covering keyword, use-case, attribute, and price-constrained
queries (e.g. `q7` = "modest dress for work under 5000").

## 1. Build the subset (3 results per query → 30 products)

`build-lk-subset.ts` takes the first N results from each snapshot and writes two things:

- `datasets/lk-snapshot-subset/source/q*.json` — the trimmed snapshots (provenance)
- `datasets/lk-snapshot-subset/corpus.json` — the eval-ready `{ products, queries }`

Each snapshot's `query` becomes one **EvalQuery** whose `relevant` set is exactly the products
taken from that snapshot (they were the upstream results for that query). Price phrasing like
"under 5000" is parsed into a `maxPrice` constraint.

```bash
cd examples/fashion-search
LK_SNAPSHOTS_DIR=/abs/path/to/search-snapshots bun build-lk-subset.ts --per 3
```

Output:

```
subset built → .../datasets/lk-snapshot-subset
  products: 30 (3 × 10)
  queries:  10
  price-constrained queries: q7
```

The eval data model (validated by `eval.ts`):

```ts
type Product   = { id, title, brand, category, colors[], material, price, available };
type EvalQuery = { name, q, filters?, constraints?, relevant: string[], image? };
```

```jsonc
// corpus.json (excerpt)
{ "products": [
    { "id": "q1-1", "title": "Red Mirage Shift Dress", "brand": "Avirate",
      "category": "dresses", "colors": ["red"], "material": "", "price": 5280, "available": true }
  ],
  "queries": [
    { "name": "q1", "q": "red dress", "relevant": ["q1-1","q1-2","q1-3"],
      "filters": { "available": true }, "constraints": { "available": true } },
    { "name": "q7", "q": "modest dress for work under 5000", "relevant": ["q7-1","q7-2","q7-3"],
      "filters": { "price": { "$lte": 5000 }, "available": true },
      "constraints": { "maxPrice": 5000, "available": true } }
  ] }
```

## 2. Run the eval offline (zero dependencies)

`eval.ts` reads the corpus from `FASHION_DATASET_DIR`. With no live server configured it runs
an **in-process keyword search** (`localSearch`) — no Postgres, no API keys, instant. This is
your baseline.

```bash
FASHION_DATASET_DIR=datasets/lk-snapshot-subset bun eval.ts
```

It writes `.samesake/fashion-eval.{json,md}` and prints a scorecard. Metrics:

- **relevance@3** — of each query's `relevant` products, how many surface in the top 3
- **constraint compliance / constraint@5** — do returned hits respect `filters`/`constraints`
  (e.g. price ≤ 5000, available)
- **zero-result / relaxation rate**, **latency**

**Baseline result (keyword `localSearch`):**

```
Engine: local-deterministic-fixture
- relevance@3: 0.70
- constraint compliance: 1.00
- perfect constraint@5: 1.00
- zero-result rate: 0.00
- mean latency: 0ms · cost: $0.00
```

Per-query, the weak spots are exactly the hard query types — keyword matching can't reason about
intent or budget:

| query | type | relevance@3 (keyword) |
| --- | --- | ---: |
| q1 red dress | keyword | 1.00 |
| q2 ladies office wear | use-case | 0.33 |
| q7 modest dress for work under 5000 | price + use-case | **0.00** |
| q9 white cotton blouse long sleeve | attribute | 0.33 |

This is the motivation to go live: the hybrid engine adds NLQ parsing (intent → filters +
semantic query) and embedding recall on top of keyword.

## 3. Go live: ingest + hybrid eval (one command)

The live path pushes the same 30 products (raw) into a **dedicated, empty project**
(`lk_subset`) and runs the real pipeline — LLM enrichment (category/colors/material/etc.,
fetching each product image through the SSRF-hardened fetcher) → compose embed doc →
embeddings + index — then runs each corpus query through the live hybrid engine
(`matcher.search`: NLQ parse → FTS + cosine ANN, RRF-combined) in-process. Document ids match
the corpus ids so `relevant` sets line up with live hits.

> **Gotcha — use a dedicated project.** The example's default `fashionparity` project can carry
> an *orphaned* catalog: if a prior full ingest's project row was deleted, its schema and
> `c_products` table (thousands of rows) survive. A new ingest then mixes your 30 products into
> that catalog and your eval is no longer about your subset. A clean check must look at the
> **table row count**, not just the `samesake_projects` row. The tutorial uses a fresh slug to
> sidestep this entirely.

Prereqs: `.env` at repo root with `DATABASE_URL` (Postgres + pgvector) and `GEMINI_API_KEY`.

```bash
bun --env-file=../../.env live-lk-subset.ts
```

```
pushing 30 raw docs -> lk_subset/products
== enrich (Gemini classify + extract) ==
  pass 0: enriched=30 failed=0
composed embed_doc for 30 products
== index (embeddings) ==
indexed 30 searchable products
== live hybrid eval ==
- relevance@3: 0.63
- constraint overall@5: 1.00
- zero-result rate: 0.00
- relaxation rate: 0.10
```

It writes `.samesake/fashion-eval-live.{json,md}`.

> **Alternative — HTTP + the same `eval.ts`.** Instead of the in-process eval you can serve the
> project over HTTP and reuse `eval.ts`'s `remoteSearch` path:
> `bun --env-file=../../.env serve.ts` then
> `FASHION_SEARCH_BASE=http://localhost:8788 API_KEY=$GEMINI_API_KEY FASHION_DATASET_DIR=datasets/lk-snapshot-subset bun eval.ts`.
> (`serve.ts` targets the `fashionparity` project; point it at your subset project to use it here.)

## 4. Keyword vs hybrid — the scorecard

Same 30-product corpus, same 10 queries, two engines:

| metric | offline keyword (`localSearch`) | live hybrid (`matcher.search`) |
| --- | ---: | ---: |
| relevance@3 (mean) | 0.70 | 0.63 |
| constraint compliance / @5 | 1.00 | 1.00 |
| zero-result rate | 0.00 | 0.00 |
| relaxation rate | 0.00 | 0.10 |
| cost | $0.00 | ~30 embeds + ~60 enrich calls |

Per query (relevance@3):

| query | type | keyword | hybrid |
| --- | --- | ---: | ---: |
| q1 red dress | keyword | 1.00 | 1.00 |
| q2 ladies office wear | use-case | 0.33 | 0.00 |
| q3 linen shirt men | attribute | 1.00 | 1.00 |
| q4 party saree | local | 1.00 | 1.00 |
| q5 denim jacket | keyword | 1.00 | 1.00 |
| q6 beach-wedding (vague) | use-case | 0.67 | 0.00 |
| q7 modest dress … under 5000 | price | **0.00** | **0.33** |
| q8 oversized streetwear tshirt | style | 1.00 | 0.67 |
| q9 white cotton blouse long sleeve | attribute | 0.33 | 0.33 |
| q10 gym leggings women | keyword | 1.00 | 1.00 |

**Read this honestly.** On a *30-product* corpus the keyword baseline is not beaten on mean
relevance@3 — and that's expected:

- **Where hybrid wins:** the price query **q7** (0.00 → 0.33) — NLQ parsed "under 5000" into a
  `price ≤ 5000` filter and surfaced an in-budget match keyword overlap missed. Hybrid also held
  **constraint compliance at 1.00** and used soft-filter **relaxation** (q7) to dodge a
  zero-result dead-end.
- **Where hybrid regresses:** broad/use-case queries (**q2, q6, q8**). With only 30 documents,
  cosine recall pulls semantically-adjacent items from *other* categories; because `relevant` is
  defined narrowly (the 3 snapshot products per query), those neighbours score as misses. FTS is
  also sparse at this size.

The takeaway: **corpus size matters.** Embedding recall needs a catalog big enough to
disambiguate — at 30 docs you mostly measure keyword overlap + constraint handling. Scale up
(`--per 20`, or the full snapshot set) to see hybrid's recall advantage; the harness, metrics,
and commands are identical.

## Files in this tutorial

| File | Role |
| --- | --- |
| `build-lk-subset.ts` | snapshots → `corpus.json` + trimmed `source/` |
| `datasets/lk-snapshot-subset/corpus.json` | eval input (30 products, 10 queries) |
| `eval.ts` | offline harness (`localSearch`) / remote harness (`remoteSearch`) |
| `live-lk-subset.ts` | dedicated-project ingest (push+enrich+index) **and** in-process hybrid eval |
| `serve.ts` | optional HTTP server exposing `/fashion-search` (for the remote-eval alternative) |
| `.samesake/fashion-eval.{json,md}` | offline scorecard |
| `.samesake/fashion-eval-live.{json,md}` | live hybrid scorecard |

## Notes & gotchas

- **`relevant` ids are the contract.** relevance@3 is only meaningful because each query's
  `relevant` set points at real corpus ids. Live doc ids must match (`q1-1`, …) — `live-lk-subset.ts`
  guarantees this.
- **Offline ≠ hybrid.** The offline baseline is deliberately dumb (keyword overlap) so the
  delta to the live engine is visible. Don't read the offline numbers as the product's quality.
- **Constraint metrics** are objective (price/availability are structured), so they're reliable
  even without human relevance labels.
- **Scaling up:** bump `--per` for a bigger corpus, or point `LK_SNAPSHOTS_DIR` at the full
  snapshot set. Cost scales with enrichment (≈2 Gemini calls + 1 image fetch + 1 embedding per
  product).
