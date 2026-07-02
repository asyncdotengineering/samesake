# RFC: Close the skippable-seam gaps in the enrich → index → search pipeline

**Category:** Architectural Change
**Author:** octalpixel
**Date:** 2026-06-20
**Status:** Draft (rev 5 — G2/G3/G5 redesigned around the breaking **`indexing` DSL** chosen via `/design-an-interface` (`docs/design/indexing-dsl.md`): required `indexing.surfaces` builders + required `gate`, replacing the optional `compose?/gate?` hooks and the `$enriched.*` string source. Embrace-breaking-changes posture, alpha. rev 4 — G4 reranker resolved to **blend, not replace** from tobi/qmd `docs/research/qmd/README.md`; open questions researched in `docs/research/open-questions-literature.md`. rev 3 = DoorDash corpus (confidence-floor + multiplicative-fusion + G8 eval harness, `docs/research/doordash/LEARNINGS.md`). rev 2 = opencode/GLM-5.2 review, `.handoff/wbs-rfc-pipeline-review.md`.)
**Reviewers:** opencode/GLM-5.2 (adversarial, suite-verified 172/172 green at `ad21a9a`)
**Related:**
- Baseline SHA `ad21a9a`
- Source comparison: production multimodal-RAG pipeline article (13-stage doc-RAG lifecycle) vs samesake product-retrieval pipeline
- Memory: `product-direction` (enrichment is make-or-break), `model-preferences`
- External research folded into rev 3: `docs/research/doordash/LEARNINGS.md` (37-post DoorDash corpus), `docs/research/mastra/README.md` (Mastra `@mastra/rag` rerank/retrieval internals)
- Code touched: `packages/server/src/connectors/normalize.ts`, `packages/server/src/core/{enrich-pipeline,embed-index,search,fashion-search,collections-schema-gen,collections-migrate}.ts`, `packages/sdk/src/{types.ts,templates/fashion.ts}`

---

## 1. Problem Statement

A line-by-line comparison of samesake against a production multimodal-RAG pipeline surfaced a consistent failure pattern: **the strong machinery exists, but the load-bearing steps are optional, consumer-driven, or silently skippable.** The article's thesis — "quality is decided long before the user types a query; nothing skippable, everything tracked" — maps directly onto samesake because, per `product-direction`, enrichment is the make-or-break stage.

Seven concrete defects, each verified against current code:

| # | Defect | Class |
|---|--------|-------|
| G1 | `content_hash` ignores image **bytes** (`normalize.ts:25-39`) — visual index drifts when the photo behind a stable URL changes | Correctness |
| G2 | No index-time **gate** on enrichment quality; the only gate is fashion logic **hardcoded into the generic indexer** (`embed-index.ts:339-345`); `confidence` is captured + reviewable but never blocks indexing | Correctness + layering |
| G3 | **Textualization is a skippable manual step** — `composeFashionEmbedDoc` must be hand-called between `enrich` and `index`; skip it and `resolveEmbedTemplate` silently falls back to `data.title` (`embed-index.ts:348-349`) | Correctness (silent degradation) |
| G4 | **Reranking is opt-in with no default** (`search.ts:825`), AND when wired it **replaces** the fused order outright (`search.ts:850-855` sorts purely by reranker score, discarding the RRF score) — so a confidently-wrong reranker can sink a high-confidence exact/visual match. Vague-intent fashion queries get RRF-as-final; precise queries risk reranker-torpedo | Relevance ceiling |
| G5 | **No reranker-text** — the reranker scrapes ad-hoc title/name/description (`search.ts:826-831`); there is no purpose-built representation | Relevance |
| G6 | **No durable pipeline tracking** — status is implicit in timestamps; enrich failures are counted then dropped (`enrich-pipeline.ts:231-233`); no attempt count, last-error, backoff, retry worker, or error-rate breaker; examples hand-loop `for(i<10){enrich()}` | Operability |
| G7 | Business/metadata boosts exist **only in the `fashion-search.ts` facade** (`:138-173`), not in core `search()`, and are hand-tuned **additive constants on raw RRF scores** of a different scale | Architecture (facade-only, unprincipled) |
| G8 | **No offline relevance feedback loop** — no human-calibrated LLM-as-judge eval harness. Every gap fix and ranking/prompt change is unfalsifiable before A/B, and samesake has no traffic to A/B against. (Surfaced by the DoorDash corpus as the single biggest missing piece — `docs/research/doordash/LEARNINGS.md`.) | Evaluability (blocks proving everything else) |

**Success criteria (measurable, post-implementation):**
- S1: Changing an image at a stable URL, then running `index`, produces a different image embedding for that row (G1).
- S2: A low-confidence / non-apparel enrichment never lands in the searchable set; it is routed to a `quarantined` status, queryable via the existing review endpoint (G2).
- S3: A consumer who declares `indexing.surfaces` and calls only `enrich` then `index` gets fully-built surface text (no separate manual step) — never a title-only fallback (G3).
- S4: With the fashion template and a configured `generate`, search returns a reranked order by default; the reranker is **blended** with retrieval (position-aware), not replacing it, so a high-confidence rank-1 hit survives a low reranker score; `rerank: false` restores pure RRF (G4).
- S5: The default reranker receives a verbose attribute-rich text per candidate, not just the title (G5).
- S6: A crash mid-enrich leaves rows in a `failed` state with `attempt_count` and `last_error`; a retry pass with capped attempts + backoff drains them; a run aborts when the per-run failure rate exceeds a threshold (G6).
- S7: The business/availability/personalization boost is reachable from core `search()` via a declared hook (not only the fashion facade), and operates on **normalized scores composed multiplicatively** (G7).
- S8: A repeatable offline eval harness produces per-query Hit@K / nDCG@K / MRR against a frozen golden set graded by a human-calibrated LLM judge, and is wired as a gate on ranking/enrichment changes (G8). The confidence floor (G2) is set by this harness, not hardcoded.

**Non-goals:** document parsing / OCR / chunking / answer-generation / citations (the article stages that do not apply to product retrieval); replacing pg-boss with an external durable queue (G6 is in-table state, not a new broker); a learned ranker; the `gender`/`kids`→`age_group` enum split (separate ADR per GLM-5.2 review — it is a schema migration of its own); fixing `apps/playground/lib/samesake.ts:36` `variantGroup: "content_hash"` (pre-existing misconfig, F7, out of scope — tracked separately).

---

## 2. Background

### 2.1 Current pipeline shape (verified)

Flow per row: `ingest` (upsert + `content_hash`) → `enrich` (LLM stages → `enriched` JSONB, sets `enriched_at`) → `index` (compose embeddings + `space_vec`, sets `indexed_at`) → `search` (RRF over FTS + cosine + spaces + recency, optional rerank). State is tracked by timestamps on the collection table (`collections-schema-gen.ts:90-93`): `ingested_at`, `enriched_at`, `indexed_at` (plus a generic `updated_at`, which is not a pipeline marker). Re-ingest with a changed `content_hash` resets `enriched_at`/`indexed_at`/`enriched` to NULL (`ingest.ts:45-60`), which is a clean idempotency design.

### 2.2 Why each defect is real (grounded)

**G1.** `contentHash()` (`normalize.ts:25-39`) and `computeContentHash()` (`:105-127`) hash `image_url`, not image content. For a *visual* search engine this is the wrong invariant: CDN re-crops and seasonal re-shoots behind a stable URL leave `content_hash` unchanged, so the re-enrich/re-embed reset in `ingest.ts:49-60` never fires. The visual index silently diverges from the live catalog.

**G2.** `fashionExtractSchema` already produces `confidence` and `uncertain_fields` (`fashion.ts:132-133`); `review.ts:33-40` already lists rows where `(enriched->>'confidence')::float < $1`, and `app-builder.ts:335` exposes `max_confidence`. So the signal is captured, persisted, and reviewable — but **post-hoc only**. Nothing prevents a low-confidence or misclassified row from being indexed. The *only* gate that exists is fashion-specific and hardcoded into the generic indexer: `embed-index.ts:339-345` skips rows where `enriched.is_apparel_product === false || enriched.category === "other"`. That is a layering leak — fashion semantics inside `@samesake/server`'s generic embed-index — and it ignores `confidence` entirely.

