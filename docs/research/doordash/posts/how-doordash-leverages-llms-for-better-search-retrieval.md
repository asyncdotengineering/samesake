```
# How DoorDash leverages LLMs for better search retrieval
URL: https://careersatdoordash.com/blog/how-doordash-leverages-llms-for-better-search-retrieval/

## Key mechanisms
- **Hybrid retrieval for compound intent (Figure 1):** Query journey = parse → segment → annotate → entity-link → (vertical intent); document journey = KG-backed metadata annotation before index. Retrieval combines keyword/rules (enforce constraints) with embedding similarity (generalize) — e.g. "vegan chicken sandwich" must not retrieve non-vegan chicken via pure doc similarity.
- **Taxonomy-slot segmentation, not n-grams:** LLM maps query fragments directly into ontology slots (`Quantity`, `Dietary_Preference`, `Flavor`, `Product_Category`) instead of arbitrary segments like `["small", "no-milk", "vanilla ice cream"]`. Claimed hallucination rate <1% because output is immediately classified into controlled categories.
- **RAG-constrained entity linking (Figure 2):** (1) embed query + all KG taxonomy concepts; (2) ANN retrieve **top-100** candidate labels per query (context-window + noise limit, citing arXiv:2307.03172); (3) LLM selects only from those candidates to link segments to KG concepts (e.g. "no-milk" → "dairy-free"). Linked concepts are indexed alongside documents and used as retrieval keys.
- **MUST vs SHOULD retrieval tiers:** After linking, attributes drive retrieval logic — e.g. dietary restrictions are **MUST** (hard filter), flavor/size are **SHOULD** (relaxable). This is how they enforce "reject non-vegan chicken but allow other vegan sandwiches."
- **Post-processing + batch human audit:** Post-processors validate segmented queries and linked entities against the controlled vocabulary; annotators review a statistically significant sample per batch to catch systematic linking errors (especially dietary).
- **Memorization vs generalization split:** Batch LLM QU works for fixed/high-volume query sets but doesn't scale to long-tail; on-the-fly embedding/BM25/heuristics handle unseen queries. Production system is explicitly hybrid.
- **Ranker co-evolution:** New QU signals must reach downstream rankers; after retrieval improvements they retrained the ranker on shifted engagement — reported **~30%** popular-dish carousel trigger-rate lift, **>2%** whole-page relevance (WPR) on dish-intent queries, **+1.6%** WPR after ranker retrain (no model/dim/loss details).

## Learnings for samesake
### L1: Slot-fill NLQ into taxonomy enums, not free-text soup  [maps: NEW]
- DoorDash evidence: Segmentation outputs structured `{Dietary_Preference: "no-milk", Product_Category: "ice cream", …}` aligned to KG taxonomies; arbitrary word chunks are explicitly rejected.
- Samesake action: Tighten `fashionNlqSchema` / `FASHION_NLQ_INSTRUCTIONS` (`packages/sdk/src/templates/fashion.ts:258-277`) so every extractable constraint lands in a declared enum field (`category`, `gender`, `colors`, `occasions`, `exclude_*`) and `semantic_query` carries **only** residual fuzzy intent (silhouette, vibe, product-type phrasing). Add a post-`generate` validator in the NLQ path (`packages/server/src/core/search.ts` / `search-query.ts`) that drops or re-prompts any enum value outside `fashion.enums` / `fashion.taxonomy` — same controlled-vocabulary guard DoorDash uses after segmentation.
- Why / caveat: Samesake is single-vertical fashion with a small enum set (~tens of values), so full-vocab validation is cheap without building a KG. This is the closest analog to DoorDash's doc-side enrich attrs (`enriched.category`, `enriched.colors`, …) meeting query-side attrs at filter time.

### L2: ANN-shortlisted candidates before LLM entity pick  [maps: NEW]
- DoorDash evidence: For entity linking, they ANN-retrieve the **100** closest taxonomy concepts, then constrain the LLM to pick among only those — reducing hallucinated concepts not in the KG.
- Samesake action: For ambiguous free-text in NLQ (e.g. "no-milk" → material/dietary, "kandyan" → category/product_type), precompute embeddings of taxonomy + enum labels (and optional `product_type` centroids from catalog), ANN-shortlist top-K per query segment, inject into the NLQ prompt as `candidate_labels`, and reject LLM output not in that set. Hook lives beside existing NLQ `generate` call; reuse consumer's `embed` function (provider-agnostic).
- Why / caveat: Fashion enums are small enough that passing the full list may suffice for colors/gender/category; ANN matters most for **`product_type`** and colloquial→enum mapping (already hinted in `examples/fashion-search/fashion.ts` cultural vocabulary). Skip building a separate KG — enriched row attrs + enum list are the "graph."

### L3: Explicit MUST vs SHOULD filter tiers at retrieval  [maps: NEW | G7]
- DoorDash evidence: Linked query attrs drive retrieval with hard MUST (dietary) vs relaxable SHOULD (flavor) — the core fix for compound queries where dense retrieval over-relaxes.
- Samesake action: Extend NLQ + `search()` filter application so `exclude_colors`, `exclude_patterns`, `exclude_terms`, explicit `gender`, and shopper-stated `colors` are **MUST** (SQL exclusion from all channels — FTS, cosine, spaces, recency per RFC REQ-6b); keep `occasions`, `styles`, soft `colors` as **SHOULD** (rankingPolicy boost on normalized scores, RFC G7). Document tiers in `FASHION_NLQ_INSTRUCTIONS` mirroring enrich's "highest-stakes fields" rule (`fashion.ts:147`).
- Why / caveat: Samesake already marks some fields `soft: true` in `fashionSearchFields`, but NLQ negations ("not blue", "no prints") and gender/category lack DoorDash's explicit hard/soft semantics — this is where "vegan chicken sandwich"-style false positives would appear in fashion ("linen dress but not blue" retrieving blue linen).

### L4: Keep hard attrs out of dense channels; match on enriched JSON  [maps: G3 | REQ-11b]
- DoorDash evidence: Retrieval control comes from **matching linked query concepts to document metadata fields** indexed from the KG — not from hoping embedding similarity respects "dairy-free."
- Samesake action: RFC REQ-11b already removes `category`, `gender`, `colors`, `material`, `fit`, `brand` from `composeFashionEmbedDoc`. Double down: `semantic_query` (cosine/FTS input) and trimmed `embed_doc` carry compositional signal only; MUST-tier NLQ filters bind directly to `enriched.*` columns / filterable fields. Ensure `gate` (RFC G2) quarantines low-confidence hard attrs so bad guesses never enter the searchable set as unrelaxable vector signal.
- Why / caveat: DoorDash's lesson validates the RFC's embedding-hygiene direction, not a new seam. Fashion has fewer "restriction overrides preference" rules than food, but material/color/gender mis-guesses in vectors are equally unfixable at query time.

### L5: Feed structured constraint alignment into default reranker text  [maps: G4 | G5]
- DoorDash evidence: QU signals were made available to rankers; after retrieval changed engagement patterns, a retrained ranker added **+1.6% WPR** — rankers must see the same structured signals retrieval uses.
- Samesake action: When implementing RFC `composeFashionRerankDoc` + default `fashionRerank` (`templates/fashion.ts`, `search.ts:826-831`), include enriched attrs **and** a compact "constraints satisfied/violated" string derived from NLQ MUST filters (e.g. `colors=red ✓, exclude blue ✓`). RRF fusion is blind to which MUST predicates each hit passed; the reranker is the right place to break ties among cosine-retrieved violators.
- Why / caveat: Samesake won't train a learned ranker at DoorDash scale; a cross-encoder/LLM reranker with rich `rerank_doc` is the transferable pattern. Cost is one `generate` call/query (RFC Q1) — acceptable if MUST-tier precision is the goal.

## Applicability caveats
- **No KG / multi-vertical architecture:** DoorDash's core win is LLM-built food+retail knowledge graphs with cross-entity relationships. Samesake's per-SKU enrich JSONB is sufficient at single-retailer fashion scale; don't invest in a graph — invest in enum alignment and filter tiers.
- **Batch query preprocessing:** Their memorization path (batch LLM on fixed queries) doesn't transfer; fashion queries are long-tail and real-time. Samesake's on-the-fly NLQ is correct; borrow only validation/constraint patterns, not batch QU jobs.
- **Thin on ML specifics:** Post names no embedding models, dims, losses, or ranker architecture — only "closed-source, pre-trained, or in-house" embeddings and online A/B metrics. No actionable embedding-training or ranker-training recipe for samesake.
- **Domain-specific surfaces:** Popular-dish carousel, vertical intent (restaurant vs grocery), and marketplace conversion metrics don't map to a single-brand visual product search engine.
- **Eval gap:** DoorDash relies on manual batch audits + WPR/conversion A/B. Samesake should mirror the **controlled-vocab audit** idea for NLQ/enrich (sample `pipeline_status='quarantined'` + NLQ misparses) but WPR isn't directly portable without labeled fashion query sets (`examples/fashion-search/` eval harness is the right scale).
```
