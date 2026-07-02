# Using Triplet Loss and Siamese Neural Networks to Train Catalog Item Embeddings
URL: https://careersatdoordash.com/blog/using-twin-neural-networks-to-train-catalog-item-embeddings/

## Key mechanisms
- **Shared query–item latent space via weight-tied Siamese encoders (Figures 1, 8–9):** One encoder (BiLSTM → FFN projection head) embeds both raw search queries and item names into the same space so retrieval is a single cosine comparison — not separate query/item models.
- **Triplet loss with margin on behavioral triples (Figure 6, loss `max(d(a,p)−d(a,n)+margin,0)`):** Anchor = query text; positive = same-session post-search purchase where the item is the **most expensive in the basket**; negative = purchase from a different query with **Levenshtein distance > 5** (so “burger”/“burgers” are not hard negatives). Labels are explicitly noisy; loss only enforces *relative* ordering.
- **Character trigram tokenization + minimal normalization (Figure 7, 11):** Lowercase + strip punctuation only; inputs as char trigrams (spaces kept) into a **bidirectional LSTM** + ReLU/BatchNorm projection head. Chosen over BPE/WordPiece/word ngrams for speed; outperformed BERT on **metric** quality with enough in-domain unlabeled search data.
- **Rejected baselines with stated failure modes:** Word2vec on item IDs (daily retrain cost, cold-start sparsity); supervised classifier penultimate layer (weak cosine metric, needs hard negatives per class); BERT fine-tune (slow inference; domain self-supervised beat it on metric properties).
- **Eval stack:** UMAP cluster sanity (Figure 13) + zero-shot classification F1 vs FastText (+23% Siamese vs labeled FastText baseline; LSTM classifier +15%). Downstream tagging needed **>3×** labeled data without these embeddings.
- **Serving pattern — retrieve then rank (Figure 14):** Precomputed item embeddings → cosine retrieval filter → existing conversion ranker on the shortlist. Store/consumer vectors = **mean of constituent item embeddings** (Figure 2), computed offline.

## Learnings for samesake
### L1: Treat search as retrieve-then-rerank, not one fused score  [maps: G4 | G7 | N/A]
- DoorDash evidence: Figure 14 — cosine embedding retrieval is step 1; a separate conversion-optimized ranker reorders the filtered pool (step 2). They explicitly prefer this over a monolithic `<consumer, store>` scorer because retrieval is cheap and rankers can iterate independently.
- Samesake action: Ship RFC **G4** default `fashionRerank()` and **G7** normalized post-RRF boosts in `packages/server/src/core/search.ts` / `core/ranking.ts` as a deliberate two-stage contract: RRF (recall) → rerank (precision on vague intent) → normalized business/availability hook — mirroring DoorDash’s separation, not additive constants on raw RRF (`fashion-search.ts:163-168`).
- Why / caveat: Same architectural shape, opposite data advantage — samesake has rich enrichment + visual spaces, not DoorDash-scale purchase logs. The learning is *stage separation*, not copying their ranker.

### L2: Query and catalog text must live in one comparable representation  [maps: G3 | NEW | N/A]
- DoorDash evidence: Figure 1 — queries (green) and items (yellow) must co-embed with high cosine when relevant; a shared encoder is the mechanism.
- Samesake action: (1) RFC **G3** — unskippable `compose` writes `embed_doc` inside `enrichOne` (`enrich-pipeline.ts`). (2) **NEW** — add an NLQ/`search-query.ts` contract: the string passed to `ctx.embed()` for cosine (`semanticText = nlq.parsed.semantic_query || q`) should be formatted like `embed_doc` (same field order, no filter-only tokens), or NLQ should emit a dedicated `query_embed_text` parallel to `semantic_query`. Today query text is often a short rewrite while items embed a composed paragraph — same BYO embedder, mismatched surface form.
- Why / caveat: samesake won’t train a Siamese net; comparability comes from **textualization symmetry** + shared embed fn. Fashion’s richer attrs make format drift more harmful than on raw menu names.

