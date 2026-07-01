# What other engineering teams are telling us — ecommerce search, enrichment, eval (2024–2026)

Status: Research digest · Date: 2026-07-01 · 29 cited sources across three tracks (search
architecture, LLM product-data enrichment, hybrid fusion + rerank + LLM-judge eval). Purpose:
pressure-test samesake's architecture against the industry — what **validates** it, what we're
**missing**, what's **genuinely new**. Pairs with `full-scale-fashion-search.md` and the
`doordash/` learnings already here.

## The industry consensus (recurs across nearly every team)

1. **Hybrid retrieval is the default; vector-only is rejected.** Everyone runs lexical (BM25/`ts_rank`)
   *alongside* dense and merges — Instacart unions, Faire blends, Zalando "a mix of lexical and semantic."
2. **Multi-stage funnel:** query understanding → hybrid recall → ranking (LTR/DNN) → whole-page
   re-rank (diversity, dedupe, business rules) → presentation. Bi-encoder for recall, cross-encoder
   for precision is near-universal.
3. **Fusion = RRF (k=60) as the no-tuning baseline** (Cormack 2009; Elastic/Qdrant defaults), graduating
   to **relative-score/normalized fusion** when score magnitude carries signal (Weaviate: ~6% recall
   gain + enables cluster-based no-results cutoffs).
4. **Rerank top-50→200 with a cross-encoder** (~150–460 ms, payload-driven) OR distill to an inline
   model (<10 ms). Caveat (Innsbruck 2025): the "best" vendor reranker isn't universally best on OOD/tail.
5. **Input representation (enrichment) is the biggest lever — bigger than model choice.** DoorDash
   decomposed it: better *encoder* alone = **+5.9%** Hit@5; better *data* (LLM-enriched profiles) alone
   = **+31.2%**; "the single largest lever is input representation, not model choice."
6. **Enrichment method = 2-stage classify→category-conditioned extract, multimodal, confidence-gated
   with HITL/active-learning.** Shopify, Instacart, Mercari, DoorDash all converge here.
7. **Domain-trained beats off-the-shelf** — unanimous (Etsy custom embeddings +10% NDCG; Constructor
   "commerce-aware" embeddings; Faire found BERT no better than USE).
8. **LLM-as-judge is the 2024–2026 eval standard**, and always the same loop: **anchor to a human
   golden set → align (temp=0, few-shot CoT, confusion matrix/κ) → scale → human spot-audit.**
9. **Graded engagement labels beat binary clicks** (Mercari click<like<cart<purchase; Constructor
   outcome scoring); optimize low-variance business KPIs, not revenue/nDCG alone.

## What validates samesake's architecture

