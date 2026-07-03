# samesake — full-scale fashion search engine architecture (build-for-one)

Status: End-state blueprint · Date: 2026-07-01 · Lens: `build-for-one` (definite direction, lean
increments). This is the "1" — what the system looks like designed correctly from day one — plus an
honest map of what's built vs. what's next. It is the destination every increment is measured against,
not a big-bang plan to build all at once.

---

## The "1" (Rome)

> **An internal, intent-driven product-discovery engine for fashion commerce: a shopper describes what
> they want in plain language — or shows a picture — and gets the right pieces, ranked correctly, on
> top of the Postgres the store already owns, because samesake has enriched the store's poor catalog
> into clean, structured, machine-rankable attributes.**

The job is *"turn a store's bad catalog into search that understands intent,"* not *"ship a generic
search framework."* At full scale this is a **Search + Enrichment toolkit** for a fashion catalog of
~100k–1M+ SKUs, where **enrichment accuracy is the moat** (measured + gated), the model is **BYO** (not
the moat), and the whole thing runs in **your own Postgres** (own-your-data).

## Architecture principles (the guiding policy)

1. **Enrichment is the product; retrieval is its consumer.** Search quality is downstream of
   enrichment quality — garbage in, garbage ranked. Invest in extraction accuracy first.
2. **Own-your-data, Postgres-native.** One datastore (pgvector + pg_trgm inside the store's Postgres),
   no separate search cluster to sync, no catalog egress to a vendor cloud — until scale genuinely
   forces the escape hatch.
3. **Eval-gated everything.** No change to enrichment prompts, ranking, or NLQ ships without passing
   the three eval suites. The evals *are* the moat's proof and the reason "better than Algolia" is
   provable, not asserted.
4. **BYO models.** `gemini-embedding-2` (embeddings) + `gemini-3.1-flash-lite` (classify/extract/NLQ/
   judge). The moat can't be the model, so it must be enrichment accuracy + eval discipline + the
   vertical's gold data.
5. **Definite direction, lean increments.** Build the end-state *shape*; do not build speculative
   *capability* (sharding, billion-vector infra, multi-vertical generality) before a real caller needs it.

---

## The layered architecture

```
                              ┌─────────────────────────────────────────────────────────┐
 CONSUMPTION                  │ in-process · fetch(Request) · Hono mount · MCP · @samesake/client (React) │
                              └───────────────▲─────────────────────────────▲───────────┘
                                              │                             │
 L3  TOOLKIT (merchant + dev)   autocomplete/suggest · auto-synonyms(from enrich) · merchandising rules
                                 · analytics/events · A/B · highlighting · headless React UI
                                              │                             │
 L2  RETRIEVAL CORE            NLQ → hard filters + semantic residual → hybrid RRF
                                 (lexical + semantic(HNSW) + spaces) → OOD floor → rerank →
                                 ranking boosts → variant diversify → facets · /explain
                                              ▲                             │
 L1  INGEST + ENRICHMENT       connectors(Shopify/Woo/JSONL/push) → normalize → ENRICH
     (THE MOAT)                  (classify→extract, vision+text LLM) → confidence gate/quarantine
                                 → few-shot correction loop → index (embed doc + rerank doc + fts src)
                                              ▲                             │
 L0  DATA + INFRA              Postgres 15+ : pgvector(HNSW+halfvec+iterative scans) · pg_trgm ·
                                 unaccent · fuzzystrmatch  |  BYO embed/generate  |  Fly/CF Workers(Hyperdrive)
                                              ▲                             │
 L4  QUALITY SPINE (cross-cutting gate on every layer)
      enrichment-accuracy eval · golden search eval · adversarial red-team · deterministic LLM-judge · calibrate
```

### L0 — Data & infrastructure
- **One Postgres per store** with `vector` (pgvector HNSW), `pg_trgm`, `unaccent`, `fuzzystrmatch`.
  Per-project schema, DDL generated at runtime from the typed config.
- **Vector config (end state):** `halfvec` embeddings by default (2× smaller, <1% recall loss),
  `hnsw.iterative_scan` on for filtered queries, tunable `ef_search`. At 100k–1M SKUs this fits in RAM
  on a modest box — no exotic vector extension needed (see `postgres-high-scale-search.md`).
- **BYO models** injected at `createMatcher`: `embed` (gemini-embedding-2) + `generate`
  (gemini-3.1-flash-lite). No model bundled.
- **Deploy:** the store's app process + Postgres. Fly (controlled VM — the path to BM25 later), or CF
  Workers + Hyperdrive→managed PG. Two containers, no Redis/Elasticsearch.

### L1 — Ingestion & enrichment (**the moat**)
The pipeline that turns a poor catalog into machine-rankable data:
1. **Connect:** Shopify/Woo (auth-free `/products.json`), JSONL, or direct `pushDocuments`.
2. **Normalize:** raw fields → canonical shape; content-hash for change detection.
3. **Enrich (2-stage LLM, image-aware):** `classify` (category, gender, product_type, is_apparel) →
   `extract` (colors+raw_color, pattern, material, fit, occasions, styles, neckline…, confidence,
   uncertain_fields). Controlled taxonomy + enums; value normalization (base color + marketing name);
   stage-cached, retryable, error-rate circuit-breaker.
4. **Gate/quarantine:** low-confidence / uncertain-load-bearing / cross-signal-disagree / non-apparel /
   invalid-price rows are quarantined out of the index.
5. **Few-shot correction loop:** human review corrections feed back as few-shot examples into the
   enrich prompt — the right mechanism for edge cases (vs. destabilizing global prompt edits).
6. **Index:** compose the dense embed doc, the rerank doc, and the FTS source; embed and write.

### L2 — Retrieval core
- **NLQ** parses the query → hard filters (price, color, gender, occasion, negation) + a cleaned
  `semantic_query` + aesthetic→style expansion ("quiet luxury"→minimalist/classic). Hard filters stay
  hard (SQL WHERE); no category-`other` poison.
- **Hybrid RRF** over three legs: **lexical** (FTS today; BM25 candidate later), **semantic**
  (pgvector HNSW cosine), **spaces** (segmented visual + price + category + freshness vectors).
- **Modes:** `intent` (keyword = tiebreaker) vs `similar` (keyword off; visual/semantic decide;
  auto when an image is present) — the composed "like this, but black" query.
- **OOD rejection** (relevanceFloor, roadmap): off-domain queries return no-results instead of junk.
- **Rerank** (BYO cross-encoder) → **multiplicative ranking boosts** (merchandising signals) →
  **variant diversification** → **facets** (enum/array/range). `/explain` shows per-leg contributions.

### L3 — Toolkit (the ecommerce surface — what makes it a toolkit, not just an engine)
Each feature is **powered by enrichment**, which is how it beats a generic engine:
- **Autocomplete / query-suggestions** — over enriched attributes + popular queries.
- **Auto-synonyms** — *derived* from the enrichment map (raw_color→base, aesthetic→style), not hand-maintained.
- **Merchandising rules** — pin/bury/boost over enriched attributes (built on the ranking-boost primitive).
- **Search analytics** — events (query, results, clicks, conversion, no-results) → the feedback substrate.
- **A/B testing** — ranking configs, winner chosen by `calibrateSearch`.
- **Result highlighting**; **`@samesake/client`** — a typed client + headless React layer (task #16).

### L4 — Quality spine (the defensibility — cross-cutting)
The reason every layer's changes are safe and "better" is provable:
- **Enrichment-accuracy eval** (`matcher.evaluateEnrichment`) — per-attribute P/R/F1 vs gold; the
  root-cause loop. Live re-enrich harness for prompt changes.
- **Golden search eval** (`matcher.evaluateSearch`) — LLM-judge relevance across query-type buckets.
- **Adversarial red-team** — OOD, numerical, injection, contradiction, degenerate, polysemy.
- **Deterministic LLM-judge cache** — grades persisted by (judge-version, query, doc) so pre/post
  deltas reflect retrieval, not judge noise.
- All wired as **merge gates**: enrich-prompt / taxonomy / NLQ / ranking changes must pass.

---

## End-to-end flows

**Index path:** connector/push → normalize → enrich (classify→extract, cached) → gate → compose docs
→ embed (halfvec) → write per-project tables. Durable execution wraps enrich/index in the caller's
platform step (Inngest/Workflows) for large catalogs.

**Query path:** `q` (+ optional image) → NLQ (hard filters + semantic_query, cached) → embed query →
hybrid RRF (lexical + semantic + spaces, mode-weighted) → OOD floor → rerank top-N → ranking boosts →
variant diversify → facets → hits + `/explain`. Analytics event emitted.

---

## Build state → end state (honest map)

| Layer | Component | State |
|---|---|---|
| L1 | 2-stage enrichment, gate, stage-cache, retry, few-shot loop | **Built** |
| L1 | Fashion taxonomy/enums, value normalization, colour base-rule | **Built** (colour fix shipped) |
| L1 | Non-apparel/kids edge cases | **Open** → few-shot loop (global prompt edits regressed) |
| L2 | Hybrid RRF, intent/similar modes, NLQ→filters, facets, rerank, boosts, variants, explain | **Built** |
| L2 | NLQ category-`other` poison | **Fixed** (use-case no-results 30%→0%) |
| L2 | **OOD rejection** (relevanceFloor) | **Open** (P0 — red-team: 7/8 OOD return junk; needs calibration) |
| L2 | **Lexical BM25** (replace ts_rank) | **Deferred** — measure-first, then bake-off; deployment-gated (see #17) |
| L0 | pgvector HNSW; halfvec + iterative scans | HNSW **built**; halfvec/iterative-scan **P-now adopt** |
| L3 | autocomplete, auto-synonyms, merchandising, analytics, A/B, highlighting | **To build** (the toolkit gap vs Algolia) |
| L3 | `@samesake/client` (frontend SDK + headless React) | **To design** (task #16) |
| L4 | enrichment eval, golden eval, red-team, deterministic judge, calibrate | **Built** |
| L4 | multilingual (Sinhala/Tamil) relevance | **Open** (roadmap) |

---

## Scale path (from `postgres-high-scale-search.md`)
- **Launch → ~1–2M SKUs/store:** single tuned Postgres + pgvector HNSW + halfvec. No sharding, no
  extra vector extension. Comfortable, sub-100ms warm.
- **Lexical upgrade (quality, not scale):** on controlled PG, bake-off BM25 (`pg_search` vs
  `vchord_bm25` vs tuned `ts_rank`) once the eval confirms lexical is the bottleneck.
- **Multi-million vectors / self-host:** pgvectorscale StreamingDiskANN or VectorChord IVF+RaBitQ.
- **Escape hatch:** >~few-million SKUs/tenant with sub-second faceted UX → external engine via CDC.

## What we deliberately do NOT build (capability discipline)
Sharding/Citus, billion-vector infra, a proprietary model, general multi-vertical abstractions, and a
second search datastore — until a real caller needs them. These are the premature-scaling traps the
"1" exists to avoid. Definite direction, lean increments.

## Related docs
`product-direction` (the "1") · `search-enrichment-accuracy-implementation-notes.md` (L4 enrichment eval)
· `search-eval-phase1-implementation-notes.md` (L2/L4 golden eval + fixes) · `search-redteam-implementation-notes.md`
(L4 adversarial) ·
`README.md` (current API surface).
