# Conversational & Generative Retrieval for Commerce Search — Academic Prior Art

> Prior-art dossier for **samesake**, a TypeScript-first "search engine compiler" for visual commerce. samesake compiles a typed catalog into a Postgres + pgvector hybrid search layer (FTS + cosine ANN over BYO embeddings + optional segmented "spaces" vectors, fused via RRF), with hard SQL-predicate filters that gate before ranking, an NLQ parser on a constrained schema, a multimodal enrich pipeline, entity resolution/dedup, `/search/explain` auditability, and a `findProducts()` agentic surface that **stops at retrieval**. Current benchmarks: mean grade@10 ~2.33, P@5 0.83 on a ~5k-doc LK fashion corpus; "spaces" off by default (failed eval gate).
>
> This file surveys the academic literature on conversational/multi-turn product search, clarifying questions, query reformulation, LLM-as-reranker, RAG over product catalogs, generative retrieval (DSI / generative recommendation), and agentic/tool-use shopping — with datasets and 2023–2026 papers. Each entry gives title / year / method / result / link, and distinguishes **PROVEN** (measured in a paper) from **MARKETED/CLAIMED** (asserted without independent verification).

---

## 0. How this maps to samesake (TL;DR for the build)

| Academic thread | What it proves | samesake implication |
|---|---|---|
| Conversational product search w/ clarifying Qs (ProductAgent, System-Ask-User-Respond) | Multi-turn clarification measurably **raises** retrieval HIT/MRR turn-over-turn | `findProducts()` could ask one targeted clarifying question when intent is under-constrained; gate it behind a confidence/coverage signal, not always-on |
| LLM-as-reranker (RankGPT, RankZephyr, RankVicuna) | Zero-shot listwise LLM reranking beats supervised SOTA on TREC/BEIR; distillable to small models | samesake fuses FTS+ANN via RRF today; an **optional** distilled cross-encoder/LLM reranker on the top-K is the natural next ranking stage — keep it BYO and off the hot path |
| Generative retrieval / DSI / TIGER | Docids/semantic-IDs can be *generated*; strong cold-start generalization | Architecturally **opposite** to samesake's design (Postgres index + ANN). Useful as a contrast, not a path; index-in-model conflicts with "runs in your own Postgres, auditable" |
| RAG over product catalogs | Grounding LLM answers in retrieved catalog/KG improves factuality | samesake is the *retrieval* substrate a RAG/agent layer sits on; `/search/explain` + grounding aligns with RAG-eval expectations |
| Agentic shopping (WebShop, ShoppingBench, Shopping MMLU) | Even GPT-4-class agents are weak at end-to-end shopping (29–48% success) | Validates samesake's "stop at retrieval" boundary: the hard, unsolved part is downstream planning/checkout, not retrieval. Differentiate by being the *grounded, verifiable retrieval tool* an agent calls |
| Query reformulation (MiniELM, e-comm rewrite) | LLM rewriting helps but is latency/cost-heavy; long-tail over-generation hurts | samesake's NLQ parser on a **constrained schema** is a deliberately cheaper, safer alternative to free-form LLM rewriting |

---

## 1. Datasets & Benchmarks

### 1.1 Shopping MMLU (NeurIPS 2024 D&B) — **PROVEN benchmark**
- **Title:** *Shopping MMLU: A Massive Multi-Task Online Shopping Benchmark for Large Language Models*
- **Authors:** Yilun Jin, Zheng Li, Chenwei Zhang, et al. (22 authors; Amazon + HKUST + Notre Dame)
- **Year:** 2024 — NeurIPS 2024 Datasets & Benchmarks Track
- **What it is:** "**57 tasks** covering **4 major shopping skills**: concept understanding, knowledge reasoning, user behavior alignment, and multi-linguality" derived from real-world Amazon data; **20,799 questions** total.
- **Scale of eval:** evaluated "**over 20 existing LLMs**"; basis for **Amazon KDD Cup 2024** ("over 500 participating teams").
- **License:** GitHub repo Apache-2.0; paper notes CC BY-NC-SA 4.0 for data. (Two sources disagree on the exact data license — verify before any reuse.)
- **Relevance to samesake:** the single best off-the-shelf yardstick for "shop-assistant" LLM competence — concept understanding and user-behavior-alignment tasks are directly relevant to enrich/NLQ quality. **Caveat:** Amazon-domain, mostly text QA, not fashion-visual; samesake's LK fashion corpus is out-of-distribution, so use Shopping MMLU for *capability sanity-checks*, not as samesake's primary eval.
- **Links:** https://arxiv.org/abs/2410.20745 · https://github.com/KL4805/ShoppingMMLU · https://openreview.net/forum?id=D3jyWDBZTk