### L3: Optimize embeddings for metric geometry, not classification accuracy  [maps: G3 | N/A]
- DoorDash evidence: They reject supervised classifier embeddings because cross-entropy doesn’t guarantee cosine-friendly geometry (cite metric-learning literature); triplet loss explicitly pulls/pushes in embedding space (Figure 9). They also avoid over-normalizing inputs so typos/variations stay in-distribution.
- Samesake action: Implement RFC **REQ-11b** — strip low-cardinality attrs (`category`, `gender`, `colors`, `material`, `fit`, `brand`) from `composeFashionEmbedDoc` in `packages/sdk/src/templates/fashion.ts`; keep them in filters/spaces/`rerank_doc` only. Dense vectors carry compositional/occasion/style signal; exact attrs stay filter-relaxable.
- Why / caveat: DoorDash’s lesson transfers as **embedding hygiene**, not custom training. Baking a wrong LLM `material` guess into pgvector is the fashion analog of a bad triplet anchor — unrelaxable. Filters/spaces avoid that.

### L4: Noisy supervision is usable if you gate index, not if you demand clean labels  [maps: G2 | N/A]
- DoorDash evidence: Figure 6 — positives are heuristic and wrong (“thai fresh rolls” ≠ “sushi”); training still works because triplet loss only needs *positive closer than negative*, not perfect relevance labels.
- Samesake action: Wire RFC **G2** `gate()` on `PipelineDef` with `FASHION_CONFIDENCE_FLOOR = 0.4` — quarantine low-confidence enrichments (`pipeline_status = 'quarantined'`) instead of treating `confidence` as post-hoc review-only (`review.ts:33-40`). Noisy LLM vision output is the same class of label noise; the fix is **exclude from index**, not chase perfect extraction.
- Why / caveat: samesake lacks DoorDash’s volume to learn through noise; a small catalog can’t absorb bad vectors. Gating is the right analog of their robust loss.

### L5: Qualitative embedding QA before trusting downstream metrics  [maps: NEW | N/A]
- DoorDash evidence: UMAP on labeled holdout (Figure 13) preceded F1 benchmarking; clustering by cuisine validated metric quality before deployment to recommendations/tagging.
- Samesake action: **NEW** — add an offline eval script (extend `apps/playground/lib/search-relevance.ts` or `examples/fashion-search/`) that UMAP-projects `embedding`/`space_vec` segments colored by `enriched.category`, plus a zero-shot kNN query→item hit rate using the same embed path as `search.ts:547`. Run after compose/gate changes (C6–C7) to catch attribute-bleed or title-only regressions before A/B.
- Why / caveat: At fashion scale UMAP is cheap and catches “dresses near shoes” failures RRF aggregates hide. No purchase-log F1 equivalent exists yet.

## Applicability caveats
- **No behavioral triplet mining:** DoorDash’s core signal is search→purchase sessions at massive scale. Samesake has no equivalent log pipeline; training a custom Siamese/triplet model is out of scope for the BYO-embed RFC and likely never worth it at single-retailer scale.
- **Text-only, pre-vision, pre-LLM-enrich (2021):** The encoder is char-trigram BiLSTM on item **names**, not images, structured attrs, or LLM `search_document`. samesake’s make-or-break stage is vision enrichment + multi-channel RRF — this post doesn’t address G1 (image-byte drift), visual spaces, or FTS.
- **Single dense space vs samesake’s fusion:** DoorDash retrieval is one cosine leg; samesake deliberately splits semantic (`embed_doc`), visual, price, category, recency, and FTS with RRF. Don’t collapse channels to mimic Figure 1; apply the *comparability* and *two-stage* ideas within the existing architecture.
- **Entity-ID Word2vec critique doesn’t map cleanly:** Their rejection of ID embeddings targets daily catalog churn at DoorDash scale; samesake’s `content_hash` + re-ingest reset is a different invalidation model (and G1 fixes URL-not-bytes).