**G3.** `FASHION_EMBED_DOC_SOURCE = "$enriched.embed_doc"` (`fashion.ts:255`) and the playground/example configs set the doc embedding `source` to it (`apps/playground/lib/samesake.ts:25`). But the enrich pipeline never writes `embed_doc`; a separate `composeFashionEmbedDoc` (`fashion.ts:238`) must be called by the consumer between `enrich` and `index`. Every consumer hand-rolls this: `apps/playground/{lib/embed-doc.ts,app/api/upload/route.ts,scripts/sync-to-samesake.ts}`, `examples/fashion-search/{compose-embed.ts,spike-avirate.ts,run-pipeline.ts,eval-configs-lk.ts,live-lk-subset.ts,template-smoke.ts}`. If skipped or ordered wrong, `resolveEmbedTemplate("$enriched.embed_doc", …)` returns "" and `embed-index.ts:348-349` falls back to `data.title` — search silently degrades to title-only embedding with no error. This is exactly the "stage we skipped showed up later as a bad answer" failure the article warns about, baked into our own API as a footgun.

**G4 / G5.** The rerank seam is complete and graceful (`search.ts:819-856`, `RerankFn` in `packages/server/src/types.ts:96-110`, pool `RERANK_POOL=50`), but it has three defects: (1) `search.ts:825` returns first-stage order when `ctx.rerank` is absent, and no template wires one; (2) when wired, `rerankHits` **replaces** the order — `search.ts:850-855` re-sorts purely by the reranker's score and discards the RRF score, so one confidently-wrong rerank score demotes the best retrieval result (acute for samesake: a literal exact match or a near-perfect *visual*-space match can be sunk by a text reranker); (3) the candidate text is scraped ad-hoc from `title ?? name ?? data.title ?? data.description` (`:826-831`) — no reranker-specific representation.

The "replace vs blend" question is **resolved by tobi/qmd** (`docs/research/qmd/README.md` L1; `store.ts:4786-4793`): a production hybrid engine does NOT replace — it **blends** a rank-derived position score with the reranker score, weighting retrieval more heavily at the top of the list and the reranker more toward the tail (`0.75/0.60/0.40` at rank cutoffs 3/10). Rationale: retrieval confidence is highest at the head (exact/visual winners) and lowest at the tail, so the reranker's authority should grow exactly where retrieval's shrinks. This closes parent-RFC Q1's blend sub-question (REQ-13b).

**G6.** `ctx.jobs.run` wraps each stage (`enrich-pipeline.ts:154`), but the pg-boss runner resolves in-memory (per prior exploration of `packages/jobs-pgboss`), and `runEnrichCollection` counts failures (`failed++`, `:231-233`) then discards them: the row simply stays `enriched_at IS NULL` with no attempt count, no last error, no backoff, no alert. Recovery is a human re-running `enrich`. Examples encode this as `for (i<10) { enrich(); if (enriched===0) break }` (`spike-avirate.ts`). At catalog scale this is the gap that bites silently.

**G7 (reframed — partially built).** Business/availability/newness/personalization ranking **does** exist, in `fashion-search.ts`: `defaultRankingPolicy`/`mergeRankingPolicy` (`:53-81`) and `rankHits` (`:138-173`, including `buryUnavailable` → `score -= 2`). The defects are narrower than "missing": (a) it lives **only in the fashion facade**, so core `search()` and non-fashion collections have no boost hook; (b) it adds **hand-tuned constants directly onto raw RRF scores** (`:163-168`), mixing scales — a relevance RRF score (~0.0–0.05 range) and `score -= 2` are not commensurable. This is a hardening + promotion task, not a greenfield build.

### 2.3 Design seam chosen — the `indexing` DSL (rev 5, breaking)

The unifying fix for G2 + G3 + G5 is a **required `indexing` block** on the collection — the chosen interface from `/design-an-interface` ("D+ synthesis"), fully specified in **`docs/design/indexing-dsl.md`**. samesake is alpha, so this is a clean breaking redesign with no compat ([[embrace-breaking-changes]]):

```ts
indexing: {
  surfaces: {                                  // required keyed map, beside embeddings/spaces
    embed_doc:  { kind: "dense",  embedding: "doc", build: (ctx) => /* graded text only */ },
    rerank_doc: { kind: "rerank", build: (ctx) => /* verbose text */ },
    fts_doc:    { kind: "fts",    build: (ctx) => /* lexical text */ },
  },
  gate: (ctx) => ({ index: boolean, reason?: string }),   // required; generic; quarantine + reason
}
```

- Every retrieval surface is a first-class derived column with a **required `build` function** (no string template, no `data.title` fallback) — kills G3/G5. Builds run at enrich time and persist (so re-index never recomputes domain logic).
- `gate` is a **required** sibling returning `{index, reason}` → drives `pipeline_status` (G2), replacing the hardcoded fashion skip in `embed-index.ts:339-345`.
- `CollectionEmbeddingDef.source` is **removed**; a `dense` surface cross-references its embedding by key. Functions live on the in-process `AuthoredCollection` (like `enrich.stages[].prompt`); the serializable def carries an `indexingManifest` for offline validation.

This **supersedes** rev 3's optional `PipelineDef.compose?/gate?` hooks: "optional" is itself a footgun (still forgettable). `indexing` is non-optional on the authoring type, so omitting it is a compile error, not a runtime forget. Candidates B/C/A and the rationale are in the design doc; Q3 (hooks vs method) is therefore moot.

### 2.4 External corroboration (rev 3)

Two independent bodies of work, researched after rev 2, reinforce these gaps — see `docs/research/doordash/LEARNINGS.md` and `docs/research/mastra/README.md`:

- **DoorDash engineering corpus (37 posts).** "Content/profile quality dominates encoder choice" (+31% Hit@5 from LLM profiles vs +6% from a better encoder) validates G3/embedding-hygiene; quality gates before serving (confidence ≥0.80, guardrail models, jury veto) validate G2; two-stage retrieve-then-rerank as the standard shape validates G4; a human-calibrated LLM-as-judge eval gating changes before A/B is the named "single biggest missing piece" → **G8**; multiplicative business×relevance fusion (`R^α·S^β`) → **REQ-20**.
- **Mastra `@mastra/rag` source** (`packages/rag/src/rerank/index.ts`). Its default reranker is an LLM-judge (`MastraAgentRelevanceScorer`) behind a `RelevanceScoreProvider` interface with drop-in Cohere/Voyage/ZeroEntropy backends — a concrete pattern for G4's BYO-with-default. It scores only `metadata.text` with no rerank-specific representation — it *shares* samesake's G5 defect, so `rerank_doc` is a genuine improvement, not a copy. Its scorer combines `0.4·semantic + 0.4·vector + 0.2·position` but multiplies an **un-normalized** vector score by nudges — the exact scale hazard G7/REQ-20 names; borrow the multiplicative shape, normalize first. Its agent scorer is a ready-made LLM judge reusable for G8.

---

## 3. Strict Requirements

### G1 — image content invalidation
- REQ-1: `content_hash` MUST incorporate an image-version token when one is available on the row (`image_etag` / `image_updated_at` / caller-supplied `image_version`), so a known image change forces the existing re-enrich/re-embed reset.
- REQ-2: A `revalidateImages(project, collection)` pass MUST issue a conditional request (HEAD or `If-None-Match`/`If-Modified-Since`) per `image_url`, and on a changed ETag/Last-Modified MUST reset `indexed_at` (and `enriched_at` when the enrich pipeline consumes the image) to force re-embedding. It MUST reuse the hardened fetch path (`fetch-image.ts`) and MUST NOT fetch full bytes when a cheap validator suffices.
- REQ-3: Revalidation MUST be idempotent and resumable, and MUST record the observed validator (`image_etag`, `image_checked_at`) on the row.
- REQ-3b (blocker M1 — stage cache must not defeat revalidation): `stageCacheKey` (`enrich-pipeline.ts:15-25`) currently hashes `imageUrls.join(",")` (URLs, not content) and the stage cache is 90-day persistent (`stage-cache.ts`). Forcing re-enrich after an image change would return the OLD image's enrichment. The stage cache key MUST incorporate the per-image validator (`image_etag`/`image_version`/pHash) so a changed image misses the cache; OR revalidation MUST invalidate the affected stage-cache entries.
- REQ-3c (follow-up F4 — no-validator fallback): when a CDN strips ETag/Last-Modified, revalidation MUST fall back to a perceptual hash (pHash) computed from the bytes already fetched at embed time (`embed-index.ts:162-207`), so detection does not depend on CDN cooperation or an extra fetch (see Q2).