### 1.2 Amazon-M2 (NeurIPS 2023 D&B) — **PROVEN benchmark**
- **Title:** *Amazon-M2: A Multilingual Multi-locale Shopping Session Dataset for Recommendation and Text Generation*
- **Year:** 2023 — NeurIPS 2023 D&B; basis for **KDD Cup 2023**
- **What it is:** "the first multilingual dataset consisting of millions of user sessions from **six different locales**" (English, German, Japanese, French, Italian, Spanish). Three tasks: (1) next-product recommendation, (2) next-product recommendation with domain shifts, (3) next-product title generation.
- **Relevance to samesake:** session-based / sequential signal — *not* samesake's current single-shot retrieval model, but the multilingual angle and "next-product" framing matter if samesake later adds session personalization or a recommendation surface. The title-generation task overlaps with the enrich pipeline.
- **Links:** https://arxiv.org/abs/2307.09688 · https://proceedings.neurips.cc/paper_files/paper/2023/hash/193df57a2366d032fb18dcac0698d09a-Abstract-Datasets_and_Benchmarks.html

### 1.3 ProClare / ProductAgent benchmark — **PROVEN benchmark + method (see §2.1)**
- Conversational product search benchmark over "**1,000,000 documents across 20 categories**" from AliMe KG (Alibaba). Two settings: traditional (2,000 Doc2Query-synthesized queries) and conversational (2,000 LLM-user-simulator dialogues, 10 turns each). Metrics: MRR@10, HIT@10.
- **Link:** https://arxiv.org/abs/2407.00942 (HTML: https://arxiv.org/html/2407.00942)

### 1.4 WebShop (NeurIPS 2022) — **PROVEN agentic benchmark**
- **Title:** *WebShop: Towards Scalable Real-World Web Interaction with Grounded Language Agents*
- **Authors:** Shunyu Yao, Howard Chen, John Yang, Karthik Narasimhan (Princeton)
- **Year:** 2022
- **What it is:** simulated e-commerce site with "**1.18 million real-world products and 12,087 crowd-sourced text instructions**"; agent must search, browse, and buy the item matching an instruction.
- **Results (PROVEN):** best model **29% task success** vs rule-based heuristic 9.6% vs **human expert 59%**. "Agents trained on WebShop exhibit non-trivial **sim-to-real transfer** when evaluated on amazon.com and ebay.com."
- **Relevance to samesake:** the canonical demonstration that *end-to-end shopping is hard and unsolved* — the 29% vs 59% gap is the empirical backbone for samesake's "stop at retrieval" stance. samesake addresses the *search* sub-step that WebShop agents must repeatedly invoke.
- **Link:** https://arxiv.org/abs/2207.01206

### 1.5 ShoppingBench (2024/2025) — **PROVEN agentic benchmark**
- **Title:** *ShoppingBench: A Real-World Intent-Grounded Shopping Benchmark for LLM-based Agents*
- **Authors:** Jiangyuan Wang, Kejun Xiao, et al. (Lazada/Alibaba)
- **What it is:** four progressively harder intents — Products Finder, Knowledge (implicit-knowledge relevance), Multi-products Seller, Coupon & Budget (constraint optimization). **3,310 instructions** (2,410 train / 900 test) over a sandbox of "**2.5+ million real-world products from Lazada**."
- **Results (PROVEN):** "**even the best-performing language agent (GPT-4.1-based) achieves a success rate below 50%**" — GPT-4.1 = **48.2%** overall, dropping to **30.4% on Coupon & Budget** vs 59.6% on simple product finding. A fine-tuned Qwen3-4B reached 48.7% after distillation.
- **Relevance to samesake:** directly reinforces the retrieval-boundary thesis. The "Products Finder" and "Knowledge" intents are exactly what `findProducts()` targets; the Coupon/Budget collapse is squarely downstream of retrieval (planning/cart), which samesake correctly excludes. The "Knowledge" intent (implicit relevance) is the hardest part samesake's enrich pipeline can help with.
- **Link:** https://arxiv.org/html/2508.04266v3

---

