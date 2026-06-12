# prior-art-research.md — What's been done before, and what we should borrow

**Companion to:** [`db-investigation.md`](./db-investigation.md) (the architecture plan) and [`rfcs/imports-and-matching/`](./rfcs/imports-and-matching/) (the execution RFCs).
**Goal:** Meticulously survey existing work — academic, open-source, commercial — that overlaps with the imports-and-matching feature. For each item: state what it is, decide whether to adopt, borrow a specific idea, file as "future option", or ignore. Result in concrete deltas back to the plan.
**Method:** Three parallel channels — web search (academic + blogs + competitor product pages), `gh` CLI (repo discovery + repo metadata), Context7 (canonical library docs we might have missed). 30+ distinct queries; deduplication and verdict per item below.
**Date:** 2026-05-15.

---

## 1. TL;DR

1. **The hybrid model we proposed has academic validation.** Joe Ornstein's 2024 paper "Probabilistic Record Linkage Using Pretrained Text Embeddings" (Cambridge *Political Analysis*) and its R package `fuzzylink` combine **Fellegi-Sunter probabilistic record linkage** with **pretrained embedding cosine** as a learned feature. That is structurally what `db-investigation.md` §4.1 prescribes. We're not freelancing; we're on a known-good architecture. Cite this in the RFC.

2. **There is an actual benchmark dataset for our exact languages.** Ranathunga et al. (2025) — "*A multi-way parallel named entity annotated corpus for English, Tamil and Sinhala*" — released a CC0 dataset at `github.com/suralk/multiNER`. This is the **first real evaluation set** we can use to compute precision/recall for the matcher on Sinhala and Tamil specifically, instead of relying on synthetic intuition. Add to the program acceptance criteria.

3. **`pgvector` 0.8.0 added `hnsw.iterative_scan`** — the feature we genuinely need for per-tenant filtered HNSW queries. **Supabase ships pgvector 0.5.1.** This is a real gap. Without iterative scan, a `WHERE "ownerId" = $1 ORDER BY embedding <=> $q LIMIT 5` with a small-tenant filter can return zero matches because HNSW returns its top-40 globally before the filter applies, and most of those 40 may belong to other tenants. Workaround on 0.5.1: pre-filter via subquery + materialise the candidate set, or raise `hnsw.ef_search`. Long-term: ask Supabase to upgrade.

4. **Reciprocal Rank Fusion (RRF) with k=60** is the standard way to combine ranked lists from heterogeneous scorers (embedding cosine + trigram + alias + phone). It's score-scale-independent, doesn't need our component weights tuned by hand, and is what ParadeDB, OpenSearch, Elasticsearch, Tiger Data, and the Postgres community recommend. **This is potentially superior to the probabilistic-OR formula in `db-investigation.md` §4.1**. Both produce sensible rankings; RRF has more validated tooling and zero score-normalisation tax. Worth A/B-testing post-launch.

5. **Indic-specific fuzzy matching exists** — `libindic/inexactsearch` combines edit distance with **Indic Soundex** for cross-script "sounds-like" matching across Indian languages. The technique generalises to Sinhala/Tamil. We can port the Soundex idea into a Postgres function for ~30 lines of SQL and use it as one more component in the hybrid scorer. Low effort, real upside on transliterated names like `Anuhas` ↔ `අනුහස්`.

6. **`Singlish-Transliterator` and `aspriya/Sinhala-Transliterator`** are open-source tools for Sinhala ↔ Singlish (romanised). Combined, they let us **auto-generate aliases** when the user confirms a match (e.g., confirming `Amma → අම්මා` also seeds `Amma` ↔ `Amma`, `amma`, `Ammā` as aliases). Phase 6 idea, not launch — but cheap to add.

7. **`dedupe`, `Splink`, `Zingg` aren't drop-ins.** They're all batch-oriented Python tools designed for "given two datasets, link them once" — not "given a query, find candidates online with sub-50ms latency." Their *math* is reusable (Splink's Fellegi-Sunter weights, Dedupe's blocking) but their *runtime* isn't. Don't pull them in.

8. **Khatabook / OkCredit / Vyapar** are the direct SME-bookkeeping competitors and they support 11–13 Indian languages. None publicly advertise AI-extraction with **name-matching back to existing contacts/inventory**, which is the actual gap we're filling. They have multilingual UI; we'd have multilingual extraction *plus* matching. That's a real differentiator.

9. **Receipt OCR + SKU resolution is a solved enterprise problem** (Microblink: 15M-product catalogue; Veryfi: 38 languages, 99%+ accuracy; Mindee/Nanonets in the same tier). But: these are *commercial vendors*. Their tech stacks aren't reusable. What they prove is that the problem is solvable at scale — useful as evidence to defenders of the plan, not as software to integrate.

10. **Cloudflare's Workflows + Queues + Dynamic Workflows (announced May 2026)** make our decision in `db-investigation.md` to defer Inngest more defensible than I initially framed it. Cloudflare is investing heavily in this primitive; staying native pays a long-term dividend.

**Net impact on the plan:** four concrete deltas (sections 5–8 below). No fundamental rethink. The architecture survives contact with the literature.

---

## 2. Method

Three channels in parallel, with manual deduplication.

