# Eval Methodology Depth: LLM-as-Judge Reliability, Retrieval Benchmarks, and Online Evaluation

> Completeness-pass deep-dive for **samesake** — a TypeScript-first "search engine
> compiler" for visual commerce (fashion-first, Sri Lankan corpus: Sinhala/Tamil/English
> code-mixed). samesake compiles a typed catalog into a Postgres + pgvector layer running
> in the user's app (two containers; no Redis/Elasticsearch/hosted vector DB). Retrieval =
> Postgres FTS + cosine ANN over BYO embeddings + optional typed "spaces", fused via RRF.
> Hard filters compile to SQL predicates that gate before ranking; soft filters relax. It
> has an NLQ parser, multimodal enrich pipeline, entity-resolution/dedup, `/search/explain`,
> and a `findProducts()` agentic surface that STOPS at retrieval. Current bench: **mean
> grade@10 ≈ 2.33, P@5 0.83 on ~5k LK fashion docs**, scored by a **Gemini ESCI judge**.
> "Spaces" is off (failed the gate).

**Why this document exists.** Decision `07-decisions/06-eval-and-proof.md` already chose the
*metric set* — ESCI E/S/C/I grades, NDCG@10, Recall@20/50, head/tail stratification, a
filtered-recall eval, and online conversion as the eventual bar. This document fills the
**methodology** layer underneath those metrics: **is the Gemini judge that produces grade@10
trustworthy, and how would we know?** plus the benchmark-design and online-eval literature
the metric choices imply. Four parts:

