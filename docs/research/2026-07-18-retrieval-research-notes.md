# Retrieval research notes — 2026-07-18

Distilled from a full read of: shaped.ai case studies (12) and blog (~50 relevant posts across 5
clusters), Upside Lab Enthusiast docs + repo, arXiv 2606.19684, and 2024–26 engineering
blogs/papers from DoorDash (3), Walmart (3), Pinterest (2), Instacart (1), Airbnb (1).
Purpose: cross-check the standing RFCs (`rfcs/`) and source core retrieval improvements for the
fashion-marketplace deployment. Each claim below traces to a named source; the full per-source
notes lived in the research session — this file keeps only what changes decisions.

## The one-paragraph verdict

Samesake's architecture is repeatedly re-derived by industry: hybrid lexical+dense with
rank-based fusion (RRF) is the settled pattern (Walmart, DoorDash, Airbnb, Pinterest all keep an
inverted-index leg; Shaped's own "Related Pins" playbook computes literally `w/(1+rank)` in
SQL), write-time LLM enrichment into materialized columns is the industry-standard shape
(Shaped AI Views, DoorDash content profiles), and LLM-as-judge offline eval is current best
practice (Bloomberg, DoorDash, Pinterest). The gaps are specific: ungrounded query
understanding, no zero-result recovery ladder, no diversity/ordering stage, and a purely
offline eval loop.

## Strongest cross-source findings (ranked by evidence × feasibility)

1. **Enrichment quality dominates model choice — measured.** DoorDash ablation: better LLM item
   profiles +31.2% Hit@5 vs better embedding model +5.9% (both +37.6%). *Diagram-audit caveat
   (2026-07-18): the item-level "data alone" row swaps embedding models rather than holding the
   baseline fixed, and "model alone" goes −1% at Hit@20 — the clean isolation is the
   store-level 2×2 in the same post: +161% model / +161% data / +209% both. Direction holds;
   cite the store-level table for rigor.* Pinterest OmniSearchSage: synthetic BLIP captions +
   board titles + engaged queries drive the recall gains, not the encoder. Validates the
   enrichment-as-moat thesis with hard numbers.
2. **Ground query understanding in the catalog, not world knowledge.** DoorDash agentic intent
   paper: catalog grounding is +8.3pp of a +13pp total accuracy gain; ungrounded LLM
   classification is the documented failure mode (−10.9pp). Instacart: candidate-constrained
   category classification + embedding-similarity guardrails. Every production system constrains
   LLM output to a controlled vocabulary. → `rfcs/rfc-grounded-query-understanding.md`.
3. **Typed LLM query rewrites recover nulls.** Instacart: substitute/broader/synonym rewrite
   prompts took rewrite coverage 50%→95%+ at 90%+ precision; tail-query complaints −50%.
   Slots into samesake's existing relaxation ladder as a final pre-empty step.
4. **Head/tail asymmetry is the economics of LLM QU.** DoorDash serves 95.9% of impressions
   from batch-precomputed QU cache; Instacart runs live inference on only ~2% of traffic.
   Samesake's 7-day NLQ stage-cache is the same pattern reactive-only; precompute is a later
   optimization, invalidation on schema/instruction change is the part that must be right.
5. **Ordering stage is the biggest no-training gap.** MMR diversity re-rank (Breakr case study:
   +382% diversity; Shaped Part-4 post) and freshness/exploration boosts are pure arithmetic
   over pgvector cosines and Postgres counters. Directly counters the marketplace failure modes:
   wall-of-near-identical listings and new-listing cold-start (the "billion-dollar blind spot").