## 2. Conversational / Multi-turn Product Search & Clarifying Questions

### 2.1 ProductAgent (2024) — **PROVEN method**
- **Title:** *ProductAgent: Benchmarking Conversational Product Search Agent with Asking Clarification Questions*
- **Authors:** Jingheng Ye, Yong Jiang, Xiaobin Wang, Yinghui Li, Yangning Li, Hai-Tao Zheng, Pengjun Xie, Fei Huang (Tsinghua + Alibaba)
- **Year:** 2024
- **Method:** an LLM agent running a "conversational loop" of (1) **Category Analysis** (generate a query for known demands, retrieve, summarize as dynamic statistics), (2) **Item Search** (NL query → Retriever), (3) **Clarification Question Generation** (new clarifying questions + answer candidates). Tools: Text2SQL, Category Analyze, Query Generation, Retriever, Question Generation. Backed by **both SQL and dense-vector DBs** plus a memory module storing structured Q&A pairs.
- **Results (PROVEN):** conversational setting (GPT-4 + BM25): **Turn 1 HIT@10 = 39.48%, MRR@10 = 32.00%**; "retrieval performance **improves with increasing dialogue turns**" across all LLM backbones.
- **Relevance to samesake — high.** The Text2SQL + dense-retriever + structured-memory architecture is *strikingly close* to samesake's stack (Postgres SQL predicates + pgvector ANN + typed catalog). The proven turn-over-turn HIT@10 lift is the empirical case for adding **one bounded clarifying question** to `findProducts()` when constraints are sparse. samesake's constrained NLQ schema is a natural place to ground the clarification (ask about a missing typed facet, not free text).
- **Link:** https://arxiv.org/abs/2407.00942

### 2.2 "System Ask, User Respond" (CIKM 2018) — foundational, **PROVEN**
- **Title:** *Towards Conversational Search and Recommendation: System Ask, User Respond*
- **Authors:** Yongfeng Zhang, Xu Chen, Qingyao Ai, Liu Yang, W. Bruce Croft
- **Year:** 2018
- **Method:** unified framework where the system asks **aspect-value** questions and the user responds, refining product search; multi-memory network over extracted aspect-value pairs.
- **Relevance to samesake:** the original "ask-to-refine" formulation. The aspect-value structure prefigures samesake's typed facets — clarification over *typed catalog attributes* (color, silhouette, price band) is the principled descendant of this work.
- **Link:** http://yongfeng.me/attach/conv-search-rec-zhang2018.pdf

### 2.3 Conversational Product Search Based on Negative Feedback (CIKM 2019) — **PROVEN**
- **Authors:** Keping Bi, Qingyao Ai, Yongfeng Zhang, W. Bruce Croft
- **Method:** when users reject shown items, collect fine-grained **negative aspect-value feedback** and use it to relax/redirect retrieval.
- **Relevance to samesake:** maps onto samesake's **soft-filter relaxation** idea — negative feedback is a relaxation signal. A "not this" gesture in `findProducts()` could compile to soft-filter down-weighting rather than a hard exclude.
- **Link:** https://arxiv.org/pdf/1909.02071

### 2.4 ClarQ-LLM (2024) — **PROVEN benchmark**
- **Title:** *ClarQ-LLM: A Benchmark for Models Clarifying and Requesting Information in Task-Oriented Dialog*
- **Year:** 2024
- **What it is:** evaluates whether LLMs **know when and how to clarify** to resolve ambiguity / fill missing slots in task-oriented dialog (broader than commerce).
- **Relevance to samesake:** the "when to ask vs when to just retrieve" decision is exactly the gating question for `findProducts()`. Over-asking is a known UX failure; this benchmark is the lens for tuning that threshold.
- **Link:** https://arxiv.org/abs/2409.06097 · https://github.com/ygan/ClarQ-LLM

### 2.5 AGENT-CQ (2024) — **PROVEN method**
- **Title:** *AGENT-CQ: Automatic Generation and Evaluation of Clarifying Questions for Conversational Search with LLMs*
- **Year:** 2024
- **Method:** LLM pipeline to *generate* and *evaluate* diverse clarifying questions; argues question diversity/quality drives downstream retrieval gains.
- **Relevance to samesake:** if samesake adds clarification, AGENT-CQ's generate-then-evaluate loop is a template for keeping clarifying questions grounded and non-redundant — and could be wired through the same eval gate samesake already uses for "spaces."
- **Link:** https://arxiv.org/pdf/2410.19692