### G2 — quality gate / quarantine
> Realized by the `indexing` DSL (`docs/design/indexing-dsl.md`): the gate is `indexing.gate`, a **required** sibling of `indexing.surfaces` — not an optional `PipelineDef` hook.
- REQ-4: `IndexingDef` MUST carry a **required** `gate(ctx: DerivedDocContext) => { index: boolean; reason?: string }`. (Use a provided `gates.always` for index-everything — explicit, never an absence the runtime fills in.)
- REQ-5: `enrichOne` MUST evaluate `gate` after stages + surface builds; when `index === false` it MUST set `pipeline_status = 'quarantined'` (with `reason`) while still setting `enriched`/`enriched_at` (enrichment is complete).
- REQ-5b (blocker B1 — quarantine must leave the searchable set): when a gate flips a row to `quarantined`, `enrichOne` MUST also null its `doc`, `embedding`, and `space_vec` and clear `indexed_at` (a row that was previously `ready` and indexed must not retain stale vectors). Nulling `doc`/`embedding`/`space_vec` is necessary but NOT sufficient — `title` still feeds the generated `fts` column (`collections-schema-gen.ts:88`), so REQ-6b is also required.
- REQ-6: The indexer MUST NOT contain any fashion-specific predicate; the hardcoded `is_apparel_product`/`category === 'other'` check in `embed-index.ts:339-345` MUST be removed. The indexer MUST set `pipeline_status = 'ready'` on a successful index UPDATE (`embed-index.ts:422-427`) — this is what lets non-enrich collections (whose rows default `'pending'`) reach `'ready'` (blocker B2).
- REQ-6b (blocker B1/B2 — status filter at search time): the `staleClause` `pipeline_status = 'ready'` predicate MUST apply ONLY when the collection has an enrich pipeline (`needsEnrich`); non-enrich rows are `'pending'` until the indexer sets `'ready'` on success. Independently, `search()` MUST exclude rows where `pipeline_status NOT IN ('ready')` at candidate selection across ALL channels (FTS, cosine, spaces, recency) — not rely on nulled vectors alone, because FTS matches on `title`.
- REQ-7: The fashion template's `indexing().gate` MUST quarantine non-apparel, `category === 'other'`, and low-quality enrichments. "Low-quality" MUST NOT be a single hardcoded floor (the DoorDash corpus gates multi-vertical LLM features at **≥0.80**, far above the original 0.4 — `docs/research/doordash/LEARNINGS.md`). Instead the gate MUST combine: (a) `confidence < FLOOR` where FLOOR is **tuned by the G8 eval harness**, default `0.5` as a placeholder; (b) `uncertain_fields` intersecting load-bearing attributes (`category`, `gender`, `colors`); and (c) a cheap **cross-signal agreement** check (e.g. image-derived category vs title/tags), since a model's self-reported confidence is not trustworthy on its own [doordash-llm-transcribe-menu]. Quarantined rows MUST remain visible to the existing review endpoint (`review.ts:33-40`).

### G3 — unskippable textualization
> Realized by the `indexing` DSL (`docs/design/indexing-dsl.md`): each retrieval surface is an `indexing.surfaces[key]` with a **required** `build` function — no optional hook, no `$enriched.*` string template, no fallback.
- REQ-8: `IndexingDef.surfaces` MUST be a **required, non-empty** keyed map; each entry has a `kind` (`dense`/`rerank`/`fts`) and a **required `build(ctx: DerivedDocContext) => string`**. `CollectionEmbeddingDef.source` and the `$`-token template engine (`resolveEmbedTemplate`, doc path) MUST be **removed**; a `dense` surface cross-references its embedding by key.
- REQ-9: `enrichOne` MUST, after the inference stages, run every `surfaces[].build(ctx)` and `gate(ctx)` and **persist** the built surface texts (e.g. `doc`/`rerank_doc`/`fts_src` columns) + `pipeline_status` before `enriched_at` is set — so the indexer consumes typed persisted text (no `$enriched.*` resolution at index time) and a re-index never re-runs builders/domain logic.
- REQ-10: The fashion template MUST export `fashion.indexing()` providing the `embed_doc`/`rerank_doc`/`fts_doc` builders + `gate`. The removed pieces — `fashion.composeEmbedDoc`, `fashion.embedDocSource`, `FASHION_EMBED_DOC_SOURCE`, the standalone `composeEmbedDocs`/`compose-embed.ts` and every manual call site (playground + 6 example scripts) — prove the step is no longer manual.
- REQ-11: A `build` returning `""` MUST quarantine the row (`pipeline_status='quarantined'`, `reason:"empty:<surface>"`) — never a silent `data.title` fallback. The fallback at `embed-index.ts:348-349` MUST be deleted.
- REQ-11b (filter-not-embed — embedding hygiene): `composeFashionEmbedDoc` (`fashion.ts:238-253`) MUST be trimmed to carry only graded/compositional signal — `search_document`, `product_type`, `occasions`, `styles`, `details` (and `pattern` when not `solid`). The hard, low-cardinality, exact-queryable attributes that are already filters/spaces MUST be removed from the embed doc to stop attribute-bleed and double-counting: **`category`, `gender`, `colors`, `material`, `fit`** (these remain filters; `category` is also a categorical space; `colors` is also carried by the visual space). `brand` MUST NOT be embedded (it is filter + boost; note the generic README example `"$title $brand $color $occasion"` is the anti-pattern). A wrong low-confidence guess (e.g. material-from-image, `fashion.ts:125`) baked into the vector is unrelaxable; a filter is. Reviewer (GLM-5.2) concurs and scopes the `gender`/`kids`→`age_group` enum split as a SEPARATE ADR, not this RFC.