| Channel | Coverage | Queries run |
|---|---|---|
| **Web search** | Academic papers (arXiv, ACL, ScienceDirect, Cambridge), engineering blogs (Cloudflare, Supabase, ParadeDB, Tiger Data, AWS, EDB), vendor product pages (Veryfi, Microblink, Mindee), HN discussions, comparison sites | 14 queries across angles |
| **`gh search`** | Open-source repos by topic / language / keyword, individual repo metadata via `gh repo view --json` | 12 searches; deep-inspected ~10 repos |
| **Context7** | Canonical library docs for pgvector | 1 ID resolve + 1 doc query |

Search angles deliberately covered:
- Established entity-resolution stacks (Splink, Zingg, dedupe, Senzing, PyJedAI, DedupliPy, Awesome-Entity-Resolution list)
- Embedding-augmented record linkage (fuzzylink, Ornstein 2024)
- Multilingual entity recognition for Sri Lankan languages (Ranathunga et al. 2025 corpus + benchmark; AI4Bharat tooling; libindic)
- Indic transliteration libraries (IndicXlit, indic_transliteration_py, libindic/sdk-transliteration, AI4Bharat/IndicNLP-Transliteration)
- Sinhala-specific tooling (aspriya/Sinhala-Transliterator, Singlish-Transliterator, polyvox)
- Postgres+pgvector hybrid retrieval (ParadeDB pg_search, Tiger Data, Jonathan Katz blog, RRF tutorials)
- Receipt OCR + SKU resolution commercial (Microblink, Veryfi, Mindee, Nanonets)
- Bookkeeping app competitors (Khatabook, OkCredit, Vyapar, myBillBook)
- Cloudflare Workers + Supabase + Hyperdrive production patterns
- Durable execution comparison (Inngest, Trigger.dev, Temporal, Cloudflare Workflows)