1. **LLM-as-judge reliability & biases** — position, verbosity, self-preference, prompt
   sensitivity; calibration to human labels via Cohen's κ; the pointwise-vs-pairwise choice.
   *(samesake's grade@10 is produced by an LLM judge — this is the load-bearing part.)*
2. **Retrieval benchmarks beyond ESCI** — BEIR, MTEB/RTEB, MIRACL; the recurring lesson and
   its limits.
3. **Online evaluation** — team-draft interleaving vs A/B testing, sensitivity, offline→online
   metric correlation.
4. **Measuring filtered-recall and head/tail properly** — turning Decision 06 §3–4 into method.

**Evidence convention.** **[PROVEN]** = peer-reviewed paper / official benchmark / reproduced
result. **[MARKETED]** = vendor blog or unverified comparison. **[FAILED FETCH]** = source I
could not parse (PDF binary), facts taken from a secondary readable source and flagged.

---

# Part 1 — LLM-as-Judge Reliability & Biases

samesake reports `grade@10 ≈ 2.33`. That number is **not measured; it is generated** — a Gemini
model reads each `(query, product)` pair and emits an E/S/C/I grade. Every downstream claim
("the reranker beat baseline", "spaces failed the gate") inherits whatever bias and noise the
judge has. The first eval-methodology question is therefore **not** "what is grade@10?" but
**"how reliable is the instrument that produces grade@10, and is it calibrated to humans?"**

## 1.1 The foundational result: LLM judges *can* match humans — and have documented biases

The canonical study is **Zheng et al., "Judging LLM-as-a-Judge with MT-Bench and Chatbot
Arena," NeurIPS 2023** (arXiv:2306.05685). Its two headline claims are in tension and both
matter for samesake.

**Claim A — high agreement.** [PROVEN]

> "the agreement under setup S2 (w/o tie) between GPT-4 and humans reaches **85%**, which is
> even higher than the agreement among humans (**81%**)."

So a strong judge can equal or beat human-human agreement. This is the empirical license for
using an LLM judge at all. **But** the same paper documents four biases, each with numbers:

**Bias 1 — Position bias.** [PROVEN] In pairwise judging, the judge favors a slot, not the
better answer. From Table 2:

> "Position bias of different LLM judges. **Consistency** is the percentage of cases where a
> judge gives consistent results when swapping the order of two assistants."
>
> | Judge | Consistency | Biased→first | Biased→second |
> |---|---|---|---|
> | Claude-v1 (default) | **23.8%** | 75.0% | 0.0% |
> | GPT-4 (default) | **65.0%** | 30.0% | 5.0% |
> | GPT-4 (rename) | 66.2% | 28.7% | 5.0% |

Even GPT-4 flips its verdict **35% of the time** when you swap the order of two near-equal
answers. Crucially: *"position bias is more noticeable for models with close performance and
can almost disappear when the performance of the two models differs a lot"* — the bias is
**worst exactly where samesake needs the judge most** (distinguishing a *substitute* from an
*exact* match, or ranking two near-identical sarees). **Mitigation (proven):** swap positions
and only count a verdict if it is consistent; or use few-shot examples, which raised GPT-4
consistency *"from 65.0% to 77.5%."* (Caveat the authors add: *"high consistency may not imply
high accuracy."*)

**Bias 2 — Verbosity bias.** [PROVEN] Judges prefer longer answers even when not better. The
"repetitive list attack" (rephrase two list items, otherwise identical) had a **failure rate of
91.3% for both Claude-v1 and GPT-3.5**; GPT-4 *"defends significantly better."* For samesake
this maps onto **document-length / description-richness bias**: a product with a long,
keyword-stuffed enriched description may be graded *Exact* over a sparsely-described identical
item. This directly threatens the **enrich pipeline's** neutrality — if enrichment lengthens
descriptions, it can inflate grade@10 without improving retrieval.

**Bias 3 — Self-preference / self-enhancement bias.** [PROVEN, with the authors' own caveat]

> "GPT-4 favors itself with a **10% higher win rate**; Claude-v1 favors itself with a **25%
> higher win rate**. However, they also favor other models … Due to limited data and small
> differences, our study cannot determine whether the models exhibit a self-enhancement bias."

The stronger, separate study **"Self-Preference Bias in LLM-as-a-Judge" (arXiv:2410.21819)**
confirms judges favor text whose *style* they recognize as their own. **The samesake-specific
risk:** samesake is **BYO generation + BYO embeddings**, and a tenant may use **Gemini both to
enrich product descriptions and to judge relevance.** That is a closed loop — the judge would
systematically reward Gemini-written enrichments. This is the single most important
operational warning in this document.

**Bias 4 — Prompt sensitivity.** [PROVEN] The judge's verdict moves with semantically
equivalent rewordings of the rubric. The recent **JudgeSense benchmark (arXiv:2604.23478)**
formalizes this: *"scale does not predict consistency"* (bigger model ≠ more stable), and it
proposes a Judge Sensitivity Score (JSS) as a reporting figure. Practical reading: samesake's
grade@10 is only comparable across runs **if the judge prompt is frozen and version-pinned**.
A prompt edit is a measurement-instrument change and silently rebases the whole benchmark.

## 1.2 The IR-specific evidence: judges rank *systems* well even when they grade *items* only "fairly"

The MT-Bench result is about chat-answer preference. The closer analog to samesake is
**LLM-as-judge for graded relevance**, where the canonical reproducible result is **UMBRELA
(Upadhyay et al., arXiv:2406.06519)** — an open-source reproduction of Bing's relevance
assessor, now the official judge of the **TREC 2024 RAG Track**. It uses a 0–3 graded scale
(Irrelevant / Related / Highly relevant / Perfectly relevant) — structurally the same shape as
ESCI's 4-grade E/S/C/I. Its results expose **the central paradox samesake must internalize:**

[PROVEN] (Table 2, GPT-4o vs human NIST assessors, TREC Deep Learning 2019–2023):

| Track | Cohen κ (4-scale) | Cohen κ (binary) | Kendall τ (system rank) | Spearman ρ |
|---|---|---|---|---|
| DL 2019 | 0.36 | 0.50 | 0.89 | 0.97 |
| DL 2020 | 0.35 | 0.45 | 0.94 | 0.99 |
| DL 2021 | 0.37 | 0.49 | 0.93 | 0.99 |
| DL 2022* | 0.34 | 0.42 | 0.87 | 0.97 |
| DL 2023* | 0.31 | 0.42 | 0.91 | 0.99 |

Read this carefully, because it reframes everything:

- **Per-item agreement is only "fair."** Cohen's κ of **0.31–0.37** on the 4-scale is, by the
  standard Landis-Koch bands, only *"fair"* agreement (0.21–0.40). The judge **does not
  reliably reproduce a human's exact grade on a single item.** Confusion-matrix detail: the
  LLM matched human labels with *"roughly 75% accuracy"* for non-relevant, but only *"50%,
  30%, and 45%"* for the three positive grades. **The judge is weakest on the fine-grained
  positive distinctions** — which is precisely ESCI's hard part (Exact vs Substitute).
- **System-ranking agreement is "high."** Kendall τ of **0.87–0.94** means that when you use
  the judge to *rank competing retrieval systems by NDCG@10*, you get almost the same ordering
  a human would. The per-item noise **averages out** at the system-comparison level.

**The lesson for samesake, stated as a rule:** *An LLM judge is trustworthy for **relative,
aggregate** decisions ("did config B beat config A?") and untrustworthy for **absolute,
per-item** claims ("this specific product is exactly grade 2"). samesake's grade@10 = 2.33 as
a standalone number is soft; grade@10(reranker) − grade@10(baseline) as a gate decision is
defensible — provided the same frozen judge scores both arms.* This is the rigorous
justification for Decision 06 §5's "gate every lever" framing.

The UMBRELA case study even shows the judge being **more right than the human** on ambiguous
labels (a "daily life of Thai people" query where humans had marked a Thai-flag passage
"perfectly relevant"). LLM judges are not strictly worse — they are *differently* wrong, and
their errors are more systematic (hence cancellable by symmetry tricks) than human fatigue.

## 1.3 The skeptic's counterweight — do not close the human loop entirely

**Soboroff / Faggioli-lineage critique, "LLM-based relevance assessment still can't replace
human assessment" (arXiv:2412.17156)** [PROVEN — argument; FAILED FETCH on PDF binary, summary
via secondary read]: the danger is **circularity** — *"LLMs assessing other LLMs may introduce
bias toward LLM-generated content,"* producing **system-ranking inversions** versus human
qrels for some systems. The practical implication for samesake: **the judge can be trusted to
compare two retrieval configs, but must not be the sole arbiter when one config's outputs are
themselves LLM-shaped** (e.g., LLM-reranked, or LLM-enriched). Keep a **small human-labeled
anchor set** to detect drift.

## 1.4 The e-commerce / fashion-specific evidence (most directly applicable)

Two sources put LLM-judge directly in samesake's domain:

- **Zalando, "Leveraging Multimodal LLMs for Large-Scale Product Retrieval Evaluation" (2024)**
  [MARKETED blog announcing a peer-reviewed paper; numbers from the blog]. Zalando uses a
  **multimodal** judge — *"MLLMs assign relevancy scores to the search results based on both
  textual and visual descriptions"* (product packshot + query + attributes) — on a 3-tier scale
  ("highly relevant" / "acceptable substitute" / "irrelevant", i.e. a compressed E/S/I).
  Reported: **GPT-4o ≈ 80% agreement** with human annotator groups (EN + DE); **20,000
  query-product pairs in ~20 minutes**; *"up to 1,000× cheaper than human labor."* **The
  fashion-specific caveat is the gold here:** the LLM was *"often too strict in their judgement"*
  on **color/style variations**, while humans *"maintained superiority on nuanced cases like
  style and trend interpretation."* For an LK fashion corpus where *style* and *substitute*
  judgments dominate, this is the exact failure surface to monitor.
- **"Large Language Models for Relevance Judgment in Product Search" (arXiv:2406.00247)** and
  **Amazon's reported ~89% agreement** ("relevance models achieve agreement with human
  evaluators' NDCG-based comparison in up to 89% of feature-launch experiments") [PROVEN /
  vendor-reported] reinforce that **the agreement bar in commerce is real but lands ~80–89%,
  not 99%** — there is a residual ~10–20% the judge gets wrong, concentrated on the subjective
  substitute/style band.

**Multimodal matters for samesake specifically.** samesake is visual-commerce and fashion-first;
a **text-only** Gemini judge cannot see that a returned item is the wrong *cut* or *drape* of a
saree even when its text attributes match. If the judge grades on text alone while retrieval
ranks partly on image embeddings, **the judge is blind to the exact axis the embeddings are
ranking on** — systematically under-crediting good visual matches and over-crediting
text-keyword matches. A multimodal judge (Gemini is natively multimodal) closes that gap.

## 1.5 Pointwise vs pairwise — a judge-design choice samesake has implicitly made

[PROVEN — convergent literature] samesake's ESCI judge is **pointwise** (grade each item
absolutely on E/S/C/I). The literature is consistent that **pairwise comparison is more
reliable than pointwise scoring**: *"pairwise evaluation tasks enable LLMs to approximate human
preferences with greater fidelity than pointwise scoring … pointwise scores tend to fluctuate a
lot."* Pairwise is also what interleaving (Part 3) consumes natively. **The tension:** pointwise
grades give you per-query NDCG@10 directly and avoid the O(n²) blowup; pairwise gives more
stable verdicts but needs aggregation (Bradley-Terry / Elo) and is position-biased (§1.1). For
samesake the pragmatic answer is **keep pointwise grading for the offline NDCG@10 number, but
add a pairwise "did config B beat config A on this query?" judge for gate decisions**, because
gates are exactly the relative-comparison regime where pairwise wins and where position-swap
symmetrization is cheap.

