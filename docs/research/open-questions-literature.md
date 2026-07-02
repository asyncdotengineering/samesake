# Open-Questions Literature Digest — samesake RFCs

Retrieval-led research resolving open questions in two samesake RFCs. samesake = a fashion
visual + intent product search engine: Postgres + pgvector, RRF over FTS + cosine + "spaces",
BYO embed/generate/rerank, no production traffic yet.

Each section: **Finding** (the consensus) → **Citations** (verified primary sources, with URLs) →
**Recommended resolution for samesake**. Verified passages were read from primary sources where a
specific number is load-bearing; honesty notes flag where the literature is thin or mixed.

---

## RQ1 — Reranker: REPLACE the fused order, or BLEND/interpolate with it?

**Finding.** The literature is genuinely mixed, and the honest answer is *it depends on how strong
your first stage is*.

- A reranker is **not** guaranteed to improve a strong first-stage result. Jacob et al.
  ("Drowning in Documents", Databricks, 2025) measured best-in-class cross-encoder rerankers on top
  of *strong dense retrieval* (not the usual BM25-on-MS-MARCO setup) and found that **reranking
  degrades Recall@10 below retrieval-alone in 53.3% (academic) / 44.4% (enterprise) of experiments**
  once you rerank many documents. They document "phantom hits" — irrelevant documents the reranker
  scores very highly that the retriever correctly buried. Verified quote: "while rerankers initially
  help with small values for K, reranking with large K decreases recall precipitously … often
  dropping beneath the quality of standalone retrievers." This is the single strongest piece of
  evidence that a reranker should not blindly *replace* a strong fused order.
- **Naive score interpolation between lexical and neural models is inconsistent.** Wang, Lin et al.
  ("To Interpolate or not to Interpolate", SIGIR 2022) and the BM25-injection paper (Askari et al.,
  ECIR 2023) both report that linear interpolation of lexical + neural relevance scores "may not
  consistently result in higher effectiveness" — it helps in some collections, hurts in others, and
  is sensitive to score normalization.
- **Strong first-stage gains do not flow through additively to the reranker.** Gao, Dai, Callan
  ("Rethink Training of BERT Rerankers", ECIR 2021 / LCE) found that a better retriever does *not*
  automatically give a better end-to-end pipeline — "popular reranker cannot fully exploit the
  improved retrieval result" — i.e. the two stages interact and must be tuned jointly.
- The "blend" camp does have support when the first stage is weak/lexical: HYRR (Zhuang et al., 2022)
  and many TREC systems interpolate or train rerankers over hybrid signals and win — but those
  pipelines lean on BM25-class first stages, exactly the favorable condition "Drowning in Documents"
  warns about.

**Citations**
- Jacob, Lindgren, Zaharia, Carbin, Khattab, Drozdov. *Drowning in Documents: Consequences of
  Scaling Reranker Inference.* ReNeuIR @ SIGIR 2025. arXiv:2411.11767 — https://arxiv.org/abs/2411.11767
- Wang, Lin, et al. *To Interpolate or not to Interpolate: PRF, Dense and Sparse Retrievers.*
  SIGIR 2022. arXiv:2205.00235 — https://arxiv.org/abs/2205.00235
- Askari, et al. *Injecting the BM25 Score as Text Improves BERT-Based Re-rankers.* ECIR 2023.
  arXiv:2301.09728 — https://arxiv.org/abs/2301.09728
- Gao, Dai, Callan. *Rethink Training of BERT Rerankers in Multi-Stage Retrieval Pipeline (LCE).*
  ECIR 2021. arXiv:2101.08751 — https://arxiv.org/abs/2101.08751

**Recommended resolution for samesake.**
Do **not** let the reranker unconditionally replace the RRF order. Treat the reranker as a *bounded
re-scorer of a small top-K* (e.g. K = 20–50), not a re-retriever, and **keep the RRF/first-stage
score as a guardrail**: blend via a convex combination of *normalized* scores
(`final = α·rerank_norm + (1−α)·rrf_norm`), or only let the reranker reorder within the top-K while
the fused order governs the tail. Tune α and K on the eval harness (RQ4/RQ7), per query stratum —
expect the reranker to help head/ambiguous queries and to risk hurting already-strong visual
queries. Because samesake is multimodal and text-only cross-encoders cannot see the image, a reranker
that ignores the visual signal is *exactly* the "phantom hit" risk; gate it, do not enthrone it.

