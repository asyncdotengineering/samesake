# Decision 07 — Completeness-Pass Additions (Decisions 16–25)

The first six decision docs were written from the initial 21-dossier sweep. The completeness
pass (`10-gaps/`) added 11 firsthand dossiers on topics the sweep missed and surfaced one
correction. This doc captures the **net new decisions** — concise verdicts + flip conditions,
each pointing to its `10-gaps/` dossier for the full evidence and the implementation SQL.

> **The single biggest finding of the entire research is Decision 16 (multilingual):**
> samesake's documented "local"-query weakness is **structural, not a tuning miss** — and it has
> a concrete fix. Treat it as the headline, not a footnote.

---

## D16 — Multilingual / code-mixed retrieval is the #1 quality investment
> **CORRECTED (firsthand code inspection, prompted by the user).** The dossier this summarizes
> claimed Postgres has *no* Sinhala/Tamil handling and a transliteration layer must be built from
> scratch. **That is wrong.** samesake already ships, in system DDL, `samesake_normalise`
> (lowercase+unaccent, `db/system-ddl.ts:47`) and `samesake_phonetic` — a real Indic-Soundex
> **cross-script hash mapping Sinhala+Tamil+Latin to one phonetic alphabet** (`db/system-ddl.ts:64`),
> used with `pg_trgm similarity()` in the **entity-resolution** path (`core/match.ts`,
> `core/schema-gen.ts:350`). The genuine gap is narrower: the **collection product-search keyword
> leg is hardcoded to `to_tsvector('english')` / `plainto_tsquery('english')`**
> (`core/collections-schema-gen.ts:88`, `core/search.ts:288`) and never calls those primitives.
> **So the build is REUSE, not rebuild:** give collections a `name_normalised`/`phon_hash`-style
> generated column and add a trigram/phonetic similarity leg to `Channels.fts` (or a new
> `Channels.lexical`), reusing the existing functions instead of relying on the English tsvector.
> Learned transliteration + BGE-M3-sparse drop to *optional upgrades*, not the first move.

**Verdict (as originally framed, now scoped to the product-search leg).** samesake's weakest
benchmark type ("local" LK queries) fails for three compounding,
*structural* reasons, not bad tuning: (1) Sinhala/Tamil are genuinely low-resource (XLM-R saw
~226× less Sinhala than English; Sinhala is absent from mBERT) so dense embeddings are weak
there; (2) **Postgres FTS is near-useless for non-Latin script** — no Sinhala/Tamil stemmer,
`unaccent` is Latin-only, `pg_trgm` historically drops non-ASCII — so the RRF effectively runs
**dense-only** on native script; (3) queries are **romanized + code-mixed** ("Singlish"), which
is non-standardized and many-to-one ambiguous. **Public benchmarks are blind here** (MIRACL omits
both Tamil and Sinhala), so samesake's own LK bench is the only ground truth.
**Do:** (a) add a **normalization + learned-transliteration front-door** before the NLQ parser
(NFC → script-detect → seq2seq Singlish→Sinhala; rule-based transliteration is ~67% WER vs seq2seq
~20%); (b) adopt **BGE-M3 (MIT)** as a first-class BYO model — its **learned-sparse head replaces
the broken FTS leg** and its multi-vector head is the planned reranker (three roadmap items, one
model); (c) route native-script lexical signal through **pgvector `sparsevec`**, not `tsvector`.
The code-mixed IR literature reports **15–16% MAP gains** from normalization+transliteration alone,
model-agnostic.
**Flip:** revisit the front-door if a future multilingual embedding natively handles romanized
code-mixed Sinhala/Tamil at parity with the transliteration pipeline on the LK bench.
→ `10-gaps/multilingual-and-codemixed-retrieval.md`