## 1.6 Concrete judge-hardening checklist (the actionable core of Part 1)

| Bias / risk | Symptom in samesake | Mitigation (proven) |
|---|---|---|
| Position bias | Pairwise gate flips on order | Swap order, count only consistent verdicts; few-shot (65%→77.5%) |
| Verbosity bias | Enriched/long descriptions over-graded | Truncate descriptions to fixed budget in judge prompt; A/B the judge on length-matched pairs |
| Self-preference | Gemini judges Gemini-written enrichments | **Use a different model family to judge than to enrich/generate**; keep human anchor set |
| Prompt sensitivity | grade@10 shifts between runs | **Version-pin & hash the judge prompt**; report it in `/search/explain` provenance; freeze model snapshot |
| Per-item unreliability (κ≈0.35) | Single-item grades over-trusted | Trust **aggregate deltas**, not absolute per-item grades; report κ vs human anchor set |
| Text-only blindness | Visual mismatches mis-graded | Use **multimodal judge** (image + text), matching the multimodal retrieval signal |
| Circularity | LLM-reranked output judged by LLM | Human anchor set as inversion detector; never close the loop fully |

---

# Part 2 — Retrieval Benchmarks Beyond ESCI

ESCI is samesake's anchor (Decision 06 §1) and the right one for *commerce relevance taxonomy*.
But the broader IR-benchmark literature carries design lessons ESCI alone does not, and a
multilingual benchmark (MIRACL) is directly relevant to the LK code-mixed weakness.

## 2.1 BEIR — the "no free lunch" benchmark, and the source of the hybrid mandate

**BEIR (Thakur et al., NeurIPS 2021, arXiv:2104.08663)** — 18 datasets, zero-shot, evaluating
lexical / sparse / dense / late-interaction / reranking. [PROVEN] Findings, verbatim-supported:

- **BM25 is a stubbornly strong zero-shot baseline** — *"remains a highly competitive zero-shot
  method … outperforming most neural/sparse models in out-of-distribution scenarios absent
  domain-specific adaptation."*
- **Reranking / late-interaction win on quality but cost** — *"on average achieve the best
  zero-shot performances, however, at high computational costs."*
