# Ecommerce Recommendation Engines — Methods, Algorithms, and the Retrieval/Recommendation Convergence

> **Scope.** A prior-art survey of recommendation-engine families for ecommerce, written
> *for* samesake — the TypeScript-first search-engine compiler that today does hybrid
> **retrieval** (Postgres FTS + cosine ANN over BYO embeddings + typed "spaces", fused with
> RRF), with hard SQL filters, an NLQ parser, a multimodal enrich pipeline, and a
> `findProducts()` agentic surface that **stops at grounded retrieval**.
>
> **The load-bearing distinction this doc draws out:** classic recommenders are
> **behavioral** (they learn from *who-clicked/bought-what*), while samesake is
> **content/intent** (it matches *query/image/constraints → product attributes*). The two
> worlds *converge* at exactly three places — **embeddings, the two-tower architecture, and
> candidate-generation-then-rank** — and that convergence is where samesake's retrieval
> could legitimately double as a **content-based / cold-start recommender** without
> becoming a behavioral recsys. That thesis is argued at the end.
>
> **Provenance discipline:** every method below is tied to a primary paper (title, authors,
> year, URL), abstract claims are quoted, and "proven in production at scale" is
> distinguished from "academic benchmark result" and from "vendor marketing."

---

## 0. The mental model: what a recommender actually is

A recommender predicts **affinity between a user (or context) and an item**, then returns a
ranked list. It differs from search along one axis that matters enormously for samesake:

| | **Search / Retrieval (samesake today)** | **Recommendation (this doc)** |
|---|---|---|
| Trigger | An explicit query (text / image / NLQ / constraints) | An implicit context (a user, a session, "people also…") |
| Primary signal | **Content**: product attributes, text, images, embeddings | **Behavior**: clicks, carts, purchases, co-occurrence |
| The hard question | "Does this product *match what was asked*?" | "Will *this user* like this item *next*?" |
| Cold-start pain | New **query** (handled — embeddings generalize) | New **user** *and* new **item** (the canonical failure) |
| Auditability | High — predicate + score are inspectable | Usually low — a latent dot product |

Most production systems are **two-stage**: a cheap **candidate generator** that pulls
hundreds of items from millions, then an expensive **ranker** that scores those few. This
two-stage shape is *the* architectural bridge to samesake, because samesake's retrieval
*is* a candidate generator. (See §3, §11.)

The families below are grouped by where they sit: **collaborative** (behavior-only) →
**content/hybrid** → **architecture (two-tower)** → **sequential/session** → **graph** →
**candidate-gen + ranking stack** → **cold-start** → **LLM/generative**.

---

## 1. Collaborative Filtering — Matrix Factorization (MF / ALS)