## D17 — Ship opinionated embedding defaults + `halfvec`; stop saying only "BYO"
**Verdict.** "BYO embeddings" with no default forces every adopter to re-run a hard analysis.
Ship **two reference recipes**: **open/self-host default** = `Qwen3-Embedding-0.6B` (Apache-2.0,
Matryoshka, multilingual) for text + **Marqo-FashionSigLIP** (the only fashion-benchmark-proven
image tower; confirm checkpoint license) for images; **managed ceiling** = Gemini/Voyage-3.5
(int8/binary native) text + Cohere Embed v4 (one model for text+image). Make **`halfvec` the
default pgvector column** (proven ~50% storage/RAM cut, negligible recall loss — "no reason for
float32 to be the default"). Expose **Matryoshka truncation** + **binary-quantize + rescore** as
per-tenant scale levers (store `bit` index + `halfvec` payload from day one or rescore is
impossible to add later). Fuse text and image towers via **RRF** — never average across towers.
**Flip:** re-evaluate the default model when a new open multilingual model beats Qwen3 on the LK
bench, or when pgvector ships first-class int8 (issue #521), which changes the quantization recipe.
→ `10-gaps/embedding-model-selection.md`

## D18 — Query-side: doc2query at index-time + a *named* reranker; keep online-LLM expansion opt-in
**Verdict.** The highest-leverage query-side lever is **doc2query/docTTTTTquery at index time** —
append model-predicted queries (incl. **LK transliteration & code-mixed variants**, filtered via
Doc2Query--) to each product's FTS document. It costs **zero at query time**, needs no online LLM,
and **directly attacks vocabulary mismatch** (samesake's actual failure mode). Name the default
cross-encoder reranker: **`bge-reranker-v2-m3`** (Apache-2.0, 100+ langs, 0.6B, self-hostable) —
`mxbai-rerank-base-v2` as the alt, Cohere Rerank as a managed escape hatch; **avoid** Jina v2
(CC-BY-NC) and English-only MiniLM. Add an **LLM-generated synonym/taxonomy dictionary built
offline** (Postgres FTS thesaurus + canonical color/size/garment normalization). Keep **HyDE /
query2doc off the default hot path** (they need an online LLM per query and degrade on low-resource
LK); offer as opt-in BYO-generation tiers, **preferring query2doc** (anchored, helps FTS, resists
drift). **PRF/Rocchio (vector) + RM3 (sparse)** are an optional in-Postgres second round.
**LambdaMART/XGBoost** is the phase-2 feature-rerank home for score modifiers + personalization
(needs interaction data).
**Flip:** promote an online-LLM expansion tier to default only if it clears the LK bench within a
latency budget; adopt LambdaMART once a tenant has interaction logs.
→ `10-gaps/query-understanding-expansion-rerankers.md`

## D19 — Auditable merchandising, faceting, diversity & zero-result are table stakes (build them)
**Verdict.** A merchant cannot run a store on retrieval quality alone. Build, all expressible
inside samesake's existing shape: (1) **Score modifiers** — bounded scalar columns (popularity,
margin, recency, quality) × per-tenant weights, applied **multiplicatively after RRF** (never
additive, never an RRF leg, **never baked into the model** — that's the Marqo anti-pattern that
forfeits auditability); pins/hides as deterministic post-RRF splices; validity windows as SQL
`WHERE now() BETWEEN`. Every modifier's raw value + contribution emitted in `/search/explain` —
"auditable merchandising" is the headline differentiator. (2) **Diversity** — field-collapse
(`DISTINCT ON`/`ROW_NUMBER() PARTITION BY brand`) as the default, near-dup ε-collapse over top-K
embeddings, MMR only eval-gated. (3) **Faceting** — `GROUPING SETS` (the hard part is *correct
filtered counts*, not speed; it's a compiler job); `pgfaceting` documented as an escape hatch (not
AGPL ParadeDB). (4) **Zero-result relaxation ladder** (typo → synonym/translation → drop optional
terms → relax soft filters → **vector-only fallback** → honest empty), count-gated, **hard filters
never relax**, path logged in `/search/explain`. The vector-only fallback is the **LK weapon** when
code-mixed text defeats FTS. (5) **Freshness** = a decay-function score modifier.
**Flip:** add MMR only if field-collapse proves insufficient and grade@10/P@5 don't regress.
→ `10-gaps/merchandising-faceting-diversity.md`

## D20 — Personalization (CORRECTS Decision 05): content/context-vector personalization is in reach
**Verdict.** Decision 05's "samesake lacks personalization" was **too absolute** — true only of
*behavioral* personalization. **Content/context-vector personalization needs no interaction log**
and is a pgvector vector-add: build a **taste vector** = weighted mean of the embeddings of items
the user liked/viewed (`avg(embedding) WHERE id = ANY(...)`), fuse into the query vector
(`l2_normalize(q + β·taste)`), run the existing ANN. This is **Rocchio (1971)** / Marqo context
vectors / Qdrant `average_vector` / Weaviate ref2vec — all the same operation. Adopt Rocchio's
`α/β/γ` as merchandiser knobs surfaced in `/search/explain`. Add **negative examples**
("less-like-that", the `−γ·mean(disliked)` term) to the planned "more-like-this". Add **visual
onboarding cold-start** ("tap 3 looks you like" → centroid taste vector) — which **sidesteps LK
code-mixed parsing entirely** (users tap images), turning the weakest axis into a non-issue for
seeding. Maintain **multi-turn state as an externalized typed constraint accumulator** (add/replace/
relax deltas), not in the LLM ("lost in multi-turn"). Hard filters still gate first — personalized
**and** constraint-safe **and** auditable: a claim behavioral recsys cannot make. Still **avoid**
behavioral CF/two-tower (needs event infra + retrain).
**Flip:** build a behavioral surface only if a tenant brings its own interaction log and wants
samesake to own ranking over it.
→ `10-gaps/personalization-without-behavior-and-session-state.md`

## D21 — Agentic/MCP security: "stops at retrieval" is a security feature; harden the surface
**Verdict.** Exposing `findProducts()`/a UCP-MCP server inherits a real 2026 attack surface, but
samesake's design is a **security asset**: "stops at retrieval" removes leg 3 (consequential
action) of Simon Willison's **lethal trifecta**. samesake **owns** the *retrieval surface*:
(1) **typed/structured output, never a prose blob** (the cheapest, strongest anti-injection move —
structured data is far harder to weaponize); (2) **per-field provenance + source-trust tier**
carried into results + a **trust-gated score modifier** so untrusted seller/UGC text can't
monopolize top-k (direct counter to PoisonedRAG: 5 docs → 90% ASR); (3) **MCP hygiene to spec** —
OAuth 2.1 Resource Server, RFC 8707 audience validation, **MUST NOT accept/forward tokens not
issued for it**, **one read-only scope** (`catalog:search:read`), per-agent identity threaded into
the **hard SQL filter (gate-before-rank)**; (4) **exfiltration controls** — server-side max `k`,
per-identity quotas, **never return embedding vectors** (inversion risk), tenant isolation as a
predicate that gates *before* ANN; (5) **spotlighting-ready** marked untrusted fields + a
documented caller prompt template. **Avoid** becoming an OAuth proxy (use the app's own auth) and
**never claim "injection-safe"** (a retrieval layer can't — that closes in the caller's agent).
`/search/explain` doubles as the **incident-response audit surface**.
**Flip:** n/a — this is a standing security posture, not an option.
→ `10-gaps/agentic-mcp-security.md`

## D22 — Fit/sizing: own the retrieval surface, not the fit model
**Verdict.** Fit/size is the #1 apparel return reason (~53%), but fit *prediction* needs a
purchase+return outcome graph samesake doesn't have (and incumbents like True Fit derive theirs
from ~zero LK coverage). **Don't build a fit model; own the retrieval surface around it:**
(1) **size availability as a hard filter that gates before ranking** (`variants(sku,size,in_stock)`
→ SQL predicate) — highest-value, lowest-risk, ship first; (2) a **signed `fit_signal
{direction, confidence}`** ("runs small/true/large") as a typed **soft** signal / score modifier,
populated by **enrich** from reviews + visual (SizeNet-style cold-start) — never a gate; (3) a
typed **fit-profile** query-side context the NLQ parser populates; (4) a **BYO `FitRecommender`
adapter** (mirror BYO embeddings/rerankers) consumed as an RRF input / score modifier with
`/search/explain` provenance. **Avoid** body-scan/anthropometric ingestion (privacy-heavy, vendor-
owned). LK: availability gate + size-label normalization are universal wins; the signed signal is
best sourced from visual + code-mixed reviews.
**Flip:** build deeper fit modeling only if a tenant supplies return-outcome data and wants it.
→ `10-gaps/fashion-fit-sizing-returns.md`

## D23 — GEO/feeds: own catalog *legibility*, refuse rank-control
**Verdict.** External-agent discoverability is **mostly data legibility, not ranking** — and
ranking inside ChatGPT/Perplexity/Google is not something any layer can control (claiming it is
snake-oil). samesake owns the legible catalog. **Build:** (1) **feed export adapters** — one typed
catalog → **Google Shopping CSV** (the lingua franca that also feeds Perplexity), **OpenAI ACP
product feed**, and **schema.org `Product`/`Offer`/`Review` JSON-LD** (a clean compiler target,
perfectly on-identity); (2) a compile-time **`/catalog/lint` completeness/feed-health linter**
(missing GTIN, thin description, stale price, keyword-stuffed title) — attacks the "67% of products
lack the attributes AI needs" gap with a *local* check; (3) an optional **enrich-for-legibility**
mode following the **E-GEO "universal pattern"** (intent-aligned, spec-rich, review-grounded) **but
gated by factuality/provenance** — E-GEO proves *naive* LLM rewrites *lower* rank, and the GEO
paper proves **keyword stuffing actively hurts**. Provenance-backed attributes are more
citation-*absorbable* (the metric that matters, not mention count). **Avoid** ranking guarantees,
off-site PR/authority, building checkout, and mention-count dashboards (integrate Otterly/Peec).
LK reality: feed-legibility works regardless of payment rails and the same English-normalized
enrich output *also* helps code-mixed internal retrieval — one investment, two payoffs.
**Flip:** revisit if an engine ever exposes a real, queryable ranking signal (none does today).
→ `10-gaps/geo-aeo-agent-discoverability.md`

## D24 — Visual depth: VL-CLIP enrich now; VLM-rerank + MUVERA as gated pilots; avoid raw ColPali
**Verdict.** Beyond plain CLIP ANN: **adopt VL-CLIP-style enrich preprocessing** (visual-ground/
crop the garment before image embedding; LLM-normalize attribute text before text embedding) — it's
index-time, fits the existing enrich pipeline, and is the only candidate with a *quantified
production lift* (+18.6% CTR, +4% GMV at Walmart). Add an **optional VLM reranker** over top-k≤20
(off by default) as the multimodal generalization of the planned cross-encoder — plausibly the
strongest LK code-mixed lever, **but gate it on the LK bench**. **Avoid** raw ColPali/ColQwen
multi-vector retrieval (no native pgvector MaxSim, 256KB/page, no fashion benchmark) and
**VectorChord** (AGPLv3 copyleft — incompatible with shipping into the customer's app). If
late-interaction is wanted, **MUVERA FDE** is the only path that stays in plain pgvector (collapses
multi-vectors to one approximating-MaxSim vector) — pilot it. Add **OWL-ViT region localization →
bbox "highlights"** (Apache-2.0, index-time) for multi-garment imagery and region-level
more-like-this — a `/search/explain` differentiator. **Avoid blanket background removal** (degrades
pretrained encoders).
**Flip:** adopt a native-MaxSim path if pgvector gains multi-vector support (issue #640).
→ `10-gaps/visual-late-interaction-and-multimodal-rerank.md`

## D25 — Eval methodology: trust aggregate deltas, never close the LLM loop, interleave for low traffic
**Verdict (deepens Decision 06).** `grade@10 ≈ 2.33` is **generated by a Gemini ESCI judge, not
measured.** The literature (UMBRELA on TREC) shows graded-relevance LLM judges are only "fair" per
item (Cohen κ ≈ 0.31–0.37) but "high" at *system ranking* (Kendall τ ≈ 0.9): **trust relative,
aggregate deltas ("did B beat A on the frozen judge?"), never absolute per-item grades.** Operational
musts: (1) **never let the same model family enrich/generate product text AND judge it** (Gemini
self-preference closed loop — the single most important warning); (2) **version-pin + hash the judge
prompt and model snapshot** (a prompt edit silently rebases the benchmark) and expose it in
`/search/explain`; (3) use a **multimodal judge** (fashion is visual — a text-only judge is blind to
the cut/drape axis the image embeddings rank on); (4) add a **pairwise gate judge** alongside the
pointwise NDCG judge; (5) build a **~200-item native-speaker LK anchor set** (the MIRACL method) and
report Cohen's κ against it — it's the inversion detector that keeps the LLM loop open. For online
eval: **Team-Draft Interleaving beats A/B by 10–100× in sensitivity** → the right first-tenant tool
for low-traffic LK stores (A/B would be underpowered for months); A/B/switchback only to confirm
business lift and for non-ranking changes. Offline NDCG predicts online ~97% (Amazon SIGIR 2022)
**only if the E/S/C/I→gain mapping matches the tenant's conversion objective** — state and freeze it.
Build the **filtered-recall eval** (deterministic, no judge) as the correctness check.
**Flip:** n/a — standing eval discipline.
→ `10-gaps/eval-methodology-llm-judge.md`

---

## Net effect on the thesis

None of this overturns the core verdict (Decision 01); it **sharpens and hardens** it. The
completeness pass converts several "abstract" first-sweep recommendations into named, concrete,
licensed choices (the reranker, the embedding default, `halfvec`, doc2query), corrects one
over-absolute claim (personalization), and adds five capability areas the first sweep omitted
entirely (multilingual front-door, auditable merchandising, agentic security, fit-as-retrieval,
GEO feed-legibility). The recurring through-line holds: **everything either runs at index/build
time or inside the two containers; auditability (`/search/explain`) is extended to merchandising,
security, fit, and GEO; and the LK code-mixed corpus is the axis where samesake is simultaneously
weakest and most differentiated.**

## Vendors checked (no change to the competitive picture)
The additional-vendors sweep (Pinecone, Vectara, Turbopuffer, Zilliz, Shopify Search & Discovery,
Fast Simon, Unbxd, Luigi's Box, Doofinder, Searchanise, Hawksearch, GroupBy, etc.) confirmed the
first sweep's market read: all are hosted SaaS or managed-vector services; none compiles search
into the customer's own Postgres. **Athos Commerce** (search + GEO + feed + *fashion* focus) is the
closest bundle-shaped overlap and worth watching as a competitor or a distribution channel samesake
could feed. → `10-gaps/additional-search-and-vector-vendors.md`
