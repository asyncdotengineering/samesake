# Personalization Without a Behavior Log, and Conversational Session State

> **Scope & purpose.** A completeness-pass deep-dive *for* samesake — the TypeScript-first
> "search-engine compiler" for visual commerce (fashion-first, Sri Lankan/LK corpus,
> Sinhala/Tamil/English code-mixed). samesake compiles a typed catalog into a **Postgres +
> pgvector** layer running *in the user's app* (two containers; no Redis, Elasticsearch, or
> hosted vector DB). Retrieval = **Postgres FTS + cosine ANN over BYO embeddings + optional
> typed "spaces", fused via RRF**; hard filters compile to SQL predicates that gate *before*
> ranking; soft filters relax. There is an NLQ parser (constrained schema), a multimodal
> enrich pipeline, entity-resolution/dedup, `/search/explain` auditability, and a
> `findProducts()` agentic surface that **stops at retrieval**.
>
> **This doc refines an over-absolute earlier claim** — that "samesake lacks
> personalization." That is true only of *behavioral* personalization (a clickstream-trained
> user model). It is **false** for a large, well-evidenced family of personalization that
> needs **no interaction log at all** and is expressible as **pgvector weighted-vector-add +
> SQL**. This doc proves which techniques fall in that family, quotes the load-bearing
> sources, and gives concrete samesake implementations.
>
> **Provenance discipline.** Every technique is tied to a primary source (paper title/year, or
> a vendor doc/blog with a URL). **PROVEN** (paper, benchmark, or product API doc) is
> distinguished from **MARKETED** (vendor blog framing). Where a fetch failed it is noted.

---

## 0. The reframing: three things "personalization" can mean

The word "personalization" silently bundles three very different mechanisms. Conflating them
is what produced the over-absolute "samesake lacks personalization" claim.

| Sense | Signal it needs | Storage it needs | Expressible in samesake today? |
|---|---|---|---|
| **A. Behavioral** (collaborative, clickstream-trained user/item factors) | A user×item **interaction log** | Event store + retrain pipeline | **No** — and intentionally so (auditability, no event infra) |
| **B. Content/embedding** (a *taste vector* from items the user *liked/viewed/bought*, fused into the query vector) | A short **set of item IDs** (or just images) | The catalog vectors *already in pgvector* | **Yes** — pgvector vector-add + SQL |
| **C. Session/conversational state** (constraints accumulated and relaxed across turns; "more like the 2nd one but cheaper") | The **current conversation** | An in-memory/typed **session object** per request chain | **Yes** — typed constraint state + NLQ + filter compiler |

The gap the first sweep missed is that **B and C require neither a behavioral log nor new
infrastructure**. They are *content-based* and *intent-based* personalization — exactly the
two worlds samesake already lives in. This doc is about B and C.

The crucial enabling fact, confirmed below (§5), is that **pgvector ships the exact algebra
these techniques need**: element-wise `+`, `-`, `*`, plus `avg(vector)` and `sum(vector)`
aggregates and the `<=>` cosine operator. So "fuse a taste vector into the query vector" is
not a research project — it is a few lines of SQL over data already in the table.

---

## 1. Context vectors — Marqo "Context Is All You Need" (Jesse Clark)