---

## RQ2 — Reciprocal Rank Fusion: canonical k and weighting query contributions

**Finding.** RRF is the Cormack–Clarke–Büttcher method (SIGIR 2009). The score is

> RRFscore(d) = Σ_{r ∈ rankers} 1 / (k + rank_r(d))

with the canonical constant **k = 60**, chosen empirically in the original paper (it worked best/near-best
across their TREC runs; the role of k is to dampen the outsized influence of the very top ranks so
that a document ranked #1 by one system cannot dominate documents that rank well across *several*
systems). RRF needs no score normalization (it uses ranks, not scores) and **outperformed Condorcet
fusion and learned (LambdaMART/LETOR) rank-combination** in the original study. On **weighting**: the
original paper uses unweighted contributions, but the weighted generalization
`Σ w_r / (k + rank_r(d))` is standard, well-defined, and used in practice (e.g. Elasticsearch /
OpenSearch RRF expose per-retriever weights). There is **no canonical published weight ratio** for
"original query > expanded/rewritten query" — that is a tuning decision, not a literature constant.
(Honesty note: the specific idea of down-weighting expanded/rewritten queries relative to the
original is sound engineering folklore but I found no authoritative paper prescribing a ratio; treat
it as a hyperparameter.)

**Citations**
- Cormack, Clarke, Büttcher. *Reciprocal Rank Fusion Outperforms Condorcet and Individual Rank
  Learning Methods.* SIGIR 2009, pp. 758–759. —
  https://dl.acm.org/doi/10.1145/1571941.1572114 ·
  PDF: http://cormack.uwaterloo.ca/cormacksigir09-rrf.pdf ·
  Google Research: https://research.google/pubs/reciprocal-rank-fusion-outperforms-condorcet-and-individual-rank-learning-methods/

**Recommended resolution for samesake.**
Keep **k = 60** as the default; it is the published canon and a safe starting point. Use the
**weighted** RRF form so FTS, cosine, and each "space" carry tunable weights, and add a separate
weight for original-query vs rewritten/expanded-query rankers — **down-weight expanded queries**
(start ~0.5–0.7× the original) and tune on the harness. Do not normalize scores before RRF (it is
rank-based by design); reserve normalization for the *non-RRF* business-signal fusion (RQ6). Treat
k, the per-source weights, and the original-vs-rewrite ratio as harness-tuned hyperparameters, not
constants to hardcode.

---

## RQ3 — LLM-as-judge for relevance: agreement, defensible bar, biases, pointwise vs pairwise

**Finding.** Strong LLM judges agree with humans at roughly the level humans agree with each other —
but with well-documented, systematic biases.

- **Agreement bar.** Zheng et al. (MT-Bench / Chatbot Arena, NeurIPS 2023) is the canonical result:
  GPT-4 reaches **85% agreement with human experts on non-tie pairs (setup S2), which exceeds the
  81% human–human agreement** (verified from the paper's §4.2 and Table 5). Abstract: "strong LLM
  judges like GPT-4 can match … human preferences well, achieving over 80% agreement, the same level
  of agreement between humans." So an **agreement target in the low-to-mid 80s%** is defensible and
  matches the human ceiling; demanding far above human–human agreement is not justified.
- **For *relevance* specifically (IR, not chat):** Thomas et al. (Microsoft/Bing, SIGIR 2024) showed
  LLMs predict searcher preferences about as well as human labellers; UMBRELA (Upadhyay et al., ICTIR
  2025) is the open reproduction and shows LLM relevance labels correlate highly with manual TREC DL
  / RAG-track system rankings. Caveat: Mishra et al. (2026) document **LLM "overrating" / score
  inflation** in relevance assessment, so calibrate the threshold against human-labelled anchors.
- **Known biases:** position bias, verbosity/length bias, and self-preference/self-enhancement bias
  are all empirically confirmed (Zheng et al.; Wu/Aji "Comparative Trap"; the self-preference-bias
  literature). MT-Bench's own data: GPT-4 zero-shot is only 65% position-consistent (77.5% few-shot).
- **Pointwise (graded) vs pairwise:** pairwise comparison is generally more aligned with humans but
  **amplifies** verbosity/position bias (Wu & Aji, "The Comparative Trap", 2024) and is O(N²) /
  order-dependent. Pointwise graded scoring is cheaper, order-independent, and "less susceptible to
  such bias because each output is judged in isolation," at some cost in discriminative power.
- **κ vs F1.** Cohen's κ is the right *chance-corrected* agreement statistic and is standard; raw F1
  / exact-match agreement **overstates** judge quality because it doesn't correct for chance (Gehring
  et al. 2026, "Reliability without Validity"). So the RFC's instinct to report κ is well-founded;
  the F1 ≥ 0.80 target is reasonable as a secondary check but should be read alongside κ.

