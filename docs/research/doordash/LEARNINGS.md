# Learnings for samesake from the DoorDash engineering corpus

Synthesis of 37 RFC-aware per-post reviews (see [`posts/`](./posts/)) against `rfcs/rfc-pipeline-integrity-seams.md`. samesake = fashion visual+intent product search; Postgres+pgvector; `ingest → enrich(LLM vision) → compose embed_doc → index(doc cosine + spaces: visual/price/category/recency + FTS) → search(RRF + optional rerank + NLQ)`; single vertical, small scale, BYO embed/generate/rerank.

**Headline:** the corpus overwhelmingly *validates* the RFC's direction — especially G2 (quality gate), G3 (unskippable compose), embedding hygiene (filter-not-embed), and G6 (durable state). The single biggest thing the RFC is *missing* is a **human-calibrated LLM-as-judge offline eval harness** — the feedback loop every other change needs to prove itself before A/B exists. Two specifics should amend the RFC (below).

---

## Two corrections to the current RFC

1. **Confidence floor: 0.4 is too low; tune it, don't hardcode it.** The RFC's `FASHION_CONFIDENCE_FLOOR = 0.4` is the one number the corpus actively pushes back on — DoorDash gates multi-vertical LLM features at **≥0.80** [doordash-llms-bridge-behavioral-silos]. Recommendation: keep the gate, but (a) gate on the floor **AND** on `uncertain_fields` intersecting load-bearing attributes (category/gender/color), not a single aggregate number; (b) treat 0.4 as a placeholder to be **tuned by the eval harness** (NET-NEW #1), not a settled default. Amends RFC Q4 / REQ-7.

2. **G7 fusion should be multiplicative on normalized scores, not additive.** The RFC's G7 normalizes scores but composes boosts additively. The corpus's strongest specific refinement: DoorDash fuses as **`R(s)^α · S(s)^β`** [doordashs-next-generation-homepage-genai] so an item must score on *both* relevance and business to rise; additive boosts can float an irrelevant-but-available item to the top. Recommendation: make the default G7 composition multiplicative over normalized factors with tunable exponents on `rankingPolicy`, plus an optional minimum-relevance floor. Amends RFC REQ-20.

---

## Cross-cutting themes (the patterns that recur across many posts)

**T1 — Content/profile quality dominates encoder choice.** The most-repeated finding: the *text you feed the embedder* matters far more than which embedder you pick — DoorDash measured **+31.22% Hit@5 from LLM narrative profiles vs +5.92% from an encoder upgrade** on raw metadata [doordash-llms-to-build-content-embeddings]. Directly validates samesake's bet that enrichment is make-or-break and `compose → embed_doc` must be unskippable. [building-doordashs-product-knowledge-graph], [doordash-dashclip], [using-twin-neural-networks], [building-a-gigascale-ml-feature-store].

**T2 — Heterogeneous fields → heterogeneous encoding (filter-not-embed).** Hard, low-cardinality, exactly-queryable attributes (category, gender, color, material, fit, brand) belong in filters/categorical/visual spaces; the dense vector carries only compositional/graded signal; a verbose attribute-dense string is a *third* surface for the reranker. One blob causes attribute-bleed + double-counting. Exactly RFC embedding-hygiene/REQ-11b; argued by ≥8 posts and contradicted by none. [building-a-gigascale-ml-feature-store], [doordash-kdd-llm], [using-twin-neural-networks], [how-doordash-leverages-llms-for-better-search-retrieval], [doordash-unified-consumer-memory], [evolving-doordashs-substitution].

**T3 — Two-stage retrieve-then-rerank is the standard shape.** Wide multi-channel recall (RRF/BM25+dense) → precision reranker on a bounded pool is the default, not a luxury; first-stage scores are recall signal, not final order. Validates G4. DoorDash's fine-tuned reranker added **+7.8% nDCG on dish search** [doordash-llms-to-build-content-embeddings]. [beyond-single-agents], [homepage-recommendation-with-exploitation-and-exploration], [personalizing-the-doordash-retail-store-page], [pipeline-design-pattern-recommendation], [using-twin-neural-networks].

**T4 — Quality gate before serving, not post-hoc review.** Low-confidence/abstained/inconsistent/out-of-domain enrichments are quarantined *before index*, never silently served: hard confidence floors (≥0.80) [doordash-llms-bridge-behavioral-silos], a guardrail classifier predicting accuracy before publish [doordash-llm-transcribe-menu], multi-LLM jury veto (95% bad recall) [doordashs-next-generation-homepage-genai], explicit abstention [doordash-offline-llms-online-personalization]. Validates G2.

**T5 — LLM-as-judge offline eval, human-calibrated, gating changes before A/B.** A structured, versioned, rubric-driven judge (NDCG/Hit@K/MRR, facet-decomposed) that must pass on a frozen golden set before any ranking/prompt/weight change ships — and is **calibrated against human labels first**. [doordash-llms-to-evaluate-search-result-pages] (AutoEval, position-weighted NDCG, ~98% latency cut), [doordash-simulation-evaluation-flywheel] (judge F1, generator–verifier gap), [doordash-llms-to-build-content-embeddings], [doordashs-next-generation-homepage-genai] (P@10 68%→85% before A/B).

**T6 — Offline-LLM / online-cheap-retrieval split; amortize LLM on deduplicated keys.** Expensive LLM work runs offline in batch on stable, deduplicated content keys; online is cheap ANN. DoorDash computed taxonomies for ~10K unique tagsets once, reused across 200M users (~10,000× cheaper) [doordash-llms-for-grocery-preferences]; cached static prompt prefix (~80% cut) [doordash-llms-bridge-behavioral-silos]; heavy scoring off the hot path [integrating-a-scoring-framework], [how-we-designed-road-distances].

**T7 — Change-triggered incremental re-embed + cache-key correctness.** Re-embed only what changed, triggered by a content-version signal, not a daily full refresh — and the cache key must reflect content or it returns stale residuals. URL-only keys cause same-URL/new-bytes → old enrichment [how-to-investigate-the-online-vs-offline]; assemble docs from source-of-truth at index time [open-source-search-indexing]; version lineage enables re-embed-without-re-LLM [doordash-unified-consumer-memory]. Validates G1 + REQ-3b.

**T8 — Hard eligibility pushed to retrieval; boosts normalized & multiplicative post-fusion.** Eligibility (availability, hard NLQ filters, pipeline status) is a pre-ranking predicate across *every* channel, not a score nudge or post-fetch cleanup; boosts apply on normalized scores after fusion, multiplicatively. Validates G7 + REQ-6b. [how-we-designed-road-distances], [taming-content-discovery], [powering-search-recommendations], [doordashs-next-generation-homepage-genai] (R^α·S^β), [introducing-doordashs-in-house-search-engine].

**T9 — No silent degradation; durable, replayable pipeline state.** Sentinel fallbacks (title-only embed, zero vectors on fetch failure, default "other") are bugs masquerading as success; state must be durable (status/attempt/last_error/backoff), failures replayable, not counted-and-dropped. Validates G6 + G3 + M5. [five-common-data-quality-gotchas], [open-source-search-indexing], [pipeline-design-pattern-recommendation], [ship-to-production-darkly].

**T10 — Query understanding: slot-fill into a controlled taxonomy; MUST vs SHOULD.** NLQ maps fragments into declared enum slots (not free-text soup), constrains the LLM to ANN-retrieved candidate labels (hallucination <1%), and separates hard MUST filters (SQL exclusion) from soft SHOULD signals (boosts). [how-doordash-leverages-llms-for-better-search-retrieval], [building-doordashs-product-knowledge-graph], [doordash-kdd-llm], [doordash-llm-chatbot-knowledge-with-ugc].

---

## Reinforcements to the RFC (per gap)

- **G1 (image invalidation):** Strongly validated. Sharpest proof: [how-to-investigate-the-online-vs-offline] — URL-keyed caches are "cached residuals"; closing a parity gap moved AUC 4.3%→0.76%. Reinforces REQ-3b (validator in `stageCacheKey`). Refinement: add lineage hashes alongside `image_etag`, and a pHash hamming bucket when CDNs strip validators.
- **G2 (quality gate):** Most-validated gap. Refinements: confidence floor higher than 0.4 + `uncertain_fields` check [doordash-llms-bridge-behavioral-silos]; a cheap guardrail model (LightGBM > neural on few labels) [doordash-llm-transcribe-menu]; multi-judge veto [doordashs-next-generation-homepage-genai]; contradiction/specificity filters [doordash-llms-for-grocery-preferences], [five-common-data-quality-gotchas].
- **G3 (unskippable compose):** Validated as a structural principle — every load-bearing stage a named non-bypassable operator [pipeline-design-pattern-recommendation], [open-source-search-indexing]; colocate derived text in one write [using-cockroachdb], [building-a-gigascale-ml-feature-store]; title-only fallback is a sentinel-as-valid bug [five-common-data-quality-gotchas]. Refinement: an explicit **index↔query parity contract** — NLQ `semantic_query` composed the same shape as `embed_doc` [doordash-llm-chatbot-knowledge-with-ugc].
- **G4 (default reranker):** Strongly validated (T3). Refinement on RFC Q1: favor a **binary/per-id LLM judge** over open rewrite (generator–verifier gap) [doordash-simulation-evaluation-flywheel]; the *same* judge can serve as production reranker AND offline eval judge [doordash-llms-to-evaluate-search-result-pages]; keep `rerank:false` → pure RRF as honest baseline.
- **G5 (reranker-text):** Validated by T2. Refinement: include a compact "constraints satisfied/violated" string in `rerank_doc` (RRF is blind to which MUST predicates each hit passed) [how-doordash-leverages-llms-for-better-search-retrieval].
- **G6 (durable state):** Strongly validated — durable+replayable index failures, hot vs throttled backfill [open-source-search-indexing]; prioritize status/freshness/spot-check observability over a full platform [transforming-mlops-at-doordash] (confirms RFC scope); cap batch sizes, full-row-replace on state change [using-cockroachdb]; zero-vector-on-failure is silent corruption [five-common-data-quality-gotchas] (reinforces REQ-18b/M5).
- **G7 (boosts):** Validated, with the multiplicative-fusion refinement above. Also: pairwise query×candidate match beats flat nudges [powering-search-recommendations]; ranking as a declarative query-time operator [introducing-doordashs-in-house-search-engine].
- **Embedding hygiene (REQ-11b):** Best-supported single line item (≥8 posts). Refinements: "optimize for metric geometry, not classification accuracy" [using-twin-neural-networks]; use **labeled sections** in the embed text ("Description: … Occasions: …") not bare concatenation [doordash-unified-consumer-memory].

---

## Net-new recommendations (not in the RFC)

### 1. LLM-as-judge offline eval harness (Hit@K / nDCG / MRR, facet-decomposed, human-calibrated) — **the missing feedback loop**
Evidence: [doordash-llms-to-evaluate-search-result-pages], [doordash-simulation-evaluation-flywheel], [doordash-llms-to-build-content-embeddings], [doordashs-next-generation-homepage-genai], [evolving-doordashs-substitution].
Action: promote `apps/playground/lib/search-relevance.ts` into a first-class `@samesake/server` runner — frozen query set (head + vague tail) × catalog snapshot → `search({explain:true})` → versioned rubric prompt over each hit's `rerank_doc` → per-query Hit@K/nDCG@k/MRR + JSON artifact; add an `eval_golden` table `(query, product_id, grade, justification, intent_tags)`. **Calibrate the judge vs ~50–100 human labels (report F1) before trusting it.** Gate every change to RRF weights / default rerank / `rankingPolicy` / enrich prompts on it. Effort: **M**. Why: with no traffic, an offline judge is the *only* signal that any gap fix or recommendation actually helped.

### 2. Asymmetric query/document embedding (task types + parity contract)
Evidence: [doordash-dashclip], [doordash-unified-consumer-memory], [doordash-llms-to-build-content-embeddings], [using-twin-neural-networks].
Action: declare `taskType: "RETRIEVAL_DOCUMENT"` on the doc embedding, `RETRIEVAL_QUERY` for the search-side embed of `nlq.semantic_query` in `templates/fashion.ts`/README; document the index↔query parity contract; add a test asserting the two text shapes don't diverge. Effort: **S**. Why: near-free lift, fits BYO-embed (Gemini supports task types — matches `model-preferences`). Caveat: only when the embedder honors task types.

### 3. Waterfall / tiered enrichment (cheap precise tiers before vision LLM)
Evidence: [building-doordashs-product-knowledge-graph], [doordash-llms-bridge-behavioral-silos], [doordash-kdd-llm].
Action: in `fashionEnrichPipeline()`, add optional pre-stages (parse structured merchant fields / title keywords as high-confidence signals), **short-circuit non-apparel before `extract`**, inject classify outputs as frozen constraints into the extract prompt, cache the static prompt prefix separately. Effort: **M**. Why: enrichment is the dominant cost and the make-or-break stage; tiering cuts cost + hallucination.

### 4. Per-row ANN-retrieved few-shots for enrichment
Evidence: [building-doordashs-product-knowledge-graph], [doordash-llms-for-grocery-preferences], [how-doordash-leverages-llms-for-better-search-retrieval].
Action: replace run-global `correctionExamples()` with per-row retrieval — embed `title + image`, ANN-query human-corrected rows in the same category (reuse the consumer `embed` + pgvector/HNSW), inject top-k correction pairs into the `extract` prompt. Effort: **M**. Why: turns the correction backlog into a self-improving flywheel (compounds T1). Caveat: needs a seeded correction set.

### 5. MMR / diversity pass after rerank
Evidence: [personalizing-the-doordash-retail-store-page], [doordashs-next-generation-homepage-genai].
Action: optional greedy MMR re-order of top-K reranked hits using existing enriched attrs (category/product_type/colors/pattern), `λ` exposed on `rankingPolicy`. Effort: **S**. Why: pages full of near-identical black dresses kill perceived quality; cheap, uses existing data. Caveat: keep off for tight MUST-filtered queries.

### 6. Query understanding: enum slot-fill + ANN-shortlist + MUST/SHOULD tiers
Evidence: [how-doordash-leverages-llms-for-better-search-retrieval], [doordash-kdd-llm].
Action: tighten `fashionNlqSchema`/`FASHION_NLQ_INSTRUCTIONS` so every constraint lands in a declared enum and `semantic_query` carries only residual fuzzy intent; post-generate validator drops enum values outside `fashion.enums`; ANN-shortlist candidates for ambiguous fragments; mark `exclude_*`/gender/color as **MUST** (SQL) vs occasions/styles as **SHOULD** (boost). Effort: **M**. Why: the front door of intent-driven search — samesake's core promise — and the cheapest hallucination control.

### 7. Version lineage on enrich outputs (re-embed without re-LLM)
Evidence: [doordash-unified-consumer-memory], [how-to-investigate-the-online-vs-offline].
Action: persist a `_lineage` object inside `enriched` (model_id, prompt_hash, schema_version per stage); when only the embedder changes, re-embed from stored `embed_doc` without re-running LLM stages. Composes with G1/G6 columns. Effort: **S–M**. Why: embedder/prompt churn is constant in development; lineage turns full re-enrich into cheap re-embed.

### 8. "No silent degradation" QA views
Evidence: [five-common-data-quality-gotchas], [ship-to-production-darkly], [building-doordash-assistant].
Action: a collection-level QA view — `embed_doc` length / `rerank_doc` presence on `ready` vs `quarantined`; correlated-missing groups; quarantine/failed rates by week; assert `rerank_doc` populated whenever `embed_doc` is. Surface in the review endpoint. Effort: **S**. Why: catches the next silent-degradation footgun the RFC didn't enumerate.

### 9. Multiplicative business×relevance fusion (sharpens G7) — see RFC amendment #2.

### 10. Shadow / champion-challenger mode
Evidence: [ship-to-production-darkly], [how-to-investigate-the-online-vs-offline].
Action: a `shadow` mode that runs a challenger config (new enrich prompt / trimmed `embed_doc` / default rerank / `rankingPolicy`) in parallel, computes-but-does-not-serve, logs per-query diffs via `explain`. Effort: **M**. Why: validate changes on real-ish queries before exposing. Caveat: at small scale overlaps the offline harness — build #1 first; this is P2.

### Explicitly out of scope for a single-vertical, small-scale, no-behavioral-data engine
**Semantic IDs** (huge-catalog efficiency), **bandit exploration** (needs impression telemetry; recency channel is the honest cold-start proxy for now), **consumer-memory personalization** (needs user history — the transferable kernel is *lineage*, rec #7), **co-trained behavioral/twin embeddings** (need click/conversion logs), **knowledge-graph multi-hop** (transferable kernels are waterfall enrich + ANN few-shots, recs #3/#4), **generative carousels** (different surface; transferable kernels are jury-veto gating + multiplicative fusion). Each requires scale or telemetry samesake lacks.

---

## Prioritized backlog

**P0 — correctness & the feedback loop**
1. Land the RFC compose/gate seam + status model (G2/G3/G6 spine) — the most-validated cluster; structural foundation.
2. **LLM-as-judge offline eval harness, human-calibrated (NET-NEW #1)** — the feedback loop every other change needs.
3. G1 image-content invalidation incl. validator-in-cache-key (REQ-3b) + ban silent fallbacks (G3/M5).
4. Embedding hygiene REQ-11b (filter-not-embed) with labeled sections.

**P1 — relevance ceiling**
5. Default reranker over `rerank_doc`, binary LLM judge, RRF as honest fallback (G4/G5).
6. Asymmetric task types + index↔query parity contract (NET-NEW #2).
7. Query understanding: enum slot-fill + ANN-shortlist + MUST/SHOULD (NET-NEW #6).
8. Confidence floor tuned by the harness (not 0.4 hardcoded) + cross-signal/contradiction gate predicates (RFC amendment #1).
9. G7 with multiplicative normalized fusion + exponents (RFC amendment #2 / NET-NEW #9).

**P2 — compounding quality (after the loop exists)**
10. Waterfall/tiered enrichment + prompt-prefix caching (#3).
11. Per-row ANN-retrieved enrich few-shots (#4) — needs a seeded golden set from P0 #2.
12. MMR/diversity after rerank (#5).
13. Version lineage on enrich outputs (#7).
14. No-silent-degradation QA views (#8).
15. Shadow / champion-challenger (#10) — defer until there's traffic.
