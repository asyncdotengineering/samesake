# Merchandising, Faceting, Diversity & Fallback — the product capabilities samesake didn't research

> **Status:** completeness pass. The first sweep nailed retrieval quality, fusion, scaling, and
> protocols. It said almost nothing about the *product surface a real store search needs once
> retrieval works*: business-rule ranking, result diversity, faceted navigation, zero-result
> recovery, and freshness. This dossier fills that gap and maps every capability onto samesake's
> primitives — **hard SQL filters → RRF over (FTS + cosine ANN + spaces) → /search/explain**.
>
> **Anchor:** samesake is fashion-first on a Sri Lankan (Sinhala/Tamil/English code-mixed) corpus,
> embed-in-product (Postgres + pgvector, two containers, no Redis/ES/hosted vector DB), BYO
> embedding+generation models, `findProducts()` stops at retrieval. Every recommendation below has
> to survive *that* box: no new infrastructure, auditable by construction, and honest about the LK
> long-tail where local queries are the weakest benchmark type.

---

## 0. Why this matters for samesake specifically

Retrieval quality is necessary, not sufficient. The moment a real LK boutique runs samesake, the
merchandiser will ask five questions the first dossier can't answer:

1. *"Push this sari collection for Avurudu / bury the out-of-season winter coats — without breaking
   relevance, and show me **why** a product ranked where it did."* → **business-rule ranking + score
   modifiers, auditably.**
2. *"My 'red dress' results are 20 near-identical listings from one brand."* → **diversity /
   de-dup in ranking** (distinct from entity resolution, which collapses *catalog* duplicates;
   this collapses *result-list* redundancy).
3. *"Show colour/size/brand/price filters with live counts that update as I narrow."* → **faceting
   at scale in Postgres.**
4. *"Customer searched 'ලෙදර් ජැකට්' (leather jacket, Sinhala) and got nothing."* → **zero-result
   handling + query relaxation** — and this is *exactly* where samesake's worst benchmark lives.
5. *"New arrivals should surface; dead stock from 2019 shouldn't."* → **recency/freshness ranking.**

None of these need a model retrain. All of them are expressible as SQL predicates, post-retrieval
reordering, or extra RRF legs — i.e. inside samesake's existing shape. The strategic prize is the
same as the rest of the dossier: **make merchandising correct, explainable, and reindex-free by
construction**, in direct contrast to vendors who bake business logic into an opaque model.

---

## 1. Business-rule ranking, done auditably

### 1.1 The vocabulary (what merchandisers actually ask for)

The industry has a settled taxonomy. From Algolia's Rules documentation, rules are
`conditions → consequences (→ validity period)`, where only consequences are mandatory:

> "Rules let you make precise, predetermined changes to your search results, for example, you can
> pin or hide items, boost or bury categories, or results based on the query."
> — [Algolia, Rules overview](https://www.algolia.com/doc/guides/managing-results/rules/rules-overview)

The consequence vocabulary (verbatim from the doc):

- **Pin an Item** — "Insert an item at a specific position"
- **Hide an Item** — "Remove a specific result from the list"
- **Boost/Bury Categories** — "Filter/Boost Matching Attributes" using facets
- **Promote** — elevate items in ranking
- **Filter** — apply `filters` or `optionalFilters` based on query matching
- **Query modification** — remove/replace/rewrite the user query
- **Custom Data** — "Add custom JSON data to the search response"

Conditions trigger on **query pattern** (`is`/`contains`/`starts with`/`ends with`), **applied
filters** (exact match), or **context** (`ruleContexts` — e.g. "homepage", "avurudu-campaign"), or
nothing (always-on). This is the de-facto standard merchandisers expect, and samesake should speak
it natively rather than invent new terms (CLAUDE.md §9: mirror the domain vocabulary).

### 1.2 Two kinds of business-rule ranking — keep them separate

| Kind | What it is | samesake expression |
|---|---|---|
| **Hard rules (gating)** | Pin, hide, include-only, exclude. Deterministic set operations on the result list. | SQL predicate (`WHERE`) or a deterministic post-RRF splice. Gate *before* ranking, like hard filters. |
| **Soft rules (biasing)** | Boost/bury, promote, "score modifiers" — query-independent scalars that nudge order. | A **multiplicative soft leg** applied to the fused score, never a hard cut. |

The first dossier already established the gating discipline ("hard filters compile to SQL
predicates that gate before ranking; soft filters relax"). Business rules slot into the *same* two
buckets — pinning/hiding are hard, boost/bury are soft.

### 1.3 Score modifiers — the soft multiplicative leg

A **score modifier** is a query-independent, per-document scalar that biases ranking: popularity,
margin, recency, quality, conversion rate, in-stock depth. The clean engineering pattern is a
*multiplicative bias over the relevance score*, normalized to a known range. The canonical academic
form (from the hybrid-ranking literature surfaced in the pgvector search) is:

> `score(A, q) = cos(q, p_A) × TraceRank(A)`
> — a multiplicative combination of query-dependent similarity and a query-independent quality
> scalar. ([ParadeDB, Hybrid Search in PostgreSQL](https://www.paradedb.com/blog/hybrid-search-in-postgresql-the-missing-manual) thread / general IR practice)

Elasticsearch generalizes this as the `function_score` query: a set of functions combined into the
relevance score via `score_mode` (how the functions combine: `multiply` default, `sum`, …) and
`boost_mode` (how the function bundle combines with the query score: `multiply`, `sum`, `replace`).
From the Elastic reference:

> **multiply** (score_mode): "scores are multiplied (default)"
> **replace** (boost_mode): "only function score is used, the query score is ignored"
> — [Elastic, function_score query](https://www.elastic.co/docs/reference/query-languages/query-dsl/query-dsl-function-score-query)

**Multiplicative, not additive, is the right default for soft modifiers** because it preserves the
relevance signal's shape: a 1.2× popularity boost lifts a strong match more than a weak one, and a
0.7× "dead-stock bury" can't promote an irrelevant item above a relevant one the way an additive
constant can. (Hard overrides — pin/hide — are the exception; they *are* allowed to override
relevance, which is why they're hard rules, not modifiers.)

### 1.4 The anti-pattern to differentiate against: Marqo bakes margin into the model

This is the single sharpest contrast in this dossier. Marqo's "Commerce Superintelligence"
positions baking merchandising signals **into the ranking model itself**:

> "Margin, inventory levels, seasonal strategy, and promotional objectives are embedded in the
> ranking model … merchandisers define intent, and the AI applies it across millions of queries,
> including the long-tail queries that manual rules could never cover."
> — [Marqo, "What Is Marqo?"](https://www.marqo.ai/blog/what-is-marqo) (vendor blog — **MARKETED**, not benchmarked)

This is seductive (one model, covers the long tail) but it is the **opposite of auditable**. Once
margin is inside the embedding/ranker weights:

- You cannot answer "why did this rank here?" — the margin contribution is entangled with relevance
  in a learned function.
- You cannot turn a rule off for one query, one campaign window, or one tenant without retraining.
- You cannot prove to a regulator/merchant that relevance wasn't sacrificed for margin on a given
  query (a real concern — margin-biasing search is adjacent to dark-pattern territory).
- Cold-start and the LK long-tail get the model's *learned* margin prior, not an explicit,
  inspectable scalar the merchant set.

The first dossier already flagged Marqo's numbers as unaudited marketing and its blog as generated
SEO collateral. The margin-in-model claim is in the same category: a **marketing** claim with no
benchmark, and architecturally it forfeits the one thing samesake sells — explainability.

### 1.5 How samesake should express business rules (the build)

**Score modifiers as a registered, typed, auditable soft leg.** Each modifier is a named,
query-independent scalar column (or expression) on the typed catalog, normalized to a bounded range
(e.g. `[0.5, 1.5]`), with a per-tenant weight. The fused-score query becomes:

```sql
-- after hard filters have gated, after RRF has produced a relevance score `rrf_score`
SELECT p.id,
       p.rrf_score
         * COALESCE(power(1.0 + tenant.popularity_weight, p.popularity_norm), 1)  -- soft modifier
         * COALESCE(tenant.margin_weight  * p.margin_norm  + (1 - tenant.margin_weight), 1)
         AS final_score,
       p.rrf_score,                       -- keep the un-modified score for /search/explain
       p.popularity_norm, p.margin_norm   -- and the raw inputs
FROM filtered_ranked p
ORDER BY final_score DESC
```

The non-negotiable design rules:

1. **Modifiers are scalars in SQL, never weights in a model.** This is the Marqo differentiation,
   made architectural.
2. **`/search/explain` must emit, per result: the un-modified relevance score, each modifier's raw
   value, its weight, and its multiplicative contribution.** Then the audit answer is arithmetic,
   not introspection of a black box. This is samesake's moat, and it's free here.
3. **Pins/hides are a deterministic post-RRF splice**, logged in explain as "pinned by rule
   {id}" / "hidden by rule {id}", with the rule's condition recorded so the audit shows *why* it
   fired. Hard rules gate; they don't touch scores.
4. **Boost/bury categories = a conditional modifier**: a rule whose condition (query pattern /
   context / applied filter) is met multiplies the modifier for matching `category`/`brand`. Same
   machinery as a global modifier, scoped by a SQL predicate.
5. **Validity periods are `WHERE now() BETWEEN rule.starts_at AND rule.ends_at`** — a SQL predicate,
   so "Avurudu campaign, 10–17 April" is a date-bounded rule, not a deploy.
6. **No reindex.** Modifier columns and weights change at query time. Relevance comes from the
   already-built FTS + ANN; the modifier multiplies. This is the reindex-free promise the first
   dossier made for ranking, extended to merchandising.

**Should boost/bury be an RRF leg or a multiplicative post-fusion modifier?** Use a **multiplicative
post-fusion modifier**, not an RRF leg. RRF fuses *rankings* (rank-position lists); a
query-independent scalar like margin has no meaningful per-query ranking to fuse — it's a constant
re-weighting, which multiplication expresses exactly and RRF would distort (RRF would treat the
single global popularity order as co-equal with relevance, drowning relevance on the head). Keep the
RRF legs for *retrieval* signals (FTS, ANN, spaces); apply modifiers *after* fusion. This is a
crisp, defensible line and it's the opposite of Marqo's "fuse everything into one model."

---

## 2. Result diversity & de-duplication in ranking

Three distinct problems get conflated. Keep them apart:

| Problem | Lives where | samesake mechanism | Distinct from |
|---|---|---|---|
| **Near-duplicate *catalog* items** (same SKU ingested twice, mirror listings) | ingest / index | **entity resolution / dedup** (already in samesake) | result-list redundancy |
| **Near-duplicate *results*** (different SKUs, perceptually/semantically near-identical at query time) | ranking | near-duplicate result collapsing (embedding-distance threshold) | catalog dedup |
| **Lack of variety** (10 red dresses from one brand; one category dominates) | ranking | category/brand field-collapse **or** MMR | both of the above |

The first dossier's entity resolution handles the *catalog*; this section handles the *result list*.

### 2.1 Field collapsing (the cheap, deterministic win)

Field collapsing returns at most N results per distinct value of a field (brand, style, product
family). From the Solr/Elastic ecosystem:

> "Result grouping … is the ability to ensure only one document (or some limited number) is returned
> for each unique value within a field." … "result pages were full of similar documents like the
> same car model where only the edition differs … but what is actually desired is to only show the
> different models."
> — [Apache Solr, Result Grouping / Field Collapsing](https://cwiki.apache.org/confluence/display/solr/fieldcollapsing); [Elasticsearch Labs, pagination with collapse](https://www.elastic.co/search-labs/blog/elasticsearch-pagination-with-collapse-and-cardinality)

Elastic notes the pagination trap and its fix:

> "By adding a cardinality aggregation on the same collapse field, you can accurately compute the
> number of distinct groups, enabling reliable and predictable pagination."
> — Elasticsearch Labs (above)

**In Postgres this is `DISTINCT ON` or a windowed `ROW_NUMBER() … PARTITION BY collapse_field`** over
the ranked set, keeping the top-scoring member per group and (optionally) an "expand" follow-up
query for the rest. Zero new infrastructure, fully deterministic, trivially explainable ("collapsed
3 lower-ranked items sharing brand=X"). This should be samesake's **default diversity primitive**
because it's auditable and free.

```sql
-- keep top-2 per brand from the ranked, modifier-applied result set
SELECT * FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY brand ORDER BY final_score DESC) AS rn_in_brand
  FROM ranked
) t
WHERE rn_in_brand <= 2
ORDER BY final_score DESC
```

### 2.2 Near-duplicate result collapsing (semantic, embedding-distance)

Field collapse needs a categorical field. Two *different* SKUs with no shared field can still be
near-identical (same dress, two sellers; near-identical product photos). Collapse these by
**cosine distance between result embeddings**: within the top-K, greedily drop any item whose
embedding is within ε of an already-kept item. This reuses the embeddings samesake already has and
is computable over the top-K in-process (top-K is small — 50–200). This is *result-list* dedup; it
must not feed back into the catalog (that's entity resolution's job and a different confidence bar).

### 2.3 MMR — the principled diversity reranker (use sparingly)

Maximal Marginal Relevance balances relevance against redundancy. The formula (consensus form across
sources):

> `MMR = (1 − λ) × relevance_score − λ × max(similarity_with_selected_docs)`,
> where λ is the diversity parameter (closer to 1 = more diversity).
> — [Vectara](https://www.vectara.com/blog/get-diverse-results-and-comprehensive-summaries-with-vectaras-mmr-reranker) / general IR; note sources differ on whether λ multiplies relevance or diversity — pin the convention in code.

Elastic's convention (worth pinning, because conventions clash):

> "The λ parameter controls the trade-off, where λ = 1.0 is pure relevance (no diversity) and
> λ = 0.0: pure diversity (ignore relevance)."
> — [Elasticsearch Labs, Maximum Marginal Relevance](https://www.elastic.co/search-labs/blog/maximum-marginal-relevance-diversify-results)

It is a **post-scoring reranker over a fetched candidate pool** — Qdrant exposes it natively with a
`candidates_limit` (default 100) and a `diversity` (λ) knob:

> "The algorithm picks the most relevant item first," then for each subsequent result balances
> "relevance against similarity to already-selected results."
> — [Qdrant, MMR diversity-aware reranking](https://qdrant.tech/blog/mmr-diversity-aware-reranking/)

The cost caveat (proven, from Elastic):

> "While MMR provides significant value, it does come with computational costs. The algorithm
> computes similarities between candidates and selected items." … "consider limiting the reranking
> depth to a top k … retrieving the vectors will impact your performance, as it requires
> serialization of large amounts of data."
> — Elasticsearch Labs (above)

MMR is O(K²) in the candidate pool — fine for K≈100, and samesake already holds the top-K embeddings
post-RRF, so the pairwise similarities are in-process and cheap. The survey context:
**Result Diversification in Search and Recommendation: A Survey** (Wu, Zhang, Ma, Lyu, He, Mitra,
Liu; arXiv:2212.14464, 2022, rev. 2024) presents a unified taxonomy of diversification metrics and
approaches and frames the core tension as satisfying "both the various interests of customers and
the equal market exposure of providers" — i.e. diversity is also a *fairness/exposure* lever (LK
relevance: surfacing smaller local brands the head would otherwise bury).

### 2.4 samesake verdict on diversity

- **Default: field-collapse via `DISTINCT ON`/`ROW_NUMBER()`** (brand/style cap). Deterministic,
  auditable, free, no model. Ship this first.
- **Add: near-duplicate embedding collapse** over top-K (ε threshold) — reuses existing vectors,
  in-process, cheap.
- **Optional, behind the eval gate: MMR** over the post-RRF top-K, λ per-tenant. Only if collapse
  proves insufficient; gate on grade@10/P@5 *not regressing* (MMR trades relevance for diversity, so
  the eval must prove the trade is worth it — exactly the discipline the dossier already demands of
  the cross-encoder reranker).
- **Explain it:** every dropped/demoted item logs *why* ("collapsed: brand cap", "near-dup of
  result #3 at cos=0.96", "MMR-demoted: λ=0.3"). Diversity without an audit trail is indistinguishable
  from a bug.

---

## 3. Faceting at scale in Postgres

Faceting = counting occurrences of each attribute value in the *current result set*, so the UI can
show "Red (42), Blue (17)" and update counts as the user narrows. It looks like `GROUP BY`; it is a
performance trap at scale.

### 3.1 Why naive faceting is slow

> "faceting *looks* simple: it's just grouping and counting. But try to make it fast in a
> traditional row-based database, and you'll run into serious performance challenges." … "Want to
> show search results *and* category counts from a single query? That's either two index scans or a
> full index scan and a lot of data transferred."
> — [ParadeDB, Teaching Postgres to Facet Like Elasticsearch](https://www.paradedb.com/blog/faceting)

The deeper trap: **filtered facet counts**. Each facet's count must reflect *all other* active
filters but **not its own** (so the user can still widen on that facet). That's N separate counting
passes for N facet dimensions.

### 3.2 The plain-Postgres patterns (no extension)

**Unpivot + group**, all facets in one pass (James McNee):

```sql
SELECT facet_name, jsonb_object_agg(COALESCE(facet_value,'null'), count) AS facet_values
FROM (
  SELECT facet_name, facet_value, COUNT(*) AS count
  FROM "fruit",
       LATERAL (VALUES ('colour',"colour"),('size',"size"),('origin',"origin")) facets(facet_name,facet_value)
  GROUP BY facet_name, facet_value
) facets
GROUP BY facet_name;
```

**Filtered facets** — `UNION ALL` per facet, each excluding its own filter (McNee):

```sql
-- colour count excludes the colour filter but keeps size; size count excludes size but keeps colour
... UNION ALL
  SELECT 'colour' AS facet_name, "colour" AS facet_value, COUNT(*) AS count
  FROM "fruit" WHERE "size" = 'medium'   -- note: colour filter omitted here
  GROUP BY "colour"
...
```

The author is honest about the ceiling:

> "not the most optimal way to implement faceting" — recommends a "more performant solution" for
> large datasets.
> — [James McNee, Fascinating Faceting with Postgres](https://jamesmcnee.co.uk/blog/posts/2024/may/05/fascinating-faceting-with-postgres/)

`GROUPING SETS` is the same idea expressed in one SQL statement (compute several group-bys in one
pass) and is the cleanest plain-SQL multi-facet primitive.

### 3.3 The fast path: precomputed inverted index / roaring bitmaps

`pgfaceting` (built on `pg_roaringbitmap`) precomputes an inverted index mapping each facet value →
a compressed bitmap of matching doc-ids; counting becomes bitmap-AND + popcount:

> A traditional LATERAL query without parallelization requires **222 seconds** on a 100-million-row
> table … parallel query drops it to 18 seconds … "By contrast, pgfaceting completes the same
> operation in **155 milliseconds**."
> — [pganalyze, Roaring Bitmaps and pgfaceting](https://pganalyze.com/blog/5mins-postgres-roaring-bitmaps-pgfaceting-query-performance)

The **proven** cost (not marketing):

> "this is not maintained automatically for new data that is coming in." Users must manually trigger
> maintenance; "the extension currently requires self-hosted PostgreSQL" (not RDS/Aurora).
> — pganalyze (above)

ParadeDB's `Top K` faceting solves it differently — single-pass over a columnar index:

> "ParadeDB's Top K faceting maintains consistent performance by executing both search ranking and
> aggregation in a single pass through the index" … leveraging "ParadeDB's columnar index, which
> allows fast per-document value lookups during aggregation" … "at scale, this represents well over
> an order of magnitude improvement." (On 46M Hacker News rows.)
> — [ParadeDB, faceting blog](https://www.paradedb.com/blog/faceting)

**But ParadeDB's `pg_search` is AGPL** — the first dossier already ruled it out for the embeddable
two-container stack (a network-copyleft trap). So ParadeDB faceting is *informative, not adoptable*.

### 3.4 samesake verdict on faceting

| Approach | Speed | Freshness | License | New infra | Verdict for samesake |
|---|---|---|---|---|---|
| `GROUP BY` / `GROUPING SETS` / unpivot | OK to ~100k–1M rows | live | core PG | none | **Adopt as default.** Honest at LK catalog sizes (~5k–100k). |
| `pgfaceting` (roaring bitmaps) | ~1000× on 100M rows | **manual refresh** | PostgreSQL-licensed, but **self-host only** | extension | **Document as escape hatch** for huge single-tenant catalogs; flag the staleness + RDS limitation. |
| ParadeDB `pg_search` Top-K | order-of-magnitude | live | **AGPL** | extension | **Avoid** — copyleft trap in embed-in-product (consistent with prior dossier). |

Concrete plan:
1. **Default: typed-facet declaration → `GROUPING SETS` query** that returns result page + facet
   counts in one round trip. At LK catalog sizes (the real corpus is ~5k docs; even 100k is fine)
   this is *correct and fast enough* — don't over-engineer (CLAUDE.md §2).
2. **Filtered-count correctness is the hard part, not speed.** Generate the "exclude-own-facet"
   counting set from the typed filter schema, deterministically. This is a *compiler* job — exactly
   samesake's wheelhouse — and it's where naive implementations silently get counts wrong.
3. **Facet ordering:** default by count desc (proven UX expectation), with typed overrides (size
   facets ordered S<M<L<XL, not by count; price as ranges/histogram buckets, not raw values).
4. **Escape hatch:** if a tenant's catalog outgrows `GROUP BY` latency, document `pgfaceting` with
   its manual-refresh and self-host caveats stated up front — same posture as the
   pgvectorscale/pg_textsearch upgrade paths in BUILD-READY.

---

## 4. Zero-result handling & query relaxation

This is **the** section for samesake, because the first dossier says local LK queries
(Sinhala/Tamil/English code-mixed) are its **weakest** benchmark type — and weak retrieval is
precisely what produces zero/low results.

### 4.1 The governing principle: causes, not symptoms; honesty over noise

Daniel Tunkelang (ex-Endeca/LinkedIn, the canonical voice here):

> "trying to minimize null and low results without understanding the underlying causes will probably
> make things worse."

> "it is better to be forthright about not having what the searcher wants than to flood the searcher
> with irrelevant results." … this "builds trust for the long term."
> — [Daniel Tunkelang, Making Sense of Null and Low Results](https://dtunkelang.medium.com/making-sense-of-null-and-low-results-a077f37bf8fc)

He separates **null queries** (zero results) from **low-recall queries** (too few good results) but
treats them under one cause framework: query-understanding failure, missing inventory, overspecified
query, or retrieval problem. **This is the discipline samesake should encode:** don't blindly pad
results to avoid an empty page — relaxation must be *typed and explainable*, and an honest empty
state beats irrelevant noise.

### 4.2 The relaxation ladder (industry-standard order)

From Bloomreach's query relaxation (a clean, documented reference):

> "Bloomreach's semantic understanding identifies the product type (… *shoes*) from the query." Then
> "relaxes the query matching criteria from 'match on all terms' to 'match on one term.'" … "The
> query is relaxed to only look for the identified product type (*shoes*) as the mandatory matching
> term. Other terms (*awesome*) … are made optional."
> — [Bloomreach, Query relaxation](https://documentation.bloomreach.com/discovery/docs/query-relaxation)

Tunkelang's overspecified-query example — soft-filter relaxation:

> searching "navy blue shirts" with no exact match → return dark blue shirts: "it is often better
> than returning no results."
> — Tunkelang (above)

Reported business effect (**MARKETED**, vendor aggregate, not a controlled study):

> "Teams implementing systematic no-results recovery, including fuzzy matching, synonym expansion,
> query relaxation, and category fallbacks, typically reduce zero-result rates from 12–20% down to
> under 2–3%."
> — [Expertrec, Zero-Result Optimization](https://blog.expertrec.com/zero-result-optimization-for-ecommerce-recover-missed-queries-and-boost-conversions/)

The canonical ladder, ordered least→most lossy:

1. **Typo/fuzzy** — PG `pg_trgm` similarity / `levenshtein`. Cheap, high-value for LK transliteration
   variance.
2. **Synonym / translation expansion** — Sinhala/Tamil ↔ English term mapping. **This is samesake's
   highest-leverage LK lever** and belongs in the typed catalog/NLQ layer.
3. **Drop optional terms** (keep mandatory product-type) — the Bloomreach move; maps to NLQ
   identifying the head noun and relaxing modifiers.
4. **Relax soft filters** — "navy" → any blue; "under 3000 LKR" → widen the band. samesake already
   has soft-filter relaxation; zero-result handling *triggers* it.
5. **Vector-only fallback** — drop the FTS leg entirely and lean on cosine ANN (semantic match when
   lexical fails — exactly the code-mixed-query case).
6. **Category fallback / honest empty state** — show the category's bestsellers *clearly labelled as
   a fallback*, or an honest "no exact match, here's the closest" — never silent noise (Tunkelang).

### 4.3 How samesake should express it

- **Relaxation is a typed, ordered pipeline gated on result count**, with a per-stage threshold
  (`if hits < min_results: try next stage`). Each stage is a SQL/NLQ transformation samesake already
  owns — no new machinery, just sequencing.
- **`/search/explain` must record the relaxation path**: "0 hits exact → dropped modifier 'awesome'
  → 0 → relaxed colour navy→blue → 14 hits". This turns the dreaded empty page into an auditable,
  fixable signal. It also feeds the merchandiser the *exact* synonym/inventory gap (Tunkelang's
  "every zero-result query is a fixable gap").
- **Hard filters never relax.** The dossier's invariant holds: budget/size/in-stock stay hard even
  in fallback (a customer who needs size XL doesn't want size S "to avoid an empty page"). Only
  **soft** constraints and **lexical** strictness relax. This is the line that keeps relaxation
  honest.
- **The vector-only fallback is the LK weapon.** When code-mixed Sinhala/Tamil text defeats FTS,
  dropping to cosine ANN over multilingual/visual embeddings is the natural recovery — and it's a
  *built-in* consequence of samesake's hybrid design, not a feature to add. Worth an explicit eval:
  *does vector-only fallback rescue the LK zero-result tail?* That measurement is the proof.

---

## 5. Recency / freshness ranking

"New arrivals up, dead stock down" is a **score modifier** (§1.3) keyed on a date field. The proven
mechanism is a **decay function** — score falls off smoothly with age.

### 5.1 The decay math (proven, from Elastic reference)

> **Gauss:** `S(doc) = exp( − (max(0, |value − origin| − offset)²) / (2σ²) )`, σ² = −scale²/(2·ln(decay))
> **Exp:** `S(doc) = exp( λ · max(0, |value − origin| − offset) )`, λ = ln(decay)/scale
> **Linear:** `S(doc) = max( (s − max(0, |value − origin| − offset)) / s , 0 )`, s = scale/(1−decay)
> — [Elastic, function_score decay functions](https://www.elastic.co/docs/reference/query-languages/query-dsl/query-dsl-function-score-query)

Parameters (verbatim): **origin** (the reference point — for freshness, `now()`), **scale**
(distance at which score = `decay`), **offset** ("only compute decay for documents with distance
greater than offset" — i.e. a grace window where everything is "fresh"), **decay** ("how documents
are scored at the distance given at scale"; default 0.5).

Which curve:

> "Choose gauss for most cases. Use exp when you want a gentler long-tail. Use linear when you need a
> hard boundary."
> — [search-result synthesis of Elastic guidance]

These map cleanly to a SQL expression — no extension needed. e.g. exponential freshness in Postgres:

```sql
-- freshness modifier: 1.0 for items inside `offset` days, decaying by `decay` every `scale` days
exp( ln(:decay) / :scale * GREATEST(0, EXTRACT(EPOCH FROM now() - p.created_at)/86400 - :offset) )
```

### 5.2 samesake verdict on freshness

- **Freshness is a score modifier, full stop** — same multiplicative soft leg as popularity/margin
  (§1.3), keyed on `created_at`/`restocked_at`. No new subsystem.
- **Gauss as default, exp for catalogs with long viable shelf life** (fashion staples), exp/short
  scale for fast-fashion. Expose `origin/scale/offset/decay` per tenant; default `offset` = a grace
  window so "this week's drop" all rank as equally fresh.
- **Express in SQL, audit in explain.** The freshness multiplier and the item's age both appear in
  `/search/explain` — "freshness ×1.18 (age 4d, scale 30d, exp)". Same auditability dividend.
- **Don't let freshness override relevance or hard filters** — multiplicative + bounded keeps a
  brand-new irrelevant item from outranking a relevant older one. (The additive-constant footgun.)
- **Freshness ↔ diversity interaction:** a freshness boost can flood results with new arrivals;
  field-collapse/MMR (§2) is the counterweight. Tune them together, measure together.

---

## 6. Comparison table — capability → samesake expression → verdict

| Capability | Proven mechanism (source) | samesake expression | Verdict |
|---|---|---|---|
| Pin / hide (hard rule) | Algolia Rules consequences | Deterministic post-RRF splice, logged in explain | **Adopt** |
| Boost / bury, promote (soft rule) | Algolia Rules; ES function_score | Conditional **multiplicative** modifier, post-fusion | **Adopt** |
| Score modifiers (popularity/margin/recency/quality) | ES function_score (multiply); `cos×TraceRank` | Bounded scalar columns × tenant weights, post-RRF; raw inputs in explain | **Adopt + differentiate** |
| Margin baked into ranking model | Marqo "Commerce Superintelligence" (vendor, unbenchmarked) | — | **Avoid** (forfeits auditability) |
| Brand/category variety | Solr/ES field collapse + cardinality | `DISTINCT ON` / `ROW_NUMBER() PARTITION BY` | **Adopt** (default diversity) |
| Near-dup result collapse | embedding-distance dedup | greedy ε-collapse over top-K vectors | **Adopt** |
| Principled diversity reranking | MMR (Vectara/Elastic/Qdrant; Wu et al. 2022 survey) | MMR over post-RRF top-K, λ per tenant | **Integrate, eval-gated** |
| Facet counts (default) | PG `GROUPING SETS` / unpivot (McNee) | Typed-facet → single-pass counting query | **Adopt** |
| Facet counts (huge catalog) | pgfaceting roaring bitmaps, 222s→155ms (pganalyze) | extension, manual refresh, self-host only | **Document as escape hatch** |
| Facet counts (columnar) | ParadeDB Top-K, OOM faster (ParadeDB) | — | **Avoid** (AGPL) |
| Zero-result / relaxation | Bloomreach ladder; Tunkelang causes-not-symptoms | Typed ordered relaxation pipeline, count-gated; vector-only fallback for LK; explain the path | **Adopt** (highest LK leverage) |
| Recency / freshness | ES decay functions (gauss/exp/linear) | Decay expression as a score modifier in SQL | **Adopt** |

---

## 7. Relevance to samesake — adopt / avoid / differentiate / integrate

**ADOPT (do these; they're inside the existing box):**
- **Score modifiers as bounded scalar columns × tenant weights, applied multiplicatively after RRF**,
  with raw inputs + contributions in `/search/explain`. One mechanism serves popularity, margin,
  quality, **and** recency (§1.3, §5).
- **Pins/hides as deterministic post-RRF splices**; validity windows as `WHERE now() BETWEEN …`
  (§1.5). No reindex, ever.
- **Field-collapse diversity** via `DISTINCT ON`/window functions as the default variety primitive
  (§2.1) + **near-dup ε-collapse** over top-K embeddings (§2.2).
- **`GROUPING SETS` faceting** with compiler-generated exclude-own-facet filtered counts — the
  correctness, not the speed, is the hard part at LK scale (§3.4).
- **Typed, count-gated relaxation pipeline** ending in vector-only fallback, with the relaxation
  path in explain (§4) — samesake's single biggest LK quality lever.

**AVOID:**
- **Baking margin/business logic into the embedding or ranker** (Marqo) — forfeits the one thing
  samesake sells. Modifiers stay explicit scalars in SQL (§1.4).
- **ParadeDB `pg_search` faceting** — AGPL network-copyleft trap, consistent with the prior license
  ruling (§3.3).
- **Padding zero-result pages with irrelevant noise** to chase a zero-result metric — Tunkelang:
  honest empty > irrelevant flood (§4.1).
- **Additive score modifiers / unbounded boosts** — they let a strong margin/freshness bias promote
  irrelevant items over relevant ones (§1.3, §5.2).

**DIFFERENTIATE:**
- **"Auditable merchandising" is the headline.** Marqo's pitch is "the AI handles margin across the
  long tail"; samesake's counter is "every rank is `relevance × explicit modifiers`, and
  `/search/explain` shows the arithmetic." This is a *demoable* contrast a merchant can verify, and
  it extends the dossier's existing explainability moat into the merchandising surface.

**INTEGRATE (eval-gated, after the adopts):**
- **MMR over the post-RRF top-K**, λ per tenant — only if field-collapse + ε-collapse prove
  insufficient, and only if grade@10/P@5 don't regress (§2.3). Same gate discipline as the
  cross-encoder reranker in BUILD-READY Tier 1.
- **pgfaceting** as a documented escape hatch for tenants who outgrow `GROUP BY` faceting — with the
  manual-refresh and self-host-only caveats stated up front (§3.4).

**Where this slots into BUILD-READY:** these belong in a new tier between Tier 1 (reranker/UCP) and
Tier 2 (more-like-this), because a merchant cannot run a real store without pins, boosts, facets, and
zero-result recovery — they are table stakes, not polish. Suggested order:
1. Score modifiers (popularity/freshness) + pin/hide, all surfaced in `/search/explain`.
2. `GROUPING SETS` faceting with correct filtered counts.
3. Count-gated relaxation pipeline + vector-only LK fallback (+ an eval that proves it rescues the
   LK zero-result tail).
4. Field-collapse diversity; near-dup collapse; MMR only if needed.

---

## 8. Open questions

1. **Modifier normalization across tenants.** popularity/margin distributions differ wildly per
   tenant; how is `popularity_norm`/`margin_norm` computed and refreshed without an interaction log
   (the dossier rules out behavioral CF)? Percentile-rank at index time? Recomputed how often?
2. **RRF-leg vs post-fusion modifier — is multiplication always right?** §1.5 argues post-fusion
   multiplication; is there a query class (pure browse, empty query) where a modifier *should* be an
   RRF leg? Needs an eval, not an assertion.
3. **MMR's relevance cost on the LK tail.** Does diversity reranking *help* (exposure for small local
   brands) or *hurt* (demoting the one good code-mixed match) when retrieval is already weak? Measure
   before integrating.
4. **Filtered facet-count correctness under hard-filtered ANN.** When pgvector iterative scan
   (BUILD-READY Tier 0) relaxes the candidate set, are facet counts computed over the *true* filtered
   population or the ANN-approximate one? Counts that don't match the result page erode trust.
5. **Freshness ↔ diversity ↔ margin tuning is multi-objective.** Three soft levers interacting; is
   there a principled per-tenant tuning procedure, or is it manual until enough labeled queries exist
   (cf. the ≥50-labeled-query CC-fusion threshold)?
6. **Synonym/translation table provenance for Sinhala/Tamil.** The relaxation ladder's stage 2 needs
   a code-mixed term map. Where does it come from — curated, mined from the corpus, or LLM-generated
   at enrich time? This is the load-bearing LK asset and it's unspecified.
7. **Zero-result eval metric.** The dossier measures grade@10/P@5 on queries that *return*. What's
   the metric for queries that *don't*? Zero-result rate + "relaxation rescue rate" + a quality bar
   on rescued results, stratified by LK vs English.

---

## 9. Sources

**Proven (docs / papers / reference):**
- Algolia, *Rules overview* — https://www.algolia.com/doc/guides/managing-results/rules/rules-overview
- Elastic, *function_score query* (decay math, score_mode/boost_mode) — https://www.elastic.co/docs/reference/query-languages/query-dsl/query-dsl-function-score-query
- Elasticsearch Labs, *Maximum Marginal Relevance & Elastic* — https://www.elastic.co/search-labs/blog/maximum-marginal-relevance-diversify-results
- Elasticsearch Labs, *Efficient pagination with collapse and cardinality* — https://www.elastic.co/search-labs/blog/elasticsearch-pagination-with-collapse-and-cardinality
- Apache Solr, *Result Grouping / Field Collapsing* — https://cwiki.apache.org/confluence/display/solr/fieldcollapsing
- Qdrant, *Balancing Relevance and Diversity with MMR Search* — https://qdrant.tech/blog/mmr-diversity-aware-reranking/
- Vectara, *MMR Reranker* — https://www.vectara.com/blog/get-diverse-results-and-comprehensive-summaries-with-vectaras-mmr-reranker
- Wu, Zhang, Ma, Lyu, He, Mitra, Liu, *Result Diversification in Search and Recommendation: A Survey*, arXiv:2212.14464 (2022, rev. 2024) — https://arxiv.org/abs/2212.14464
- ParadeDB, *Teaching Postgres to Facet Like Elasticsearch* — https://www.paradedb.com/blog/faceting
- ParadeDB, *Hybrid Search in PostgreSQL: The Missing Manual* — https://www.paradedb.com/blog/hybrid-search-in-postgresql-the-missing-manual
- pganalyze, *Roaring Bitmaps and pgfaceting* — https://pganalyze.com/blog/5mins-postgres-roaring-bitmaps-pgfaceting-query-performance
- James McNee, *Fascinating Faceting with Postgres* (SQL patterns) — https://jamesmcnee.co.uk/blog/posts/2024/may/05/fascinating-faceting-with-postgres/
- Bloomreach, *Query relaxation* — https://documentation.bloomreach.com/discovery/docs/query-relaxation
- Daniel Tunkelang, *Making Sense of Null and Low Results* — https://dtunkelang.medium.com/making-sense-of-null-and-low-results-a077f37bf8fc

**Marketed (vendor blog — treat claims as unverified):**
- Marqo, *What Is Marqo?* (margin baked into ranking model) — https://www.marqo.ai/blog/what-is-marqo
- Expertrec, *Zero-Result Optimization* (12–20% → 2–3% aggregate claim) — https://blog.expertrec.com/zero-result-optimization-for-ecommerce-recover-missed-queries-and-boost-conversions/
- Algolia, *Search results page merchandising* (playbook) — https://www.algolia.com/ecommerce-merchandising-playbook/search-results-page-merchandising

**Failed to fetch (noted, not used):**
- Cybertec, *Faceting large result sets in PostgreSQL* — HTTP 403; substituted with McNee + pganalyze for the SQL/perf claims.
- arXiv:2212.14464 PDF body — binary/compressed; used the abstract page for title/authors/year/framing instead.