| Pillar | Validation |
|---|---|
| **Postgres-native single store** | **Instacart** runs prod text retrieval on Postgres (GIN+`ts_rank`) and is **consolidating vector into pgvector** for "a single document store" — at 1.4B docs. Exactly our bet. |
| **Enrichment as the moat** | DoorDash's +31% vs +6%; Zalando's failures all trace to missing/wrong attributes; Lyst prefers enriched taxonomy over free text ("'jeans' in a description may be a jacket's material"). |
| **2-stage classify→extract, image-aware, confidence-gated** | Industry-standard (Shopify's explicit two calls, Instacart cascade, Mercari). Confidence gate matches **Instacart self-verification score** + **Shopify token-probability routing**. |
| **Few-shot correction loop (this session's P1 lesson)** | **Univ. Mannheim (2025): LLM *self-correction* corrupts more than it fixes**; the real levers are **few-shot from semantically-similar items (+10–20 F1)** and fine-tuning. Directly validates why our global classify-prompt edits regressed and why corrections belong as *exemplars*, not model self-review. |
| **Hybrid RRF + BYO cross-encoder rerank** | The converged architecture; RRF is the standard baseline; BYO hedges the Innsbruck OOD finding. |
| **LLM-judge + deterministic cache + calibration + adversarial/OOD testing** | Vespa/Etsy/DoorDash all do golden→align→scale with temp=0; our persistent judge cache + red-team + eval gates are textbook. |
| **Intent extraction → structured retrieval for fashion** | Lyst (entity recognition→linking on a fashion taxonomy) and Zalando (NER tags→catalog filters) are two fashion-natives doing exactly our NLQ→hard-filters loop. |
| **Measured per-attribute P/R/F1** | Matches Shopify (hierarchical P/R) + the academic corpus. Adopt Mannheim's 5-bucket (VC/VW/NV/VN/NN) F1 to be benchmarkable vs OA-Mine/AE-110K/MAVE. |

## What we're missing (prioritized, actionable)

**Retrieval / ranking (L2):**
1. **Query-entropy adaptive recall** (Instacart): size each retrieval leg by query specificity, not
   fixed top-K → +1.7% converting position, −1.5% latency. Cheap, high-leverage.
2. **Whole-page re-rank stage** distinct from item scoring — diversity, brand dedupe, demote
   low-quality sellers, merchandising (Faire, Constructor). We only score items.
3. **Semantic-relevance model as a ranking input, not just retrieval** (Etsy's four integration points:
   filter irrelevant pre-ranking, feature, loss-weight, boost).
4. **Relative-score / distribution fusion as an option** beside RRF (Weaviate +6% recall; enables
   AutoCut no-results cutoffs — a principled alternative to a hand-tuned OOD floor).
5. **Prefilter-during-ANN** for hard filters (size/price/availability) vs post-filter (Faire on ES8;
   pgvector supports it — ties to our iterative-scan adoption).

**Enrichment (L1):**
6. **Internal-catalog RAG extraction** (Amazon PatternRAG, EMNLP 2025): ~half of a product's attributes
   are missing from its own text/image but exist in *sibling* products — retrieve same-category,
   same-brand, high-traffic filled examples as few-shot → **+34% recall**. Biggest single enrichment lever.
7. **Active learning from the confidence signal we already compute** (Shopify): low-token-probability
   SKUs → human label → back into the few-shot pool / fine-tune set. Closes our flywheel.
8. **Distillation to a small fine-tuned model** (Mercari gemma-2b QLoRA: 14× cheaper, beats GPT-3.5;
   Shopify Qwen2VL-7B) once past a few-thousand SKUs — the cost/latency margin lever.
9. **Value normalization as a first-class step** (Shopify hex colors; Amazon AVEN-GR) — we do base-color; extend.

**Eval (L4):**
10. **Bucketed reporting** (head/torso/tail, branded/generic, attribute/negation) — Layers: "a weight
    change that improved NDCG@10 overall was quietly degrading tail-branded queries by 12 points." We
    bucket by query-type; add branded/tail.
11. **Judge-calibration depth**: Cohen's κ per class, Kendall's τ on system ordering, **Judged@k** (catch
    unjudged "holes"), **pool candidates from multiple retrievers**, **judge pairs independently**
    (avoid threshold-priming).
12. **The judge-bias risk is acute for us** (Google, arXiv:2503.19092): LLM judges are **lenient** and
    **biased toward LLM-generated rankers/content** — and our enrichment *is* LLM-written. Mitigate with
    periodic human audits + track judge *sensitivity* (can it separate two close systems?), not just correlation.
13. **Business-metric guardrail** — Etsy: "engagement declines even as semantic relevance improves."
    Don't ship on judge score alone.
14. **Multimodal / visual retrieval + judge** (Faire CLIP, DoorDash VLM→text, Zalando/Layers image-aware
    judges) — for fashion this is table stakes and is underweighted in our text-first design.

## Genuinely new ideas (2024–2026)

- **LLM-generated content profiles as the embedding substrate** (DoorDash, Etsy): don't embed raw
  metadata — have an LLM/VLM write a standardized structured narrative *first*, then embed. The
  dominant lever, and exactly our `search_document` composition idea taken further.
- **Teacher→student relevance distillation** (Etsy: o3 → Qwen3-VL-4B → BERT two-tower, <10 ms) — get
  frontier-judge quality into a real-time serving budget.
- **Instruction-following rerankers** (Voyage rerank-2.5, Aug 2025): steer relevance per-intent with a
  natural-language instruction — a strong fit for our *intent-driven* angle ("prefer in-season,
  occasion-appropriate").
- **Multimodal LLM judge with catalog context** (Layers, Etsy): image + catalog lets the judge tell a
  "broken result" from an "out-of-catalog" query — directly relevant to our OOD/red-team finding.
- **Internal-catalog RAG for enrichment** + **self-verification confidence score** (token-prob of "yes"
  on a scoring prompt, Instacart) + **uncertainty-driven active learning** (Shopify).
- **Semantic IDs / generative retrieval** (DoorDash roadmap, TIGER) — discretize items into semantic
  codes and *generate* IDs; targets long-tail/cold-start. Emerging, not yet default.
- **Pairwise VLM style-compatibility** (Wayfair Gemini 2.5 Pro, +11%) — a concrete "complete the look" recipe.

## Net read

samesake is **on the industry main line, not a side path**: Postgres-native hybrid + enrichment-first +
intent extraction + LLM-judge eval are exactly what Instacart, DoorDash, Etsy, Zalando, Lyst, and
Shopify are doing. The enrichment-first thesis is the strongest-validated bet in the corpus (DoorDash
quantified it). The highest-ROI gaps to close next: **internal-catalog RAG enrichment (+34% recall
lever)**, **query-entropy adaptive recall**, **whole-page re-rank + merchandising**, **bucketed +
bias-aware judge calibration**, and **multimodal/visual retrieval**. The biggest risk to watch:
**an LLM judge that flatters our own LLM-generated enrichment** — keep humans in the calibration loop.

## Sources (selected)

Architecture: Instacart hybrid-retrieval · Faire embedding-based retrieval · Etsy DL ranking + LLM
relevance · DoorDash content-embeddings · Zalando LLM-judge · Lyst fashion query understanding · Mercari
ML re-ranking · Constructor search-intent.
Enrichment: Instacart PARSE · Shopify Global Catalogue (ICLR 2025) · DoorDash product KG · Mercari
categorization + attribute extraction · Wayfair style-compatibility · Amazon MXT (ACL 2023) · Univ.
Mannheim self-refinement (arXiv:2501.01237) · Amazon PatternRAG (EMNLP 2025) · MAVE/OA-Mine/AE-110K.
Hybrid/rerank/eval: Weaviate fusion · Vespa LLM-as-judge · Cohere Rerank 3.5 · Voyage rerank-2.5 ·
Elastic min_score · ZeroEntropy latency benchmark · Layers (Shopify) commerce-scale eval · DoorDash
AutoEval/WPR · Turnbull/WANDS · Innsbruck reranker study (arXiv:2508.16757) · Google "Rankers, Judges,
and Assistants" (arXiv:2503.19092).
