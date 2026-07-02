# BUILD-READY — Conversational/Agentic Commerce Search Framework

Green-light check + prioritized first moves, distilled from the research tree (21 initial
dossiers + 11 completeness-pass dossiers in `10-gaps/`) and the `07-decisions/` docs. Ordered by
**leverage × confidence × architectural fit**. Each item names the decision/dossier evidence.

## Green light

The research **confirms the working hypothesis** and the completeness pass **hardened it**:
samesake's bet — brand-owned, in-app, typed, auditable hybrid retrieval over commodity Postgres
with BYO models — is validated by competitors and the literature alike. The opportunity is **not
"train a better embedding"** — it's making hybrid retrieval + hard constraints + agent protocols
*correct, explainable, and scale-honest by construction*. The one direct OSS analog (Marqo OSS)
deprecated; the slot is open.

## Tier 0 — correctness must-fixes (not optional)

1. **Filtered-recall eval + pgvector iterative scans.** Deterministic recall under realistic hard
   filters; `hnsw.iterative_scan='relaxed_order'` + exact-KNN fallback; surface in `/search/explain`.
   *Without this, "hard filters stay hard" is unverified.* → D-02§6, D-06§4, D-25.
2. **Head/tail + type-stratified eval reporting** + **version-pin/hash the judge prompt** and
   **stop enriching & judging with the same model family** (self-preference loop). → D-06, D-25.

## Tier 1 — the LK quality core + agent reach (highest leverage)

3. **Wire existing cross-script matching into product search** ⭐ — *Corrected after code
   inspection:* samesake already ships `samesake_normalise` + `samesake_phonetic` (Indic-Soundex,
   Sinhala+Tamil+Latin) used by entity-resolution (`db/system-ddl.ts:47,64`), but the **collection
   product-search keyword leg is hardcoded `to_tsvector('english')`** (`collections-schema-gen.ts:88`,
   `search.ts:288`) and never calls them. Reuse them: add a `name_normalised`/`phon_hash` generated
   column on collections + a trigram/phonetic similarity leg to `Channels.fts` (or a new
   `Channels.lexical`). *This is the #1 quality investment and it's mostly rewiring, not new code.*
   Optional upgrades (not first): learned transliteration front-door, BGE-M3 sparse leg via
   `sparsevec`. → D-16.
4. **doc2query at index-time** (incl. LK transliteration/code-mixed variants, Doc2Query--filtered)
   — zero query-time cost, attacks vocabulary mismatch at the source. → D-18.
5. **Named cross-encoder reranker** = `bge-reranker-v2-m3` (Apache-2.0, 100+ langs), optional,
   latency+FLOPs-gated over the RRF top-K. → D-02§3, D-18.
6. **`halfvec` as default pgvector column** + ship embedding defaults (Qwen3-0.6B +
   Marqo-FashionSigLIP open; Gemini/Cohere v4 managed). → D-17.
7. **UCP-Catalog MCP server** + **richer handoff contract** (typed output, per-field provenance,
   calibrated scores/entropy, freshness re-verify) — built **to the MCP security spec** (OAuth 2.1,
   no token passthrough, one read scope `catalog:search:read`, per-agent identity → hard SQL gate,
   never return vectors). → D-04, D-21.

## Tier 2 — merchant table stakes (a store can't run without these)

8. **Score modifiers** (popularity/freshness/margin/quality) — bounded scalars × tenant weights,
   multiplicative post-RRF, raw inputs + contributions in `/search/explain`; **pins/hides** as
   deterministic splices. → D-19.
9. **`GROUPING SETS` faceting** with compiler-generated correct *filtered* counts. → D-19.
10. **Count-gated zero-result relaxation ladder** ending in **vector-only fallback** (the LK
    weapon), hard filters never relax, path logged in `/search/explain`. → D-19.
11. **Size-availability hard gate** (`variants(sku,size,in_stock)`) + signed `fit_signal` soft
    modifier from enrich. → D-22.
12. **Field-collapse diversity** (`DISTINCT ON`/window) + near-dup ε-collapse over top-K. → D-19.

## Tier 3 — surface depth + personalization

13. **Content/context-vector personalization** — taste vector (Rocchio) fused into the probe;
    **"more-like-this" + "less-like-that"**; **visual-onboarding cold-start** (sidesteps LK
    language); externalized multi-turn constraint accumulator. No interaction log. → D-20.
14. **VL-CLIP enrich preprocessing** (ground/crop garment → embed; LLM-normalize text → embed) —
    index-time, +18.6% CTR proven. → D-24.
15. **ACP product-feed exporter + Google Shopping CSV + schema.org JSON-LD** + **`/catalog/lint`**
    completeness linter (catalog legibility for external agents). → D-23.
16. **One bounded clarifying question**, gated on retrieval entropy + hard-filter cardinality. → D-04§2.
17. **Optional VLM reranker** (top-k≤20, off by default) — gate on LK bench. → D-24.

## Tier 4 — scale + advanced (per-tenant, when triggered)

18. **CC fusion path** (≥~50 labeled queries) + re-investigate "spaces" under CC weighting. → D-02.
19. **pgvectorscale (StreamingDiskANN) / pg_textsearch** upgrade path; **MUVERA FDE** pilot for
    late-interaction-in-pgvector; **LambdaMART** feature-rerank once interaction data exists. → D-03, D-24, D-18.
20. **Native item-to-item + BYO FitRecommender adapter**; **OWL-ViT bbox highlights**. → D-22, D-24.

## Explicit non-goals (stay out)

- ❌ Generation / checkout / payment — feed them, don't build them.
- ❌ Behavioral CF / sequential / graph recsys — no log; breaks two-container.
- ❌ ColBERT/SPLADE, **raw ColPali, VectorChord (AGPL)**, ParadeDB pg_search (AGPL), Elasticsearch-AGPL.
- ❌ Fit-prediction model, body scans; ranking-control / GEO rank guarantees; mention-count dashboards.
- ❌ Claiming "injection-safe" or Marqo-style unverifiable hero numbers; baking margin into the model.
- ❌ Blanket background removal (degrades pretrained encoders); naive un-gated LLM description rewrite.

## First 3 commits (concrete)

1. `eval: filtered-recall harness + head/tail/type stratification + version-pinned judge` (Tier 0).
2. `search: route collection keyword leg through samesake_normalise+samesake_phonetic+pg_trgm (reuse entity-resolution primitives) instead of english-only tsvector` (Tier 1, the LK core).
3. `retrieval: pgvector iterative scans + optional bge-reranker-v2-m3 over RRF top-K, both behind the eval gate` (Tier 0/1).