- **Dense retrievers generalize poorly out-of-domain** — *"often underperform … highlighting
  the considerable room for improvement in their generalization."*
- **No single method dominates** — *"performing well consistently across all datasets is
  challenging, and no single approach consistently outperforms."*

**Why this is load-bearing for samesake:** BEIR is the empirical origin of samesake's core
architecture bet. A dense embedding trained on web/English data, applied zero-shot to **LK
fashion code-mixed** text, is *exactly* the out-of-domain regime where BEIR shows dense
retrieval degrades and BM25 holds. samesake's **Postgres FTS + ANN fused by RRF** is the
BEIR-endorsed hedge: keep a lexical signal that *"does not depend on any model's training
data."* RRF specifically is what the follow-on literature credits — *"combining BM25 and dense
retrieval via Reciprocal Rank Fusion improves over both … is unsupervised, requires no score
normalization, and consistently outperforms individual retrievers and alternative fusion
strategies"* [MARKETED/secondary, but matches the original RRF paper, Cormack et al. 2009].

## 2.2 MTEB / RTEB — leaderboard saturation and the in-domain caveat

**MTEB (Muennighoff et al., 2022, arXiv:2210.07316)** — 8 task types, 58 datasets (15 retrieval),
112 languages, the de-facto embedding leaderboard. [PROVEN] Core finding: *"no particular text
embedding method dominates across all tasks."* But the **methodology lesson is the cautionary
one**, and it bites the "BYO embeddings, which one?" question (see sibling doc
`embedding-model-selection.md`):

- **Benchmark contamination / saturation.** *"BEIR is no longer a true zero-shot benchmark, as
  researchers now routinely include BEIR datasets in their training pipelines, and MTEB's
  leaderboard now has 400+ models with marginal performance differences, suggesting either
  saturation or over-fitting to the benchmark distribution."* [PROVEN/secondary]
