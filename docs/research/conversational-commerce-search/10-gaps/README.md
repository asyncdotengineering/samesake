# 10 — Completeness Pass (Gaps Missed in the First Sweep)

This folder is the deliberate "what did we miss?" pass. Two kinds of misses:

1. **Topical gaps** — robust-framework concerns no dossier covered. Researched by the
   `cc-search-gap-fill` workflow (11 agents). Files land here as they complete.
2. **Under-weighted nuggets** — findings present in dossiers I summarized from agent-returns
   rather than read in full, which didn't make it into `07-decisions/`. Captured below and
   folded into the decision docs.

## Topical gaps researched (workflow `cc-search-gap-fill`)

| File | Why it was a gap |
|---|---|
| `multilingual-and-codemixed-retrieval.md` | **Biggest miss.** samesake's real corpus is LK fashion (Sinhala/Tamil/English code-mixed); "local" is its *weakest* benchmark type — yet multilingual retrieval was never researched. |
| `embedding-model-selection.md` | We said "BYO embeddings" but never *which* — no MTEB/Matryoshka/quantization guidance. |
| `query-understanding-expansion-rerankers.md` | Recommended "a cross-encoder" without naming models; never covered typo/segmentation/synonyms or HyDE/query2doc/doc2query. |
| `merchandising-faceting-diversity.md` | Boost/bury/score-modifiers, MMR diversity, faceting-at-scale, zero-result relaxation, recency — all unresearched product capabilities. |
| `personalization-without-behavior-and-session-state.md` | Decision 05 was too absolute ("samesake lacks personalization"); context-vector personalization needs no behavioral log. |
| `fashion-fit-sizing-returns.md` | Fit/sizing is a top apparel return driver; barely touched. |
| `agentic-mcp-security.md` | Prompt-injection-via-catalog-data and MCP security — a 2026 concern, entirely uncovered. |
| `geo-aeo-agent-discoverability.md` | GEO/AEO methodology (how external agents rank products) — noted by vendors, never researched. |
| `visual-late-interaction-and-multimodal-rerank.md` | ColPali/ColQwen, multimodal-LLM rerank, localization — visual depth beyond plain CLIP. |
| `additional-search-and-vector-vendors.md` | Missed vendors: Pinecone, Vectara, Shopify native, Fast Simon, Unbxd, Luigi's Box, etc. |
| `eval-methodology-llm-judge.md` | LLM-as-judge biases (samesake uses a Gemini ESCI judge), BEIR/MTEB/MIRACL, interleaving vs A/B. |

## Under-weighted nuggets recovered from full re-reads (fold into decisions)

From **`01-marqo/models-training.md`** and **`01-marqo/visual-fashion.md`** (read in full only on
the completeness pass — first synthesis used agent summaries):

1. **Context vectors (Marqo CTO, "Context Is All You Need").** Precompute a user taste vector
   from liked/viewed/bought items, fuse it into the query vector before ANN — **personalization
   with zero retraining, no query-time model call, and no behavioral interaction log**, expressible
   as a weighted vector-add in pgvector. → *Corrects Decision 05's "samesake lacks behavioral
   personalization" to "lacks **behavioral** personalization, but content/context-vector
   personalization is natively in reach."*
2. **Score modifiers.** Query-independent document scalars (popularity, quality/aesthetic, margin,
   recency) that multiplicatively bias similarity — the **auditable merchandising lever** flagged
   as a gap. A soft bias leg on top of hard SQL filters; keeps boost/bury explainable (vs Marqo
   baking margin into the model). → Decision 02 / new merchandising decision.
3. **Visual localization → highlights.** Index-time patching (YOLOX/DINO) + search-time
   query-conditioned reranking (OWL-ViT) to return the matching *region/bbox* of a product image.
   Sub-image vectors are also a precedent for "spaces"/late-interaction. → Decision 02 §7.
4. **NSFW/data-curation via weighted CLIP queries + cosine threshold + relevance feedback.** A
   BYO-embedding catalog-hygiene technique for the enrich/dedup pipeline (curation-grade, not a
   safety guarantee).
5. **GCL = arXiv:2404.08535**; per-query-*cluster* eval analysis (Cobalt) to diagnose *why*
   "spaces" failed the gate — not just an aggregate number. → Decision 06.
6. **Marqo's "tensor search" = multi-vector documents** (best-matching sub-vector scoring) —
   relevant to both the "spaces" verdict and ColPali-style late interaction.
7. **Marqo deleted/redirected its technical posts** (recovered via Wayback) — hardens the
   "technical posts are generated SEO collateral" finding; the real engineering record is the
   2024 originals, not the 2026 "Commerce Superintelligence" rewrites.

From **`08-rag/rag-for-products.md`** (full read):

8. **Field-level provenance** for the citation feed — does `findProducts()` expose *which catalog
   field / which review* supports *which asserted attribute* (e.g. "`waterproof=true` ← spec.materials;
   'runs small' ← review#412"), or only product-level "why"? "Cite Before You Speak" (+13.83%
   grounding) needs field-level. → handoff-contract refinement (Decision 04 §4).
9. **Aggregate-over-many-reviews** for subjective queries ("runs small?") — pure top-k may
   under-serve aggregate-opinion questions; AmazonQA/Rufus both *synthesize over many reviews*.

These nine are folded into `07-decisions/` (see the in-place additions); the eleven topical
files will produce their own adopt/avoid/integrate verdicts, to be reconciled into the decision
docs when the workflow completes.