Deliberately not covered (out of scope for the matching problem):
- General OCR engine quality benchmarks (we're committed to Gemini Flash for extraction).
- Mobile-side UX patterns (separate workstream).
- Production observability tooling (Grafana, Datadog).

---

## 3. Prior art catalogue with verdicts

Each entry: name + source link + one-paragraph description + **Verdict** (Adopt / Borrow idea / Future option / Reject) + concrete consequence for our plan.

### 3.1 Established entity-resolution libraries

#### Splink — `moj-analytical-services/splink`
- **What:** Python + SQL package for Fellegi-Sunter probabilistic record linkage. 2,152 stars. Used by the Australian Bureau of Statistics for the 2026 Census quality assurance. Multi-backend (DuckDB, Spark, Athena; *no native Postgres backend* but a Clickhouse fork exists at `ADBond/splinkclickhouse`). Validated math; well-documented Fellegi-Sunter weight learning via expectation-maximisation.
- **Verdict:** **Borrow idea — adopt the *math*, not the *library*.**
- **Why:** Splink is batch-oriented. Its workflow is "load two datasets, train weights on a labelled sample, emit a linked output." That's not our shape — we need online <50ms candidate scoring per OCR-extracted name. But the Fellegi-Sunter framework (m-probabilities for matches, u-probabilities for non-matches, log-Bayes-factor weights per feature) is the right way to think about combining heterogeneous comparison signals. The probabilistic OR in `db-investigation.md` §4.1 is a hand-rolled approximation of Fellegi-Sunter; once we have telemetry from `match_candidate.outcome`, the weights formalise into proper Fellegi-Sunter weights. **No code from Splink; we lift the framework.**
- **Plan delta:** Document the Fellegi-Sunter framing in Phase 6 (telemetry retune). When we tune the formula, do it as m/u probabilities estimated from `match_candidate` data, not as freelance weights.

#### dedupe (`dedupeio/dedupe`)
- **What:** Python active-learning library for fuzzy matching and dedup. 4,463 stars — the most-installed open-source ER library. Trains a logistic regression on user-labelled match/non-match pairs. Also a paid SaaS (dedupe.io) with a UI.
- **Verdict:** **Reject as a runtime dependency. Borrow the active-learning workflow as a UI pattern.**
- **Why:** Same problem as Splink — batch-oriented, requires user-labelled training pairs upfront. We have zero labels at launch. But dedupe's UX (show the user uncertain pairs, ask "match / no-match / unsure", retrain) is the right shape for our **telemetry-driven retune** loop. Phase 6 can adopt that workflow conceptually.
- **Plan delta:** When we add the "review your auto-linked entries" UI in a future RFC, model the interaction on dedupe's labelling flow — present highest-uncertainty pairs first.

#### Zingg (`zinggAI/zingg`)
- **What:** Scalable identity resolution + entity resolution + MDM. Python + Java. 1,199 stars. Integrates with Databricks, Snowflake, AWS, Fabric. Active-learning model.
- **Verdict:** **Reject.**
- **Why:** Lakehouse-scale tool aimed at data engineering teams. Operational footprint is far heavier than our problem warrants. No standout idea we don't already get from Splink/dedupe.
- **Plan delta:** None. Note in the "evaluated and rejected" log.

#### Senzing
- **What:** Commercial entity resolution platform with newly-added Spark batch mode + transactional SQL + hybrid. Closed-source. "Real-time AI for ER."
- **Verdict:** **Reject.**
- **Why:** Commercial, closed, expensive, overkill for our cardinality. Their *blog* (the "Four Generations of Entity Resolution" framing) is intellectually useful but they have no product surface we'd buy.
- **Plan delta:** None.

#### PyJedAI (`AI-team-UoA/pyJedAI`)
- **What:** End-to-end ER workflows in Python. Schema matching, blocking, matching, clustering pipelines.
- **Verdict:** **Future option for offline evaluation tooling.**
- **Why:** Useful for **batch evaluation runs** against the Ranathunga multiNER corpus (finding 2). Not for our online matcher. Could plug into the Phase 6 telemetry/eval setup.
- **Plan delta:** Mention as a possible eval harness when we build the precision/recall measurement framework post-launch.

#### DedupliPy, ZeroER, HierGAT, deeper-lite, goldenmatch, Spark-Matcher
- **Verdict (all):** **Reject.**
- **Why:** Various academic or industry-scale tools. None offer something the Splink + fuzzylink axis doesn't already give us at a level closer to our shape.

#### Awesome-Entity-Resolution (`OlivierBinette/Awesome-Entity-Resolution`)
- **What:** 121-star curated list of ER software and resources. Best single index of the field. Includes the "Four Generations of Entity Resolution" framing.
- **Verdict:** **Adopt as the reading list for whoever owns the matcher long-term.**
- **Plan delta:** Link from `db-investigation.md` Appendix A.

### 3.2 Embedding-augmented record linkage (academic state-of-the-art)

#### fuzzylink (`joeornstein/fuzzylink`) + Ornstein 2024 paper (Cambridge *Political Analysis*)
- **What:** Probabilistic Record Linkage Using Pretrained Text Embeddings. R package (18 stars, also on CRAN). Combines pretrained embedding cosine with Jaro-Winkler in a logistic-regression-style match probability model. API: `fuzzylink(by, record_type, blocking.variables, model, embedding_model, instructions)`. Backed by a published paper (Cambridge Core, Political Analysis).
- **Why this matters:** **This is the academic validation of our exact architecture.** The paper's central finding: cosine similarity over pretrained embeddings produces a **better Fellegi-Sunter feature** than edit-distance-style lexical similarity, *especially when the strings encode the same entity in different surface forms* (acronym vs full name; transliteration; cross-language). Our problem (`sugar ≈ සීනි ≈ sini`) is literally the example domain the paper validates.
- **Verdict:** **Adopt the architecture, cite the paper in §4.1 of `db-investigation.md`.** Don't pull the R package — port the *method* into our SQL functions.
- **Plan delta:**
  - Add a citation to `db-investigation.md` §4.1.
  - Update RFC 03 (people matcher live) to note that the score combination is empirically validated by Ornstein 2024 — not freelancing.
  - The R package's output columns (`sim` for embedding cosine, `jw` for Jaro-Winkler) map onto our `match_candidate.components` JSON. Use the same column names for code-archaeology continuity.

#### "Probabilistic Record Linkage Using Pretrained Text Embeddings" paper
- **Reported experimental domains:** political candidates ↔ voter files; misspelled US city names ↔ Census; amicus signers ↔ donation records; political party names across languages.
- **Verdict:** **Cite as the architectural reference paper.** Read by whoever drafts RFC 03.

### 3.3 Multilingual fuzzy matching for Sri Lankan + Indic languages

#### multiNER corpus — Ranathunga et al. 2025 (`github.com/suralk/multiNER`)
- **What:** Multi-way parallel English-Tamil-Sinhala corpus with Named Entity annotations. Public domain (CC0). Compressed `nerannotateddatasets.zip` available; published in *Natural Language Processing Journal* (2025). Establishes benchmark NER results on multilingual pretrained LMs.
- **Why this matters:** **The first real benchmark dataset for our exact language combination.** Until now we'd be tuning the matcher against gut feel. With this corpus we have parallel English/Tamil/Sinhala entity strings — we can compute objective precision/recall numbers for the matching layer.
- **Verdict:** **Adopt as the evaluation set for the matcher.**
- **Plan delta:**
  - Add to `rfcs/imports-and-matching/README.md` §3 Gate 04 (Product Matcher): "Verify precision ≥ 0.85 / recall ≥ 0.70 on the Ranathunga 2025 multiNER evaluation set, English→Sinhala and English→Tamil entity pairs."
  - Build a small eval harness (`scripts/eval-matcher.ts`) that loads the corpus, embeds the entities, runs match_party, computes metrics. Lands as part of RFC 03 backfill PR.

#### libindic/inexactsearch
- **What:** Python fuzzy string search for Indian languages. Combines edit distance (the "written like" channel) with **Indic Soundex** (the "sounds like" channel). Cross-language: can search Hindi words inside Malayalam text. Uses bigram-average algorithm; threshold default 0.6.
- **Why this matters:** Indic Soundex is a phonetic hash specifically designed for Indian-language graphemes. `pg_trgm` is built for Latin alphanumerics; on Sinhala/Tamil clusters it underperforms because Indic scripts use grapheme clusters (e.g., `ක්‍ර` is one logical character spanning 3 Unicode codepoints). A phonetic hash sidesteps this entirely.
- **Verdict:** **Borrow the idea — port a small Indic-aware phonetic hash function into Postgres.**
- **Plan delta:**
  - Add a new SQL function `public.indic_phonetic_hash(text)` in Phase 2k. Roughly 30 lines of PL/pgSQL based on libindic's algorithm: strip vowels, normalise nasals, collapse equivalent consonants per script.
  - Add `name_phonetic_hash` text column on `customer`/`supplier`/`asset` with a btree index. One more comparison signal in the hybrid scorer.
  - Token cost: zero (deterministic SQL, no LLM call).

#### IndicXlit (`AI4Bharat/IndicXlit`)
- **What:** Transformer-based transliteration for 21 Indic languages, Roman ↔ native. By AI4Bharat (a major Indian-language NLP lab).
- **Critical caveat:** **Does NOT include Sinhala.** Includes Tamil but not Sinhala.
- **Verdict:** **Future option — use only for Tamil-side alias expansion if we add that affordance.**
- **Plan delta:** Note in §4.4 of `db-investigation.md` that automated alias generation for Tamil is feasible via IndicXlit; Sinhala needs a separate tool (see below).

#### Sinhala-Transliterator (`aspriya/Sinhala-Transliterator`)
- **What:** Python tool: Sinhala Unicode → Singlish (romanised Sinhala). Mature, simple, deterministic mapping table.
- **Verdict:** **Borrow — use at alias-generation time.**
- **Plan delta:** When a user confirms `Amma → අම්මා`, automatically generate the inverse: feed `අම්මා` through Sinhala-Transliterator → get `amma`, store as an alias. **Cheap, deterministic, no LLM.** Add to RFC 04 or RFC 06.

#### Singlish-Transliterator (`Sameera2001Perera/Singlish-Transliterator`)
- **What:** BERT-based Romanized Sinhala → Sinhala (reverse direction). Implementation of an IndoNLP 2025 shared-task paper. 2 stars, but academic-quality.
- **Verdict:** **Future option — useful if we get Latin-only Sinhala input from voice/OCR.**
- **Plan delta:** Note as a Phase 7+ candidate for handling voice transcription of Sinhala-pronounced-in-Latin input.

#### hindi-fuzzy-merge (`IDinsight/hindi-fuzzy-merge`)
- **What:** Stata + Python scripts for fuzzy matching Hindi transliterated into Latin. From a real-world development-economics fieldwork team. 7 stars but written by people doing this for a job.
- **Critical idea worth lifting — the stepwise tightening strategy:** Match in waves. First wave: exact match on name + relation. Second wave: exact on name, fuzzy on relation. Third wave: fuzzy on both with tighter threshold. Fourth wave: fuzzy on both with loose threshold. Each wave removes matched rows so the next wave operates on a smaller, harder set. Net effect: high-confidence matches lock in early; low-confidence matches face only their own kind.
- **Verdict:** **Borrow the stepwise strategy for the import flow.**
- **Plan delta:** RFC 05 (async import pipeline) should match in waves, not in one pass:
  1. Exact phone match → lock in.
  2. Exact normalised name → lock in.
  3. Alias hit → lock in.
  4. High-cosine + size+unit gate (products) or high-cosine + phone-prefix (people) → suggest at confidence ≥ 0.85.
  5. Embedding fallback → suggest at 0.55–0.85.
  6. Remainder → ask user.
  This is functionally what the threshold logic in `db-investigation.md` §4.1 does, but framing it as *waves* makes the import UI cleaner — show the user "8 of your 50 rows are linked with high confidence; review the 12 uncertain ones; the 30 already-confirmed don't need your attention."

#### Tamizhi-Net-OCR (`aaivu/Tamizhi-Net-OCR`)
- **What:** Tesseract adaptation for Tamil + Sinhala legacy fonts. Includes a parallel Tamil-Sinhala-English corpus.
- **Verdict:** **Future option as an OCR fallback.** Not relevant for matching directly.
- **Plan delta:** None for now; note as a backup if Gemini Flash extraction quality regresses for a specific font.

#### polyvox (`d-senyaka/polyvox`)
- **What:** Local, zero-cost trilingual chatbot for Sinhala/Tamil/English with mixed-script and transliterated-text detection. Topics: `entity-resolution`, `language-detection`, `multilingual`. 0 stars, but **the description is the exact problem space** we're in.
- **Verdict:** **Read the source.** Even if we don't borrow code, the author has confronted the same language-detection-and-routing problem and may have heuristics we can lift.
- **Plan delta:** Owner of RFC 03 reads polyvox's repo before drafting the language-detection step.

### 3.4 Postgres + pgvector + hybrid search patterns

#### pgvector 0.8.0 — `hnsw.iterative_scan`
- **What:** Released late 2024; Supabase ships 0.5.1. New feature: when a filtered HNSW query returns fewer than the LIMIT due to over-aggressive filtering, the planner can iteratively scan further into the index until LIMIT is satisfied or `hnsw.max_scan_tuples` is hit. Two modes: `strict_order` (exact distance ordering) and `relaxed_order` (95–99% recall, materially faster).
- **Why this matters:** **Our exact failure mode.** Without iterative scan, a query like `WHERE "ownerId" = $1 ORDER BY embedding <=> $q LIMIT 5` first returns the global top-40 by `ef_search`, then applies the tenant filter. If the tenant owns 1% of rows, on average only 0.4 rows survive the filter — *fewer than the requested LIMIT 5*. This silently degrades recall.
- **Verdict:** **Critical gap. Three-fold mitigation.**
- **Plan delta:**
  1. **Short-term (Supabase on 0.5.1):** Use a candidate-set materialisation pattern. Pre-filter via the `customer_ownerId_idx` btree to get all rows for the tenant, *then* re-rank by `embedding <=> $q`. For tenants with <500 entities this is exact and fast. For tenants with >500 entities this becomes the slow path — accept it; the largest current tenant has 305 customers and 694 assets.
  2. **Medium-term:** Raise `hnsw.ef_search` per-query for filtered cases. Use `SET LOCAL hnsw.ef_search = 200` inside the `match_party` function when a tenant filter is in play. This is a temporary hack until upgrade.
  3. **Long-term:** Ask Supabase to upgrade to pgvector ≥ 0.8.0. Open a ticket once the program ships. Once available, the SQL function switches to:
     ```sql
     SET LOCAL hnsw.iterative_scan = relaxed_order;
     SET LOCAL hnsw.max_scan_tuples = 20000;
     ```
- Add this whole section to `db-investigation.md` §4.1 and §6.1 as a gotcha.

#### pgvector HNSW configuration (Context7)
- **Key findings from canonical docs:**
  - HNSW supports `vector_cosine_ops`, `vector_l2_ops`, `vector_ip_ops`, `vector_l1_ops`; plus `halfvec_*`, `sparsevec_*`, `bit_hamming_ops`, `bit_jaccard_ops` variants.
  - Default `m = 16`, `ef_construction = 64`. For our scale, defaults are correct (confirmed in §5 Phase 2e of the investigation).
  - **`hnsw.ef_search` is per-session** — `SET hnsw.ef_search = 200` before a filtered query is the standard tuning knob.
  - **Build faster:** `SET maintenance_work_mem = '8GB'; SET max_parallel_maintenance_workers = 7;` before `CREATE INDEX`. **Relevant for the Phase 3 backfill.**
  - Index progress: `SELECT phase, round(100.0 * blocks_done / nullif(blocks_total, 0), 1) FROM pg_stat_progress_create_index;`
- **Verdict:** **Adopt the `maintenance_work_mem` + parallel workers settings in Phase 3 backfill RFC.**
- **Plan delta:** Update RFC 03's Phase 3 backfill script to bump these session settings before HNSW build. Cuts backfill time materially on the asset HNSW build.

#### Reciprocal Rank Fusion (RRF), k=60
- **What:** Standard hybrid-search ranking combiner. Each retrieval channel produces a ranked list. For each candidate, score = Σ over channels of `1.0 / (60 + rank_in_channel)`. Score-scale-independent. Default k=60 is empirically validated across diverse datasets (the OpenSearch + Elasticsearch + ParadeDB + Tiger Data + Microsoft community consensus).
- **Why this matters:** Our `db-investigation.md` §4.1 uses a probabilistic-OR formula: `1 - Π(1 - w_i · score_i)`. That formula requires:
  - All scores normalised to [0,1] (we already do this).
  - Hand-tuned `w_i` weights per channel (we have rough starting values: cosine 0.6, trigram 0.25, alias 0.4).
  - Re-tuning every time we add a channel.
  RRF avoids all three. It only cares about *ranks*, not raw scores. Adding a new channel doesn't require re-tuning others. Established tooling assumes it.
- **Verdict:** **Hold both. Ship probabilistic OR for v1 (we already have the SQL). Add RRF as a parallel computation in `match_candidate.components`. A/B-test which produces higher precision at the auto-link threshold after 2 weeks of telemetry.**
- **Plan delta:** Update `match_candidate.components` JSON to store both:
  ```json
  {"prob_or": 0.91, "rrf": 0.027, "channels": {...}}
  ```
  After 2 weeks of `match_candidate.outcome` data, compute precision@auto-link for each scoring scheme. Pick the winner. This is a tiny extra SQL cost — both formulas are arithmetic over the same component scores.

#### ParadeDB pg_search
- **What:** BM25 native Postgres extension. The mature alternative to `pg_trgm` for full-text scoring inside Postgres. Brings Elasticsearch-grade scoring without the operational cost of running Elasticsearch.
- **Verdict:** **Reject for v1; future option if `pg_trgm` proves inadequate.**
- **Why:** Not available on Supabase managed (it's a third-party extension). We'd need to either self-host Postgres or wait for Supabase to enable it. For our short-name matching problem, `pg_trgm` is sufficient — BM25 shines on long documents, not 5-token product names. Revisit only if telemetry shows `pg_trgm` is the weakest link.
- **Plan delta:** Mention as the "if pg_trgm proves inadequate" follow-up in `db-investigation.md` §8 risks.

#### pgvectorscale (`timescale/pgvectorscale`)
- **What:** Timescale's pgvector extension. Adds StreamingDiskANN index + statistical binary quantization. Higher Context7 benchmark score (90.7) than pgvector itself (85.4) — meaning better doc quality, not necessarily better performance.
- **Verdict:** **Future option, not v1.**
- **Why:** It's a more advanced index family, valuable at ≥10M vectors. We have 50k. Adding a non-stock Postgres extension to Supabase means waiting for Supabase to enable it. Stay on stock `pgvector`.
- **Plan delta:** Note in the "when to revisit" break-out triggers (§3.3 of `db-investigation.md`).

#### Hyperdrive + Supabase docs (`developers.cloudflare.com/hyperdrive`)
- **Adopt:** `db-investigation.md` §6.1 already prescribes Hyperdrive. Confirmed best practice — use `DIRECT_URL` (:5432) not pooled (:6543), use a real driver (postgres-js, node-postgres) not `supabase-js`. Cloudflare's docs are explicit.
- **Plan delta:** None — the plan is already aligned.

### 3.5 Receipt OCR → SKU resolution (commercial state-of-the-art)

#### Microblink
- **What:** Commercial receipt OCR. Proprietary 15M+ SKU catalogue. Translates SKU-level codes into full product info during OCR. Used by major retail analytics platforms.
- **Verdict:** **Not a buy candidate.** Closed, expensive, designed for global retail brand audiences. Our problem is per-tenant catalogues, not global SKU resolution.
- **Why it matters:** **Evidence the matching problem is enterprise-solvable.** Useful as a defender of the plan if someone asks "is this even possible?"
- **Plan delta:** Cite in §1 of `db-investigation.md` ("existence proof at enterprise scale").

#### Veryfi
- **What:** Receipt OCR API, 38 languages, 99%+ accuracy claim, 91 currencies.
- **Verdict:** **Reject.** Same reasoning as Microblink — closed commercial vendor.
- **Plan delta:** None.

#### Mindee, Nanonets
- **Verdict:** **Reject.**
- **Why:** Same category — commercial OCR-as-a-service. Their existence is evidence; their software isn't reusable.

### 3.6 Direct competitors (SME bookkeeping apps)

#### Khatabook, OkCredit, Vyapar, myBillBook
- **What:** Indian SME bookkeeping apps. Khatabook: 13+ Indian languages incl. Tamil. OkCredit: 11 Indian languages incl. Tamil, Bengali, Marathi. Vyapar: GST invoicing focus. myBillBook: similar.
- **Notable gap:** None of these publicly advertise **AI-extraction with name-matching back to existing contacts/inventory**. They have multilingual UI; their AI features are around invoice generation and OCR-import-of-purchase-bills (vendor side), not credit-book-style customer entry extraction.
- **Verdict:** **Confirmed competitive whitespace.** Our differentiator is the matching layer, not OCR.
- **Plan delta:** None for the technical plan. **Marketing-relevant**: this is the "intelligent bookkeeping" pitch.

### 3.7 Durable execution for async pipeline

#### Cloudflare Workflows + Queues + (May 2026) Dynamic Workflows
- **What:** Cloudflare's growing durable-execution stack. Dynamic Workflows (announced May 2026 via InfoQ) enables per-tenant code loading at the isolate level — zero idle cost. Combined with native Queues (transaction-mode pooling) and existing Cron Triggers.
- **Verdict:** **Adopt — aligns with `db-investigation.md` §3.3 + §6.1's existing call.** Cloudflare is investing heavily in this; staying native pays a long-term dividend as features land.
- **Plan delta:** Strengthen the "no Inngest" stance in RFC 05 (async import pipeline). Add a one-line note: "Cloudflare's investment in this primitive (Workflows GA, Dynamic Workflows May 2026) makes the native path the long-term right call, not just the cheap-near-term one."

#### Inngest
- **What:** Event-driven durable workflow engine. Excellent DX. Per-execution pricing.
- **Verdict:** **Defer.**
- **Why:** Already covered in `db-investigation.md` discussion. The new finding (Cloudflare Dynamic Workflows) reinforces the deferral.
- **Plan delta:** None — the existing decision holds.

---

## 4. Five most important findings (concrete deltas to the plan)

Ordered by impact:

### 4.1 pgvector 0.8.0 `iterative_scan` — and Supabase's lag at 0.5.1

**Problem:** Without `iterative_scan`, filtered-HNSW queries (`WHERE ownerId = $1 ORDER BY embedding`) suffer silent recall loss because the filter applies *after* HNSW returns its top-`ef_search` neighbours globally.

**What changes:** Add a new subsection to `db-investigation.md` §4.1 documenting the three-step mitigation (candidate-set materialisation now → `SET LOCAL hnsw.ef_search = 200` → request Supabase upgrade). Update RFC 03 to ship a "tenant-pre-filter" SQL pattern, not a naive HNSW order-by.

### 4.2 Ranathunga 2025 multiNER corpus — real evaluation set

**Problem:** Without an objective benchmark, threshold-tuning is a gut exercise.

**What changes:** Add to `rfcs/imports-and-matching/README.md` §3 a gate that requires the matcher to hit `precision ≥ 0.85, recall ≥ 0.70` on the corpus's English↔Sinhala and English↔Tamil entity pairs. Build a small eval harness in RFC 03's Phase 3.

### 4.3 RRF as an alternative to probabilistic OR

**Problem:** Our score-combination formula in `db-investigation.md` §4.1 is hand-rolled. RRF is the industry standard with empirically-validated `k=60` default.

**What changes:** Ship both. Store `match_candidate.components` with both scores. After 2 weeks of telemetry, A/B-test and pick the winner. Update RFC 03 schema.

### 4.4 Fellegi-Sunter framing + Ornstein 2024 citation

**Problem:** The hand-rolled formula needs an academic anchor for code archaeology and team understanding.

**What changes:** Add a citation to `db-investigation.md` §4.1 referencing Ornstein 2024 "Probabilistic Record Linkage Using Pretrained Text Embeddings". Frame the formula as a Fellegi-Sunter approximation we'll formalise once `match_candidate.outcome` data exists.

### 4.5 Indic phonetic hash as a fifth scoring channel

**Problem:** `pg_trgm` underperforms on Sinhala/Tamil grapheme clusters. `libindic/inexactsearch`'s Indic Soundex addresses exactly this gap.

**What changes:** Add a new `indic_phonetic_hash(text)` SQL function (~30 lines, deterministic, no LLM). Add `name_phonetic_hash` columns on `customer`/`supplier`/`asset` with btree indexes. One more comparison signal in the hybrid scorer. Lands as Phase 2k in `db-investigation.md` §5.

---

## 5. Concrete plan diffs (file-by-file)

### `db-investigation.md` changes

| Section | Change |
|---|---|
| §1 TL;DR | Add a bullet: "Hybrid retrieval is academically validated (Ornstein 2024 *Political Analysis*). pgvector 0.8.0 `iterative_scan` is the right primitive for filtered HNSW; Supabase's 0.5.1 lacks it — three-step mitigation documented." |
| §4.1 Hybrid retrieval, ranked | Add the **Fellegi-Sunter framing** + cite Ornstein 2024. Add the **RRF alternative scoring** as a parallel formula. Add the **iterative_scan gotcha** with three-step mitigation. Add **Indic phonetic hash** as the fifth channel in the score table. |
| §4.4 Product matching | Add **stepwise matching strategy** (IDinsight pattern) as the structuring principle for the import flow. |
| §5 Phase 2 | Add **2k: `indic_phonetic_hash(text)` SQL function and `name_phonetic_hash` columns**. Add **session-level pgvector tuning** (`maintenance_work_mem`, `max_parallel_maintenance_workers`) to Phase 3 backfill block. |
| §6.1 | Document the **filtered-HNSW mitigation pattern** (tenant pre-filter → ef_search bump → upgrade ask). |
| §8 risks | Add row: "pgvector 0.5.1 lacks iterative_scan — filtered queries can under-recall. Mitigation as in §4.1; upgrade ask filed with Supabase." |

### `rfcs/imports-and-matching/README.md` changes

- §3 Gate 04 (Product Matcher): add line "precision ≥ 0.85 / recall ≥ 0.70 on Ranathunga 2025 multiNER eval set."
- §7 Guiding light: add item 11: "Match in waves, not one pass — high-confidence first, low-confidence last (IDinsight pattern)."

### RFC 03 (people matcher live, currently Stub) — pre-draft notes

- Schema: `match_candidate.components` includes both `prob_or` and `rrf` scores.
- Eval harness: `scripts/eval-matcher.ts` loads Ranathunga 2025 corpus, computes precision/recall.
- SQL: `match_party` uses tenant pre-filter (subquery) → re-rank, not naive HNSW order-by.

### RFC 05 (async import pipeline, currently Stub) — pre-draft notes

- Import workflow processes rows in 6 waves (exact phone → exact name → alias → high-cosine+gate → mid-cosine → human).
- UI surfaces "X confirmed / Y to review / Z auto-confirmed" rather than a single flat list.

---

## 6. What we evaluated and rejected (the negative log)

- **Splink, Zingg, dedupe, Senzing, PyJedAI, DedupliPy, goldenmatch as runtime deps** — batch-oriented; wrong shape.
- **pgvectorscale, ParadeDB pg_search** — better tools, blocked by Supabase managed limitations; revisit if scale justifies.
- **Microblink, Veryfi, Mindee, Nanonets as integrations** — commercial vendors; our problem is per-tenant, not global SKU.
- **IndicXlit for Sinhala** — doesn't cover Sinhala (Tamil only).
- **Tamizhi-Net-OCR** — alternative OCR engine; we're committed to Gemini Flash.
- **Inngest, Trigger.dev, Temporal** — durable-execution overkill at our scale; Cloudflare-native primitives win.

Documenting these matters because future contributors will ask "why didn't we use X?" and the answer should be a sentence, not a rediscovery.

---

## 7. Open questions that remained open after research

1. **What is the *measured* performance of `gemini-embedding-001` on Sinhala/Tamil short strings specifically?** MMTEB benchmarks confirm strong low-resource performance broadly (Macedonian, Assamese cited). The Ranathunga corpus will let us measure for our exact languages — but only after Phase 3. We're committing on a strong prior; the answer comes from our own telemetry.
2. **Will Supabase upgrade pgvector to ≥ 0.8.0 in time for us to benefit from `iterative_scan`?** Unknown. Mitigation #1 (tenant pre-filter) works regardless; mitigation #3 is the cleaner long-term path. Worth a Supabase ticket once the program ships.
3. **Is the Indic Soundex actually a meaningful add on top of cosine + trgm + alias + phone?** Empirical question — we won't know until we A/B-test with and without it on the Ranathunga eval set. Cheap to ship; cheap to drop if it doesn't help.

---

## 8. Sources

### Academic papers
- Ranathunga et al. (2025). "A multi-way parallel named entity annotated corpus for English, Tamil and Sinhala." *Natural Language Processing Journal*. [arXiv:2412.02056](https://arxiv.org/abs/2412.02056) · [github.com/suralk/multiNER](https://github.com/suralk/multiNER) · [ScienceDirect](https://www.sciencedirect.com/science/article/pii/S2949719125000366)
- Ornstein, J. (2024). "Probabilistic Record Linkage Using Pretrained Text Embeddings." *Political Analysis*. [Cambridge Core](https://www.cambridge.org/core/journals/political-analysis/article/probabilistic-record-linkage-using-pretrained-text-embeddings/0414DDE200A0305EEDD7B31EA8849EB9) · [PDF](https://joeornstein.github.io/publications/fuzzylink.pdf) · [github.com/joeornstein/fuzzylink](https://github.com/joeornstein/fuzzylink)
- "Splink: Free software for probabilistic record linkage at scale." [IJPDS](https://ijpds.org/article/download/1794/3457/9089)

### Open-source projects (verdict-grouped)

**Adopted methodology / cited:**
- [moj-analytical-services/splink](https://github.com/moj-analytical-services/splink) — Fellegi-Sunter framework (math only)
- [joeornstein/fuzzylink](https://github.com/joeornstein/fuzzylink) — embedding + FS architecture (cited)
- [pgvector/pgvector](https://github.com/pgvector/pgvector) — HNSW, iterative_scan (0.8.0)
- [suralk/multiNER](https://github.com/suralk/multiNER) — evaluation corpus

**Borrowed specific ideas:**
- [libindic/inexactsearch](https://github.com/libindic/inexactsearch) — Indic Soundex technique
- [aspriya/Sinhala-Transliterator](https://github.com/aspriya/Sinhala-Transliterator) — Sinhala→Singlish alias generation
- [IDinsight/hindi-fuzzy-merge](https://github.com/IDinsight/hindi-fuzzy-merge) — stepwise tightening strategy
- [dedupeio/dedupe](https://github.com/dedupeio/dedupe) — active-learning UX pattern

**Future options:**
- [Sameera2001Perera/Singlish-Transliterator](https://github.com/Sameera2001Perera/Singlish-Transliterator) — IndoNLP 2025 BERT Singlish→Sinhala
- [AI4Bharat/IndicXlit](https://github.com/AI4Bharat/IndicXlit) — Tamil-side alias expansion
- [AI-team-UoA/pyJedAI](https://github.com/AI-team-UoA/pyJedAI) — offline eval harness
- [timescale/pgvectorscale](https://github.com/timescale/pgvectorscale) — at scale
- [aaivu/Tamizhi-Net-OCR](https://github.com/aaivu/Tamizhi-Net-OCR) — OCR fallback
- [d-senyaka/polyvox](https://github.com/d-senyaka/polyvox) — same-language-stack reference impl

**Reading list:**
- [OlivierBinette/Awesome-Entity-Resolution](https://github.com/OlivierBinette/Awesome-Entity-Resolution) — comprehensive ER resource list

### Engineering blogs and docs
- [pgvector 0.8.0 release](https://www.postgresql.org/about/news/pgvector-080-released-2952/)
- [Supabase pgvector docs](https://supabase.com/docs/guides/database/extensions/pgvector)
- [Supabase HNSW indexes guide](https://supabase.com/docs/guides/ai/vector-indexes/hnsw-indexes)
- [Cloudflare Hyperdrive + Supabase](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/supabase/)
- [Cloudflare Dynamic Workflows announcement (InfoQ, May 2026)](https://www.infoq.com/news/2026/05/cloudflare-dynamic-workflows/)
- [ParadeDB — Hybrid Search in PostgreSQL: The Missing Manual](https://www.paradedb.com/blog/hybrid-search-in-postgresql-the-missing-manual)
- [ParadeDB — What is Reciprocal Rank Fusion](https://www.paradedb.com/learn/search-concepts/reciprocal-rank-fusion)
- [Tiger Data — PostgreSQL Hybrid Search Using pgvector and Cohere](https://www.tigerdata.com/blog/postgresql-hybrid-search-using-pgvector-and-cohere)
- [Jonathan Katz — Hybrid search with PostgreSQL and pgvector](https://jkatz05.com/post/postgres/hybrid-search-postgres-pgvector/)
- [AWS — pgvector 0.8.0 on Aurora PostgreSQL](https://aws.amazon.com/blogs/database/supercharging-vector-search-performance-and-relevance-with-pgvector-0-8-0-on-amazon-aurora-postgresql/)
- [IDinsight — What's in a name (Part 1)](https://www.idinsight.org/article/part-1-whats-in-a-name-combining-datasets-when-unique-identifiers-are-missing/) · [Part 2](https://www.idinsight.org/article/part-2-whats-in-a-name-combining-datasets-when-unique-identifiers-are-missing/)

### Commercial vendors (for context, not adoption)
- [Veryfi Receipts OCR API](https://www.veryfi.com/receipt-ocr-api/)
- [Microblink Receipt OCR](https://microblink.com/products/data-capture-receipts/)
- [Mindee OCR](https://www.mindee.com/blog/leading-ocr-api-solutions)
- [Nanonets Receipt OCR](https://nanonets.com/ocr-api/receipt-ocr)
- [Khatabook](https://play.google.com/store/apps/details?id=com.vaibhavkalpe.android.khatabook)
- [OkCredit](https://okcredit.com/)