- **The RTEB private-set episode.** MTEB launched **RTEB (Oct 2024)** with a *private* test set
  precisely to combat overfitting, then **temporarily removed the private column** over
  trust/fairness concerns (*"the uneven playing field fundamentally undermines trust"*; GitHub
  issue #3934). [PROVEN — project's own governance]

**The samesake takeaway:** **MTEB rank is not evidence of fitness for LK fashion.** A model
sitting at the top of MTEB-retrieval may have *seen* the benchmark; it has certainly never seen
romanized Sinhala. Embedding choice must be validated on **samesake's own golden LK set**, not
on leaderboard rank. This is the benchmark-methodology analog of Decision 06 §5 ("gate every
lever locally").

## 2.3 MIRACL — the multilingual benchmark samesake should actually mirror

**MIRACL (Zhang et al., TACL 2023, arXiv:2210.09984)** — *"a multilingual dataset for ad hoc
retrieval across 18 languages,"* **726k relevance judgments over 78k queries**, all by **native
speakers**, *"around five person-years of human annotator effort,"* spanning *"high-resource as
well as low-resource languages."* [PROVEN] It is **monolingual-per-language** (query and corpus
same language) — which is the *right* shape for samesake's per-language slices but **not** for
its actual hard case.

**The gap MIRACL itself exposes for samesake:** MIRACL covers neither **Sinhala** nor **Tamil**
explicitly in its 18 (its low-resource set is Yoruba/Telugu/Swahili/Bengali/etc.), and — more
importantly — **it does not test code-mixing**. samesake's real query is *romanized Sinhala +
English brand + Tamil garment term in one string*. No public benchmark tests that. **The
methodology lesson, not the data:** MIRACL's *construction method* is the template — **native-
speaker graded judgments, monolingual per language, low-resource explicitly stratified.**
samesake should build its golden set the MIRACL way: **native LK fashion speakers grading a
stratified set that explicitly includes a code-mixed stratum**, because that stratum is the one
no external benchmark can lend it. (See sibling `multilingual-and-codemixed-retrieval.md`.)

## 2.4 Benchmark comparison and verdict

| Benchmark | Year / venue | Domain | Languages | Relevance scale | Direct use for samesake |
|---|---|---|---|---|---|
| **ESCI / Shopping Queries** | 2022 KDD Cup | E-commerce product search | EN/JA/ES | E/S/C/I (4) | **Anchor taxonomy** (already adopted; CC BY-NC-SA, eval-only) |
| **BEIR** | 2021 NeurIPS | Heterogeneous IR (18 sets) | mostly EN | binary/graded | **Architecture justification** (hybrid > pure dense OOD); not a fashion eval |
| **MTEB / RTEB** | 2022 / 2024 | Embedding tasks (retrieval ⊂) | 112 | task-dependent | **Embedding shortlist only — never the final word**; saturation/contamination risk |
| **MIRACL** | 2023 TACL | Wikipedia ad-hoc | 18 (no si/ta, no code-mix) | graded, native-speaker | **Construction template** for the LK golden set; not usable data |
| **samesake golden LK set** | (to build) | LK fashion, visual | si/ta/en + **code-mixed** | E/S/C/I | **The only benchmark that measures the thing that matters** |
| **Verdict** | — | — | — | — | **ESCI for taxonomy + BEIR for architecture rationale + MIRACL's *method* to build a native-graded, code-mix-stratified LK golden set. MTEB rank is a filter, not a proof.** |

**Recurring lesson across all four (state it explicitly):** *Hybrid (lexical + dense) wins
broadly, and benchmark rank does not transfer to your corpus — especially a low-resource,
code-mixed, visual one. The only trustworthy benchmark is one built on your own data with your
own (native-speaker, and for the judge, calibrated-LLM) labels.*

---

# Part 3 — Online Evaluation

Decision 06 §6 names **online conversion** as the eventual proof bar and notes samesake's
in-app architecture makes a shadow/parallel A/B *trivial*. The methodology question is: **A/B
test, or interleave?** The literature has a sharp answer for *ranking* comparisons.

## 3.1 Interleaving beats A/B testing on sensitivity by 1–2 orders of magnitude

**Chapelle, Joachims, Radlinski, Yue, "Large-Scale Validation and Analysis of Interleaved
Search Evaluation," ACM TOIS 2012** [PROVEN; PDF at cs.cornell.edu] is the canonical reference.
The repeatedly-cited finding: **interleaving needs 1–2 orders of magnitude (10–100×) fewer
impressions than A/B testing to detect the same ranking difference.** Mechanism: A/B testing
splits *users* into two cohorts and compares aggregate metrics across cohorts (high
between-user variance); **interleaving merges two rankings into one result list shown to the
*same* user and attributes clicks to whichever ranker contributed the clicked item** —
eliminating between-user variance, the dominant noise source.

**Team-Draft Interleaving (TDI)** (Radlinski et al. 2008) is the standard credit-assignment
method: like picking playground teams, the two rankers alternate "drafting" their top
un-picked result into the merged list; a click credits the ranker that drafted that item.
Nuance worth recording [PROVEN, Chapelle 2012]: *"team draft is the weakest interleaved method
in terms of sensitivity, though the A/B test is even less sensitive"* — so TDI is the safe,
simple default, but balanced/optimized interleaving variants are more sensitive still. Industry
corroboration that this is live practice, not theory: **Netflix**, **Airbnb** (interleaving +
counterfactual, arXiv:2508.00751), **Thumbtack**, and **Amazon Search** (debiased balanced
interleaving) all publish interleaving deployments [MARKETED/industry].

## 3.2 When interleaving is *not* the right tool

Interleaving answers exactly one question: **"which ranker do users prefer?"** It is the right
tool for samesake's gate decisions (reranker vs baseline, CC vs RRF, spaces on vs off) because
those are *pure ranking swaps*. It is **the wrong tool** when:

- The change alters **what** is shown, not just order — e.g., a hard-filter change that removes
  items, a zero-result-relaxation policy, or a new facet. There is no coherent "merged list."
- You need an **absolute business metric** (revenue per session, return rate) rather than a
  preference — that is an A/B / switchback question.
- The treatment has **session-level or cross-query effects** (personalization context vectors,
  see sibling `personalization-without-behavior-and-session-state.md`) — interleaving's
  per-query click attribution can't see them.

**Rule for samesake:** *interleave to choose the ranker fast and cheap; A/B (or switchback) to
prove the business impact of the winner and to evaluate non-ranking changes.* This is exactly
the two-stage funnel Netflix describes — interleaving as a high-throughput **filter**, A/B as
the **confirmatory** stage.

## 3.3 Offline→online correlation — the bridge that justifies the offline harness at all

The whole offline harness (grade@10, NDCG@10) is only worth running if it **predicts** the
online outcome. The best public evidence is **Amazon, "How well do offline metrics predict
online performance of product ranking models?" (SIGIR 2022)** [PROVEN; FAILED FETCH on PDF
binary — figures via Amazon Science abstract + secondary]: a study of **36 offline metrics**
against large deployed online experiments (**>40M users**) found offline metrics *"align well
with online metrics, agreeing on which ranking model is better up to 97% of the time, with
NDCG showing discriminative power over 99%."* **This is the strongest available license for
trusting NDCG@10 as a gate.**

**But the caveat is sharp and samesake-relevant:** the *construction* of the offline metric
changes the correlation. The same line of work finds **weak correlation between NDCG variants**
— e.g. NDCG using purchase-*probability* gains vs NDCG using *binary* purchase had Kendall's
**τ = 0.364** (i.e., they disagree on model ordering nearly as often as they agree). [PROVEN/
secondary] **Translation for samesake:** *NDCG@10 predicts online — but only if the relevance
gain function matches the business objective.* An E/S/C/I→gain mapping tuned for "find the exact
item" (E=3,S=1,C=0,I=0) will rank configs differently than one tuned for "find anything
buyable" (E=3,S=2,C=1,I=0). **The gain mapping is a modeling decision that must be stated and
held constant**, and ideally chosen to correlate with the tenant's actual conversion definition.

## 3.4 Sample-size / sensitivity discipline

- **A/B testing for search needs a lot of traffic.** Because ranking effects are small (single-
  digit % conversion lifts are "big" — JD +1.29%, Etsy +5.58% per Decision 06), an A/B test
  must be powered for those small effects, often **weeks of traffic** for a small store. For an
  early LK tenant with modest traffic, a clean A/B may be **underpowered for months.**
