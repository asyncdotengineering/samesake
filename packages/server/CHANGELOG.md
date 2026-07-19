## 5.0.0

### Major Changes

- 717cbee: Grounded query understanding (rfc-grounded-query-understanding v2). Scoped per-collection
  vocabulary tables with trigger-maintained deltas ground open-vocab NLQ filters (map-or-drop:
  every accepted value matches a live visible row); the parse exposes a corrected
  `lexical_query` used by all FTS branches, protected by a deterministic edit-distance guard
  (no added/translated/expanded terms); LLM-derived hard enum filters apply only when
  corroborated by the user's own tokens (query-side taxonomy guesses cannot silently delete
  the relevant pool); NLQ now runs on every text query (BREAKING: the short-query token skip
  is removed); zero-LLM deterministic enum-token filters; progressive soft-filter relaxation
  with declared `relaxOrder` priority (SDK: new `search.relaxOrder`); typed honest-zero
  rewrites; truthful `constraintTrace`/`searchExplain`. Gate record in RFC §13: typo mean
  2.05→2.083, overall 1.871→1.916, OOD honest zeros unchanged.
- c5d2c85: Multi-aspect retrieval major. Collections declare named aspect embeddings (`doc`, `visual`,
  `facets`, ...) — each gets its own column, HNSW index, and RRF leg; evidence aspects store
  row-per-claim with a MaxSim leg; NLQ routes query intent to aspects. BREAKING: the `spaces`
  subsystem is removed (`SpacesChannel`, `s.*` builders, `space_vec` — destructive migration on
  apply); image/`similar` queries now run through the `visual` aspect (verified parity: exact
  product at rank 1). Eval-gated defaults: non-primary aspect legs are OFF for text intent
  queries (C9 gate + two calibrations, artifacts in `evals/runs/`; see BENCHMARKS "Aspects
  gate") and fully ON for image/`similar` mode. Per-query `weights.aspects` re-enables intent
  aspects for experiments. Also: indexing gains bounded concurrency (`SAMESAKE_INDEX_CONCURRENCY`),
  a per-doc watchdog, and rolling-pool processing.

### Patch Changes

- Updated dependencies [717cbee]
- Updated dependencies [c5d2c85]
  - @samesake/core@4.0.0

## 4.1.0

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

### Patch Changes

- Updated dependencies [f83f5f7]
- Updated dependencies [a0ceec2]
  - @samesake/core@3.2.0

## 4.0.0

### Major Changes

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

### Patch Changes

- 396c9a5: `samesake init [dir]` now scaffolds a complete runnable search project — catalog config,
  docker-compose Postgres (pgvector 0.8 + contrib extensions), a ~20-line HTTP server, a
  deterministic local embedder (no LLM key needed), a 24-product seeded catalog, and `.env` with a
  generated API key. Zero to first search in four commands. The old entity-resolution
  single-config-file `init --name` form is gone.

  `createDbFromUrl` now silences Postgres NOTICEs (`onnotice`): idempotent `IF NOT EXISTS` DDL is
  the design, and the "already exists, skipping" spam on every boot was pure noise.

- 396c9a5: `evaluateSearch`'s persisted judge-grade write is now awaited. The fire-and-forget write raced
  process exit at the end of an eval run, silently dropping grades — the next run re-rolled the
  judge on pairs it should have reused, so metric deltas stopped meaning "retrieval changed".
  Proven fixed: two back-to-back eval runs are now byte-identical per query (67/67 grades + topIds).
- Updated dependencies [396c9a5]
- Updated dependencies [396c9a5]
  - @samesake/core@3.1.0

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

### Patch Changes

- Updated dependencies [fcb5742]
  - @samesake/core@3.0.0

## 2.4.1

### Patch Changes

- 87a8d9c: Use `workspace:^` for inter-package dependencies. In dev this always resolves to the local
  workspace package; at publish `bun publish` rewrites it to a real `^<version>` (verified via
  `bun pm pack`). Replaces the previous loose `^2.0.0` ranges that could silently resolve to a stale
  published version (the bug that left `apps/playground` pinned to `^1.3.0`).

# @samesake/server changelog

## 0.5.4 — 2026-05-20

**Framework owns the schema contract; consumer apps own the prompt body.**

Restructured `parseService` so the framework's default no longer carries
domain-specific content. Reviewer feedback: the 0.5.3 default had
Sri Lankan SME examples, currency conventions, and Sinhala/Tamil
language rules — all project-specific content that mis-steers any
other consumer (healthcare, global retail, etc.).

### Changes

- `PRODUCT_PARSE_SCHEMA_CONTRACT` (new, exported): a small block that
  defines only the schema contract and the cross-script invariant.
  `parseService` ALWAYS prepends this to the final prompt, whether
  the consumer overrides or not. Consumers do not need to restate
  the contract in their override.
- `DEFAULT_PRODUCT_PARSE_BODY` (new): the minimal generic role-block
  used when `entity.parse.instructions` is not provided. No domain
  content, no examples — just "you parse one product name, faithful
  extraction is your only job".
- `DEFAULT_PRODUCT_PARSE_INSTRUCTIONS` retained as a deprecated alias
  to `DEFAULT_PRODUCT_PARSE_BODY` for 0.4.x callers. Will be removed
  in 0.7.x.
- `parseService.parseProductName` composes the final prompt as
  `PRODUCT_PARSE_SCHEMA_CONTRACT + "\n\n" + (instructions ?? DEFAULT_PRODUCT_PARSE_BODY)`.

### Migration

The parse-cache key includes a hash of the final composed prompt, so
this change invalidates all cached parse results automatically.

Consumers whose 0.5.3 override was a full prompt should split it into:

1. Their domain content (role + examples + extraction rules) → keep
   in their entity's `parse.instructions`.
2. Schema contract — DELETE from the consumer override; framework now
   provides it.

For demo consumers: the Sri Lankan SME prompt previously living in
the framework moved to the consumer's entity config as the
`parse.instructions` on the stockbook_item entity. Same content
(OCR digit-letter rule, brand-position rule, 6 examples including the
Sinhala "කිස්ට් ඇපල් නෙක්ටා 5OOml" case) — different location.

## 0.5.3 — 2026-05-20

**Strengthened default product-parse prompt — addresses the residual
"4OOg" OCR digit-letter miss documented in
docs/baselines/2026-05-20-cross-script-AFTER.md §2.**

DEFAULT_PRODUCT_PARSE_INSTRUCTIONS restructured per Anthropic /
GPT-5 / Vercel AI SDK prompt-engineering guidance:

- XML-tagged sections: `<role>`, `<rules>` with id'd rule blocks,
  `<examples>` with 6 curated input→output pairs covering the
  measured failure modes, `<output_format>`.
- New rule `ocr_digit_letter`: explicit instruction to normalise
  letter-O / letter-l confusions inside size tokens (the
  load-bearing change for the "Anchor full creme milk pwdr 4OOg"
  case that was the only miss after 0.5.2).
- New rule `preserve_language` distinguishes 'item' (original
  script) from 'item_canonical' (lowercase Latin), removing
  earlier ambiguity that surfaced as inconsistent cross-script
  parse output.
- New example with Sinhala 'කිස්ට් ඇපල් නෙක්ටා 5OOml' input,
  demonstrating both the original-script preservation in 'item'
  and the OCR normalisation in size_value.

### Migration

The parse-cache key includes a hash of the instructions string, so
this change invalidates all cached parse results automatically.
Existing rows in the per-project entity\_<kind>\_match tables retain
their stored parsed columns; they will not be re-parsed unless the
caller re-upserts. For demos and design-partner deploys, wipe and
re-seed; for production, re-upsert affected rows when convenient.

No DDL change. No schema-gen change.

## 0.5.2 — 2026-05-20

**Fail-loud parse for parse-shape entities.**

Discovered while testing the stockbook inventory matcher: `upsert.ts`
caught `parseProductName` failures and silently stored rows with NULL
brand/item/size_value/size_unit. Those rows were then un-matchable by
the brand_gate, size_unit_gate, and item-cosine channels downstream.
The original symptom was 2/10 seeded stockbook items having empty
parse data (Gemini was rate-limited during seed; the catch swallowed
the error).

### Changes

- `parseService.parseProductName` now retries on transient
  user-parse failures with exponential backoff (0.3s, 1s, 3s). After
  all retries exhausted, throws with the full error chain.
- `upsert.ts` no longer catches parse failures — the error propagates
  to the caller (seed script, API route, etc.). The caller decides
  whether to retry the upsert or surface the failure to the user.
  This prevents the silent-NULL-row class of bug.

### Migration

No DDL change. Existing 0.5.x deployments can adopt directly. Rows
that were upserted under 0.5.0 / 0.5.1 with NULL parse data are
still un-matchable until they are re-upserted (parse step then runs
with retry); consumers should re-upsert any rows whose `brand_normalised`
is NULL on a parse-shape entity if matching is required.

## 0.5.1 — 2026-05-20

**Production fix for Tamil↔Latin and Sinhala↔Latin same-name matching.**

### Background

Adversarial Sinhala+Tamil customer-list testing (see
`docs/baselines/2026-05-20-cross-script-baseline.md` in the
consuming `@samesake/core` repo) found two production defects on the
Day-1-import flow for Sri Lankan SME customer books:

- Tamil ↔ Latin same-name pairs (e.g. `Arun Sillarai ↔ அருண் சில்லரை`)
  produced divergent phonetic keys (`RNSLR` vs `RNCLR`) because
  Tamil `ச` was mapped to category `C`. In Sri Lankan / modern
  Tamil, `ச` at word-start is the `s` sound — the per-script map
  was factually wrong.
- Even when phonetic keys converged (e.g. `Anuja Wiwarana ↔ අනූජ
විවරණ` both → `NCVRN`), the trigram channel returned 0 because
  the two scripts share no character n-grams in their original
  form. With cosine alone carrying ~85% of the combined-score
  weight, cross-script same-name pairs sat at the 0.78 suggest
  threshold instead of clearly above it.

### Changes

**`samesake_phonetic` (system DDL)**

- Tamil `ச` → `S` (was `C`). Aligns with how Latin `s` already maps.
- Tamil `ஜ` → `C` explicitly (was bundled with ச in `'சஜ' → 'CC'`).
  Preserves the j-class mapping to align with Latin `j`.

**Generated `match_<kind>` SQL (people-shape)**

- Trigram channel is now `GREATEST(similarity(query.norm,
candidate.name_normalised), similarity(query.phon,
candidate.phon_hash))`. Intra-script pairs still use the richer
  normalised-text similarity (no behavior change). Cross-script
  pairs gain a trigram bridge via their phonetic signatures — for
  identical phonetic keys, trigram ≈ 1.0 instead of 0.

The parse-shape (asset / stockbook) match function is unchanged —
its trigram channel uses the same `name_normalised` form, but
parse-shape entities don't rely on cross-script phonetic equivalence
in the production workloads we have today. (If they do later, the
same change applies there.)

### Migration / cache implications

The `samesake_phonetic` change means stored `name_phon` values
computed by 0.4.x are stale for any row whose name contains Tamil
`ச`. Existing 0.4.x deployments need to re-upsert affected rows to
recompute `name_phon` before the matcher returns correct results.
The embedding cache (`samesake_embed_cache`) is unaffected —
embeddings did not change.

For new deployments: just run `matcher.apply()` / `matcher.upsertOne()`
on the new version. The DDL is idempotent; `CREATE OR REPLACE
FUNCTION` swaps in the new phonetic logic.

### Acceptance evidence

See `docs/baselines/2026-05-20-cross-script-baseline.md` §5 for the
required pass/fail per row on the adversarial Sinhala + Tamil blobs.
A focused phonetic smoke lives at
`scripts/cross-script-smoke.ts` in the consuming repo.

## 0.4.3 — 2026-05-19

Per-entity channel weights honored in generated SQL.

## 0.4.2 — 2026-05-19

Per-scope thresholds wildcard fallback; r.candidates strictly above suggest.

## 0.4.1 — 2026-05-19

Dedup-function name-field bug; honors entity nameField (not hardcoded `a.name`).