### 2.6 Survey: *Conversational Search: From Fundamentals to Frontiers in the LLM Era* (2025)
- **Authors:** Fengran Mo, Chuan Meng, Mohammad Aliannejadi, Jian-Yun Nie
- **Structure:** Fundamentals (query reformulation, dense retrieval, mixed-initiative) + LLM-era topics (automatic evaluation, generation-augmented retrieval (GAR), RAG, personalization, **agentic systems** that "complete users' information tasks via actions and interactions"). On clarification: the open question is "**what type of initiative to take and when to take it**."
- **Relevance to samesake:** the clearest current map of the field's components; samesake implements the *retrieval + query-understanding* core and deliberately leaves "agentic action" downstream — consistent with this survey's separation of components.
- **Link:** https://arxiv.org/html/2506.10635v1

---

## 3. LLM-as-Reranker

### 3.1 RankGPT (EMNLP 2023 Outstanding Paper) — **PROVEN, seminal**
- **Title:** *Is ChatGPT Good at Search? Investigating Large Language Models as Re-Ranking Agents*
- **Authors:** Weiwei Sun et al.
- **Year:** 2023
- **Method:** zero-shot **instructional permutation generation** — sliding window over candidate passages, LLM emits a permutation (listwise). Plus **permutation distillation** into small specialized models. Introduces **NovelEval** to control for data contamination.
- **Results (PROVEN):** "GPT-4 with zero-shot instructional permutation generation **outperforms supervised systems on almost all datasets**," beating prior SOTA by avg **+2.7 / +2.3 / +2.7 nDCG on TREC / BEIR / My.TyDi**. A **distilled 440M model outperforms a 3B supervised model** on BEIR.
- **Relevance to samesake — high.** samesake's RRF fusion produces a candidate set; a listwise LLM reranker over the top-K is the highest-leverage ranking upgrade. The distillation result is the operationally important one: samesake can run a **small distilled cross-encoder/reranker locally** (consistent with the two-container, BYO-model, no-hosted-service ethos) rather than calling a frontier API on the hot path. Keep it optional and behind the eval gate.
- **Link:** https://arxiv.org/abs/2304.09542 · https://github.com/sunnweiwei/RankGPT

### 3.2 RankVicuna (2023) — **PROVEN, open-source**
- **Title:** *RankVicuna: Zero-Shot Listwise Document Reranking with Open-Source Large Language Models*
- "the **first fully open-source LLM** capable of high-quality listwise reranking in a zero-shot setting" — reproducible without proprietary models.
- **Relevance to samesake:** proves the reranker can be fully open/BYO — no dependency on a closed API, matching samesake's deployment constraints.
- **Link:** https://arxiv.org/abs/2309.15088

### 3.3 RankZephyr (2023) — **PROVEN, open-source**
- **Title:** *RankZephyr: Effective and Robust Zero-Shot Listwise Reranking is a Breeze!*
- Open 7B reranker that "bridges the gap and in some cases goes beyond **RankGPT-4**."
- **Relevance to samesake:** a concrete, sized (7B) open model that is a candidate BYO reranker; demonstrates open models now rival closed for this narrow task.
- **Link:** https://arxiv.org/abs/2312.02724

### 3.4 LLM rerankers for e-commerce specifically (2024–2026) — **PROVEN methods, narrower**
- **Hint-Augmented Re-ranking** (2025) — LLM **query decomposition** + small (<3B) pointwise rerankers (Qwen2.5-0.5B/3B) as a resource-efficient product-search reranker, benchmarked against Qwen2.5-72B and DeepSeek-R1. https://arxiv.org/html/2511.13994
- **MemRerank** (2026) — setwise reranker fed a concise **preference memory** for personalization, rather than changing the ranker. https://arxiv.org/html/2603.29247
- **Efficiency-Effectiveness Reranking FLOPs** (2025) — argues LLM-call/token counts mislead; proposes FLOPs-aware evaluation because "LLM-based rerankers have achieved impressive gains in NDCG … at substantial computational expense." https://arxiv.org/html/2507.06223
- **Relevance to samesake:** these are the realistic pattern — *small, pointwise/setwise, latency-aware* rerankers, not frontier listwise calls. The FLOPs paper is a direct warning: any reranker samesake adds must clear a **latency+cost gate**, not just an nDCG gate. samesake's existing eval-gate discipline ("spaces" off until it passes) is exactly the right governance for this.

