# @samesake/core

## 3.2.0

### Minor Changes

- f83f5f7: Tenancy for collections (P2-1). `CollectionDef.scopes` (e.g. `["tenant_id"]`) compiles each key
  to an indexed `scope_<key>` column and makes the full scope MANDATORY on every surface: documents
  carry `scope` on push (and per-connector via `ConnectorDef.scope`), and search / facets / explain /
  getDocument / grepDocument / removeDocuments / evaluateSearch all require `scope` — there is no
  cross-scope read. Ids stay unique per collection; an upsert that would overwrite an id owned by a
  different scope is rejected (cross-tenant takeover guard), deletes only touch the caller's scope,
  and the search cache keys on scope. HTTP: `scope` in POST bodies, `scope.<key>=` query params on
  GET routes; CLI `remove`/`search-explain` accept `--scope k=v`. Adding or changing scopes on an
  existing collection is a destructive migration. Scopes are hard isolation ("whose catalog is this
  row") — a vendor facet inside one shared marketplace catalog remains a normal field.

  Also: the score-drop cutoff's cliff baseline can now be SET (raised, never lowered) by
  FTS-anchored hits, so a semantic junk tail behind keyword-matched results is cut correctly.

- a0ceec2: Cross-vendor offer dedup (P2-2). `CollectionDef.dedup` clusters listings of the same physical
  product so search returns **one hit per product** with an `offers` array. Declare scoring channels
  (`exactKey` — decisive equal-key short-circuit; `trigram`; `cosine` — weighted, normalized to
  [0,1]), an `autoLink` threshold (merge automatically), an optional `suggest` threshold (queue for a
  human), and `offerFields` (the declared fields copied onto each offer). Clustering is an explicit,
  incremental `matcher.dedup(project, collection)` stage after `index` (`{ rebuild: true }`
  re-clusters from scratch, replaying human decisions).

  Search collapses on the cluster id by default (existing `variantGroup` mechanism; `diversify: false`
  opts out) and each hit carries `offers` — one entry per **ready** cluster member, restricted to
  `offerFields` + `id` (never raw `data`), fetched in one batched query per page (`offers: false`
  skips it). Quarantined/deleted members drop out automatically.

  Human loop: `dedupClusters` / `dedupSuggestions` list state; `confirmGroup` merges a suggested pair;
  `splitGroup` evicts a row into a fresh cluster and records the decline so re-runs and rebuilds never
  re-link it. Precision-first: an uncertain pair is a suggestion, never an auto-merge. HTTP routes
  (`POST …/dedup`, `GET …/dedup/clusters`, `GET …/dedup/suggestions`, `POST …/dedup/confirm`,
  `POST …/dedup/split`) and CLI (`samesake dedup`, `dedup-clusters`, `dedup-suggestions`,
  `dedup-confirm`, `dedup-split`) mirror the in-process API.

  Candidates are pinned to the row's tenancy scope, so a cluster can never span `scopes`. Collections
  without `dedup` are completely unaffected on every surface. Note: the in-process `matcher.dedup`
  binding now runs collection offer-dedup; the entity-resolution engine's dedup is unchanged and stays
  reachable via `GET /v1/projects/:project/duplicates`.

## 3.1.0

### Minor Changes

- 396c9a5: Multilingual lexical leg. `CollectionDef.language` picks the Postgres FTS config (stemmer +
  stopwords) for both the indexed `fts` generated column and query parsing — the hardcoded
  `'english'` is gone. The fts column now normalises through `samesake_normalise`
  (lowercase + unaccent + punctuation folding) and queries fold accents via `unaccent()`, so
  `café` ≡ `cafe` in any language. `CollectionSearchDef.phonetic: true` (with
  `createMatcher({ phonetic })`) adds a cross-script phonetic branch to the lexical leg: a new
  `samesake_phonetic_tokens` system function feeds a generated `fts_phon` column (GIN-indexed) and
  query-side codes are ORed into the candidate set — a Sinhala/Tamil query finds the
  Latin-transliterated product. Changing `language` on an existing collection is flagged as a
  destructive migration. Note: collections created before this release keep their un-normalised fts
  column until recreated — accented documents in old tables may stop matching accented queries
  (queries are now accent-folded); recreate the collection to align both sides. Multilingual golden
  queries (`ml-01…ml-05`, Sinhala/Tamil/mixed-script) added to the fashion-lk eval set.
- 396c9a5: Honest zero-results: pluggable result-cutoff strategies on the search path
  (`CollectionSearchDef.cutoff`). Default ON for every collection as `{ strategy: "score-drop" }`
  — when no hit has lexical (FTS) evidence and even the best semantic cosine is below `minAnchor`,
  the list is honestly empty instead of nearest-neighbour padding; a steep relative cosine cliff
  (`maxDrop`) ends a semantic tail mid-list. Also available: `category-coherence` (unanchored
  results scattered across a declared field → zero) and `none` (opt out). FTS-anchored hits are
  never cut; hard-filtered queries (explicit or NLQ-derived) bypass the cutoff so filtered recall
  stays total. Search responses gain `cutoff_dropped`; `/v1/metrics` gains
  `search_cutoff_dropped_total`. Proven by an adversarial eval: "laptop" against a clothing
  catalog returns zero, not the three least-irrelevant handbags.

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