**Citations**
- Zheng et al. *Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena.* NeurIPS 2023.
  arXiv:2306.05685 — https://arxiv.org/abs/2306.05685
- Liu et al. *G-Eval: NLG Evaluation using GPT-4 with Better Human Alignment.* EMNLP 2023.
  arXiv:2303.16634 — https://arxiv.org/abs/2303.16634
- Thomas, Spielman, Craswell, Mitra. *Large Language Models can Accurately Predict Searcher
  Preferences.* SIGIR 2024. arXiv:2309.10621 — https://arxiv.org/abs/2309.10621
- Upadhyay et al. *UMBRELA: Open-Source Reproduction of the Bing Relevance Assessor.* ICTIR 2025.
  arXiv:2406.06519 — https://arxiv.org/abs/2406.06519
- Wu, Aji. *The Comparative Trap: Pairwise Comparisons Amplify Biased Preferences of LLM Evaluators.*
  2024. arXiv:2406.12319 — https://arxiv.org/abs/2406.12319

**Recommended resolution for samesake.**
Adopt LLM-as-judge for the relevance eval harness, but: (1) set the agreement bar at **κ as primary,
targeting the human–human ceiling (~0.8 agreement / "substantial" κ), with F1 ≥ 0.80 as a secondary
gate** — do not demand super-human agreement; (2) **use pointwise graded relevance** (e.g. 0/1/2/3,
mapping to nDCG gains in RQ7) rather than pairwise — order-independent, cheaper, less bias-prone, and
it directly feeds graded metrics; (3) **mitigate biases**: fixed rubric, randomize/control for
position, cap or normalize for verbosity, and **never judge with the same model family used to
generate** (self-preference). Anchor the judge against a small human-labelled gold set and watch for
score inflation before trusting absolute thresholds.

---

## RQ4 — Confidence thresholding / abstention: fixed floor or tuned on a risk–coverage curve?

**Finding.** The selective-prediction / selective-classification literature is unambiguous: **a fixed
confidence floor is the naive baseline; the principled choice is to pick the operating point on a
risk–coverage (or precision–recall) curve, and to calibrate confidence first.**

- Selective classification = "predict or abstain," formalized as a **risk–coverage trade-off**
  (Geifman & El-Yaniv, NeurIPS 2017): you choose the threshold to hit a *target risk at maximal
  coverage*, you don't guess a magic number. El-Yaniv & Wiener established the risk–coverage
  framework these build on.
- **Raw model confidence is poorly calibrated**, so a self-confidence threshold is unreliable;
  post-hoc calibration and *separate* confidence estimators routinely beat raw softmax/self-reported
  confidence (Fisch/Geifman "Calibrated Selective Classification" 2022; Cattelan & Silva "How to Fix
  a Broken Confidence Estimator" 2023; SelectiveNet trains the selector jointly rather than
  thresholding a frozen score).