### G4 / G5 — default reranker + reranker-text
- REQ-12: The fashion template MUST export a default `RerankFn` factory (provider-agnostic; built from the consumer's `generate` and/or visual-space cosines per Q1) so search reranks by default once `generate`/`rerank` is wired.
- REQ-13: `rerankHits` MUST prefer `enriched.rerank_doc` (falling back to the current title/description scrape) as candidate text.
- REQ-13b (blend, don't replace — closes Q1's blend sub-question): `rerankHits` MUST NOT re-sort purely by the reranker score. It MUST **blend** a rank-derived retrieval position score with the reranker score, both normalized to `[0,1]`: `final = w(rank)·positionScore + (1 − w(rank))·rerankScore`, where `positionScore = 1 / rrfRank` (the hit's 1-indexed position in the fused list) and `w(rank)` is **position-aware** — default `0.75` for rank ≤3, `0.60` for ≤10, `0.40` beyond (tobi/qmd `store.ts:4786-4793`). The weights and cutoffs MUST be tunable and MUST be tuned by the G8 eval harness (REQ-27), not treated as fixed. Candidates the reranker did not score MUST keep their retrieval position (never blended against a 0). The `RerankFn` contract MUST define its returned score as `[0,1]` (normalize provider scores at the boundary) so the blend is on a common scale — this shares the normalized-score requirement with G7/REQ-20. Empirical backing: rerankers degrade Recall@10 **below retrieval-alone in 44–53%** of strong-first-stage cases ("phantom hits") — Jacob et al., *"Drowning in Documents: Consequences of Scaling Reranker Inference"* (arXiv:2411.11767); keeping the RRF score as a position-weighted guardrail is the mitigation (`docs/research/open-questions-literature.md` RQ1). Honest caveat: the literature is mixed — replace-vs-blend depends on first-stage strength; the position-aware weight IS that adaptivity (strong head → trust retrieval, weak tail → trust reranker).
- REQ-14: `rerank: false` MUST still force pure first-stage order; absence of any reranker MUST still yield RRF (no regression to the existing graceful path).

### G6 — durable pipeline state
- REQ-15: Collection tables MUST carry `pipeline_status text NOT NULL DEFAULT 'pending'`, `attempt_count int NOT NULL DEFAULT 0`, `last_error text`, `next_attempt_at timestamptz`. These framework columns MUST be added idempotently to existing tables on `apply` (not via the user-field diff path).
- REQ-16: A failed enrich/index attempt MUST increment `attempt_count`, store `last_error`, set `pipeline_status='failed'`, and set `next_attempt_at` with exponential backoff; success MUST set `'ready'` (or `'quarantined'` per G2) and clear `last_error`.
- REQ-17: A `retryFailed(project, collection)` pass MUST pick up `pipeline_status='failed' AND next_attempt_at <= now()` up to a max-attempts cap, after which rows move to `'dead'` and are excluded from automatic retry.
- REQ-18: `runEnrichCollection`/`runIndexCollection` MUST abort a run and surface an error when the per-run failure rate exceeds a configurable threshold (default per Q4), instead of silently completing with a high `failed` count.
- REQ-18b (missed gap M5 — image-fetch failure is a tracked failure, not silent corruption): when an image fetch/embed fails at index time, the indexer currently writes a zero vector and proceeds (`embed-index.ts:163-170, 198-207`), silently corrupting the visual space; the row is marked `indexed_at` so G6 retry never revisits it. Such a row MUST instead be recorded as `pipeline_status='failed'` with `last_error` (eligible for `retryFailed`), not indexed with a zero visual segment.
- REQ-18c (missed gap M6): `markIndexSkipped` (`embed-index.ts:299-306`) nulls `doc`/`embedding` but not `space_vec`; it MUST also null `space_vec` so a skipped/quarantined row leaves the spaces channel.

### G7 — promote + harden boosts
- REQ-19: The post-fusion boost currently in `fashion-search.ts:rankHits` MUST be reachable from core `search()` via a declared, optional ranking hook on the collection's `search` config (so non-fashion consumers can use it), without breaking the fashion facade.
- REQ-20: Boost composition MUST operate on **normalized** scores (min-max or rank-based), never raw constants on raw RRF scores — this is the non-negotiable part (the un-normalized scale-mixing is the actual G7 defect). For the *combination shape*, the literature is nuanced and the RFC follows it (`docs/research/open-questions-literature.md` RQ6): classic IR score fusion is **additive** (CombSUM/CombMNZ — Fox & Shaw, TREC-2 1994) and additive is the right default for **soft boosts** (newness, mild personalization). **Multiplicative / weighted-geometric** (`relevance^α · availability^wa · …`, cf. DoorDash `R^α·S^β`) MUST be used for **hard conjunctive axes** where an item must score on BOTH to rank (e.g. relevance × availability) — multiplicative acts as a soft-AND that additive can't express, preventing an irrelevant-but-available item from floating up. So: relevance combined multiplicatively with hard gates, additively with soft boosts; exponents/weights tunable on `rankingPolicy`; a **minimum-relevance floor** MUST exist so no boost surfaces a result below it; `buryUnavailable` is a multiplicative penalty on the normalized scale.

### G8 — offline LLM-as-judge eval harness (the feedback loop)
- REQ-23: `@samesake/server` MUST expose a first-class eval runner (promoting the prototype in `apps/playground/lib/search-relevance.ts`) that takes a frozen query set × a catalog snapshot, runs `search({ explain: true })`, and scores each `⟨query, hit⟩` pair with a consumer-provided judge (BYO `generate`) against a rubric, producing per-query **Hit@K, nDCG@K, MRR** plus a JSON artifact.
- REQ-24: Relevance labels MUST be **graded** (`{0: irrelevant, 1: moderate, 2: highly relevant}`, cf. [dashclip]) and **facet-decomposed** for fashion (`category`, `color`, `occasion`, `gender`, `style`, `material`) then aggregated — not a single opaque score. Queries SHOULD be stratified head/torso/tail.
- REQ-25: A frozen golden set MUST be persisted (`eval_golden(query, product_id, grade, justification, intent_tags)`); the judge prompt/model MUST be **versioned**, and the judge MUST be **calibrated against a small human-labeled set (report precision/recall/F1) before it is trusted** [doordash-simulation-evaluation-flywheel, building-doordash-assistant]. The same judge MAY serve as both the eval judge and the G4 default reranker.
- REQ-26: The harness MUST emit a **null/low-confidence-result rate** as a first-class metric (cf. DoorDash's null-search rate, [doordash-llms-to-build-content-embeddings]) and MUST support "launch thresholds" — a change to RRF weights / default rerank / `rankingPolicy` / enrich prompts is gated on the harness not regressing any tracked metric below its threshold before it ships.
- REQ-27: The harness is the source of truth for the G2 confidence FLOOR (REQ-7) and the G7 exponents (REQ-20) — both MUST be tunable against it rather than hardcoded.

### Cross-cutting
- REQ-21: All changes MUST preserve the provider-agnostic contract (no bundled LLM/embedder; reranker is BYO with a template-provided default built from the consumer's `generate`).
- REQ-22: No regression to existing tests in `packages/server/test/*` and `examples/fashion-search/*` smokes.

---

## 4. Interface Specification

### 4.1 `IndexingDef` (the chosen interface — full spec in `docs/design/indexing-dsl.md`)
- **Location:** `packages/sdk/src/types.ts` (new `IndexingDef`; `CollectionDef.indexing` required on the in-process `AuthoredCollection`; `CollectionEmbeddingDef.source` removed; serializable `CollectionDef.indexingManifest` added).
- **Signature:**
  ```ts
  export type DerivedDocDef =
    | { kind: "dense";  build: (ctx: DerivedDocContext) => string; embedding: string }
    | { kind: "rerank"; build: (ctx: DerivedDocContext) => string }
    | { kind: "fts";    build: (ctx: DerivedDocContext) => string };
  export type IndexGate = (ctx: DerivedDocContext) => { index: boolean; reason?: string };
  export interface IndexingDef {
    surfaces: Record<string, DerivedDocDef>;  // required, ≥1
    gate: IndexGate;                           // required (gates.always = index-everything)
  }
  ```
- **Behavior:** `build`/`gate` are pure functions of `DerivedDocContext` (`{data, enriched}`), serializable-free (in-process, like `prompt`/`schema`). `indexing` is **non-optional** on `AuthoredCollection` → omission is a compile error.
- **Error cases:** a throwing `build`/`gate` MUST be caught in `enrichOne`, treated as an enrich failure (G6 path), and MUST NOT set `enriched_at`. A DB-loaded def without functions MUST throw at index time with a clear message (generalizes the existing `enrich` guard, `enrich-pipeline.ts:173-180`).

### 4.2 `enrichOne` (modified)
- **Location:** `packages/server/src/core/enrich-pipeline.ts:112-147`
- **Signature:** unchanged.
- **Behavior:** after the stage loop, run every `def.indexing.surfaces[].build(ctx)` and `def.indexing.gate(ctx)`; persist the built surface texts (`doc`/`rerank_doc`/`fts_src`), `pipeline_status` (`gate.index ? 'ready' : 'quarantined'`) + `gate_reason`, `enriched`, `enriched_at=now()`, `attempt_count` reset, `last_error=NULL` in one UPDATE. (Persist-at-enrich, per `docs/design/indexing-dsl.md`.)
- **Error cases:** any stage/build/gate throw → `attempt_count++`, `last_error=<msg>`, `pipeline_status='failed'`, `next_attempt_at=now()+backoff(attempt_count)`; `enriched_at` stays NULL. A `build` returning `""` → `quarantined`, `reason:"empty:<surface>"`.

### 4.3 Indexer (modified)
- **Location:** `packages/server/src/core/embed-index.ts`
- **Change:** consume the persisted surface text — embed the stored `doc` into the dense embedding column; no `resolveEmbedTemplate`, no `$enriched.*` resolution, no `data.title` fallback (all deleted). `staleClause` selects `pipeline_status='ready'` (needsEnrich) and the indexer sets `'ready'` on success for non-enrich collections (REQ-6/6b). The hardcoded `is_apparel_product`/`category` block (`:339-345`) is deleted — gating now lives entirely in `indexing.gate` at enrich time.
- **Error cases:** the indexer no longer makes text decisions; an empty `doc` cannot reach it (the row was quarantined at enrich).

### 4.4 `revalidateImages`
- **Location:** new `packages/server/src/core/revalidate-images.ts`; method exposed on the matcher (sibling to `index`).
- **Signature:** `revalidateImages(projectSlug: string, collectionName: string, opts?: { limit?: number }) => Promise<{ checked: number; changed: number; failed: number }>`
- **Behavior:** for each row with an `image_url`, conditional-GET/HEAD via `fetch-image.ts`; on changed validator, set `indexed_at=NULL` (+ `enriched_at=NULL` when the pipeline consumes the image), update `image_etag`/`image_checked_at`.
- **Error cases:** fetch failure → `failed++`, leave row untouched, log warn (mirrors `embed-index.ts:163-170`).

### 4.5 Fashion template additions
- **Location:** `packages/sdk/src/templates/fashion.ts`. Full shape in `docs/design/indexing-dsl.md`; commit-level steps in `rfcs/refactor-indexing-dsl.md`.
- **Signatures:**
  ```ts
  export function fashionIndexing(opts?: { titleKey?: string }): IndexingDef;
  //   surfaces.embed_doc.build  = trimmed composeFashionEmbedDoc (graded-only, REQ-11b)
  //   surfaces.rerank_doc.build = composeFashionRerankDoc
  //   surfaces.fts_doc.build    = title + product_type + raw_color + styles
  //   gate = apparel/other + confidence<FLOOR + uncertain_fields(load-bearing) + !crossSignalAgrees
  export function composeFashionRerankDoc(p: { title: string }, a: Record<string, unknown>): string;
  export function fashionRerank(opts: { generate?: GenerateFn; mode?: "llm" | "visual" }): RerankFn; // G4, multimodal LLM default
  export const FASHION_CONFIDENCE_FLOOR = 0.5; // placeholder; tuned by the G8 eval harness (REQ-27)
  ```

### 4.6 Core ranking hook (G7)
- **Location:** `packages/sdk/src/types.ts` (`CollectionSearchDef`), consumed in `packages/server/src/core/search.ts:finishSearch`/`search`.
- **Signature:** `CollectionSearchDef.rankingPolicy?: FashionRankingPolicy` (promote the existing SDK type to a generic, optional declared hook). Core `search()` applies normalized boosts when present; `fashion-search.ts` delegates to the same code path instead of its private `rankHits`.
- **Error cases:** absent hook → identical behavior to today (pure RRF + optional rerank).

### 4.7 Framework-column migration
- **Location:** `packages/server/src/core/collections-schema-gen.ts:82-94` (CREATE) and a new idempotent system-column step invoked on `apply` (alongside `planCollectionMigration`, `collections-migrate.ts`).
- **Signature:** `ensureCollectionSystemColumns(schema, collectionName) => string[]` returning `ALTER TABLE … ADD COLUMN IF NOT EXISTS …` for `pipeline_status`, `attempt_count`, `last_error`, `next_attempt_at`, `image_etag`, `image_checked_at`.
- **Behavior:** runs on every apply; safe on tables that already have the columns.

---

## 5. Architecture and System Dependencies

### 5.1 Structural changes
- New: `core/revalidate-images.ts`, `core/ranking.ts` (extracted normalized-boost from `fashion-search.ts`), `ensureCollectionSystemColumns` in schema-gen.
- Modified: `enrich-pipeline.ts` (build surfaces + gate + persist, failure-state), `embed-index.ts` (consume persisted text; delete template/fallback/hardcode), `search.ts` (rerank_doc, blend, ranking hook), `fashion-search.ts` (delegate to shared ranking), `templates/fashion.ts` (`fashion.indexing()` + rerank), `types.ts` (`IndexingDef`/`DerivedDocDef`/`IndexGate`, remove `CollectionEmbeddingDef.source`, `CollectionSearchDef.rankingPolicy`).
- Deleted: `CollectionEmbeddingDef.source`, `resolveEmbedTemplate` doc-path, the `data.title` fallback, the apparel hardcode; `examples/fashion-search/compose-embed.ts` and the manual textualization call sites in `apps/playground/**` + example pipelines (logic moves into `indexing.surfaces` builders). Full list in `rfcs/refactor-indexing-dsl.md`.

### 5.2 Service/library dependencies
- No new external dependencies. Reranker default is built from the consumer's `generate` (already required for enrichment) or visual-space cosines (already computed in explain mode, `search.ts:744`).

### 5.3 Data/schema changes
- New columns on every `c_<collection>` table: `pipeline_status`, `attempt_count`, `last_error`, `next_attempt_at`, `image_etag`, `image_checked_at`. Added via CREATE (new tables) + `ADD COLUMN IF NOT EXISTS` (existing). Backfill: existing `indexed_at IS NOT NULL` rows → `pipeline_status='ready'`; `enriched_at IS NOT NULL AND indexed_at IS NULL` → `'ready'` (let indexer pick up); else `'pending'`.
- `content_hash` input set extended (REQ-1) — note this re-hashes all rows on next ingest; acceptable (it triggers the intended one-time re-enrich for rows with image validators).

### 5.4 Network/performance
- `revalidateImages` adds one conditional HTTP request per image per pass — run on a schedule, not inline; bounded by `opts.limit`.
- Default reranker adds one `generate` call (LLM mode) or zero network (visual mode) per search; gated by `rerank !== false` and pool size 50.

---

## 6. Pseudocode

```
# G3 + G2: enrichOne builds + gates + persists all surfaces (indexing DSL)
FUNCTION enrichOne(def, row):
    enriched = run_all_stages(def, row)                       # existing inference stages
    ctx = {data: row.data, enriched}
    surfaces = { k: def.indexing.surfaces[k].build(ctx) for k in def.indexing.surfaces }
    g = def.indexing.gate(ctx)                                # required; {index, reason}
    status = g.index ? 'ready' : 'quarantined'
    IF any(surfaces[k] == "" for required k): status, reason = 'quarantined', "empty:"+k
    persist(row.id, enriched, enriched_at=now(),
            doc=surfaces.embed_doc, rerank_doc=surfaces.rerank_doc, fts_src=surfaces.fts_doc,
            pipeline_status=status, gate_reason=g.reason, attempt_count=0, last_error=NULL)
# on ANY throw above: attempt_count++, last_error=msg,
#   pipeline_status='failed', next_attempt_at=now()+backoff(attempt_count); enriched_at stays NULL

# G2 + G3: index selection — consume PERSISTED text, no template, no fallback
SELECT ... WHERE pipeline_status = 'ready'
      AND (enriched_at IS NOT NULL AND (indexed_at IS NULL OR indexed_at < enriched_at) OR space_vec IS NULL)
embed(stored doc) -> embedding column      # fts tsvector generated from fts_src; rerank_doc already stored

# G1: revalidate
FOR row IN rows_with_image:
    v = conditional_fetch(row.image_url, if_none_match=row.image_etag)
    IF v.changed:
        SET indexed_at=NULL (+enriched_at=NULL if pipeline uses image), image_etag=v.etag
    SET image_checked_at=now()

# G6: retry
SELECT ... WHERE pipeline_status='failed' AND next_attempt_at <= now() AND attempt_count < MAX
# run enrich/index for those; on repeated failure past MAX -> pipeline_status='dead'

# G4/G5: rerank
candidates = hits.map(h => { id, text: h.enriched.rerank_doc ?? scrape(h), data, score })
ordered = ctx.rerank(...)        # default fn from fashion template when wired

# G7: normalized MULTIPLICATIVE boost in core search (REQ-20)
norm = normalize_scores(hits)    # relevance -> [0,1], min-max or rank-based
FOR h:
    IF norm[h] < min_relevance_floor: drop h        # boosts cannot rescue irrelevance
    final = norm[h]^alpha * avail^w_a * business^w_b * personalization^w_p   # all factors in [0,1]
    IF NOT available AND buryUnavailable: final = final * bury_factor          # multiplicative penalty
# exponents/weights/floor come from rankingPolicy, tuned by the G8 harness

# G8: offline eval harness (the feedback loop)
FOR q IN frozen_query_set:
    hits = search(q, explain=true)
    FOR (q, hit): grade = judge(q, hit.rerank_doc, rubric)   # graded {0,1,2}, facet-decomposed
    record Hit@K, nDCG@K, MRR, null_rate
# judge calibrated vs human labels (F1) before trusted; change gated on launch thresholds
```

---

## 7. Code Blueprint

```ts
// packages/sdk/src/types.ts  — the indexing DSL (full spec: docs/design/indexing-dsl.md)
export type DerivedDocDef =
  | { kind: "dense";  build: (ctx: DerivedDocContext) => string; embedding: string }
  | { kind: "rerank"; build: (ctx: DerivedDocContext) => string }
  | { kind: "fts";    build: (ctx: DerivedDocContext) => string };
export type IndexGate = (ctx: DerivedDocContext) => { index: boolean; reason?: string };
export interface IndexingDef { surfaces: Record<string, DerivedDocDef>; gate: IndexGate; }
export interface AuthoredCollection extends CollectionDef { indexing: IndexingDef; } // indexing REQUIRED
// CollectionDef: + indexingManifest? (serializable mirror); CollectionEmbeddingDef.source REMOVED.
export interface CollectionSearchDef {
  /* …existing… */
  rankingPolicy?: FashionRankingPolicy; // promoted from fashion-only to a generic declared hook
}
```

```ts
// packages/server/src/core/enrich-pipeline.ts  — enrichOne tail: build all surfaces + gate, persist
for (const stage of def.enrich.stages) { /* …existing inference stages… */ }
try {
  const dctx = { data, enriched };
  const surfaces = Object.fromEntries(
    Object.entries(def.indexing.surfaces).map(([k, s]) => [k, s.build(dctx)]));
  const g = def.indexing.gate(dctx);
  const empty = Object.entries(surfaces).find(([, v]) => v.trim() === "");
  const status = (!g.index || empty) ? "quarantined" : "ready";
  const reason = !g.index ? g.reason : empty ? `empty:${empty[0]}` : null;
  await getPgClient(ctx.db, "enrich").unsafe(
    `UPDATE ${table}
       SET enriched=$1::jsonb, doc=$2, rerank_doc=$3, fts_src=$4, enriched_at=now(), updated_at=now(),
           pipeline_status=$5, gate_reason=$6, attempt_count=0, last_error=NULL, next_attempt_at=NULL
     WHERE id=$7`,
    [JSON.stringify(enriched), surfaces.embed_doc, surfaces.rerank_doc, surfaces.fts_doc, status, reason, row.id]
  );
} catch (e) { await recordFailure(ctx, table, row.id, e); return false; }  // attempt_count++, 'failed', backoff
ctx.observability.inc("enrich_docs_total");
return true;
```

```ts
// packages/server/src/core/embed-index.ts  — consume PERSISTED text; no template, no fallback
// resolveEmbedTemplate(doc path) + the data.title fallback (:348-349) + the is_apparel/category
// block (:339-345) are DELETED. The doc was built + persisted at enrich; gating happened there.
const staleClause = needsEnrich
  ? `pipeline_status = 'ready' AND (indexed_at IS NULL OR indexed_at < enriched_at)`
  : `indexed_at IS NULL OR (enriched_at IS NOT NULL AND indexed_at < enriched_at)`;
const docText = row.doc;                  // never empty for a 'ready' row (B2: non-enrich sets 'ready' on index)
embed(docText) -> embedding column;       // fts tsvector GENERATED from fts_src; rerank_doc already stored
```

```ts
// packages/sdk/src/templates/fashion.ts  — fashion.indexing() (replaces composeEmbedDoc/embedDocSource)
export const FASHION_CONFIDENCE_FLOOR = 0.5; // placeholder; tuned by the G8 eval harness (REQ-27)
export function composeFashionRerankDoc(p: { title: string }, a: Record<string, unknown>): string { /* verbose */ }
export function fashionIndexing(opts: { titleKey?: string } = {}): IndexingDef {
  const t = opts.titleKey ?? "title";
  return {
    surfaces: {
      embed_doc:  { kind: "dense", embedding: "doc",   // graded-only (REQ-11b): no category/gender/color/material/fit/brand
        build: ({ data, enriched }) => composeFashionEmbedDoc({ title: String(data[t] ?? "") }, enriched) },
      rerank_doc: { kind: "rerank",
        build: ({ data, enriched }) => composeFashionRerankDoc({ title: String(data[t] ?? "") }, enriched) },
      fts_doc:    { kind: "fts",
        build: ({ data, enriched }) => [data[t], enriched.product_type, enriched.raw_color, ...asArray(enriched.styles)].filter(Boolean).join(" ") },
    },
    gate: ({ data, enriched: e }) => {
      if (e.is_apparel_product === false) return { index: false, reason: "non-apparel" };
      if (e.category === "other")          return { index: false, reason: "category-other" };
      if (Number(e.confidence ?? 1) < FASHION_CONFIDENCE_FLOOR) return { index: false, reason: "low-confidence" };
      if (intersects(asArray(e.uncertain_fields), ["category","gender","colors"])) return { index: false, reason: "uncertain-load-bearing" };
      if (!crossSignalAgrees({ data, enriched: e })) return { index: false, reason: "cross-signal-disagree" };
      return { index: true };
    },
  };
}

// G8 eval harness (REQ-23..27) — promotes apps/playground/lib/search-relevance.ts
// packages/server/src/core/eval.ts
export interface EvalResult { perQuery: Array<{ q: string; hitAtK: number; ndcgAtK: number; mrr: number }>;
  aggregate: { hitAtK: number; ndcgAtK: number; mrr: number; nullRate: number }; judgeVersion: string }
export async function runEval(ctx, project, collection, opts: {
  queries: string[]; k?: number; judge: GenerateFn; rubricVersion: string;
}): Promise<EvalResult> {
  // for each q: search({explain:true}); judge each ⟨q,hit.rerank_doc⟩ → graded {0,1,2}, facet-decomposed;
  // compute Hit@K / nDCG@K / MRR vs eval_golden; track nullRate. Judge must be calibrated (F1) first.
}
```

```ts
// packages/server/src/core/search.ts  — G5: rerank candidate text (replaces scrape at :826-831)
text: String(
  (h.data as any)?.enriched?.rerank_doc ??           // G5: purpose-built
  h.title ?? h.name ?? (h.data as any)?.title ?? (h.data as any)?.description ?? ""
),

// G4 REQ-13b: BLEND, don't replace (replaces the pure re-sort at search.ts:850-855).
// `hits` arrive in RRF order, so the index IS the retrieval rank.
const scoreById = new Map(ordered.map(o => [o.id, clamp01(o.score)]));   // reranker score → [0,1]
const blended = hits.map((h, i) => {
  const rerank = scoreById.get(h.id);
  if (rerank === undefined) return h;                 // not scored → keep RRF position
  const rank = i + 1;
  const w = rank <= 3 ? 0.75 : rank <= 10 ? 0.60 : 0.40;   // tunable via G8 (REQ-27)
  const positionScore = 1 / rank;                     // rank-derived, already [0,1]
  return { ...h, score: w * positionScore + (1 - w) * rerank };
});
return blended.sort((a, b) => b.score - a.score);
```

Attribution: the blend is tobi/qmd `store.ts:4786-4793` (`docs/research/qmd/README.md` L1).
Attribution: the `indexing.gate` generalizes the existing hardcoded skip (`embed-index.ts:339-345`) and the existing `confidence` review query (`review.ts:33-40`); the normalized-boost refactor preserves the factor set already in `fashion-search.ts:rankHits` (`:144-170`).

---

## 8. Incremental Task Breakdown

| ID | Chunk | Files | Grounding | Acceptance criteria |
|----|-------|-------|-----------|---------------------|
| C1 | Add framework columns to CREATE + idempotent `ensureCollectionSystemColumns` on apply; backfill `pipeline_status` | `collections-schema-gen.ts`, `collections-migrate.ts`, `projects.ts` | REQ-15 | Fresh + existing tables have the 6 columns; existing indexed rows backfilled to `'ready'`; apply is idempotent |
| C2 | `recordFailure` helper + backoff; wire into `runEnrichCollection` catch | `enrich-pipeline.ts` | REQ-16 | A thrown stage sets `failed` status, `attempt_count=1`, `last_error`, `next_attempt_at` |
| C-IDX | **The `indexing` DSL refactor (G2 + G3 + G5 textualization/gate)** — execute `rfcs/refactor-indexing-dsl.md` (13 tiny commits): add `IndexingDef`/`DerivedDocDef`/`IndexGate` types + required `AuthoredCollection.indexing` + `indexingManifest`; persist surfaces + gate at enrich (`doc`/`rerank_doc`/`fts_src`/`pipeline_status`/`gate_reason`); indexer consumes persisted text + sets `'ready'` on success (B2) + nulls vectors on quarantine (M6); `search()` excludes non-`ready` (B1); `fashion.indexing()`; cut over playground + 6 examples; **delete** `CollectionEmbeddingDef.source` + `resolveEmbedTemplate` doc-path + the `data.title` fallback + the apparel hardcode; rewrite the tests that asserted removed behavior (M4). | per `rfcs/refactor-indexing-dsl.md` | REQ-4..11, REQ-11b, REQ-6b, REQ-18c | All commits green; `test:index-gate`, `test:fashion-compose-gate`, `test:embed-doc-no-hard-attrs`, `test:search-excludes-quarantined`, `test:gate-cross-signal`; no fashion identifier in `embed-index.ts`; no `.source`/`resolveEmbedTemplate`/title-fallback anywhere |
| C8 | `content_hash` includes image validator when present | `normalize.ts` | REQ-1 | `test:content-hash-image-version` |
| C9 | `revalidateImages` pass + matcher method + columns `image_etag`/`image_checked_at`; pHash no-validator fallback; **include image validator in `stageCacheKey` so re-enrich misses stale cache (M1)** | `core/revalidate-images.ts`, `enrich-pipeline.ts`, matcher index | REQ-2, REQ-3, REQ-3b, REQ-3c | `test:revalidate-images`: changed ETag resets `indexed_at`; `test:revalidate-restains-enrich`: re-enrich after image change does NOT hit the URL-keyed stage cache |
| C10 | `retryFailed` pass + max-attempts → `'dead'`; error-rate abort; **image-fetch/embed failure → `'failed'` (not zero-vector index) (M5)** | `enrich-pipeline.ts`, `embed-index.ts`, new `core/retry.ts` | REQ-17, REQ-18, REQ-18b | `test:retry-failed`, `test:error-rate-abort`, `test:image-fail-not-zero-vector` |
| C11 | `rerankHits`: prefer `enriched.rerank_doc`; **blend position-aware (REQ-13b) instead of replacing** the order; `RerankFn` score clamped to `[0,1]` | `search.ts`, `packages/server/src/types.ts` | REQ-13, REQ-13b | `test:rerank-doc-used`; `test:rerank-blend` (a rank-1 hit the reranker scores low stays above a rank-5 hit the reranker scores high; a deep-tail hit the reranker loves climbs) |
| C12 | `fashionRerank()` default `RerankFn` (LLM-judge default per Q1, visual opt-in); same judge reusable as the G8 eval judge | `templates/fashion.ts` | REQ-12, REQ-14, REQ-21 | Wiring it reranks; `rerank:false` → RRF; absent → RRF |
| C13 | Extract `core/ranking.ts` with **multiplicative** normalized fusion (`relevance^α·avail·business·personalization`) + min-relevance floor + multiplicative `buryUnavailable`; `CollectionSearchDef.rankingPolicy` hook w/ tunable exponents; core `search()` applies it; `fashion-search.ts` delegates | `core/ranking.ts`, `search.ts`, `fashion-search.ts`, `types.ts` | REQ-19, REQ-20 | `test:core-ranking-policy`; `test:multiplicative-fusion` (irrelevant-but-available item cannot top a relevant one); fashion-search tests still green |
| C15 | **G8 eval runner** `core/eval.ts` (promote `search-relevance.ts`): frozen query set × snapshot → `search({explain})` → graded facet-decomposed judge → Hit@K/nDCG@K/MRR + null-rate + JSON artifact; `eval_golden` table | `packages/server/src/core/eval.ts`, `db/schema/*`, `examples/fashion-search/eval-judge.ts` | REQ-23, REQ-24, REQ-26 | `test:eval-metrics` (known-ranking fixture → expected Hit@K/nDCG); JSON artifact emitted |
| C16 | **Judge calibration + gating**: calibrate judge vs human labels (report P/R/F1); versioned judge prompt; launch-threshold gate that fails CI on metric regression; tune FLOOR (REQ-7) + exponents (REQ-20) from harness output | `core/eval.ts`, `apps/docs/**` | REQ-25, REQ-27 | `test:eval-gate-blocks-regression`; documented calibrated FLOOR replacing the 0.5 placeholder |
| C14 | Docs + CHANGELOG: pipeline lifecycle, `indexing` DSL, revalidation, default rerank (blend), multiplicative ranking, eval harness | `apps/docs/**`, `CHANGELOG.md` | REQ-22 | Docs build; lifecycle doc reflects new statuses |

Sequencing honors the stated priority: **G2 + G3 + G5 land as `C-IDX` — the `indexing` DSL refactor (`rfcs/refactor-indexing-dsl.md`), the spine, first**; G1 across C8–C9; G6 across C1/C2/C10; G4/G5 rerank-blend across C11–C12; G7 in C13; **G8 (eval harness) across C15–C16 — P0, build it early so it can tune the G2 floor and G7 exponents and gate every later change.** C1 (framework columns) + C2 (recordFailure) underpin C-IDX and G6.

---

## 9. Validation and Testing

### 9.0 Validation Contract

| ID | Source | Assertion |
|----|--------|-----------|
| REQ-1..3 | §3 G1 | image change → re-embed; validator persisted |
| REQ-4..7 | §3 G2 | gate quarantines; indexer respects status; no fashion code in embed-index |
| REQ-8..11 | §3 G3 | `indexing.surfaces` builds run at enrich + persist; no string source; no silent title fallback |
| REQ-12..14 | §3 G4/G5 | default rerank on; rerank_doc used; RRF fallback intact |
| REQ-15..18 | §3 G6 | durable status/attempts/last_error; retry + backoff; error-rate abort |
| REQ-19..20 | §3 G7 | boost reachable from core search; normalized + multiplicative; min-relevance floor |
| REQ-23..27 | §3 G8 | eval runner emits Hit@K/nDCG/MRR + null-rate; judge calibrated (F1); gates changes; tunes FLOOR + exponents |
| test:* | §9.1 | listed fail-to-pass tests green |
| cmd:fashion-smoke | §9.3 | end-to-end enrich→index→search with no manual compose |

### 9.1 Fail-to-Pass Tests (new, in `packages/server/test/`)
- `test:enrich-surfaces-gate` — a collection with `indexing` builds + persists the surface texts and sets `pipeline_status` via the gate.
- `test:index-gate` — `quarantined` rows are never indexed; `ready` rows are.
- `test:fashion-compose-gate` — after `enrich` only (no manual step), the persisted `doc` surface is non-empty; non-apparel/low-confidence rows are quarantined.
- `test:content-hash-image-version` — same URL + new `image_version` → different `content_hash`.
- `test:revalidate-images` — changed ETag resets `indexed_at`; unchanged leaves it.
- `test:retry-failed` — a `failed` row past `next_attempt_at` is retried; past max-attempts → `'dead'`.
- `test:error-rate-abort` — a run with > threshold failures throws rather than completing silently.
- `test:rerank-doc-used` — reranker candidate text equals `enriched.rerank_doc` when present.
- `test:rerank-blend` (REQ-13b) — a rank-1 hit the reranker scores low stays above a rank-5 hit the reranker scores high (head protected); a deep-tail hit the reranker scores ~1.0 climbs above its tail neighbours (tail trusts reranker); a hit the reranker omits keeps its RRF position.
- `test:core-ranking-policy` — `rankingPolicy` on a non-fashion collection reorders by normalized boost; absent → unchanged RRF.
- `test:search-excludes-quarantined` (B1) — a row indexed then re-enriched into `quarantined` never appears in search results (cosine, spaces, AND FTS-on-title).
- `test:non-enrich-indexes-ready` (B2) — a collection with no enrich pipeline indexes rows to `pipeline_status='ready'`.
- `test:revalidate-restains-enrich` (M1) — after `revalidateImages` detects an image change, re-enrich does NOT return the URL-keyed stale stage cache.
- `test:image-fail-not-zero-vector` (M5) — an image-fetch failure marks the row `failed` (retry-eligible), not indexed with a zero visual segment.
- `test:embed-doc-no-hard-attrs` (REQ-11b) — composed `embed_doc` contains the description/occasions/styles but not `category`/`gender`/`color` filter tokens.
- `test:gate-cross-signal` (REQ-7) — a row whose image-derived category disagrees with its title/tags category is quarantined even at high self-confidence.
- `test:multiplicative-fusion` (REQ-20) — an irrelevant-but-available item cannot outrank a relevant one under `rankingPolicy`; an item below the min-relevance floor is dropped.
- `test:eval-metrics` (REQ-23/24) — on a fixture with a known ideal ranking, the harness returns the expected Hit@K / nDCG@K / MRR and a null-rate.
- `test:eval-gate-blocks-regression` (REQ-26/27) — a deliberately worse ranking config fails the launch-threshold gate.

### 9.2 Regression (Pass-to-Pass)
- Baseline is **172/172 green at `ad21a9a`** (verified by GLM-5.2 review: `bun test packages/server/test`, 31 files, ~127s).
- `packages/server/test/fashion-search.test.ts` (rankingPolicy delegation), `fashion-template.test.ts`, full `packages/server/test/*`.
- **Known intentional break (M4):** `migrations.test.ts:328-351` ("REQ-V03B-REPRO4: skipped rows terminal") asserts the hardcoded apparel-skip that C5 removes. It is NOT a regression to fix-by-revert — C5 MUST rewrite it to declare a `gate` and assert quarantine semantics. Any OTHER test transitioning red is a real regression → stop.
- `examples/fashion-search/{spike-avirate,template-smoke,run-pipeline}.ts` smokes.

### 9.3 Validation Commands
```bash
# unit/integration
bun test packages/server/test

# end-to-end fashion smoke WITHOUT any manual compose call (proves G3)
cd examples/fashion-search && bun run-pipeline.ts   # expect: embed_doc present, quarantined rows excluded

# confirm no fashion semantics leaked in the generic indexer (proves G2 layering)
! grep -n "is_apparel_product\|category === \"other\"" packages/server/src/core/embed-index.ts

# confirm the standalone compose step is gone (proves G3 unskippable)
test ! -f examples/fashion-search/compose-embed.ts

# schema: framework columns exist
psql "$DATABASE_URL" -c "SELECT column_name FROM information_schema.columns WHERE table_name='c_products' AND column_name IN ('pipeline_status','attempt_count','last_error','next_attempt_at','image_etag','image_checked_at');"
```

---

## 10. Security Considerations

- `revalidateImages` MUST route every request through `fetch-image.ts` (existing SSRF/IP-pinning guard) — no new fetch path. No new attack surface beyond the existing index-time image fetch.
- `last_error` MUST be truncated (≤200 chars, as existing logs do at `enrich-pipeline.ts:106`) and MUST NOT store full payloads/keys.
- `indexing` gate + surface builders are in-process functions from the consumer's config — no untrusted input execution.

## 11. Rollback and Abort Criteria

- Abort if: removing the `embed-index.ts:339-345` hardcode causes non-apparel rows to be indexed in any test → the fashion `gate` is not wired correctly; stop and fix the template before proceeding (root cause: gate not evaluated, not a reason to restore the hardcode).
- Abort if: after C-IDX, any fashion smoke shows title-only embeddings (empty `doc` surface) → a surface build is not running/persisting at enrich; this is the exact G3 regression — re-triage, do not re-add a manual textualization step as a workaround.
- Rollback procedure: the framework columns are additive (`ADD COLUMN IF NOT EXISTS`) and default-safe; reverting code leaves columns harmless. `content_hash` change (C8) is the only one that triggers mass re-enrich on next ingest — land it deliberately and communicate the one-time re-enrich cost.
- Symptom-patch guard: if a gate/surface-build test fails again after a fix, treat as symptom-patched — stop and re-triage rather than loosening the assertion.

## 12. Open Questions

- Q1: **Default reranker implementation.** Two sub-questions:
  - **(a) Replace vs blend — RESOLVED (rev 4).** The reranker MUST blend with retrieval position-aware, not replace it — see REQ-13b. Evidence: tobi/qmd `store.ts:4786-4793` (`docs/research/qmd/README.md` L1); corroborating IR literature on score interpolation/normalization in `docs/research/open-questions-literature.md` (RQ1). The default weights `0.75/0.60/0.40` are a starting point tuned by the G8 harness.
  - **(b) Backend — RESOLVED (rev 4): multimodal LLM-judge default.** For a BYO, **no-traffic** engine, a small cross-encoder (MiniLM/monoT5) can't be trained without click logs and is **text-only** (blind to the garment image). A multimodal LLM-as-reranker needs no training data and can *see* the image — decisive for fashion. Literature: listwise LLM rerankers are strong zero-shot (Sun et al., RankGPT, arXiv:2304.09542); defer a cross-encoder until click logs exist (`docs/research/open-questions-literature.md` RQ8). Visual cosines are computed only in `finishExplain` (`search.ts:744`), not normal `search()`, so a pure-visual reranker needs cosines plumbed in.
  **Proposal:** default `fashionRerank({ mode: "llm" })` — a **multimodal** judge from the consumer's `generate` (passing the product image when the model supports it), reusable as the G8 judge (one rubric, REQ-25); `mode: "visual"` (plumb cosines) and a hosted cross-encoder (Cohere `rerank-v3.5`) as opt-ins behind the same `[0,1]` `RerankFn`. *Confirm the per-query `generate` cost is acceptable as the default.*
- Q2: **Image revalidation trigger — RESOLVED (rev 4).** Scheduled conditional-GET `revalidateImages` (REQ-2): `content_hash` folds in an image validator only when the *source* provides one (no forced ingest-time fetch). Many CDNs strip ETag/Last-Modified (REQ-3c), so add a **pHash fallback computed from the bytes already fetched at embed time**. Literature confirms this is the standard approach: HTTP conditional requests via `ETag`/`If-None-Match` → `304 Not Modified` (RFC 9110 §8.8/§13) and perceptual hashing with Hamming-distance thresholds (Zauner, *Implementation and Benchmarking of Perceptual Image Hash Functions*, 2010) — see `docs/research/open-questions-literature.md` RQ5.
- Q3: **Compose/gate as `PipelineDef` hooks vs separate matcher step.**
  **Proposal:** hooks on `PipelineDef` (Section 2.3) — the whole point is to make the step unskippable; a separate method reintroduces the footgun.
- Q4: **Default thresholds.** `FASHION_CONFIDENCE_FLOOR` and the per-run error-rate abort threshold.
  **RESOLVED (rev 4).** Do NOT hardcode the confidence floor. Theory backs this: a fixed self-confidence threshold is unsound because model self-confidence is poorly calibrated; the floor should be chosen on the **risk–coverage curve** and the decision delegated to a **separate calibrated guardrail predictor**, not the generator's own number — Geifman & El-Yaniv, *"Selective Classification for Deep Neural Networks"* (arXiv:1705.08500); see `docs/research/open-questions-literature.md` RQ4. So the floor is a placeholder (`0.5`) **resolved by the G8 eval harness** (REQ-27) on a risk–coverage sweep, the DoorDash datapoint (≥0.80, [doordash-llms-bridge-behavioral-silos]) is a sanity ceiling, and the gate is composite (floor + load-bearing `uncertain_fields` + cross-signal predictor, REQ-7), not a single number. Error-rate abort stays at `>25%`. All configurable.
- Q5: **`pipeline_status` value set.**
  **Proposal:** `pending | ready | quarantined | failed | dead`. `ready` is the only indexable state.