---

## 4. RAG over Product Catalogs

### 4.1 Graph-Enhanced RAG for E-Commerce Customer Support (2025) — **method PROVEN; numbers CLAIMED**
- **Title:** *Graph-Enhanced Retrieval-Augmented Question Answering for E-Commerce Customer Support*
- **Method:** RAG grounded in a knowledge graph ("**50,000 product entities and 2.3 million relations**" from catalogs + 500k resolved tickets).
- **Claims:** "23% improvement in factual accuracy and 89% user satisfaction" — **MARKETED/internal-eval**; treat as single-paper self-report, not independently verified.
- **Relevance to samesake:** KG-grounding is one route to factuality; samesake's typed catalog + entity-resolution is a lighter-weight structural grounding that serves a similar purpose without standing up a separate graph store. Validates that *structure improves grounding*; differentiate on "structure already lives in your Postgres."
- **Link:** https://arxiv.org/abs/2509.14267

### 4.2 Contextually Aware E-Commerce Product QA using RAG (2025) — **PROVEN method**
- RAG for product Q&A that conditions retrieval on product/user context.
- **Relevance to samesake:** samesake is the *retrieval substrate* such a system needs; `/search/explain` provides the provenance a RAG answer layer should cite.
- **Link:** https://arxiv.org/pdf/2508.01990

### 4.3 RAG surveys (context)
- *A Comprehensive Survey of RAG: Evolution, Current Landscape and Future Directions* (2024) — https://arxiv.org/abs/2410.12837
- *Retrieval-Augmented Generation Evaluation in the Era of LLMs: A Comprehensive Survey* (2025) — https://arxiv.org/html/2504.14891v1
- **Relevance to samesake:** RAG-eval frameworks (faithfulness, grounding, answer relevance) are the vocabulary a samesake-powered agent layer will be judged on; samesake's verification/grounding/"why" outputs in `findProducts()` should align to these axes.

---

## 5. Generative Retrieval & Generative Recommendation (architectural contrast)

### 5.1 Differentiable Search Index / DSI (NeurIPS 2022) — **PROVEN, seminal**
- **Title:** *Transformer Memory as a Differentiable Search Index*
- **Authors:** Yi Tay, Vinh Q. Tran, Mostafa Dehghani, et al. (Google)
- **Method:** seq2seq model maps a query string **directly to a docid** — the corpus index lives *in transformer parameters*. Joint indexing (doc→docid) + retrieval (query→docid) training.
- **Results (PROVEN):** "given appropriate design choices, DSI **significantly outperforms strong baselines such as dual encoder models**," and beats BM25 zero-shot. (NQ.)
- **Relevance to samesake — contrast/avoid.** DSI is the *antithesis* of samesake's design: index-in-model means no SQL predicates, no auditable `/search/explain`, expensive re-indexing on catalog change (a hard problem — see DSI++, IncDSI), and no hard-filter gating. For a mutable fashion catalog with price/availability filters, the Postgres+ANN approach is the right call. Cite DSI to *explain why samesake did not go generative*.
- **Link:** https://arxiv.org/abs/2202.06991