- **This is the strongest argument for interleaving for samesake's *first* tenants:** its 10–
  100× sensitivity advantage means a low-traffic LK store can get a ranking verdict in days, not
  months. The in-app architecture makes TDI implementable as a query-time merge of two ranked
  lists in the same Postgres round-trip.
- **Always report the offline harness alongside.** Offline NDCG@10 has *"discriminative power
  over 99%"* and needs **zero live traffic** — for a pre-launch tenant it is the *only* signal.
  The funnel is: **offline NDCG@10 gate → interleaving on first live traffic → A/B to confirm
  business lift.**

---

# Part 4 — Measuring Filtered-Recall and Head/Tail Properly

Decision 06 §3–4 named two evals as load-bearing but un-built: **filtered-recall** (the
correctness check on "hard filters stay hard") and **head/tail stratification**. This part
turns them from "we should" into method.

## 4.1 Filtered-recall: the eval that proves correctness, not just quality

**The risk (Decision 02 §6):** on an approximate ANN index (HNSW/IVF in pgvector), a **selective
hard filter** applied *post*-ANN can silently return fewer than k results — the true matches
were never in the ANN candidate set because the filter wasn't known at search time. grade@10 /
P@5 are computed on what *was* returned and are **blind** to what was *wrongly excluded*.

**The method — build a ground-truth-filter eval:**

1. **Construct filtered queries with known answers.** For a set of `(query, predicate)` pairs
   (e.g. `"red saree" ∧ price≤3000 ∧ color∋red ∧ available=true`), compute the **exact answer
   set via a pure SQL scan** (`WHERE` over the full table — no ANN). This is ground truth: the
   set of all docs that satisfy the predicate, ranked by exact similarity.
2. **Run samesake's actual filtered path** (ANN + post-filter, or pre-filter, whatever it
   compiles to) for the same `(query, predicate)`.
3. **Measure filtered-recall@k** = |returned∩truth| / |truth∩top-k_exact|. A value < 1.0 means
   the ANN+filter path **dropped reachable matches** — silent over-filtering.
4. **Stratify by filter selectivity.** The failure is selectivity-dependent: a filter matching
   40% of the corpus rarely starves ANN; a filter matching 0.5% (a specific color+size+price
   combo) frequently does. **Report filtered-recall as a curve over selectivity buckets.**
5. **Gate on it.** If filtered-recall drops below threshold at high selectivity, that is the
   trigger to switch to **pre-filtering** (filter in SQL first, then ANN over the survivors) or
   **iterative/over-fetch scanning** (widen ANN `ef_search`/candidate-k until k post-filter
   results exist). **Surface in `/search/explain`** when iterative scanning fired — making the
   correctness property auditable, which is samesake's differentiator.

This is the eval that backs the *correctness* half of samesake's promise. No LLM judge needed —
it is a deterministic set-recall computation, cheap, and runnable in CI on every catalog.

## 4.2 Head/tail done properly

Decision 06 §3 cites JD.com DPSR: semantic retrieval gave *"+1.29% conversion overall but
+10.03% on tail queries"* — a mean hides the entire story. Method to make the cut rigorous:

1. **Define strata by frequency, from real logs where available, else by corpus statistics.**
   Head = top queries covering ~the first tranche of volume; tail = singletons / rare. For a
   pre-launch LK tenant with no logs, proxy head/tail by **query-term IDF** and **expected
   corpus coverage** (a query whose terms match many docs is head-like).
2. **Report every metric per stratum, never only pooled.** grade@10, NDCG@10, Recall@k, AND
   **zero-results-rate** — split head/torso/tail. Zero-results-rate is the tail's true KPI and
   needs no labels (Decision 06 §2).
3. **Cross-cut by query *type*.** samesake already tags queries (keyword/attribute/use-case/
   price/negation/style/**local**/broad). Report the **stratum × type matrix.** The "local"
   weakness then reads honestly as *"local-type tail queries fail on corpus depth"* rather than
   a global regression — exactly Decision 06 §3's framing, now measurable.
4. **Weight the eval to the business.** A pooled mean implicitly weights by query *count* (tail-
   heavy). If conversion weight is head-heavy, also report a **volume-weighted** aggregate so a
   head regression can't be masked by a tail win (and vice-versa). State the weighting.
5. **Guard against tail noise.** Tail strata have few queries → high-variance metrics →
   over-reaction risk. Report **confidence intervals / n per stratum** and require the gate to
   clear CI, not point estimate. This is the head/tail analog of §3.4's sample-size discipline.

## 4.3 Per-cluster failure analysis (recovered nugget #5, folded in)

The completeness-pass nugget — *Cobalt-style per-query-cluster eval analysis* (GCL,
arXiv:2404.08535) — belongs here. Beyond head/tail, **cluster queries semantically and report
metrics per cluster** to diagnose *why* a lever (e.g. "spaces") failed the gate: a flat
grade@10 says "spaces didn't help"; a per-cluster cut might reveal "spaces helped *style*
queries but hurt *attribute* queries," turning a kill decision into a targeted-enable decision.

---

# Relevance to samesake

### Adopt
- **The judge-hardening checklist (§1.6) as a standing eval policy.** Specifically: **version-
  pin and hash the Gemini judge prompt and model snapshot**, expose it in `/search/explain`
  provenance, and treat any prompt change as a benchmark rebase. This is the single
  highest-leverage, lowest-cost change — it makes grade@10 *comparable across time*, which it
  currently is not guaranteed to be.
