```
# Using LLMs to infer grocery preferences from DoorDash restaurant orders
URL: https://careersatdoordash.com/blog/doordash-llms-for-grocery-preferences-from-restaurant-orders/

## Key mechanisms
- **Per-user full-context LLM rejected at scale:** naïve design = each of 200M+ users × full order history × full grocery taxonomy in one prompt → context bloat, hallucinations, ~seven-figure cost per full refresh; they explicitly abandoned this.
- **Signal compression via a shared tag vocabulary:** restaurant items are not fed raw; each item is reduced to existing dish / dietary / cuisine tags, aggregated into **tagsets** (e.g. `⟨Burger, American Traditional⟩`), then recency-weighted and frequency-normalized per user over a **6-month** horizon.
- **Offline amortization (~10,000× cost reduction):** weekly batch maps **tens of thousands of unique tagsets** → grocery taxonomies once; mappings are stored and reused at runtime for all users instead of per-user LLM calls (Figure 2: “offline tagset-to-taxonomy mapping … combined with personalized scoring”).
- **Pre-LLM quality pass with explicit keep/drop rules:** LLM-assisted cleaning enforces schema invariants (e.g. reject `Meat Bowl` + `Vegetarian`), **specificity filters** (drop `Chicken and Shrimp`, `Meat + Asian`), and canonicalization (synonyms, capitalization, dedup); table gives FILTER_OUT vs KEEP with written rationale.
- **Two-stage tagset→taxonomy mapping = embed + K-NN + constrained LLM:** (1) embed every tagset and taxonomy node; (2) **K≈200** cosine nearest taxonomy candidates; (3) LLM prompt with **~100 candidates**, few-shot examples, explicit rubrics, strict JSON I/O → **ranked taxonomies with discrete relevance scores 1–5** (5 = most relevant); example: `Sesame Chicken, Chinese` → `[Fresh Rice, Frozen Chicken Dinners, …]` with scores `[3,4,3,3]`.
- **Personalized scoring is multiplicative, not LLM-only:** tagset score `s(g)` = product or weighted mix of **recency** `r = e^(-λ·d)` with `λ = ln2/h` (half-life `h` days) and **frequency** `f = count(g)/(1+count(g))`; final taxonomy score = **tagset_score × LLM_relevance(1–5)**; dedupe by max score when a taxonomy appears under multiple tagsets; take top-N taxonomies per user × business vertical.
- **Online stack is separate from LLM:** offline signals feed existing **two-tower embedding (TTE) retrieval** + **personalized multi-task MMoE (MTML) ranker** for low-latency serving (Figure 2: “online retrieval and ranking”).
- **Offline eval = LLM-as-judge with ordinal/ranking metrics:** judge re-scores mappings 1–5; prompt iteration tracked via **MAE**, **quadratic weighted kappa**, **nDCG@3**, **Precision@3 (≥3)**; production planned via conversion, add-to-cart, order-rate A/B tests.

## Learnings for samesake
### L1: Amortize LLM work on deduplicated keys, not per-row/per-user context  [maps: G1 | G6 | NEW]
- DoorDash evidence: unique tagsets (~10⁴) mapped weekly offline and reused across 200M users; per-user work is cheap aggregation + lookup, not another LLM call.
- Samesake action: treat enrich as a **shared mapping table keyed by stable content identity**, not “one uncached vision call per SKU forever.” RFC G1/M1 already moves cache keys from `imageUrls.join(",")` to `image_etag`/pHash; extend that pattern so **classify/extract stage cache + `content_hash` invalidation** behave like DoorDash’s precomputed tagset map. Wire G6 `retryFailed` / scheduled passes so re-enrich after revalidation drains the queue instead of ad-hoc `for (i<10) enrich()` loops in examples.
- Why / caveat: Same *shape* (compress → cache → reuse), different unit: SKUs not users. For a single retailer catalog this is the main cost/latency win; cross-vertical cold start doesn’t apply.

### L2: Specificity and contradiction filters belong in the gate, not post-hoc review  [maps: G2]
- DoorDash evidence: before any taxonomy LLM, they **FILTER_OUT** contradictory tags (`Meat Bowl` + `Vegetarian`) and low-information combos (`Chicken and Shrimp`, `Meat + Asian`) with explicit rubrics—not “log and ship.”
- Samesake action: extend fashion `gate()` in `packages/sdk/src/templates/fashion.ts` beyond `confidence < 0.4`, `category === "other"`, `is_apparel_product === false` to drop **internally inconsistent** enrichments (e.g. `gender` vs `category`, `material` vs visual `pattern`) and **under-specified** `search_document`/tag combos analogous to “Meat + Asian.” Quarantine → null vectors + search exclusion (RFC REQ-5b/REQ-6b), not only `review.ts` listing.
- Why / caveat: DoorDash filters *input tags*; samesake filters *LLM output*. Same failure mode—noisy intermediate representation poisons every downstream channel (embed, FTS, spaces, rerank).

### L3: Embed→K-NN narrow→small-context LLM beats full-vocabulary prompting  [maps: NEW]
- DoorDash evidence: full taxonomy in prompt caused hallucinations; fix = embed tagsets + taxonomy nodes, retrieve **top ~200**, prompt LLM on **~100** with few-shot + rubric + strict JSON scores 1–5.
- Samesake action: (a) **NLQ** (`search` rewrite + hard filters)—retrieve allowed filter values / category aliases by embedding similarity before the rewrite LLM, instead of dumping the whole attribute schema; (b) **enrich few-shot**—select correction examples by embedding nearest-neighbor on `search_document` or visual/doc embedding, not a static prompt block. Reuse existing `embed` provider + pgvector/HNSW pattern.
- Why / caveat: Fashion attribute cardinality is far smaller than grocery taxonomy, so uplift is real but smaller; highest leverage on vague NLQ (“something for a beach wedding”) and long-tail categories where unconstrained extract hallucinates.

### L4: Treat enrichment confidence like DoorDash’s 1–5 relevance multiplier in ranking  [maps: G7 | G2]
- DoorDash evidence: final taxonomy weight = **behavioral tagset score × LLM relevance (1–5)**; behavioral and semantic signals are multiplied, not added as raw constants.
- Samesake action: in RFC G7 `core/ranking.ts`, compose post-RRF score as **normalized_relevance × f(confidence)** (and availability/business/recency factors on the same normalized scale)—not `score -= 2` on raw RRF (`fashion-search.ts:163-168`). Optionally map `confidence` bands to discrete multipliers (DoorDash-style 1–5) so a 0.35-confidence row is down-ranked even if it slips past gate during re-enrich.
- Why / caveat: samesake already *captures* `confidence` and `uncertain_fields` but doesn’t *consume* them at index or rank time; DoorDash shows the intended consumption pattern. At single-retailer scale, a simple multiplier is enough—no MMoE ranker required.

### L5: LLM-as-judge + ordinal metrics for offline enrich/NLP iteration  [maps: G4 | NEW]
- DoorDash evidence: every offline generation stage iterated with an LLM judge; metrics = **MAE, QWK, nDCG@3, P@3(≥3)** against judge scores—not gut-feel prompt edits.
- Samesake action: add an offline eval harness over human corrections / labeled query–SKU pairs: judge `extract`/`search_document`/`rerank_doc` quality (and post-G4 default rerank order) with the same metric family; gate threshold (`FASHION_CONFIDENCE_FLOOR = 0.4`) and prompt changes require a regression pass before merge. Distinct from production A/B—this is pre-ship prompt QA.
- Why / caveat: samesake’s enrich *is* the product (per RFC problem statement); DoorDash’s judge loop is the missing feedback layer between “we have confidence JSON” and “we know prompts got better.” Online conversion metrics don’t exist yet at DoorDash’s scale for us—offline judges are the transferable piece now.

## Applicability caveats
- **No cross-vertical cold start:** DoorDash’s core problem is inferring grocery intent from restaurant tags; samesake is single-vertical product retrieval with no user-order-history bootstrap—most of the *personalization* story (tagset scoring over 6-month restaurant history) is N/A unless you add shopper profiles later.
- **Different online ranker class:** DoorDash serves through trained **TTE + MTML**; samesake is **pgvector HNSW + RRF + optional BYO rerank**. Their online stack doesn’t justify building two-tower models; the transferable part is **separating offline LLM inference from online retrieval/ranking**, which the RFC already targets via G4/G7.
- **Taxonomy scale mismatch:** K-NN-over-embeddings before LLM is load-bearing at grocery taxonomy size; fashion filters/spaces are lower-cardinality—embed→narrow helps NLQ and few-shot selection more than extract→taxonomy mapping.
- **Post is thin on model/dim/training details:** No embedding model names, dims, loss functions, or TTE/MTML architecture specifics—only pipeline structure, K≈200, scores 1–5, recency half-life, and eval metrics. Don’t infer their embedding geometry for samesake spaces design.
```
