---
"@samesake/core": major
"@samesake/server": major
"@samesake/cli": major
"@samesake/mcp": major
---

Tier-0 retrieval defaults baked in, and the zero-config indexing path is fixed.

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
