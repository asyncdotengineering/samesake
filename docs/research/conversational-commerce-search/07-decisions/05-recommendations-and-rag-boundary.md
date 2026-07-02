# Decision 05 — Recommendations & RAG Boundary

## TL;DR
> **Stay retrieval-pure.** Ship exactly **one** native recommendation surface — **item-to-item
> "more-like-this"** — which is free in pgvector, content-based, cold-start-native, and
> auditable. Do **not** build behavioral CF / sequential / graph recommenders (they need an
> interaction log samesake doesn't own and infra that breaks the two-container promise). Do
> **not** add a generation layer. Integrate everything else downstream.
> **Flip condition:** build a behavioral surface only if a tenant brings its own interaction log
> *and* explicitly wants samesake to own ranking over it.

---

> **CORRECTED (completeness pass).** This doc's framing of "samesake lacks personalization"
> below is **too absolute** — it is true only of *behavioral* (clickstream-trained)
> personalization. **Content/context-vector personalization needs no interaction log** and is a
> pgvector vector-add (taste vector = weighted mean of liked-item embeddings, fused into the
> query; this is Rocchio 1971 / Marqo context vectors). It is natively in reach, constraint-safe,
> and auditable. See **Decision 07 → D20** and `10-gaps/personalization-without-behavior-and-session-state.md`.
> The verdict below (stay retrieval-pure on *behavioral* recsys; ship item-to-item) still holds —
> but item-to-item should be generalized to **taste-vector personalization with negative examples
> + visual-onboarding cold-start + externalized multi-turn state**, none of which need a log.

## 1. Recommendation vs retrieval — the data-ownership fault line

Retrieval answers "does this product *match what was asked*?" from **content**. Recommendation
answers "will *this user* like this *next*?" from **behavior** (clicks/carts/purchases). The
behavioral interaction graph is the entire product of a recommender — and it belongs to the
**store**, accrues over time, and an early samesake adopter won't have it. A recommendation
surface would be empty/popularity-only at the moment of adoption. (`09-recommendations/*`)

**samesake's structural edge is the cold-start cliff that breaks behavioral recsys.** Matrix
factorization is *catastrophic* on a new SKU (no interactions → no factor → invisible); *every*
serious cold-start fix (DropoutNet, CLCRec, TIGER's Semantic IDs) injects **content** to
substitute for missing behavior. samesake is **content-native from day one** — a new SKU is
retrievable on insert because its vector comes from its image/text. This is exactly Marqo's own
(correct) argument against behavioral-only ranking — samesake gets it for free, without the
per-tenant-model lock-in.

## 2. Where retrieval and recommendation converge (the one thing to build)

They converge at three places — **embeddings, the two-tower shape, and candidate-gen-then-rank**:

- **samesake IS a two-tower retriever minus the behavioral training** (query tower =
  NLQ/text/image embedding; item tower = content embedding; scoring = cosine ANN). That makes
  it a **content-based / cold-start recommender by construction.** It should NOT try to become a
  *behavioral* two-tower (lacks the data; the two-container posture rules out the training infra).
- **"More-like-this" is `ANN(item_embedding)` with the seed excluded** — shippable *today* with
  the index samesake already has, cold-starting perfectly. The vector-DB pattern (Qdrant
  positive/negative examples; Weaviate Ref2Vec "centroid of liked items → ANN") is **directly
  implementable in pgvector with zero new infrastructure**: average the embeddings of N seed
  items, run the existing cosine ANN, gate with existing hard/soft SQL filters, fuse via RRF.
- It inherits `/search/explain` auditability for free — a differentiator no hosted recommender
  offers — and it's exactly what fashion values ("similar styles," "complete the look" as a
  vector neighborhood). (`09-recommendations/recommendation-oss-and-commercial.md`)

**Boundary discipline:** ship *only* item-to-item similarity. Do **not** ingest interaction
events, build a user model, or add CF/sequential/graph. The moment samesake stores click/cart
logs, it inherits the data-pipeline + infra burden it was designed to avoid.

## 3. What NOT to build, and what to integrate instead

- **Don't build:** behavioral CF (MF/ALS), sequential (SASRec/BERT4Rec), graph (LightGCN),
  ranking stacks (DLRM). They need interaction logs samesake doesn't own; OSS options break the
  contract (Gorse needs Redis+DB; Merlin needs GPU+Triton; RecBole is "academic-only" despite an
  MIT header). The honest gaps samesake *cannot fake* are **behavioral personalization** and
  **session-trajectory intent** — name them, don't paper over them.
- **Integrate downstream:** position samesake as the **grounded candidate generator** that feeds
  a recommender. Its hard-filtered, deduped, verified candidate set is a *cleaner input* than a
  raw catalog dump. Best deployment-affinity targets: **AWS Personalize** (runs in the customer's
  own cloud account) and **Recombee** (simple REST, SMB). Hosted-SaaS recommenders (Algolia
  Recommend $0.60/1k, Constructor, Bloomreach) integrate via the merchant app's event stream,
  not samesake. Document the reference pattern: *"samesake retrieves and grounds; your
  recommender personalizes."*
- **LLM reranker is the most adoptable recsys idea** (Hou et al., ECIR 2024: LLMs as zero-shot
  rankers "challenge conventional models when candidates are retrieved by multiple candidate
  generators") — and it assumes *someone else does candidate generation*, which is samesake's
  job. This is the same cross-encoder/LLM reranker lever from Decision 02, not a separate build.

## 4. RAG — don't add generation; harden the contract

The product-RAG and ecommerce-RAG dossiers converge: **RAG = retriever + generator, and the
hard, defensible, valuable half is retrieval** (heterogeneous structured+unstructured retrieval,
hard-filter gating, hybrid fusion, dedup, provenance). The dominant RAG failure mode is
*retrieval*, not generation (RAGAS/RGB; Amazon's production work). samesake is a best-in-class
implementation of the retrieval half; the generation half is a thin, swappable, BYO-LLM
prompt-assembly layer a consumer bolts on. Amazon's "Cite Before You Speak" (+13.83% grounding)
needs exactly the attributable evidence objects (`product` + `why` + `verification`) samesake
already returns. (`08-rag/rag-for-products.md`, `08-rag/ecommerce-rag-systems.md`)

**Decision:** the value-add is **a richer handoff contract, not a model** — see Decision 04 §4
(grounding payload, calibrated scores, freshness re-verify, single MCP tool). This is
"differentiate + integrate," not "expand into generation."

Generative *retrieval/recsys* (DSI, TIGER) is the architectural antithesis (index-in-model: no
SQL predicates, no `/search/explain`, expensive re-indexing on catalog change). For a mutable
fashion catalog with price/availability filters, Postgres+ANN is the right call — cite DSI/TIGER
to *explain why samesake did not go generative*, and note their cold-start benefit is something
content-embedding ANN already gets without the re-quantization burden.

## Flip conditions
- Build a **behavioral recommendation** surface only if a tenant brings its own interaction log
  *and* wants samesake to own ranking over it (and accepts the infra implications).
- Add **session-trajectory intent** only with an interaction stream and a clear eval win.

## Sources
`09-recommendations/recommendation-methods.md`, `09-recommendations/recommendation-oss-and-commercial.md`,
`08-rag/rag-for-products.md`, `08-rag/rag-in-fashion.md`, `08-rag/ecommerce-rag-systems.md`.