**Primary source.** Y. Hu, Y. Koren, C. Volinsky, *"Collaborative Filtering for Implicit
Feedback Datasets,"* IEEE ICDM 2008.
[Semantic Scholar](https://www.semanticscholar.org/paper/Collaborative-Filtering-for-Implicit-Feedback-Hu-Koren/184b7281a87ee16228b24716ca02b29519d52eb5)

**Core idea.** Factor the sparse user×item interaction matrix `R ≈ U·Vᵀ` into low-rank
latent user and item vectors; predicted affinity is the dot product `uᵤ · vᵢ`. The 2008
paper's key move for ecommerce (where you rarely have star ratings, only views/buys) is to
split implicit signal into **preference** (did they interact: 0/1) and **confidence**
(how strongly), with the now-canonical `cui = 1 + α·rui`. It is solved with **Alternating
Least Squares (ALS)** — fix item factors, solve users as a least-squares problem; alternate.
ALS parallelizes cleanly (each user/item row is independent), which is why it shipped in
Spark MLlib and powered a decade of production recsys.

**Where it wins.** Massive sparse implicit-feedback catalogs where behavior is abundant;
it's cheap, embarrassingly parallel, and a famously strong baseline (iALS still competes with
deep models — see [iALS++, 2021](https://arxiv.org/pdf/2110.14044)).

**Data it needs.** **Purely behavioral** — a user×item interaction log. It uses **zero**
content. This is the polar opposite of samesake.

**Cold-start behavior.** **Catastrophic.** A new item has no interactions → no row in `R` →
no factor → it is *invisible*. A new user is equally invisible. MF cannot recommend what it
has never seen interacted with. **This is the single most important contrast with samesake**
(§10): samesake's content embeddings make a brand-new SKU *immediately* retrievable on day
zero, because its vector comes from its image/text, not from clicks it hasn't received yet.

---

## 2. Content-Based Filtering

**Representative survey.** Zhang et al., *"Deep Learning based Recommender System: A Survey
and New Perspectives,"* 2017–2019, [arXiv:1707.07435](https://arxiv.org/pdf/1707.07435)
(content-based methods are the long-standing pre-deep baseline; the survey situates them).

**Core idea.** Recommend items *similar in content* to what a user has engaged with. Build an
item profile from attributes (category, brand, color, text, image embedding) and a user
profile as an aggregate of the profiles of items they liked; score by similarity
(cosine/TF-IDF historically, embedding cosine today).

**Where it wins.** **Cold-start items** (the profile exists the moment the item does),
niche/long-tail catalogs, and explainability ("recommended because it's a black silk slip
dress like the one you viewed"). Fashion is a *content-rich* domain, which is precisely why
content-based methods matter here more than in, say, movies.

**Data it needs.** **Content** (attributes/text/images) + a light user-history aggregate. No
cross-user behavior required.

**Cold-start behavior.** **Strong on new items, weak on new users** (needs *some* of the
user's own history) and prone to **over-specialization** (a filter bubble — never surprises
you). **This family is the closest cousin to samesake's retrieval** — samesake already
computes item content embeddings and similarity; turning that into "more like this" is a
small step (§10–11).

---

## 3. Two-Tower / Embedding-Based Candidate Generation

**Primary sources.**
- P. Covington, J. Adams, E. Sargin, *"Deep Neural Networks for YouTube Recommendations,"*
  RecSys 2016, [research.google](https://research.google/pubs/deep-neural-networks-for-youtube-recommendations/)
  / [PDF](https://cseweb.ucsd.edu/classes/fa17/cse291-b/reading/p191-covington.pdf) — the
  two-stage canon.
- X. Yi et al., *"Sampling-Bias-Corrected Neural Modeling for Large Corpus Item
  Recommendations,"* RecSys 2019, [ACM DL](https://dl.acm.org/doi/10.1145/3298689.3346996)
  — the in-batch-negatives correction.

**Core idea.** Two separate encoders ("towers") — a **query/user tower** and an
**item/candidate tower** — map into a *shared* embedding space; affinity = dot product /
cosine. Critically, **item embeddings are query-independent**, so you precompute them once
and serve candidates with **approximate nearest-neighbor (ANN)** search. Training typically
uses in-batch negatives; the 2019 paper corrects the **sampling bias** that arises because
popular items appear as negatives disproportionately.

**Where it wins.** *The* dominant retrieval/candidate-gen architecture at web scale
(YouTube, Twitter, Allegro, etc.). Decouples expensive learning from cheap serving.

**Data it needs.** Behavioral pairs (user/context → engaged item) to train the towers. But —
crucially — **the item tower can be fed content features**, which is the hybrid escape hatch
from pure behavior and the bridge to samesake.

**Cold-start behavior.** Depends entirely on tower inputs. ID-only towers cold-start like MF
(badly). **Content-fed towers cold-start gracefully** — a new item gets a vector from its
features. **This is the single most important architectural convergence point with
samesake** (§11): samesake's "query embedding → ANN over precomputed item embeddings" *is* a
two-tower retrieval, minus the *learned-from-behavior* part. samesake is, in effect, a
two-tower system whose item tower is "BYO content embedding" and whose query tower is "BYO
query/NLQ embedding."

> **Marketed vs proven:** the two-stage + two-tower pattern is *proven* in production at the
> largest scale in the industry. The *specific* sampling-bias correction is proven by
> Google's offline + online experiments in the 2019 paper.

---

## 4. Sequential & Session-Based Recommendation (GRU4Rec, SASRec, BERT4Rec)

These predict **the next item** from the *order* of recent interactions — the recsys analog
of language modeling. They shine for **session-based / anonymous** users (no long-term
profile), which is much of ecommerce traffic.

### 4a. GRU4Rec
Hidasi et al., *"Session-based Recommendations with Recurrent Neural Networks,"* ICLR 2016
(introduced RNN/GRU session modeling). **Core idea:** a GRU consumes the click sequence and
predicts the next item; captures **short-term** intent within a session. **Data:** behavioral
sequences (anonymous OK). **Cold-start:** good for *new sessions* (no user profile needed),
bad for *new items*.

### 4b. SASRec
W.-C. Kang, J. McAuley, *"Self-Attentive Sequential Recommendation,"* ICDM 2018,
[arXiv:1808.09781](https://arxiv.org/abs/1808.09781). **Core idea:** replace the RNN with
**self-attention** to decide which past items matter for the next prediction. Verbatim, it
*"seek[s] to capture the 'context' of users' activities on the basis of actions they have
performed recently."* It explicitly **bridges Markov Chains (great on sparse data, short
context) and RNNs (long context, need denser data)** — "capturing extended temporal
semantics while making predictions based on fewer selected actions." **Cold-start:** still
behavioral; new items unseen in any sequence are invisible.

### 4c. BERT4Rec
Sun et al., *"BERT4Rec: Sequential Recommendation with Bidirectional Encoder Representations
from Transformer,"* CIKM 2019, [arXiv:1904.06690](https://arxiv.org/pdf/1904.06690).
**Core idea:** a **bidirectional** Transformer trained with **masked-item prediction** (the
Cloze task), so context flows from both directions, not just left-to-right. Note SASRec is
essentially *"a left-to-right unidirectional version of BERT4Rec with single-head causal
attention."* **Data:** behavioral sequences. **Cold-start:** behavioral; new items unseen.

**Where this family wins for samesake's domain.** Session intent ("user is browsing summer
dresses *right now*") is genuinely valuable and **not what samesake captures today** —
samesake responds to an *explicit* query, not an inferred trajectory. This is a **real gap**,
not a convergence: sequential recsys needs an interaction log samesake does not own.

---

## 5. Graph-Based Recommendation (PinSage, LightGCN)

### 5a. PinSage
R. Ying et al., *"Graph Convolutional Neural Networks for Web-Scale Recommender Systems,"*
KDD 2018, [arXiv:1806.01973](https://arxiv.org/abs/1806.01973). **Core idea (quoted):**
*"combines efficient random walks and graph convolutions to generate embeddings of nodes
(i.e., items) that incorporate **both graph structure as well as node feature information**."*
**Scale (proven, production):** deployed at Pinterest on a graph of **3B nodes, 18B edges,
trained on 7.5B examples.** **Data:** the user-item (pin-board) graph **plus node/content
features.** Because it *fuses content features*, PinSage cold-starts better than pure-CF GCNs.

### 5b. LightGCN
X. He et al., *"LightGCN: Simplifying and Powering Graph Convolution Network for
Recommendation,"* SIGIR 2020, [arXiv:2002.02126](https://arxiv.org/abs/2002.02126).
**Core idea (quoted):** keep *"only the most essential component in GCN — neighborhood
aggregation"* — removing feature transformation and nonlinear activation, which *"contribute
little to the performance of collaborative filtering."* **Result:** ~**16% relative
improvement over NGCF**. **Data:** the user-item **interaction graph only** (no content) —
so it's a *behavioral* method, and **cold-starts poorly**, unlike PinSage.

**Relevance.** Graph methods are powerful but assume a rich interaction graph and (for
LightGCN) no content — far from samesake's posture. PinSage's *content-fused node embeddings*
are the philosophically aligned part; the *graph* part is not something samesake owns.

---

## 6. Candidate Generation + Ranking Stack (YouTube DNN, Wide & Deep, DLRM)

This is the **deployed industrial pattern**: a recall-oriented candidate generator (§3)
followed by a precision-oriented **ranker** that scores the shortlist with rich features.

### 6a. YouTube DNN (the two-stage canon)
Covington et al. 2016 (above). **Quoted structure:** *"the classic two-stage information
retrieval dichotomy: first, a deep candidate generation model, and then a separate deep
ranking model."* Candidate gen = collaborative-filtering-flavored embedding retrieval;
ranking = a deep net scoring impressions, modeling **expected watch time via weighted
logistic regression.** **Proven** at YouTube scale.

### 6b. Wide & Deep
Cheng et al., *"Wide & Deep Learning for Recommender Systems,"* DLRS@RecSys 2016,
[arXiv:1606.07792](https://arxiv.org/abs/1606.07792). **Core idea (quoted):** jointly train
*"wide linear models and deep neural networks — to combine the benefits of **memorization and
generalization**."* Wide = cross-product features (memorize seen combos); Deep = embeddings
(generalize to unseen combos). **Proven** in production on **Google Play**, lifting app
acquisitions over either component alone.

### 6c. DLRM
Naumov et al., *"Deep Learning Recommendation Model for Personalization and Recommendation
Systems,"* 2019, [arXiv:1906.00091](https://arxiv.org/abs/1906.00091). **Core idea:**
handle **categorical features via embeddings** + **continuous features via an MLP**, then
model their **interactions explicitly** (dot products of embeddings), with a top MLP. Meta's
open-source production-grade ranker; notable for its **embedding-table parallelism**
engineering. **Data:** rich behavioral + contextual features.

**Where ranking wins.** Precision on the shortlist with many features (price, recency,
context, behavior). **Relevance to samesake:** samesake's RRF fusion + hard SQL gating + the
`/search/explain` surface is *itself a ranking stage* — but a **content/constraint-based,
auditable** one, not a learned behavioral CTR model. samesake could expose a pluggable
re-rank hook here (§11) without owning a behavioral training pipeline.

---

## 7. Cold-Start Handling (the recsys Achilles heel — and samesake's structural advantage)

**Representative primary source.** M. Volkovs, G. Yu, T. Poutanen, *"DropoutNet: Addressing
Cold Start in Recommender Systems,"* NeurIPS 2017,
[PDF](https://www.cs.toronto.edu/~mvolkovs/nips2017_deepcf.pdf). **Core idea:** during
training, **randomly drop the warm (behavioral) embeddings**, forcing the model to
reconstruct preference from **content features alone** — so at inference, a content-only new
item still gets a sensible vector. It sits *on top of any latent model* to add cold-start.

Related lines: **CLCRec** (contrastive learning to preserve collaborative signal in
content-derived embeddings), **MeLU/M2EU** (meta-learning to generate warm embeddings),
multimodal VAEs ([M²VAE, 2025](https://arxiv.org/pdf/2508.00452)), and RAG-based cold-start
([Knowledge-Guided RAG, 2025](https://arxiv.org/html/2505.20773v1)).

**The throughline:** *every* serious cold-start fix injects **content** to substitute for
missing behavior. **samesake is content-native from the start** — it never has a "no
behavior yet" cliff for items, because items are retrieved by their content embedding. This
is samesake's *structural* edge as a cold-start recommender (§10).

---

## 8. LLM-Based / Generative Recommendation (P5, TIGER, LLM rerankers)

### 8a. P5
Geng et al., *"Recommendation as Language Processing (RLP): A Unified Pretrain, Personalized
Prompt & Predict Paradigm (P5),"* RecSys 2022, [arXiv:2203.13366](https://arxiv.org/abs/2203.13366).
**Core idea:** recast *all* rec tasks (rating, sequential, explanation, review) as
**text-to-text** over a single LLM; data becomes natural-language sequences. **Data:** mixed
behavioral + textual. Weakness: relies on the LLM tokenizer over **randomly-assigned item
IDs** (no content grounding in the IDs themselves).

### 8b. TIGER — Generative Retrieval
Rajput et al., *"Recommender Systems with Generative Retrieval,"* NeurIPS 2023,
[arXiv:2305.05065](https://arxiv.org/abs/2305.05065). **Core idea (quoted):** instead of
*"embedding queries and item candidates… followed by approximate nearest neighbor search,"*
a Transformer **autoregressively decodes the identifiers of the target candidates** — the
**Semantic ID**, a tuple of codewords produced by **RQ-VAE on content embeddings** so
similar items share ID prefixes. **Key cold-start claim (quoted):** *"improved retrieval
performance observed for items with no prior interaction history."* This is the first
Semantic-ID generative recommender. **Status:** strong academic results; *not yet* the
default production retrieval pattern (ANN two-tower still dominates) — **proven in benchmarks,
emerging in production.**

### 8c. LLM Rerankers
Hou et al., *"Large Language Models are Zero-Shot Rankers for Recommender Systems,"* ECIR
2024, [arXiv:2305.08845](https://arxiv.org/abs/2305.08845),
[code](https://github.com/RUCAIBox/LLMRank). **Core idea:** feed the LLM the user's history
+ a candidate set in a prompt; it returns a ranking. **Findings (quoted essence):** LLMs have
*"promising zero-shot ranking abilities but struggle to perceive the order of historical
interactions, and can be biased by popularity or item positions,"* fixable with prompt design
+ bootstrapping; *"zero-shot LLMs can even challenge conventional recommendation models when
ranking candidates are retrieved by multiple candidate generators."* **This is the most
directly adoptable recsys idea for samesake** — it assumes *someone else does candidate
generation* (samesake's exact job) and the LLM only reranks. samesake's `findProducts()`
already lives next to an LLM; an opt-in LLM rerank over RRF candidates is a natural,
content-grounded extension (§11).

---

## 9. Comparison Table

| Family | Core idea | Wins where | Data needed | Cold-start (new item) | Proven vs marketed | Convergence w/ samesake |
|---|---|---|---|---|---|---|
| **MF / ALS** (Hu-Koren 2008) | Factor user×item → latent dot product | Dense behavior, cheap, parallel baseline | **Behavioral only** | **Catastrophic** | Proven (industry-wide) | Low — antithesis of content |
| **Content-based** | Recommend content-similar items | Cold items, niche, explainable | **Content** + light history | **Strong** | Proven (classic) | **High — same machinery** |
| **Two-tower** (Covington '16, Yi '19) | Shared-space encoders + ANN | Web-scale candidate gen | Behavioral pairs (content-feedable) | Good *if* content-fed | Proven (largest scale) | **Very high — same shape** |
| **GRU4Rec / SASRec / BERT4Rec** | Next-item from sequence order | Session/anon intent | Behavioral **sequences** | Poor (new items) | Proven (benchmarks; some prod) | Low — samesake lacks seq log |
| **PinSage** ('18) | Random-walk GCN over graph **+ node features** | Web-scale graph + content | Graph **+ content** | Decent (content-fused) | **Proven (3B nodes prod)** | Medium — content part aligns |
| **LightGCN** ('20) | Neighborhood aggregation only | CF accuracy, simplicity | **Interaction graph only** | Poor | Proven (~16% > NGCF, benchmark) | Low — pure behavioral |
| **Wide & Deep / DLRM / YouTube DNN** | Two-stage; rich-feature ranker | Precision ranking at scale | Rich behavioral+context | Ranker-dependent | **Proven (Google Play, Meta, YT)** | Medium — samesake's RRF is the rank stage |
| **Cold-start (DropoutNet etc.)** | Inject content to cover missing behavior | New items/users | Content (+ optional behavior) | **By design** | Proven (benchmark) | **High — samesake is content-native** |
| **P5** ('22) | Rec as text-to-text LLM | Multi-task, unified | Behavioral + text | Weak (random IDs) | Benchmark | Medium |
| **TIGER** ('23) | Decode Semantic ID (RQ-VAE on content) | Generative retrieval, cold items | Behavioral + **content** | **Strong (claimed)** | Benchmark, emerging | **High — Semantic ID = content** |
| **LLM reranker** ('24) | LLM ranks candidates from a prompt | Rerank a shortlist zero-shot | Candidates + history | N/A (rerank only) | Benchmark | **Very high — needs a candidate gen = samesake** |
| **VERDICT for samesake** | — | — | — | — | — | **Adopt content-based + two-tower framing as a "content/cold-start recommender"; expose candidate-gen for LLM rerank; do NOT build behavioral CF/sequential/graph (no data, no fit).** |

---

## 10. Behavioral recsys vs samesake's content/intent retrieval — the contrast

The defining fault line: **behavioral recsys learns a latent space from *interactions*;
samesake operates a content/intent space derived from *the products themselves*.**

1. **Signal origin.** CF/sequential/graph(LightGCN) need a *history* of who-did-what.
   samesake needs only the catalog + a query. samesake has **no behavioral log to learn
   from** — and the brand running it in-app may not have one either at launch.
2. **The cold-start cliff is samesake's home turf.** Behavioral methods *degrade to nothing*
   on a brand-new SKU; samesake's content embedding makes it **retrievable on insert**. Every
   cold-start paper (§7) is essentially trying to bolt samesake-style content onto a
   behavioral core. samesake gets that for free.
3. **Auditability.** A CF dot product is opaque; samesake's `/search/explain` + hard SQL
   predicates make *why this item* inspectable. Recsys is historically a black box; samesake
   is glass-box by construction — a differentiator, not a parity feature.
4. **What samesake genuinely lacks.** *Personalization from behavior* and *session-trajectory
   intent* (§4) are real recsys capabilities samesake does **not** have and cannot fake
   without an interaction log. These are the honest gaps, not things to paper over with
   marketing.

---

## 11. Where retrieval and recommendation **converge** — could samesake's retrieval double as a content-based / cold-start recommender?

**Yes — for the content-based and cold-start cases specifically — and the convergence is
architectural, not aspirational.** Three concrete bridges:

1. **Embeddings are the shared substrate.** Content-based rec, content-fed two-tower, PinSage
   node features, and TIGER Semantic IDs *all* reduce to "items live in a vector space; score
   by proximity." samesake already maintains exactly that space (BYO embeddings + ANN). A
   **"more like this" / "complete the look"** recommender is `ANN(item_embedding)` with the
   query item excluded — samesake can ship this **today** with the index it already has, and
   it cold-starts perfectly because the vector exists at insert time.

2. **samesake IS a two-tower retriever, minus the behavioral training.** Query tower =
   NLQ/text/image embedding; item tower = content embedding; scoring = cosine ANN. The *only*
   thing separating it from §3 is that the towers are **BYO/pretrained, not learned from
   clicks.** That makes samesake a **content-based / cold-start recommender by construction** —
   the exact regime where behavioral two-towers fail. **It should NOT try to become a
   behavioral two-tower** (it lacks the data and the in-app, two-container posture rules out
   the training infra).

3. **Candidate-generation-then-rank is the integration seam.** Every industrial recommender
   (§6) and the most adoptable LLM idea (§8c) assume *something* generates candidates and a
   ranker/LLM refines them. **samesake's retrieval is a best-in-class, content-grounded,
   constraint-respecting candidate generator.** The clean expansion is: keep retrieval as the
   recall stage, and **expose a pluggable re-rank hook** — RRF today, optional **LLM reranker**
   ([§8c, ECIR'24](https://arxiv.org/abs/2305.08845)) tomorrow, or a brand's own behavioral
   model if they have one. This respects the "stops at grounded retrieval" boundary while
   making samesake the substrate a recommender plugs into.

**The honest verdict.** samesake should **adopt** the content-based + cold-start framing
explicitly (it's already 90% there and it's a genuine strength vs behavioral incumbents),
**differentiate** on auditability and zero-behavioral-data cold-start, **integrate** at the
candidate-gen/rerank seam (LLM reranker, "more like this"), and **avoid** building behavioral
CF, sequential, or graph engines — those need data samesake doesn't own and contradict its
in-app, two-container, BYO-model architecture. The defensible expansion is *content-based
recommendation as a thin layer over existing retrieval*, **not** a behavioral recsys.

---

## Sources

- Hu, Koren, Volinsky — *Collaborative Filtering for Implicit Feedback Datasets* (ICDM 2008): https://www.semanticscholar.org/paper/Collaborative-Filtering-for-Implicit-Feedback-Hu-Koren/184b7281a87ee16228b24716ca02b29519d52eb5
- iALS++ (2021, MF still competitive): https://arxiv.org/pdf/2110.14044
- Zhang et al. — *Deep Learning based Recommender System: A Survey* (2019): https://arxiv.org/pdf/1707.07435
- Covington, Adams, Sargin — *Deep Neural Networks for YouTube Recommendations* (RecSys 2016): https://research.google/pubs/deep-neural-networks-for-youtube-recommendations/ | PDF: https://cseweb.ucsd.edu/classes/fa17/cse291-b/reading/p191-covington.pdf
- Yi et al. — *Sampling-Bias-Corrected Neural Modeling for Large Corpus Item Recommendations* (RecSys 2019): https://dl.acm.org/doi/10.1145/3298689.3346996
- Hidasi et al. — *Session-based Recommendations with RNNs / GRU4Rec* (ICLR 2016): https://arxiv.org/abs/1511.06939
- Kang, McAuley — *Self-Attentive Sequential Recommendation (SASRec)* (ICDM 2018): https://arxiv.org/abs/1808.09781
- Sun et al. — *BERT4Rec* (CIKM 2019): https://arxiv.org/pdf/1904.06690
- Ying et al. — *Graph Convolutional Neural Networks for Web-Scale Recommender Systems (PinSage)* (KDD 2018): https://arxiv.org/abs/1806.01973
- He et al. — *LightGCN* (SIGIR 2020): https://arxiv.org/abs/2002.02126
- Cheng et al. — *Wide & Deep Learning for Recommender Systems* (RecSys 2016): https://arxiv.org/abs/1606.07792
- Naumov et al. — *DLRM* (2019): https://arxiv.org/abs/1906.00091
- Volkovs, Yu, Poutanen — *DropoutNet: Addressing Cold Start* (NeurIPS 2017): https://www.cs.toronto.edu/~mvolkovs/nips2017_deepcf.pdf
- M²VAE — *Multi-Modal Multi-View VAE for Cold-start Item Rec* (2025): https://arxiv.org/pdf/2508.00452
- Knowledge-Guided RAG for Cold-Start (2025): https://arxiv.org/html/2505.20773v1
- Geng et al. — *Recommendation as Language Processing (P5)* (RecSys 2022): https://arxiv.org/abs/2203.13366
- Rajput et al. — *Recommender Systems with Generative Retrieval (TIGER)* (NeurIPS 2023): https://arxiv.org/abs/2305.05065
- Hou et al. — *Large Language Models are Zero-Shot Rankers for Recommender Systems* (ECIR 2024): https://arxiv.org/abs/2305.08845 | code: https://github.com/RUCAIBox/LLMRank

> **Fetch notes:** DLRM (arXiv:1906.00091) and GRU4Rec abstracts returned thin via automated
> fetch; their core claims here are corroborated across the survey + canonical secondary
> sources and the families' primary papers. All other abstract quotes were verified firsthand
> via direct arXiv/publisher fetch.