- For LLM/generative settings specifically, **self-reported confidence/entropy alone is insufficient
  and a separate correctness/guardrail probe does better** (Sharma et al. 2026, "Entropy Alone is
  Insufficient for Safe Selective Prediction in LLMs"). This directly supports "don't trust the
  model's own confidence; train/tune a guardrail."
- Evaluation best practice: report **AURC / the full risk–coverage curve**, not a single fixed
  threshold (Jaeger et al., "Overcoming Common Flaws in the Evaluation of Selective Classification",
  2024).

**Citations**
- Geifman, El-Yaniv. *Selective Classification for Deep Neural Networks.* NeurIPS 2017.
  arXiv:1705.08500 — https://arxiv.org/abs/1705.08500
- Geifman, El-Yaniv. *SelectiveNet: A Deep Neural Network with an Integrated Reject Option.*
  ICML 2019. arXiv:1901.09192 — https://arxiv.org/abs/1901.09192
- Fisch et al. *Calibrated Selective Classification.* TMLR 2022. arXiv:2208.12084 —
  https://arxiv.org/abs/2208.12084
- Jaeger et al. *Overcoming Common Flaws in the Evaluation of Selective Classification Systems.*
  2024. arXiv:2407.01032 — https://arxiv.org/abs/2407.01032
- Sharma et al. *Entropy Alone is Insufficient for Safe Selective Prediction in LLMs.* 2026.
  arXiv:2603.21172 — https://arxiv.org/abs/2603.21172

**Recommended resolution for samesake.**
**Do not hardcode 0.4 / 0.5 / 0.8.** Treat "show results vs. say 'no good matches'" as selective
prediction: collect (confidence, was-it-relevant) pairs from the eval harness, plot the
**risk–coverage / precision–recall curve, and pick the threshold that meets a chosen target
precision at max coverage** — re-tune as data accrues. Prefer a **separate guardrail predictor**
(features: RRF margin, top-1 vs top-2 gap, reranker score, LLM-judge relevance) over the raw
embedding-similarity score, which is uncalibrated. This is the literature-backed justification for
"tune the floor via the eval harness, don't hardcode."

---

## RQ5 — Detecting an image changed behind a stable URL

**Finding.** Two complementary, well-established mechanisms; "conditional GET + perceptual-hash
fallback" is exactly the textbook pattern.

- **HTTP conditional requests** are standardized in **RFC 9110 (HTTP Semantics)**: the server emits
  `ETag` and/or `Last-Modified` validators; the client revalidates with `If-None-Match` (preferred,
  exact) or `If-Modified-Since`, and the server replies **304 Not Modified** (no body) if unchanged.
  ETag is more reliable than Last-Modified (1-second timestamp resolution, clock skew). This is the
  cheap first line — but it only tells you the *origin's metadata* changed, and many CDNs/origins
  emit weak or absent validators, so it can both false-negative (image bytes changed, ETag didn't)
  and be unavailable.
- **Perceptual hashing** (pHash/dHash/aHash) is the canonical content-level change detector: a hash
  that is stable under re-encoding/resize but changes when the image content meaningfully changes,
  compared via Hamming distance. The canonical reference is **Zauner's 2010 thesis "Implementation
  and Benchmarking of Perceptual Image Hash Functions"** (the pHash library). DCT-based (pHash) and
  difference-hash (dHash) are the standard robust choices.

**Citations**
- Fielding, Nottingham, Reschke (eds). *RFC 9110: HTTP Semantics.* IETF, 2022 (conditional requests
  §13, ETag §8.8.3, 304 §15.4.5). — https://www.rfc-editor.org/rfc/rfc9110.html
- Zauner. *Implementation and Benchmarking of Perceptual Image Hash Functions.* MSc thesis, Univ. of
  Applied Sciences Upper Austria, 2010. — http://phash.org/docs/pubs/thesis_zauner.pdf

**Recommended resolution for samesake (G1 image revalidation).**
"Conditional GET + pHash fallback" is the right approach. Concretely: (1) on each revalidation send
`If-None-Match`/`If-Modified-Since`; a **304 → assume unchanged, skip re-enrichment** (cheapest
path). (2) If the validator is **absent/weak**, or you got a 200, fetch and compute a **perceptual
hash (dHash or pHash), store it, and compare Hamming distance to the last hash** — only re-run
embedding/enrichment when the distance exceeds a small threshold (tuned to ignore re-compression but
catch a genuine product-image swap). pHash is the authoritative fallback for the common case where a
retailer overwrites an image behind the same URL without changing the ETag.

---

## RQ6 — Fusing relevance with business/availability signals: additive vs multiplicative

**Finding.** Both shapes are established; the choice encodes a *conjunction-vs-compensation* policy.

- **Additive (CombSUM / CombMNZ)** is the classic Fox & Shaw (TREC-2, 1994) data-fusion family:
  sum normalized scores (CombSUM), optionally multiplied by the count of nonzero contributors
  (CombMNZ). Additive is **compensatory** — a very high relevance score can fully compensate for a
  low availability score. **Score normalization to a common scale (e.g. [0,1]) is mandatory** before
  additive fusion of heterogeneous signals.
- **Multiplicative / weighted-geometric** (`final = R^α · S^β`) is **conjunctive** — a near-zero on
  *either* axis drives the product toward zero, so an item must score on **both** relevance and the
  business/availability axis to surface. This is the right shape when a signal is a near-hard gate
  (e.g. out-of-stock, or a hard brand/availability constraint) that should not be bought off by raw
  relevance. The geometric-mean / weighted-product view of fusion is supported by the geometric
  data-fusion framework (Wu, *A geometric framework for data fusion in IR*, IPM 2016) and is the
  standard "weighted product model" trade-off.

**Citations**
- Fox, Shaw. *Combination of Multiple Searches.* TREC-2, NIST SP 500-215, 1994. —
  https://trec.nist.gov/pubs/trec2/papers/txt/23.txt ·
  https://www.semanticscholar.org/paper/Combination-of-Multiple-Searches-Fox-Shaw/2f53b548e05776c24c048351e35df15b00642a76
- Wu. *A geometric framework for data fusion in information retrieval.* Information Processing &
  Management, 2016. — https://www.sciencedirect.com/science/article/abs/pii/S0306437915000113

**Recommended resolution for samesake.**
Use **multiplicative / weighted-geometric fusion for hard-ish business axes** (availability/in-stock,
hard brand or price-band constraints) where "must score on both axes" is the desired semantics —
`final = relevance^α · availability^β` after normalizing each to [0,1] — so an out-of-stock or
off-constraint item cannot be rescued by high relevance alone. Use **additive (CombSUM-style,
normalized, weighted)** for *soft* boosts (recency, margin, popularity) that should merely nudge
ranking, not gate it. Normalize every input to [0,1] before either fusion. Honesty note: the IR
literature is richer on additive fusion; the multiplicative-as-conjunction argument is principled
(weighted product model) but you'll be tuning α/β empirically rather than citing a fashion-specific
benchmark.

---

## RQ7 — Offline IR metrics: definitions and K choice

**Finding.** Standard, well-defined, and stable.

- **nDCG@K** (Järvelin & Kekäläinen, TOIS 2002) is the standard for **graded** relevance:
  DCG@K = Σ_{i=1..K} (2^{rel_i} − 1)/log2(i+1) (or rel_i/log2(i+1)), normalized by the ideal DCG.
  Use it when you have graded judgments (e.g. the 0–3 LLM-judge grades from RQ3).
- **Recall@K / Hit@K** measure whether relevant items appear in the top K (binary relevance);
  **MRR** = mean of 1/(rank of first relevant) — good for known-item / single-target queries.
- **Graded vs binary:** graded (nDCG) when you care *how* relevant; binary (Recall/Hit/MRR) when
  "relevant or not" suffices. **K choice** follows the surface: report at the cutoffs users actually
  see — for a product grid, **nDCG@10 and nDCG@20** are the conventional reporting points (TREC DL
  uses nDCG@10), with Recall@K at a larger K (e.g. 100) to measure first-stage candidate quality.
- **Query stratification** (head / torso / tail) is standard practice: tail queries behave very
  differently from head, and a single averaged number hides regressions — report metrics *per
  stratum*.

**Citations**
- Järvelin, Kekäläinen. *Cumulated Gain-based Evaluation of IR Techniques.* ACM TOIS 20(4):422–446,
  2002. — https://dl.acm.org/doi/10.1145/582415.582418 ·
  PDF: https://faculty.cc.gatech.edu/~zha/CS8803WST/dcg.pdf
- TREC Deep Learning Track (Craswell et al.) — nDCG@10 as primary metric. —
  https://microsoft.github.io/msmarco/TREC-Deep-Learning

**Recommended resolution for samesake.**
Primary metric: **nDCG@10 and nDCG@20** over graded relevance (reuse the 0–3 LLM-judge grades from
RQ3, mapped to gains). Track **Recall@K at a larger K (e.g. 50–100)** to monitor first-stage/RRF
candidate quality independently of reranking, and **MRR** for known-item / "find this exact product"
queries. **Stratify every metric by head/torso/tail query** (and ideally by visual-vs-text intent)
so a reranker or threshold change that helps head but hurts tail is visible — this directly powers
the per-stratum tuning in RQ1 and RQ4.

---

## RQ8 — Reranker backends for a BYO, no-traffic, fashion (visual+intent) engine

**Finding.** Three families, with a clear quality/cost/latency/visual-coverage trade-off.

- **Cross-encoders (MiniLM, monoT5):** cheap, fast (10s of ms), self-hostable; strong on
  text-to-text relevance. monoT5 (Nogueira et al., EMNLP Findings 2020) is the canonical T5
  cross-encoder reranker; MiniLM cross-encoders are the lightweight default. Limitation: **text-only**
  — they cannot see the product image, and they're *pointwise* (each doc scored independently), which
  "Drowning in Documents" (RQ1) identifies as the less-robust mode prone to phantom hits.
- **Listwise LLM rerankers (RankGPT / RankLLM):** Sun et al. ("Is ChatGPT Good at Search?",
  EMNLP 2023, Outstanding Paper) showed zero-shot listwise LLM reranking is SOTA-competitive with no
  training; "Drowning in Documents" found listwise gpt-4o-mini *more robust* than finetuned pointwise
  cross-encoders. Cost: high (one or more LLM calls per query), latency in seconds, order-sensitive
  (needs sliding window / permutation self-consistency).
- **Hosted (Cohere Rerank):** turnkey, good quality, no infra — but per-call cost, vendor lock-in,
  and (until multimodal variants) text-only.

For samesake specifically: text-only rerankers (cross-encoder or Cohere) **cannot judge the visual
match**, which is the core of the product. With **no traffic** there is no labelled data to fine-tune
a cross-encoder, and no latency SLA pressure yet.

**Citations**
- Nogueira, Jiang, Pradeep, Lin. *Document Ranking with a Pretrained Sequence-to-Sequence Model
  (monoT5).* Findings of EMNLP 2020. — https://aclanthology.org/2020.findings-emnlp.63/ ·
  arXiv:2003.06713
- Sun et al. *Is ChatGPT Good at Search? Investigating LLMs as Re-Ranking Agents (RankGPT).*
  EMNLP 2023. arXiv:2304.09542 — https://arxiv.org/abs/2304.09542
- Jacob et al. *Drowning in Documents.* arXiv:2411.11767 — https://arxiv.org/abs/2411.11767
  (listwise LLM > pointwise cross-encoder, §4.3)

**Recommended resolution for samesake.**
In the **no-traffic / pre-PMF** phase, use a **multimodal LLM-judge-as-reranker (listwise, top-K
only)** over a small candidate set, *because* it can reason over the image + intent that a text-only
cross-encoder cannot, needs no training data you don't have, and the latency/cost cost is acceptable
without traffic. Reuse the same LLM-judge rubric from RQ3 so reranking and offline eval share one
relevance definition. **Defer a small cross-encoder (MiniLM) until you have logged
clicks/conversions** to fine-tune on and a real latency SLA — at which point a distilled cross-encoder
becomes the cheap production path and the LLM reranker becomes the offline gold/teacher. Keep it BYO
behind the existing rerank interface so any of cross-encoder / Cohere / LLM can be swapped. And per
RQ1, **blend the reranker output with the RRF order**, do not let it replace it.

---

### Honesty notes (where the literature is thin or mixed)
- **RQ1**: genuinely mixed — "replace vs blend" depends on first-stage strength; no universal answer.
- **RQ2**: no published weight ratio for original-vs-rewritten query; that's a tuning knob.
- **RQ6**: IR literature heavily favors *additive* fusion; the multiplicative-as-conjunction case is
  principled (weighted product model) but you'll tune α/β empirically, not cite a fashion benchmark.
- **RQ8**: "LLM-judge-as-reranker vs small cross-encoder" for *fashion/multimodal* has little direct
  head-to-head literature; the recommendation reasons from the visual-coverage gap + no-traffic
  constraint, not a benchmark.