### 5.2 TIGER — Recommender Systems with Generative Retrieval (NeurIPS 2023) — **PROVEN, seminal**
- **Title:** *Recommender Systems with Generative Retrieval*
- **Authors:** Shashank Rajput, Nikhil Mehta, Anima Singh, et al. (Google)
- **Method:** each item gets a **Semantic ID** — a tuple of discrete codewords from RQ-VAE quantization of content embeddings; a seq2seq model autoregressively generates the next item's Semantic ID.
- **Results (PROVEN, qualitative from abstract):** "significantly outperform[s]" SOTA sequential recommenders; notable **cold-start generalization** ("improved retrieval performance for items with no prior interaction history"). (Exact per-dataset numbers in the full PDF, not the abstract.)
- **Relevance to samesake:** the cold-start angle is genuinely interesting for a fashion catalog with constant new SKUs — semantic-ID generalization is something pure ANN handles via embeddings rather than generation. samesake's **BYO embeddings + ANN** already get content-based cold-start without the generative machinery or the re-quantization/re-training burden. Useful as the "generative recsys" reference point; not a path samesake needs to take.
- **Link:** https://arxiv.org/abs/2305.05065
- **Follow-ups (context):** *How Does Generative Retrieval Scale to Millions of Passages?* (https://arxiv.org/pdf/2305.11841) — scaling is a known weak spot; *Differentiable Semantic ID for Generative Recommendation* (2026, https://arxiv.org/html/2601.19711).

---

## 6. Query Reformulation / Rewriting

### 6.1 MiniELM (ACL Findings 2025) — **PROVEN method**
- **Title:** *MiniELM: A Lightweight and Adaptive Query Rewriting Framework for E-Commerce Search Optimization* (a.k.a. *RL-based Query Rewriting with Distilled LLM for online E-Commerce Systems*)
- **Method:** offline **knowledge distillation** → small student model, + online **RL** to refine rewrites from real-time feedback.
- **Key finding (PROVEN, important):** "a notable limitation of vanilla LLMs is their tendency to **generate long-tail queries with excessive length**," and "generative methods face challenges in real-time e-commerce due to **high inference latency and computational costs**, making them unsuitable for direct online deployment."
- **Relevance to samesake — high, validates a design choice.** This is the empirical case *against* dropping a free-form LLM rewriter on the hot path. samesake's **constrained-schema NLQ parser** sidesteps both failure modes (no long-tail over-generation; bounded, cheap parse). Differentiator: typed/constrained reformulation beats free-form rewriting for latency and predictability.
- **Links:** https://arxiv.org/html/2501.18056 · https://aclanthology.org/2025.findings-acl.363.pdf

### 6.2 Scalability/Extensibility of Query Reformulation in E-commerce (2024) — **PROVEN**
- Behavior-driven (clicks/purchases) reformulation modeling at scale.
- **Relevance:** reminds that reformulation gains in production lean on behavioral signals samesake does not currently ingest — a future signal source, not a v1 need.
- **Link:** https://arxiv.org/abs/2402.11202

### 6.3 OptAgent (2025) — query-rewrite optimization via agentic loop. https://arxiv.org/pdf/2510.03771

---

## 7. Agentic / Tool-Use Shopping (beyond §1.4–1.5)

- **WebShop (2022)** and **ShoppingBench (2024/25)** — covered in §1.4–1.5; both show *retrieval is the tractable sub-problem; planning/checkout is where agents fail*.
- **AgentBench (2023)** — *AgentBench: Evaluating LLMs as Agents* — multi-environment agent eval (incl. web shopping). https://arxiv.org/html/2308.03688v3
- **Survey on Evaluation of LLM-based Agents (2025)** — https://arxiv.org/html/2503.16416
- **OPeRA (2025)** — *A Dataset of Observation, Persona, Rationale, and Action for Evaluating LLMs on Human Online Shopping Behavior Simulation* — https://arxiv.org/pdf/2506.05606
- **Relevance to samesake:** the agent-eval literature increasingly separates "tool quality" from "agent planning quality." samesake should position as a **high-quality, verifiable retrieval tool** an agent calls — its `findProducts()` (intent + constraints + image → grounded products with verification/grounding/why) is precisely the kind of well-specified tool these benchmarks reward, and the "stop at retrieval" boundary keeps it out of the part agents are demonstrably bad at.

---

## 8. PROVEN vs MARKETED — quick ledger

| Claim | Status | Basis |
|---|---|---|
| Multi-turn clarification raises retrieval HIT@10/MRR@10 | **PROVEN** | ProductAgent, turn-over-turn lift (https://arxiv.org/abs/2407.00942) |
| Zero-shot listwise LLM reranking beats supervised SOTA | **PROVEN** | RankGPT +2.3–2.7 nDCG (https://arxiv.org/abs/2304.09542) |
| LLM reranking distills to small/open models | **PROVEN** | RankGPT 440M>3B; RankVicuna/RankZephyr open |
| LLM rerankers are costly; need FLOPs-aware eval | **PROVEN** | https://arxiv.org/html/2507.06223 |
| Free-form LLM query rewriting is latency/long-tail-risky online | **PROVEN** | MiniELM (https://arxiv.org/html/2501.18056) |
| Generative retrieval (DSI) beats dual-encoder on NQ | **PROVEN** (but hard to re-index/scale) | DSI + scaling follow-ups |
| Semantic-ID generative recsys helps cold-start | **PROVEN (qualitative in abstract)** | TIGER (https://arxiv.org/abs/2305.05065) |
| End-to-end shopping agents are weak (≤50% success) | **PROVEN** | WebShop 29% vs human 59%; ShoppingBench GPT-4.1 48.2% |
| Graph-RAG "+23% factual accuracy, 89% satisfaction" | **MARKETED / single-paper self-report** | https://arxiv.org/abs/2509.14267 |

---

## 9. Open questions for samesake

1. **Clarifying-question gate.** ProductAgent proves turn-over-turn lift, but ClarQ-LLM/AGENT-CQ show over-asking is a failure mode. What confidence/coverage signal in samesake's retrieval (e.g., RRF score dispersion, hard-filter cardinality) should trigger *one* clarifying question over a *typed* facet — and can that decision pass an eval gate like "spaces" must?
2. **Reranker on the hot path.** RankGPT-class quality is real, but the FLOPs paper warns on cost. Does a distilled small cross-encoder reranker over the RRF top-K beat current grade@10 ~2.33 / P@5 0.83 on the LK corpus *within an acceptable latency budget* in the two-container model?
3. **Cold-start without generation.** TIGER's semantic-ID cold-start vs samesake's BYO-embedding ANN — is there a measurable cold-start gap on new fashion SKUs, or does content-embedding ANN already close it?
4. **Eval transfer.** Shopping MMLU / ShoppingBench are Amazon/Lazada and text-heavy. What is the right *fashion-visual* analogue to validate samesake's enrich + multimodal retrieval beyond the in-house LK corpus?
5. **"Spaces" vs the literature.** The segmented "spaces" vectors failed samesake's eval gate. Does any segmented/aspect-vector result in the conversational/aspect-value literature (§2.2–2.3) suggest a corpus regime where spaces would pass?

---

## Sources
- Shopping MMLU — https://arxiv.org/abs/2410.20745 · https://github.com/KL4805/ShoppingMMLU · https://openreview.net/forum?id=D3jyWDBZTk
- Amazon-M2 — https://arxiv.org/abs/2307.09688 · https://proceedings.neurips.cc/paper_files/paper/2023/hash/193df57a2366d032fb18dcac0698d09a-Abstract-Datasets_and_Benchmarks.html
- ProductAgent / ProClare — https://arxiv.org/abs/2407.00942 · https://arxiv.org/html/2407.00942
- System Ask, User Respond — http://yongfeng.me/attach/conv-search-rec-zhang2018.pdf
- Conversational Product Search w/ Negative Feedback — https://arxiv.org/pdf/1909.02071
- ClarQ-LLM — https://arxiv.org/abs/2409.06097 · https://github.com/ygan/ClarQ-LLM
- AGENT-CQ — https://arxiv.org/pdf/2410.19692
- Conversational Search survey (LLM era) — https://arxiv.org/html/2506.10635v1
- RankGPT — https://arxiv.org/abs/2304.09542 · https://github.com/sunnweiwei/RankGPT
- RankVicuna — https://arxiv.org/abs/2309.15088
- RankZephyr — https://arxiv.org/abs/2312.02724
- Hint-Augmented Re-ranking — https://arxiv.org/html/2511.13994
- MemRerank — https://arxiv.org/html/2603.29247
- Efficiency-Effectiveness Reranking FLOPs — https://arxiv.org/html/2507.06223
- Graph-Enhanced RAG (e-comm) — https://arxiv.org/abs/2509.14267
- Contextually Aware E-Comm Product QA (RAG) — https://arxiv.org/pdf/2508.01990
- RAG surveys — https://arxiv.org/abs/2410.12837 · https://arxiv.org/html/2504.14891v1
- DSI — https://arxiv.org/abs/2202.06991
- DSI scaling — https://arxiv.org/pdf/2305.11841
- TIGER — https://arxiv.org/abs/2305.05065
- MiniELM / RL query rewrite — https://arxiv.org/html/2501.18056 · https://aclanthology.org/2025.findings-acl.363.pdf
- Query reformulation scalability — https://arxiv.org/abs/2402.11202
- OptAgent — https://arxiv.org/pdf/2510.03771
- WebShop — https://arxiv.org/abs/2207.01206
- ShoppingBench — https://arxiv.org/html/2508.04266v3
- AgentBench — https://arxiv.org/html/2308.03688v3
- Survey on Evaluation of LLM-based Agents — https://arxiv.org/html/2503.16416
- OPeRA — https://arxiv.org/pdf/2506.05606
