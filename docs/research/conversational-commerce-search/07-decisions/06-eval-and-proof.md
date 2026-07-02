# Decision 06 — Evaluation & Proof

## TL;DR
> samesake's reproducible eval gate is already its rigor differentiator (the whole commercial
> market is *marketed on conversion, not proven on retrieval metrics*). Strengthen it:
> adopt the **ESCI E/S/C/I 4-grade** taxonomy (eval-only — NC license), add **NDCG@10 +
> Recall@20/50**, **stratify head vs tail**, and — most important — build a **filtered-recall
> eval** (over-filtering is invisible today). Treat an **online conversion delta** as the
> eventual proof bar everyone else ultimately reports.

---

## 1. Adopt the ESCI grading taxonomy (eval asset, not training data)

Amazon's **Shopping Queries / ESCI dataset** (KDD Cup 2022: ~130k queries, 2.6M judgments,
EN/JA/ES) is the closest external analog to samesake's eval problem. Its **E**xact /
**S**ubstitute / **C**omplement / **I**rrelevant 4-grade scale is a battle-tested relevance
taxonomy. samesake's grade@10 (≈2.33) is already graded, not binary — align it to E/S/C/I, and
adopt the **substitute vs complement** distinction so the eval rewards "right category, wrong
exact item" instead of scoring it a miss. **License caveat: CC BY-NC-SA — eval/benchmark only;
do not train a shipped commercial model on it.** (The image-enriched **SQID** extension is the
multimodal analog if a public fashion-image relevance set is ever needed.)
(`03-academic/large-retailer-product-search.md`)

## 2. Expand the metric set (from Marqo's metric primers — substance, not the numbers)

Marqo's metric posts are textbook-correct IR wrapped in conversion framing; the *substance* is
reusable, the *comparative numbers* are unaudited marketing. Adopt the **four-metrics-together
discipline**: add **NDCG@10** (rank-quality, Marqo's own headline metric) and **Recall@20/@50**
alongside the existing grade@10 / P@5. Use Marqo's published score bands only as **sanity lore,
not targets** (uncited): NDCG@10 0.45–0.65 typical / >0.70 strong; P@10 >0.80 strong;
Recall@20 >0.70 strong; MRR >0.80 excellent. Add **zero-results rate** as a first-class KPI
(<5% target, >10% urgent — computable with no human labels). (`01-marqo/metrics-and-behavioral-critique.md`)

## 3. Stratify head vs tail — the single most informative cut

JD.com's DPSR: semantic retrieval gave **+1.29% conversion overall but +10.03% on tail
queries.** A single mean grade@10 can hide a big tail win *or* a head-query regression.
**Report eval stratified by query frequency** (head / torso / tail) and by query *type*
(keyword/attribute/use-case/price/negation/style/local/broad — samesake already has these in
its golden set). This also reframes the "local" weakness honestly (corpus depth, not engine
regression). (`03-academic/large-retailer-product-search.md`)

## 4. Build a filtered-recall eval (the missing, load-bearing one)

Unfiltered grade@10 / P@5 say **nothing** about over-filtering — the #1 architectural risk
(Decision 02 §6). On an approximate HNSW index, a selective hard filter (`price<=X AND
available=true AND color∋…`) can silently starve results. **Build an eval that measures recall
*under realistic filter predicates*** and gate on it before trusting hard-filter-then-rank. This
is the highest-value addition to the harness — without it, the correctness promise ("hard filters
stay hard") is unverified. Surface in `/search/explain` when iterative scanning triggered.
(`03-academic/hybrid-fusion-and-vector-scaling.md`)

## 5. Gate every new lever the way "spaces" was gated

"Spaces" is **off because it failed the gate** — keep that empirical honesty; it's a positioning
asset, not an embarrassment. Apply the same gate to the new levers:
- **Cross-encoder reranker** — must beat grade@10/P@5 *within a stated latency + FLOPs budget*
  (the FLOPs paper warns nDCG gains hide compute cost; gate on cost, not just quality).
- **CC fusion** — promote over RRF only when it beats RRF on a tenant's labeled set.
- **Clarifying question** — must show monotonic HIT@10 lift without conversion drop.
- **"Spaces" re-investigation** — re-gate under CC weighting, not flat RRF.

## 6. The eventual proof bar: online conversion

Every PROVEN win in the retailer literature is ultimately an **online metric** — CVR, purchase
rate, transaction rate, CTR (JD +1.29% CVR; Etsy +5.58% purchase rate; Pinterest >8% relevance
/ >7% engagement; Mercari up to +40.9% transaction rate). samesake's grade@10 / P@5 are
**offline-only**. The eventual credibility bar is an **online conversion delta in a live store**
— flag this as the real proof, and design for a clean **shadow / parallel A/B** path (trivial
because samesake runs in-app), which is also the lowest-risk adoption motion (Marqo sells exactly
this as "parallel shadow testing"). (`03-academic/large-retailer-product-search.md`,
`01-marqo/scaling-performance.md`)

## 7. Methodology layer (completeness-pass addition — see Decision 07 → D25)

The metric *set* above is necessary but not sufficient; the *instrument* that produces it needs
its own discipline (full treatment: `10-gaps/eval-methodology-llm-judge.md`):
- **grade@10 is generated, not measured.** A Gemini ESCI judge is only "fair" per-item
  (Cohen κ ≈ 0.31–0.37, UMBRELA/TREC) but "high" at system ranking (Kendall τ ≈ 0.9): **trust
  aggregate deltas ("B beat A on the frozen judge"), never absolute per-item grades.**
- **Never let the same model family enrich *and* judge** (Gemini self-preference closed loop) —
  the most important operational warning.
- **Version-pin + hash the judge prompt/model** (a prompt edit silently rebases the benchmark);
  expose it in `/search/explain`. Use a **multimodal judge** (fashion is visual) + a **pairwise
  gate judge**. Build a **~200-item native-speaker LK anchor set** and report κ against it.
- **Online:** Team-Draft **Interleaving beats A/B 10–100×** in sensitivity → the right first-tenant
  tool for low-traffic LK stores; A/B/switchback only to confirm business lift and for non-ranking
  changes. Offline NDCG predicts online ~97% (Amazon SIGIR 2022) **only if the E/S/C/I→gain mapping
  matches the conversion objective** — state and freeze it.

## Sources
`03-academic/large-retailer-product-search.md`, `03-academic/hybrid-fusion-and-vector-scaling.md`,
`03-academic/conversational-and-generative-retrieval.md`, `01-marqo/metrics-and-behavioral-critique.md`,
`10-gaps/eval-methodology-llm-judge.md`.