- **Report Cohen's κ against a small human anchor set.** UMBRELA shows graded-relevance judges
  sit at κ≈0.31–0.37 ("fair") per-item even when system-ranking τ≈0.9. samesake should know its
  *own* judge's κ on LK fashion — and it will likely be **lower** than UMBRELA's English number
  because LK fashion + code-mix is harder. Build a **~200-item native-speaker-labeled anchor
  set** (the MIRACL method) and report κ as a first-class instrument-quality metric.
- **Build the filtered-recall eval (§4.1) and the stratum×type matrix (§4.2).** These are
  deterministic, label-free or label-light, CI-runnable, and back the *correctness* and
  *honesty* halves of the positioning. Filtered-recall is the highest-value missing eval.
- **Trust aggregate deltas, not absolute grades, for all gate decisions** (the §1.2 rule).
  Re-state every gate (reranker, CC fusion, spaces) as "B − A on the frozen judge," not "B hits
  grade 2.4."

### Integrate
- **A multimodal judge.** samesake is fashion/visual; a text-only judge is blind to the cut/
  drape/style axis the image embeddings rank on (§1.4, Zalando). Use Gemini's native
  multimodality: feed the **product image + query** to the judge. This aligns the instrument
  with the signal being measured.
- **A pairwise gate judge alongside the pointwise NDCG judge** (§1.5). Pointwise for the
  reported NDCG@10 number; pairwise (with position-swap symmetrization) for go/no-go gate
  decisions, since pairwise is the more reliable comparison regime and feeds interleaving
  natively.
- **Team-Draft Interleaving as the first-tenant online-eval primitive (§3.1–3.4).** The in-app
  architecture makes a two-list query-time merge trivial; its 10–100× sensitivity means a
  low-traffic LK store gets a ranker verdict in days, where an A/B would be underpowered for
  months. Funnel: **offline NDCG@10 → interleaving → confirmatory A/B.**
- **State and freeze the E/S/C/I→gain mapping** (§3.3). Choose it to correlate with the
  tenant's conversion definition; hold it constant across runs. NDCG predicts online only when
  the gain function matches the objective (τ=0.364 between mismatched NDCG variants).

### Differentiate
- **Make the judge auditable.** No competitor exposes *how* their relevance number was produced.
  samesake's `/search/explain` already audits retrieval; extend it to **audit the eval**: judge
  model+version, prompt hash, the per-item grades behind a query's grade@10, and whether
  position-swap consistency held. "Reproducible, auditable relevance measurement" is a sharper
  wedge than "we have good search," and the whole commercial market is *marketed on conversion,
  not proven on auditable retrieval metrics* (Decision 06 TL;DR).
- **A native-graded, code-mix-stratified LK golden set is a moat.** No public benchmark
  (ESCI/BEIR/MTEB/MIRACL) covers Sinhala/Tamil code-mixed fashion. Building one the MIRACL way
  is expensive but **uncopyable** and is the only instrument that measures samesake's hardest,
  most-defensible case.

### Avoid
- **Do not close the LLM loop.** Never let the *same model family* enrich/generate product text
  *and* judge it (self-preference, §1.1) — and never let an LLM-reranked config be judged solely
  by an LLM (circularity, §1.3). Keep the human anchor set as the inversion detector.
- **Do not trust MTEB/BEIR rank as evidence of LK fitness** (§2.2). Saturation + contamination +
  zero LK coverage make leaderboard rank a *shortlist filter*, not a proof. Validate every
  embedding on the LK golden set.
- **Do not interleave non-ranking changes** (§3.2). Filter-policy, zero-result-relaxation, and
  faceting changes alter *what* is shown, not just order — use A/B/switchback, not interleaving.
- **Do not report pooled means alone** (§4.2). A pooled grade@10 can hide a head regression
  behind a tail win or vice-versa; always report the stratum×type matrix with per-stratum n/CI.

---

# Open questions

1. **What is samesake's Gemini judge's actual Cohen's κ on LK fashion?** Until measured against
   a native-speaker anchor set, grade@10's instrument quality is unknown — and likely below
   UMBRELA's English κ≈0.35. This is the first experiment to run.
2. **Is the judge text-only or multimodal today?** If text-only, how much does grade@10 change
   when the product image is added to the judge prompt — i.e., how much visual signal is the
   current eval blind to?
3. **Does the enrich pipeline inflate grade@10 via verbosity bias?** Test: judge length-matched
   vs enriched descriptions on identical retrieval. If enriched wins on grade but not on a human
   anchor set, the eval is rewarding verbosity, not relevance.
4. **What E/S/C/I→gain mapping correlates with conversion for an LK tenant?** Without a tenant's
   purchase data this is unanswerable; with even a small log it can be fit (the τ=0.364 warning
   says the choice is not cosmetic).
5. **Can TDI be implemented cleanly given hard filters?** If the two arms apply *different*
   filter policies the merge is ill-defined; TDI may only be valid for pure ranking swaps within
   an identical filter gate. Needs a design spike.