**Source (MARKETED framing + PROVEN API).** Marqo, *"Context Is All You Need: AI Powered
Ecommerce Search with Personalization"*
([marqo.ai blog](https://www.marqo.ai/blog/context-is-all-you-need-multimodal-vector-search-with-personalization));
API spec in Marqo Search reference
([docs.marqo.ai](https://docs.marqo.ai/latest/reference/api/search/search/)). Marqo was
founded 2022 by Tom Hamer and **Jesse Clark** (CTO, ex-lead ML scientist, Amazon Robotics).

**The thesis, verbatim from the blog:** Marqo "derives its understanding from the products
themselves: images, descriptions, attributes, and catalog relationships," such that "New
products work immediately" without "accumulated clicks." Personalization is framed as
*layered on top of* product-native intelligence — product-native systems "get stronger as
behavioral data flows in" — i.e. **behavior is an enhancement, not a prerequisite.** (The
blog is light on math; the implementation detail lives in the API docs below.)

**The mechanism (PROVEN, from the Search API reference).** Marqo's `context` parameter lets
a search supply **custom vectors** that are blended with the query vector:

> Tensors are in the form `"tensor": List[{"vector": List[floats], "weight": (float)}]`,
> allowing you to use custom vectors as context for your queries.

> When you provide context, the vectors from your query will be combined with the tensors you
> provide and tensors from existing documents in the index, which are combined into a single
> vector using interpolation.

> The `interpolationMethod` parameter … expected values are "slerp", "lerp", or "nlerp". If
> no value is specified, the interpolation method will be set to slerp if
> `normalizeEmbeddings=True` for the index, and lerp otherwise.

So a **per-weight interpolation** of `{query_vector} ∪ {liked_item_vectors}` becomes the
single ANN probe. The "user taste vector" is **not trained** — it is the (optionally weighted)
combination of the embeddings of items the user has signalled affinity for. That is the entire
trick, and it needs **zero interaction log** — just the *set of item IDs the user liked/viewed*.

- **slerp** (spherical linear interpolation) interpolates on the unit hypersphere — correct
  for **normalized** embeddings (preserves magnitude on the sphere; avoids the "averaging
  pulls toward the origin" pathology of naive lerp on normalized vectors).
- **lerp / nlerp** (linear / normalized-linear) is the cheap path for un-normalized indexes.

**Verdict for samesake: ADOPT (adapted).** This is the single most directly transferable
idea. samesake's BYO embeddings are typically normalized (cosine ANN), so the *correct*
fusion is slerp — but samesake runs in **Postgres**, where pgvector exposes `+`, `avg()`, and
`<=>` but **not** a built-in slerp. The pragmatic samesake form is **weighted lerp +
re-normalize** (≈ nlerp), which on normalized vectors approximates slerp well for small
interpolation weights. See §5 for the SQL.

---

## 2. Rocchio relevance feedback — the 1971 ancestor of all of this

**Primary source (PROVEN, foundational).** J. J. Rocchio, *"Relevance Feedback in
Information Retrieval"* (1971), in the SMART system (Salton). Canonical reference:
[Manning, Raghavan, Schütze, *Intro to Information Retrieval*, ch. 9](https://nlp.stanford.edu/IR-book/html/htmledition/the-rocchio-algorithm-for-relevance-feedback-1.html);
[Wikipedia: Rocchio algorithm](https://en.wikipedia.org/wiki/Rocchio_algorithm).

**The formula (the load-bearing object of this whole doc):**

```
q_m  =  α·q_0  +  β · (1/|D_r|) · Σ_{d∈D_r} d   −  γ · (1/|D_nr|) · Σ_{d∈D_nr} d
```

- `q_0` = original query vector; `q_m` = modified query vector.
- `D_r` = set of vectors of **relevant** (liked) docs; `D_nr` = set of **non-relevant**
  (disliked) docs.
- `α, β, γ` = weights. Standard guidance (IIR ch. 9): **positive feedback is more valuable**,
  so set `β > γ`; a common default is `α=1, β=0.75, γ=0.15`.

**Why this matters here:** Rocchio is *exactly* context-vector personalization, derived 50
years earlier. "Build a taste vector from liked items and push the query toward it (and away
from disliked items)" **is** Rocchio. Marqo's `context` (positive-only, weighted) is the
`α·q_0 + β·mean(liked)` half; Qdrant's recommendation API (§3) is the full `+β … −γ` form.
Crucially, Rocchio needs **no training and no interaction log** — it needs the *current set of
relevance judgments*, which can be in-session ("I like these 3 of the 10 shown") or a small
persisted set of liked SKUs. It is a **closed-form vector operation**, perfectly matched to
pgvector's `avg()`/`+`/`-`.

**Verdict for samesake: ADOPT as the canonical formalism.** Frame samesake's taste-vector
fusion *as Rocchio* in docs and `/search/explain` output — it gives an auditable, citable,
50-year-proven name to the operation, and the `α/β/γ` weights are exactly the knobs a fashion
merchandiser would want exposed (how hard to lean into liked items vs. the literal query).

---

## 3. Qdrant Recommendation API — positive/negative examples, no user model

**Source (PROVEN, product API).** Qdrant, *"Deliver Better Recommendations with Qdrant's new
API"* ([qdrant.tech/articles/new-recommendation-api](https://qdrant.tech/articles/new-recommendation-api/));
[Recommendation API docs](https://qdrant.tech/documentation/concepts/explore/).

Qdrant's recommend endpoint takes **example item IDs/vectors**, not a trained user — `positive`
(things you like) and `negative` (things you don't). Two strategies:

**`average_vector` (default).** Verbatim formula:

> `average vector = avg(positive vectors) + ( avg(positive vectors) − avg(negative vectors) )`

This "converts the problem of recommendations into a single vector search." Note this is
Rocchio with `α` folded in: it is `2·mean(pos) − mean(neg)` — an aggressive push toward
positives and away from negatives, then one ANN query. (It is a **single-probe** method:
cheap, one index hit.)

**`best_score` (newer, more flexible).** Verbatim algorithm:

> `let score = if best_positive_score > best_negative_score { sigmoid(best_positive_score) } else { -sigmoid(best_negative_score) };`

Here each candidate is scored against **every** example separately; the best positive and best
negative are taken, and a sigmoid normalizes. This is **not** a single averaged probe — it is a
re-scoring over candidates, so "the more likes and dislikes added, the more diverse the
results." A `sum_scores` strategy (sum positive minus negative scores) also exists
([PR #6256](https://github.com/qdrant/qdrant/pull/6256)).

**Key transferable insight:** `average_vector` is **expressible as a single pgvector probe**
(it is just vector arithmetic → one `<=>` query). `best_score` is **not** a single probe — it
is a **rerank** over a candidate set, which in samesake maps onto the **score-modifier /
optional cross-encoder rerank stage**, not the ANN probe. This cleanly tells samesake *which
personalization belongs at retrieval (averaged taste vector) vs. at rerank (per-example
scoring)*.

**Verdict: ADOPT `average_vector` at retrieval; DIFFERENTIATE on `best_score`** (route its
spirit to samesake's rerank/score-modifier stage rather than the probe). Also adopt the
**negative-examples** idea — "less like *that*" is a real fashion query and samesake's earlier
plan only mentioned "more-like-this," not "less-like-that."

---

## 4. Weaviate ref2vec — centroid of cross-references, updated in real time

**Source (MARKETED + PROVEN module).** Weaviate, *"What is Ref2Vec and why you need it for
your recommendation system"* ([weaviate.io/blog/ref2vec-centroid](https://weaviate.io/blog/ref2vec-centroid));
module: `ref2vec-centroid`.

**Verbatim:**

> The name Ref2Vec is short for reference-to-vector, and it offers the ability to vectorize a
> data object with its cross-references to other objects.

> The Ref2Vec module currently holds the name ref2vec-centroid because it uses the average, or
> centroid vector, of the cross-referenced vectors to represent the referencing object.

> The User vector is being updated in real-time here to take into account their preferences and
> actions, which helps to produce more relevant results at speed.

> A new user could have personalization available after a few interactions on the app … helping
> to overcome … the cold-start problem.

**What it actually is:** a User object whose vector = **centroid (mean) of the product
vectors it cross-references** (the products it interacted with). When the reference set
changes, the centroid is recomputed → "real-time" personalization. This is, again, **Rocchio
positive-only with `α=0, β=1`** — i.e. `mean(liked)` — just persisted as a derived object
property rather than computed per-query.

**The one caveat (PROVEN, from issue trackers):** ref2vec-centroid has had bugs where the
centroid is not recomputed on reference updates
([weaviate#3185](https://github.com/weaviate/weaviate/issues/3185)) — a reminder that the
*recompute-on-update* discipline is the hard part, not the math.

**Verdict: INTEGRATE the pattern, not the module.** samesake should treat "user taste vector"
as a **derived, cached centroid** of the user's liked-item vectors (recomputed when the liked
set changes), stored in a small `user_taste(user_id, vec vector)` table — *not* as a per-query
recompute every time, for repeat users. For anonymous/in-session users, compute on the fly
from the session's liked IDs. Either way it is `avg(vector)` over a `WHERE id = ANY(...)`.

---

## 5. The load-bearing claim: it all fits in pgvector + SQL, no new infra

**Source (PROVEN, extension docs).** pgvector
([github.com/pgvector/pgvector](https://github.com/pgvector/pgvector)). Confirmed operator
and aggregate set:

> pgvector provides … `+` for element-wise addition, `-` for element-wise subtraction, `*`
> for element-wise multiplication, … `<=>` for cosine distance.

> pgvector provides `avg(vector)` which returns the average vector, and `sum(vector)` which
> returns the sum vector.

This is the whole argument. **Context vectors, Rocchio, Qdrant `average_vector`, and ref2vec
centroids are all the same operation** — a weighted combination of catalog vectors fed to a
cosine ANN — and **pgvector does that natively.** No Redis, no Qdrant, no Weaviate, no event
store, no retrain. The data (catalog vectors) is *already in the table*.

### 5.1 Build a taste vector from liked item IDs (Rocchio positive-only / ref2vec centroid)

```sql
-- mean of the embeddings of the user's liked items  (= ref2vec centroid)
SELECT avg(embedding)::vector AS taste_vec
FROM products
WHERE id = ANY($liked_ids);
```

### 5.2 Fuse taste vector into the query vector at probe time (context vector / Rocchio)

Because pgvector lacks slerp, the samesake form is **weighted lerp + re-normalize** (≈ nlerp;
a faithful slerp approximation for normalized embeddings at modest `β`). With `$q` the query
embedding, `$beta` the personalization strength:

```sql
WITH taste AS (
  SELECT avg(embedding)::vector AS v
  FROM products WHERE id = ANY($liked_ids)
),
fused AS (
  -- α·q + β·mean(liked) − γ·mean(disliked); normalize in app or via l2_normalize()
  SELECT l2_normalize( $q::vector + ($beta * (SELECT v FROM taste)) ) AS q_m
)
SELECT p.id, p.embedding <=> (SELECT q_m FROM fused) AS dist
FROM products p
WHERE p.gender = $hard_gender          -- hard filters STILL gate before ranking
ORDER BY p.embedding <=> (SELECT q_m FROM fused)
LIMIT $k;
```

(`l2_normalize` ships in pgvector ≥ 0.7; otherwise normalize in TypeScript before binding.)
Add a `− $gamma * mean(disliked)` term for the full Rocchio / Qdrant `average_vector` shape.

### 5.3 Why this respects samesake's architecture

- **Hard filters still gate first.** The personalization only reshapes the *ranking probe*;
  the `WHERE` predicate (gender, price band, in-stock) compiles unchanged and gates *before*
  ranking. Personalization can never smuggle a hard-excluded item back in. This is a real
  advantage over opaque recsys: **personalized but still auditable and constraint-safe.**
- **RRF still works.** The fused vector is just one input list; FTS and "spaces" lists fuse
  via RRF exactly as today. (Personalization could even be its *own* RRF list — a taste-only
  ranking fused with the literal-query ranking — giving a tunable blend without touching the
  probe math.)
- **`/search/explain` stays honest.** The explain payload can report `α/β/γ`, the liked-set
  size, and the taste-vector contribution — something behavioral recsys cannot do.
- **BYO embeddings unchanged.** No new model; the taste vector lives in the same embedding
  space as the catalog.

---

## 6. Multi-turn conversational / session state

This is sense **C** — and it is **orthogonal** to vectors. It is about **typed constraint
state that accumulates and relaxes across turns**, which is squarely samesake's NLQ +
filter-compiler territory.

**Sources (PROVEN, surveys).**
- *"Beyond Single-Turn: A Survey on Multi-Turn Interactions with Large Language Models"* (2025,
  [arXiv:2504.04717](https://arxiv.org/html/2504.04717v1)) — names four interaction patterns:
  **recollection, expansion, refinement, follow-up**.
- *"LLMs Get Lost in Multi-Turn Conversation"* ([arXiv:2602.07338](https://arxiv.org/html/2602.07338v1))
  — multi-turn intent drift is a real failure mode; **don't free-form the state in the LLM,
  externalize it.**
- *"A Survey on Recent Advances in LLM-Based Multi-turn Dialogue Systems"*
  ([ACM CSUR, 2025](https://dl.acm.org/doi/full/10.1145/3771090)) — classic **slot-filling**
  remains the robust backbone for constraint-tracking dialogue.

**The design that fits samesake:** maintain a **typed constraint accumulator** — the same
constrained schema the NLQ parser already emits — as **session state across turns**. Each turn
the NLQ parser emits a *delta* (add / replace / relax a constraint), applied to the running
state, then re-compiled to SQL + a (possibly personalized) probe.

| User turn | Operation on typed state | Compiles to |
|---|---|---|
| "red saree under 5000" | set `color=red, type=saree, price≤5000` (hard) | SQL `WHERE` + FTS/ANN |
| "show me more like the 2nd one" | take result[1]'s **id → its vector** as a positive example; add to taste set | §5.2 fused probe |
| "…but cheaper" | **relax/tighten** `price` relative to that item's price (e.g. `price < ref_price`) | edit the `price` predicate |
| "actually in cotton" | **add** `material=cotton` (hard) | new `WHERE` clause |
| "less formal" | **relax** a hard constraint to soft, or add `−γ·formal_exemplar` | soft filter + negative example |

Two distinct levers, both already in samesake's vocabulary:

1. **Symbolic state** — typed predicates accumulated/relaxed in the session object.
   `findProducts()` already stops at retrieval; session state lives *above* it, in the
   caller/agent, and is replayed into each call. This needs **no new infra** — it is a typed
   object the agent thread holds.
2. **Vector state** — "more like the 2nd one" resolves a *result item* to its catalog vector
   and adds it to the in-session taste set (§5). "but cheaper" is a *symbolic* edit, not a
   vector edit — the split is clean: **adjectives of taste → vector; constraints of fact →
   SQL.** This split is samesake's natural strength and the thing pure-vector recsys gets wrong.

**Verdict: ADOPT (it is a thin layer, not new infra).** The conversational refinement loop is
expressible as *typed-constraint deltas + in-session taste set*, both of which samesake already
has the primitives for. The one new artifact is a **session/constraint accumulator object**
the agentic surface carries between `findProducts()` calls. Critically, samesake should
**externalize** this state (typed object), not trust the LLM to remember it — directly
addressing the "lost in multi-turn" failure mode.

---

## 7. Cold-start personalization (no log, no history)

**Sources (PROVEN, papers).**
- Verma, Gulati, Shah, *"Addressing the Cold-Start Problem in Outfit Recommendation Using
  Visual Preference Modelling"* (2020, [arXiv:2008.01437](https://arxiv.org/abs/2008.01437)) —
  addresses cold-start "for new users, by leveraging a novel visual preference modelling
  approach on a small set of input images," with "feature-weighted clustering to personalise
  occasion-oriented outfit recommendation." **No interaction/click history required** — input
  is a *small set of images*. Directly relevant: **fashion + visual + image-only cold start.**
- General preference-elicitation literature
  ([Emergent Mind: Cold-Start Personalization](https://www.emergentmind.com/topics/cold-start-personalization))
  — an onboarding survey / preference quiz "can serve to generate an initial embedding for the
  user"; active learning asks users to rate "only the most informative items."

**The cold-start spectrum and where samesake sits:**

| Cold-start situation | Samesake handling | Needs log? |
|---|---|---|
| **New item** (new SKU) | **Already solved** — content embedding from image/text makes it retrievable day-0 (see `09-recommendations`) | No |
| **New user, zero signal** | Fall back to literal query + global priors (popularity is optional, not required) | No |
| **New user, onboarding quiz** | Quiz answers → pick exemplar items → **taste vector = centroid of chosen exemplars** (§5.1) | No |
| **New user, "pick 3 you like" image grid** | Verma et al. visual approach → taste vector from chosen images | No |
| **In-session, just liked 2 results** | ref2vec-style centroid of the 2 liked items, fused into probe (§5.2) | No |

**Verdict: ADOPT.** Cold-start personalization is *the* case where the no-log family shines —
an onboarding "pick the looks you like" grid (3–5 images) yields a usable taste vector
immediately, with the exact same `avg()` + fuse machinery as §5. For the **LK code-mixed**
corpus (samesake's weakest benchmark), a **visual** preference-elicitation onboarding sidesteps
the language problem entirely — users *tap images*, no Sinhala/Tamil/English parsing needed to
seed taste. This is a differentiation opportunity, not just parity.

---

## 8. Comparison table — the no-log personalization family

| Technique | Source / status | Signal needed | Math | Single ANN probe? | pgvector-expressible? | Maps to samesake stage |
|---|---|---|---|---|---|---|
| **Marqo context vectors** | Blog MARKETED + API PROVEN | liked item vectors (+weights) | slerp/lerp interpolation of {q} ∪ {liked} | Yes | Yes (lerp+normalize; no native slerp) | ANN probe |
| **Rocchio (1971)** | Paper PROVEN | liked + disliked sets | `α·q+β·mean(R)−γ·mean(NR)` | Yes | Yes (`+ - avg`) | ANN probe + explain knobs |
| **Qdrant `average_vector`** | API PROVEN | positive + negative IDs | `2·mean(pos)−mean(neg)` | Yes | Yes | ANN probe |
| **Qdrant `best_score`** | API PROVEN | positive + negative IDs | per-example sigmoid scoring | **No** (rerank) | Partially (rerank only) | rerank / score-modifier |
| **Weaviate ref2vec-centroid** | Module PROVEN + blog MARKETED | cross-ref'd item vectors | `mean(refs)`, cached, recomputed on update | Yes | Yes (`avg`, cached) | derived `user_taste` table |
| **Visual cold-start (Verma 2020)** | Paper PROVEN | small set of liked **images** | image embeddings → weighted clustering/centroid | Yes | Yes | onboarding → taste vector |
| **Session constraint accumulator** | Surveys PROVEN | current conversation | typed predicate deltas (symbolic) | n/a | n/a (SQL, not vectors) | NLQ + filter compiler + session object |
| **Behavioral CF / two-tower** | Papers PROVEN | **full interaction log** | learned latent factors | n/a | No (needs event infra + retrain) | **out of scope — avoid** |
| **VERDICT for samesake** | — | **only item IDs / images / current turn** | **weighted vector-add + SQL** | mostly Yes | **Yes, all of B & C** | **probe + rerank + session object — zero new infra** |

---

## 9. Relevance to samesake — adopt / avoid / differentiate / integrate

**ADOPT**
- **Rocchio as the canonical formalism** for taste-vector fusion (`α/β/γ` exposed as
  merchandiser knobs and surfaced in `/search/explain`). It is the citable, 50-year-proven
  name for the operation samesake can already do.
- **Context-vector / `average_vector` fusion at the ANN probe** via pgvector `+`/`avg`/
  `l2_normalize` (§5.2). One probe, no new infra.
- **Negative examples** ("less like that") — extend the planned "more-like-this" with
  "less-like-that" via the `−γ·mean(disliked)` term.
- **Visual onboarding cold-start** ("tap 3 looks you like" → centroid taste vector) — sidesteps
  LK code-mixed parsing entirely; turns samesake's *weakest* benchmark axis into a non-issue
  for seeding personalization.
- **Externalized typed session/constraint accumulator** for multi-turn refinement, carried by
  the agentic surface between `findProducts()` calls.

**AVOID**
- **Behavioral collaborative filtering / two-tower learned-user models.** They need an event
  store, a retrain pipeline, and break samesake's "two containers, no extra infra" and
  auditability invariants. They also fail cold-start, which content-based fusion solves for free.
- **Native slerp in SQL.** Not worth a C extension; weighted-lerp+normalize is sufficient.
- **Trusting the LLM to remember conversation state** (the "lost in multi-turn" failure) —
  externalize it as a typed object.

**DIFFERENTIATE**
- **Personalized *and* constraint-safe + auditable.** Because hard filters gate before ranking
  and personalization only reshapes the probe, samesake can claim something pure-vector recsys
  cannot: *personalized ranking that provably never violates a hard constraint, with the taste
  contribution explainable.*
- **Symbolic/vector split** — "cheaper/in cotton" → SQL; "more like this/less formal" → vector.
  Pure-embedding personalization muddles the two; samesake's compiler keeps them clean.
- **Day-0 personalization with no log** — frame as "personalization without surveillance":
  no clickstream, no event store, no PII trail; just the items the user *told you* they like.

**INTEGRATE**
- **ref2vec pattern as a cached `user_taste(user_id, vec)` table**, recomputed when the liked
  set changes (heed the Weaviate recompute-on-update bug — make the recompute a tested,
  explicit step). For anonymous users, compute the centroid from session-held IDs at probe time.
- **Personalization as an RRF list** — a taste-only ranking fused with the literal-query
  ranking, giving a tunable blend without entangling probe math; reuses the RRF the engine
  already has.
- **`/search/explain` extension** — emit `α/β/γ`, liked-set size, and taste-vector
  contribution per result.

---

## 10. Open questions

1. **slerp vs. lerp on LK fashion vectors.** How much does the lerp+normalize approximation
   cost on samesake's normalized BYO embeddings at typical `β`? Needs a bench on the ~5k LK
   corpus — is grade@10 / P@5 preserved or improved under personalization?
2. **Optimal `α/β/γ` for fashion.** IIR's `1/0.75/0.15` is a text-IR default. What do
   merchandisers actually want for visual fashion taste — and should `β` scale with liked-set
   size (small set → trust query more)?
3. **Where does personalization sit relative to RRF?** Fuse the taste into the probe (one list)
   *or* run a separate taste-ranked list and RRF-fuse it? The latter is more tunable and
   explainable; the former is one fewer query. Bench both.
4. **Taste-vector drift / staleness.** When a cached `user_taste` centroid spans many sessions,
   does it dilute? Does samesake need recency-weighting (`exp`-decay on the `avg`) — and does
   that quietly re-introduce a lightweight "log"?
5. **Negative-example semantics in fashion.** Does `−γ·mean(disliked)` push toward genuinely
   better items or toward incoherent off-distribution regions? `best_score`-style per-example
   rerank may be safer than averaged negatives — test at the rerank stage.
6. **Cold-start exemplar selection.** For the onboarding grid, which items maximize information
   (active learning: "most informative, diverse" set) on the LK catalog? Random vs.
   popularity vs. diversity-sampled exemplars.
7. **Session-state schema.** Exact typed shape of the constraint accumulator (add/replace/relax
   ops) and how `findProducts()` round-trips it — does it belong in core, or in the agentic
   adapter layer?
8. **Multimodal taste.** If liked items contribute *image* embeddings while the query is text,
   do they live in the same space (CLIP-style joint) for the BYO model? Fusion assumes a shared
   space — verify per embedding provider.

---

## 11. Sources

**Primary papers (PROVEN)**
- J. J. Rocchio, *"Relevance Feedback in Information Retrieval"* (1971). Canonical:
  [Manning/Raghavan/Schütze, IIR ch. 9](https://nlp.stanford.edu/IR-book/html/htmledition/the-rocchio-algorithm-for-relevance-feedback-1.html);
  [Wikipedia](https://en.wikipedia.org/wiki/Rocchio_algorithm).
- Verma, Gulati, Shah, *"Addressing the Cold-Start Problem in Outfit Recommendation Using
  Visual Preference Modelling"* (2020), [arXiv:2008.01437](https://arxiv.org/abs/2008.01437).
- *"Beyond Single-Turn: A Survey on Multi-Turn Interactions with LLMs"* (2025),
  [arXiv:2504.04717](https://arxiv.org/html/2504.04717v1).
- *"LLMs Get Lost in Multi-Turn Conversation"*, [arXiv:2602.07338](https://arxiv.org/html/2602.07338v1).
- *"A Survey on Recent Advances in LLM-Based Multi-turn Dialogue Systems"*,
  [ACM Computing Surveys, 2025](https://dl.acm.org/doi/full/10.1145/3771090).

**Product / vendor docs (PROVEN API) and blogs (MARKETED framing)**
- Marqo, *"Context Is All You Need…"* (blog, MARKETED),
  [marqo.ai](https://www.marqo.ai/blog/context-is-all-you-need-multimodal-vector-search-with-personalization).
- Marqo Search API `context` / `interpolationMethod` (PROVEN spec),
  [docs.marqo.ai](https://docs.marqo.ai/latest/reference/api/search/search/).
  *(Note: the `recommend` reference URL 404'd at fetch time; context-vector spec sourced from
  the Search reference + blog.)*
- Qdrant, *"Deliver Better Recommendations with Qdrant's new API"* (PROVEN formulas),
  [qdrant.tech](https://qdrant.tech/articles/new-recommendation-api/);
  `sum_scores` strategy [PR #6256](https://github.com/qdrant/qdrant/pull/6256).
- Weaviate, *"What is Ref2Vec…"* (MARKETED + module PROVEN),
  [weaviate.io](https://weaviate.io/blog/ref2vec-centroid); recompute bug
  [issue #3185](https://github.com/weaviate/weaviate/issues/3185).
- pgvector operators & aggregates (PROVEN, extension docs),
  [github.com/pgvector/pgvector](https://github.com/pgvector/pgvector).

**Internal cross-references**
- `09-recommendations/recommendation-methods.md` — content-based filtering, the
  search/recommendation convergence, and cold-start-for-items (this doc extends it to
  cold-start-for-users without a log).
- `01-marqo/conversational-agentic.md`, `01-marqo/metrics-and-behavioral-critique.md`.
