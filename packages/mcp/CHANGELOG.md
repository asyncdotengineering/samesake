# @samesake/mcp

## 3.0.0

### Major Changes

- fcb5742: Tier-0 retrieval defaults baked in, and the zero-config indexing path is fixed.

  **Breaking (recreate + reindex collections; requires pgvector ≥ 0.7, ≥ 0.8 recommended):**

  - Collection `embedding` and `space_vec` columns are now `halfvec` (fp16): ~2× smaller storage
    and index, ~2× faster HNSW build, <1% recall loss, and embedding dims up to 4000 (was 2000).
    Existing tables keep `vector` columns and will fail search after upgrading — re-apply the
    project on a fresh schema (or drop/re-add the vector columns) and reindex. Entity-resolution
    tables are unchanged.
  - The `fts` generated column is now weighted: `setweight(fts_src_a, 'A') || setweight(fts_src, 'B')`.
    New column `fts_src_a` carries title-class text. Declare it via `f.text({ searchable: true,
ftsWeight: "A" })` or an indexing fts surface with `weight: "A"`. `CollectionTextFieldDef.weight`
    (dead) is removed.
  - `DEFAULT_PRODUCT_PARSE_INSTRUCTIONS` (deprecated since 0.7.x) is removed; use
    `DEFAULT_PRODUCT_PARSE_BODY`.

  **Breaking (de-fashioned core — rename, no behavior change unless noted):**

  - `matcher.fashionSearch` / `POST …/fashion-search` → `matcher.shopSearch` / `POST …/shop-search`;
    `matcher.syncFashionCatalogEvent` / `POST …/fashion-sync` → `matcher.syncCatalogEvent` /
    `POST …/catalog-sync`. Types: `FashionSearchRequest/Response/Explanation/ImageInput` →
    `ShopSearch*`, `FashionPersonalizationContext` → `ShopperContext`, `FashionCatalogSyncEvent` →
    `CatalogSyncEvent`; `FashionRankingPolicy` is deleted (use `RankingPolicy`).
  - **Behavior change:** `shopSearch`'s `recoverNoResults` relaxes nothing unless the collection
    declares `search.relaxableFilters` (new on `CollectionSearchDef`). The fashion template supplies
    its list via `fashion.searchDefaults()` / `fashionSearchDefaults()` — spread it into your
    `search` def to keep the old fashion relax behavior.
  - `fashionRerank` → `llmRerank` (score mapping is now ESCI `grade/3`).
  - Catalog-sync deletes route through `removeDocuments`; `DELETE …/documents` (body `{ ids }`) and
    the CLI `samesake remove --ids=…` expose document deletion on every surface.

  **Breaking (judge honesty — evals re-grade from scratch):**

  - The LLM relevance judge is now 4-class ESCI (Exact=3 / Substitute=2 / Complement=1 /
    Irrelevant=0; Substitute is a soft positive — default `relevanceFloor` is 2). `JudgedHit.grade`
    is `0|1|2|3` with an `esci` label; facet sub-grades (`FacetGrades`) are removed.
    `FASHION_JUDGE_SYSTEM` → `ESCI_JUDGE_SYSTEM`.
  - Judge versions are content-pinned: `makeLlmJudge` versions resolve to `<tag>@<sha256(rubric)[:8]>`,
    so prompt edits auto-invalidate cached grades (file cache and the persisted search-judge cache).
  - **Same-family enrich+judge is rejected.** `runEval` and `evaluateSearch`/`calibrateSearch` throw
    when a collection has an enrich pipeline and the judge model is missing or from the same model
    family (self-preference bias). Declare a cross-family judge: in-process via
    `evaluateSearch(…, { judge: { model, generate? } })` / `makeLlmJudge(gen, { model })`, over HTTP
    via the new `judgeModel` body field on `…/search/evaluate` and `…/search/calibrate`.
  - Golden-query `constraints` now use the search filter vocabulary
    (`{ "price": { "$lte": 5000 }, "colors": { "$exclude": ["black"] } }`) checked against whatever
    fields the collection schema declares — the price/color/gender/category hardcoding is gone.

  **Breaking (one env contract):**

  - Canonical env vars everywhere: `SAMESAKE_DATABASE_URL` and `SAMESAKE_API_KEY`. The bare
    `DATABASE_URL` / `API_KEY` fallbacks and the `apps/matcher` mapping shim are deleted — no
    aliases. Provider keys keep their provider-canonical names (`GEMINI_API_KEY`,
    `OPENAI_API_KEY`); `GOOGLE_GENERATIVE_AI_API_KEY` is no longer read.

  **Fixed:**

  - Collections without an enrich pipeline indexed nothing since the S1c indexing migration
    (every doc skipped as "empty embedding document") — the README/quickstart `collection → push →
index → search` path was broken. `indexing` is optional again: without it, the engine composes
    surfaces at index time from each embedding's restored `source` template and `searchable` fields;
    with `indexing` but no enrich pipeline, the declared surfaces are built inline at index time.

  **Added:**

  - pgvector 0.8 iterative index scans (`hnsw.iterative_scan = relaxed_order`) are enabled
    automatically on vector legs, fixing filtered-ANN under-return ("hard filters stay hard").
  - `efSearch` search option (HTTP + in-process, 10–1000): per-query HNSW recall/latency dial.
  - Apply now fails fast with a clear error when pgvector < 0.7.