6. **Where is the position-bias floor for a graded (pointwise) judge?** Most bias numbers are for
   *pairwise* judging; pointwise E/S/C/I grading has different (largely order-free) failure
   modes. Does samesake's pointwise judge have a *grade-anchoring* bias (e.g., over-using grade
   1/Substitute as a safe default)? The UMBRELA confusion matrix (30% accuracy on grade-2)
   suggests yes — worth measuring.
7. **How few labels does the anchor set need?** MIRACL spent ~5 person-years; samesake needs the
   minimum viable anchor for κ estimation + inversion detection. ~200? ~500? Power analysis
   needed.

---

# Sources

**LLM-as-judge reliability & biases**
- Zheng et al., "Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena," NeurIPS 2023 — arXiv:2306.05685 — https://arxiv.org/abs/2306.05685 (HTML v4: https://arxiv.org/html/2306.05685v4) [PROVEN; position/verbosity/self-pref/agreement numbers read from HTML]
- Upadhyay et al., "UMBRELA: UMbrela is the (Open-Source Reproduction of the) Bing RELevance Assessor," 2024 — arXiv:2406.06519 — https://arxiv.org/html/2406.06519v1 [PROVEN; Cohen κ + Kendall τ table read directly]
- Thomas et al. (Microsoft Bing), "Large Language Models Can Accurately Predict Searcher Preferences," SIGIR 2024 [PROVEN; via UMBRELA references]
- "Self-Preference Bias in LLM-as-a-Judge," 2024 — arXiv:2410.21819 — https://arxiv.org/pdf/2410.21819 [PROVEN]
- "LLM-based relevance assessment still can't replace human assessment," 2024 — arXiv:2412.17156 — https://arxiv.org/pdf/2412.17156 [PROVEN argument; FAILED FETCH on PDF binary — summarized via secondary read]
- "JudgeSense: A Benchmark for Prompt Sensitivity in LLM-as-a-Judge Systems," 2026 — arXiv:2604.23478 — https://arxiv.org/html/2604.23478v1 [PROVEN]
- Faggioli et al., "Perspectives on Large Language Models for Relevance Judgment," 2023 — arXiv:2304.09161 [PROVEN; via UMBRELA references]
- "Large Language Models for Relevance Judgment in Product Search," 2024 — arXiv:2406.00247 — https://arxiv.org/pdf/2406.00247 [PROVEN]
- Zalando Engineering, "Leveraging Multimodal LLMs for Large-Scale Product Retrieval Evaluation," Nov 2024 — https://engineering.zalando.com/posts/2024/11/llm-as-a-judge-relevance-assessment-paper-announcement.html [MARKETED blog announcing peer-reviewed paper]

**Retrieval benchmarks**
- Thakur et al., "BEIR: A Heterogeneous Benchmark for Zero-shot Evaluation of IR Models," NeurIPS 2021 — arXiv:2104.08663 — https://arxiv.org/abs/2104.08663 [PROVEN]
- Muennighoff et al., "MTEB: Massive Text Embedding Benchmark," 2022 — arXiv:2210.07316 — https://arxiv.org/abs/2210.07316 [PROVEN]
- MTEB/RTEB private-column governance — GitHub issue embeddings-benchmark/mteb#3934 — https://github.com/embeddings-benchmark/mteb/issues/3934 [PROVEN]
- Zhang et al., "MIRACL: A Multilingual Retrieval Dataset Covering 18 Diverse Languages," TACL 2023 — arXiv:2210.09984 — https://aclanthology.org/2023.tacl-1.63/ [PROVEN]

**Online evaluation**
- Chapelle, Joachims, Radlinski, Yue, "Large-Scale Validation and Analysis of Interleaved Search Evaluation," ACM TOIS 2012 — https://www.cs.cornell.edu/people/tj/publications/chapelle_etal_12a.pdf [PROVEN]
- "Debiased Balanced Interleaving at Amazon Search," 2022 — https://assets.amazon.science/a9/c8/c9016a1c47caac6a634768e7491d/debiased-balanced-interleaving-at-amazon-search.pdf [PROVEN/industry]
- Netflix Tech Blog, "Innovating Faster on Personalization Algorithms … Using Interleaving" — https://netflixtechblog.com/interleaving-in-online-experiments-at-netflix-a04ee392ec55 [MARKETED/industry]
- "Harnessing the Power of Interleaving and Counterfactual Evaluation for Airbnb Search Ranking," 2025 — arXiv:2508.00751 — https://arxiv.org/html/2508.00751v1 [PROVEN/industry]
- Amazon, "How well do offline metrics predict online performance of product ranking models?" SIGIR 2022 — https://www.amazon.science/publications/how-well-do-offline-metrics-predict-online-performance-of-product-ranking-models [PROVEN; FAILED FETCH on PDF binary — figures via abstract + secondary read]

**Filtered-recall / head-tail / per-cluster (cross-refs)**
- `07-decisions/06-eval-and-proof.md`; `07-decisions/02-retrieval-and-ranking.md` §6
- `10-gaps/multilingual-and-codemixed-retrieval.md`; `10-gaps/embedding-model-selection.md`;
  `10-gaps/personalization-without-behavior-and-session-state.md`
- GCL / per-cluster analysis — arXiv:2404.08535 (recovered nugget #5)