6. **Must-match attributes are filters, never similarity.** Batch (gender-misalignment) and
   SidelineSwap (size) case studies: exact-match attributes must be hard filters/deterministic
   penalties on top of embedding candidates. DeepMind's sign-rank paper gives the theory: a
   single dense vector cannot represent conjunctive constraints — hybrid + structured filters is
   structurally necessary, not polish. Samesake already does this (NLQ → hard SQL filters);
   protect it in every new leg (the multi-aspect RFC's REQ-9 is the right instinct).
7. **Eval additions that cost nothing:** zero-result rate / Hit-Ratio@K per query segment
   (head/tail/type), per-run metadata stamping, and a rank-correlation (Kendall-tau) secondary
   gate to catch reorderings a mean-grade threshold misses. Attribute-perturbation hard
   negatives (from the CIR literature): flip one attribute of a gold item's enrichment, find
   real catalog items matching the flipped description, assert gold outranks them — measures
   exactly the attribute-blindness failure mode.
8. **Session/refinement queries are a prompt-context change.** Walmart SIGIR'24: prior-query
   context helps only on broad→narrow transitions (+2.5pt F1) and hurts on narrow→broad — gate
   injection on token/semantic overlap with the previous query. The CIR paper's inference-time
   pattern (fetch anchor item's enriched attributes, LLM-rewrite "like this but in blue" into a
   self-contained query) turns composed/refinement search into plain retrieval — no training.

## Cautions and negative results worth keeping

- **RRF over score-blending is load-bearing:** Netflix/Cornell (WWW'24) shows raw cosine
  magnitudes from opaque training objectives can be arbitrary; rank fusion hedges this. Keep
  RRF; per-query weighted-score formulas (NYMag case study) are an option only within one
  signal family.
- **Flat weights fail at every level.** NYMag ablation: equal per-field weights measurably worse
  than differentiated ones — the V02g spaces failure was an instance of a general law. Calibrate
  defaults before any gate run.
- **Free-form MLLM prose as indexed evidence adds noise** (CIR paper §5.1): keep evidence/facet
  text schema-constrained and short; enum-constrain and canonicalize extraction output; use an
  uncertainty escape hatch ("material unclear") instead of guessing.
- **Personalization/behavioral techniques are out of scope by data, not by taste:** most
  marketplace "growth lever" content (Temu, Amazon A10, maturity-curve L2–L5) assumes
  click/purchase infrastructure that doesn't exist at any installation. The roadmap already
  rejects this; nothing found argues otherwise. The exceptions that need no history: within-
  session query sequence, geo boosts, freshness.
- **pg_textsearch reality check (BM25 RFC):** PG 17–18 only; Timescale/Tiger Cloud only among
  managed providers; two open data-corruption issues (#426/#427) on the v1.3.1 write path as of
  2026-07-18. The A/B fixture is unaffected; production default-flip is gated hard.
- **Embedding-version drift is an unscoped operational risk:** upgrading the embedding model
  invalidates every stored vector (queries embed in the new space, docs in the old). Needs a
  documented re-embed/migration path before it happens by accident (Netflix realigns spaces
  with an orthogonal transform; for samesake a versioned re-embed pipeline is enough).

## Controlled-vocabulary (enum) design — census, principle, precedent (added 2026-07-19)

**Census (fashion template):** 12 vocabularies, ~141 values — categories 15, colors 25,
materials 19, neckline 14, pattern 13, styles 13, occasions 10, length 10, fit 8,
sleeve_length 7, gender 4, modesty 3. Eight are filterable collection fields today
(category, gender, colors, occasions, styles, pattern, material, fit); neckline/length/
sleeve_length/modesty are enrichment-only — natural filter-field candidates since golden
queries already use their values verbatim ("off shoulder maxi dress").

**Principle:** an attribute earns enum status when it is must-match or facet-critical —
enums are what make filters hard, facets unfragmented, enrichment measurable (the 97.8% F1
gold set requires a closed vocabulary), and deterministic query-side matching possible
(grounded-QU REQ-8). Language-like open vocabularies (brand, product_type) stay text and get
*grounding* (matched against live catalog values), never a frozen list. Over-enuming is a
real failure mode (enrichment burden, taxonomy maintenance, facet sprawl); expected mature
size ≈ 15 vocabularies / ~200 values, not thousands.

**Industry precedent — the most universal pattern in the whole survey:** every production
LLM-QU system constrains output to a controlled vocabulary (survey synthesis #4). DoorDash
tags queries into a fixed taxonomy and measured the constraint as +8.3pp of a +13pp gain,
with free-text mapped INTO controlled terms ("no-milk"→"dairy-free" — our `alsoMatch`
shape); Instacart forces the LLM to choose among retrieved candidate categories; Walmart's
relevance models consume structured attribute slots ([SEP] brand [SEP] color [SEP] gender);
Google Merchant made color/pattern/material + item_group_id the canonical feed contract;
Algolia/Typesense/Meilisearch presume declared filterable attributes, and the case studies'
measurable wins (SidelineSwap size, Batch gender) came from moving must-match attributes OUT
of embeddings into deterministic handling. Samesake's differentiation is the fill side: the
enrichment pipeline populates these vocabularies from messy vendor data at measured accuracy
— the part incumbents make merchants do by hand. The deterministic matcher closes the loop:
the same ~140 words recognized on both sides of the search box.

**Multilingual extension (follow-up):** the deterministic matcher is Unicode-correct (NFKC,
whole-token; Sinhala/Tamil are space-separated) but the vocabulary is English — non-English
queries are covered by the LLM layer (schema-constrained to English enum output). The
sanctioned zero-LLM extension is `alsoMatch` synonym packs per value (red → ["රතු",
"சிவப்பு"]): tiny closed lists, authored once into the fashion template, LLM-generated +
human-reviewed, asserted by extended `ml-*` goldens. Highest value exactly where it matters
most: non-English queries skew tail → cold/degraded parses → the deterministic guard's
coverage window.

## Enthusiast (upsidelab) — competitive read

Their retrieval is dense-only with a hard FTS gate (`ts_rank > 0.05` then pure cosine order),
no fusion, no structured filters, no reranker — samesake is ahead on every retrieval axis.
Worth borrowing: (1) their use-case-first docs pattern (agent name → one-line outcome → 3
persona scenarios → install snippet immediately below); (2) per-dataset embedding config
(model/dim pinned per store/brand); (3) confirmation-mode UX before enrichment writes.

## Embedding-model + engine-ranking landscape (added same day, verified against official docs)

- **gemini-embedding-2 is already the unified "omni" model** — per current Google docs it is
  the multimodal embedding model (text/image/video/audio/PDF, one aligned space, 3072d MRL down
  to 128; caps: 8,192 tokens shared across modalities, ≤6 images/request). The fashion config
  already uses it for both the text `doc` embedding and the `visual` image space. The
  cross-modal capability is owned; the constraint is the input cap, not the model.
- **API alternatives with one aligned text↔image space:** Cohere Embed v4 (1536d MRL, 128K
  context, mixed interleaved inputs — strongest drop-in alternative), Voyage multimodal-3.5
  (1024d, 32K, video), Jina v4 (2048d MRL + ColBERT-style multi-vector; open weights are
  non-commercial), Amazon Nova Multimodal (3072d MRL, audio/video, Bedrock). OpenAI has no
  image embedding at all. Self-host: SigLIP 2 (best open dual-encoder), Nomic vision tower
  aligned into its text space, BGE-VL.
- **Cloudflare Workers AI has zero multimodal embedding models** — 7 text-only models (notably
  bge-m3 1024d multilingual/60K ctx and qwen3-embedding-0.6b 1024d, both $0.012/M tokens; both
  fine as cheap BYO text-leg providers). **AI Gateway** natively proxies Google AI Studio /
  Vertex / Cohere / OpenAI / Bedrock with BYOK + caching + analytics + fallback — our existing
  gemini-embedding-2 calls could route through it unchanged.
- **Cloudflare AI Search (ex-AutoRAG)** = managed text-RAG pipeline (source → markdown
  conversion → chunk → embed into Vectorize → optional query rewrite → hybrid retrieve →
  bge-reranker → generate, plus MCP endpoint). Images are captioned to markdown then
  text-embedded — no visual vectors; ingestion is files/websites/R2 (≤4 MB), not catalog rows;
  embeddings cap at 1536d. Its moat is ops convenience, not retrieval quality — the analogy
  slot for samesake is "this, but for the catalog already sitting in your Postgres."
- **No product-search-native engine uses BM25.** Algolia: explicit "no variation of TF-IDF" —
  8-criteria tie-breaking sort (Typo→Geo→Words→Filters→Proximity→Attribute→Exact→Custom),
  reasoning that product records are short/structured and TF is meaningless in titles.
  Typesense: heuristic `_text_match` (token overlap, edit distance, proximity, field weights) —
  no IDF, no length norm; hybrid fuses by weighted reciprocal rank. Meilisearch: ordered
  ranking rules as bucket sort (words, typo, proximity, attribute, sort, exactness); hybrid via
  `semanticRatio` weighting. Only Lucene-lineage engines (Elasticsearch/OpenSearch) default to
  BM25 — and their e-commerce guidance immediately layers function_score business boosts on it
  and fuses hybrid via native RRF. Implication for the BM25 RFC: BM25 is a checkbox adopters
  ask for, not what the product-search incumbents actually run; samesake's AND-first two-tier +
  setweight(A/B) + RRF is philosophically the Algolia/Meilisearch design, and the right
  investment is proving that with the lexical A/B fixture rather than fighting an immature
  extension.

## arXiv 2606.19684 (fashion CIR) — skeptical read

Workshop-grade; its measured contribution is contrastive fine-tuning (out of scope) and its own
conclusion admits recall below baseline. What transfers is the prompt layer: structured
attribute captioning (color/pattern/texture/style/distinctive-elements schema), reference-
grounded rewrite of relative queries, attribute-perturbation negative generation (for eval, not
training). Stronger citations for the same ideas: Pic2Word (CVPR'23), SPRC (2023), CoVR-2
(TPAMI'24).
