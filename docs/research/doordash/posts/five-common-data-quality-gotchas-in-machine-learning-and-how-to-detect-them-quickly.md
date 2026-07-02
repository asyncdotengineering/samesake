# Five Common Data Quality Gotchas in Machine Learning and How to Detect Them Quickly
URL: https://careersatdoordash.com/blog/five-common-data-quality-gotchas-in-machine-learning-and-how-to-detect-them-quickly/

## Key mechanisms
- **Two-call Pandas profiling (`dqr_table`)** — `from dataqualityreport import dqr_table; dqr_table(my_df)` renders one scannable row per column with dtype, missingness, validity, distribution, and cardinality (Fig 1).
- **Missingness beyond `% null`** — compact pie charts for gross missing (Fig 2); a **% Missing Heatmap** across columns to surface *correlated* missing (cols 2–4 fail together, col 1 is independent — Fig 3); **partition-key missing** via a user-supplied date column (e.g. `active_date`) showing day-level gaps and “last partition partially loaded” (Fig 4).
- **Invalid-value sentinels** — separate **% Zeros** and **% Negative** pie charts to catch `-1`/`0` standing in for NULL (common in duration features — Fig 5).
- **Distribution anomalies** — per-column **box plots** for outliers (timezone/off-by-one/overflow/canary leakage — Fig 6); **Robust Histogram** (IQR-trimmed) to expose **default-value spikes** (system mean / untouched user defaults).
- **Sampling / join integrity** — **Cardinality** + `*` marker for unique columns to catch duplicate primary keys from bad joins (Fig 7); **`dqr_compare(train, eval)`** with alphabetically collated columns and **shared-axis** histograms/box plots to spot train/eval skew (Fig 8).
- **Schema typing** — explicit **dtype** column flags numeric columns stored as `object` (Fig 9).
- **Scope note:** this is **tabular training-feature QA** (open-source [DataQualityReport](https://github.com/doordash-oss/DataQualityReport)), not retrieval architecture — no embeddings, fusion, rerankers, or serving paths.

## Learnings for samesake
### L1: Treat sentinel fallbacks as invalid values, not “mostly fine”  [maps: G3 | G2 | NEW]
- DoorDash evidence: DQR flags small **% Zeros / % Negative** and **default spikes** in robust histograms — values that look in-domain but encode “unknown” (`-1`, `0`, population means).
- Samesake action: audit and ban the same pattern in the pipeline seams the RFC already names — (1) **`embed-index.ts` title-only fallback** when `$enriched.embed_doc` is empty (REQ-11: log + skip, never fallback); (2) **zero visual segment on image-fetch failure** (REQ-18b / M5: `pipeline_status='failed'`, not indexed); (3) enrich defaults that read as real attrs (`category: "other"`, `pattern: "solid"`, `confidence` omitted → treated as 1). Wire **`gate`** (`templates/fashion.ts`) to reject rows where `uncertain_fields` covers load-bearing attrs, not only `confidence < 0.4`.
- Why / caveat: samesake’s “features” are JSONB enrichment + vectors, not Pandas columns, but the failure mode is identical — silent sentinels poison search. Fashion is single-vertical and smaller scale, so you can fix this in-process gates rather than a warehouse ETL; the *detection* idea still applies.

### L2: Correlated-missing heatmaps beat single-field review for enrich QA  [maps: G2 | NEW]
- DoorDash evidence: Fig 3 — **% Missing Heatmap** shows columns 2–4 missing together → one root cause (join/outcome), not four independent bugs.
- Samesake action: extend the existing review path (`review.ts` confidence filter) with a **collection-level enrich QA report** over `enriched` JSONB: co-missing groups (e.g. `colors` + `material` + low `confidence` + long `uncertain_fields`), and **conditional missing** (`is_apparel_product=false` ⇒ whole attribute block empty). Run after `enrich`, before `index`; surface in playground/ops, not only post-search debugging.
- Why / caveat: DoorDash’s heatmap is for tabular ML features; samesake has ~15 nested enrich fields and two LLM stages — correlated failure is the norm when stage-1 `classify` misroutes or the image is bad. Cheap SQL/JSON aggregation replaces Pandas; no need to adopt DQR itself.

### L3: Partition/time-series missing views for catalog drift  [maps: G1 | G6]
- DoorDash evidence: Fig 4 — **`active_date` partition column** reveals (a) many days fully missing for a field, (b) trailing partition partially missing because upstream wasn’t ready; they recommend **dropping the bad tail partition** so train missingness matches online scoring.
- Samesake action: when logging `pipeline_status`, `attempt_count`, `image_checked_at` (RFC C1/C10), add scheduled **time-sliced QA**: quarantine/failed/dead rates and **`revalidateImages` changed-count** by `ingested_at` / `enriched_at` week. Alert on “new ingest cohort suddenly 40% quarantined” or “last 3 days high `failed` with `last_error` = image fetch”. Optionally exclude cohorts under investigation from search (same spirit as dropping the partial partition).
- Why / caveat: samesake isn’t daily warehouse ETL at DoorDash scale, but CDN/image URL drift (G1) and enrich LLM outages (G6) *are* temporal; timestamp-only state today hides cohort effects.

### L4: `dqr_compare`-style ready vs quarantined distribution checks  [maps: G2 | G5 | G3]
- DoorDash evidence: Fig 8 — **`dqr_compare`** aligns columns across datasets with shared axes to catch “eval under-represents Col_1”.
- Samesake action: before trusting **`gate`** thresholds, compare distributions of **`compose` outputs** on rows that pass vs fail gate: `embed_doc` length/token stats, presence of `search_document`, attr cardinality (`category`, `gender`, `colors`). After G5 lands, assert **`rerank_doc`** is populated whenever `embed_doc` is — catch compose skew where reranker would still scrape title. One-shot script over collection table, not per-query.
- Why / caveat: you don’t have separate train/eval tables; **`ready` vs `quarantined` vs `failed`** *is* your split. Prevents calibrating `FASHION_CONFIDENCE_FLOOR=0.4` blind and validates REQ-11b (hard attrs removed from `embed_doc` but still present in `rerank_doc`/filters).

### L5: Cardinality / almost-unique checks on ingest keys  [maps: G1 | NEW]
- DoorDash evidence: Fig 7 — **Cardinality** + `*` uniqueness flag catches duplicate join keys corrupting supervised sets.
- Samesake action: add ingest-time checks: **`content_hash` collision rate** (many SKUs → one hash because only URL is hashed today — G1); duplicate **`image_url`** across different `id`s; duplicate **`title`** with divergent enrich outputs. Fail or flag in ingest observability, not only at search time.
- Why / caveat: product catalogs reuse stock photos and stable URLs — uniqueness violations are a real G1 trigger for wrong re-embed resets. Lower priority than L1–L4 unless you see hash collisions in production.

## Applicability caveats
- **Not a search/retrieval post.** No RRF, HNSW, cross-encoder rerank, NLQ, or multimodal fusion — nothing to import for G4/G5/G7 beyond generic “measure your data.”
- **Training-table mindset.** DQR assumes a flat Pandas dataframe of model features; samesake’s state is Postgres rows + JSONB + vectors + stage cache (`stageCacheKey` URL-only — RFC M1). Mechanisms transfer as *diagnostics on collection tables*, not as a drop-in library.
- **Scale and vertical.** DoorDash’s partition-missing story is warehouse ETL at marketplace scale; samesake is single-vertical fashion with BYO providers — invest in **pipeline-integrated gates/reports** (RFC compose/gate/retry) rather than rebuilding DQR.
- **Honest yield:** 2–3 ideas (sentinel detection, correlated missing, temporal cohort QA) materially reinforce the RFC; the rest is “build lightweight catalog QA scripts inspired by DQR,” not new retrieval architecture.
