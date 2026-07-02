# RAG for Product Catalogs & Product Q&A — Prior-Art Dossier

> Research target: **samesake** — a TypeScript-first "search engine compiler" for visual commerce. It compiles a typed catalog declaration into a Postgres + pgvector hybrid retrieval layer (FTS + cosine ANN over BYO embeddings + typed "spaces" vectors, fused via RRF), with hard/soft SQL filters that gate before ranking, a constrained-schema NLQ parser, a multimodal enrich pipeline, entity-resolution/dedup, `/search/explain` auditability, and a `findProducts()` agentic surface that **deliberately stops at retrieval**. samesake does **retrieval, not generation, not recommendations**.
>
> This dossier surveys **Retrieval-Augmented Generation (RAG) applied to product catalogs and product Q&A** — the layer that a consumer would bolt *on top of* samesake's retrieval. The framing question throughout: **which RAG responsibilities does samesake already own (grounded retrieval, verification, "why"), and where does the generation boundary fall?**

---

## 0. TL;DR for samesake

- **RAG = Retriever + Generator.** Every reference architecture surveyed (Amazon Rufus, the contextually-aware e-commerce QA pipeline, Retail-GPT, the e-commerce graph-RAG systems) decomposes into the **same two halves**: (1) a retrieval stage that gathers grounded evidence from catalog/reviews/Q&A/policies, and (2) an LLM generation stage that synthesizes a cited answer. samesake is a best-in-class implementation of half **(1)** with the generation half **deliberately omitted**.
- **The hard, valuable, defensible part of product RAG is the retrieval half** — heterogeneous structured+unstructured retrieval, hard-filter gating, hybrid fusion, dedup, and "why/explain" provenance. samesake already does this. The generation half is a thin, swappable, BYO-LLM prompt-assembly layer.
- **Faithfulness/groundedness is a retrieval-quality problem first.** A grounded answer is impossible if the context is wrong; RAGAS, RGB, and the production Amazon work all show the dominant failure mode is **retrieval**, not generation. samesake's `/search/explain` + hard-filter gating + RRF directly attack the upstream cause.
- **The single most important RAG pattern for samesake to be aware of (not necessarily build): citation/attribution.** Amazon's production "Cite Before You Speak" shows citing the evidence behind each claim lifted grounding +13.83% and customer engagement +3–10% in A/B tests. samesake already returns the grounded, attributable evidence objects (product + why + verification) that a citation layer needs as input.
- **Recommendation for samesake: stay at the retrieval boundary, but harden the *contract* it hands the generator.** Emit per-result, machine-checkable provenance (which field/review/spec supports which attribute) so a downstream LLM can cite without re-deriving grounding. This is "differentiate + integrate," not "expand into generation."

---

## 1. What "RAG for products" means (and how it differs from doc-RAG)

Classic RAG (Lewis et al., 2020) retrieves text passages from a corpus and conditions an LLM on them. **Product RAG is a special, harder case** because the knowledge is heterogeneous and partly structured:

| Knowledge source | Shape | Query type it answers | Retrieval method |
|---|---|---|---|
| Catalog attributes (price, size, material, availability) | **Structured** (rows/columns) | Objective ("is it waterproof?", "under $50?") | SQL predicate / API / structured lookup |
| Product description / spec sheet | Semi-structured text | Objective + descriptive | FTS + dense embedding |
| Customer reviews | **Unstructured**, noisy, contradictory | **Subjective** ("does it run small?", "is it durable?") | Dense embedding + rerank, often aggregate-over-many |
| Community Q&A | Unstructured pairs | Both | Dense embedding |
| Policies (returns, shipping) | Document | Procedural | FTS + dense |
| Images | Visual | "looks like this", color/style | CLIP-style embedding ANN |

The recurring lesson across the literature: **structured data and unstructured data need different retrievers, and a naive "embed every row as a sentence" pipeline fails on the structured half.** From a hybrid-RAG survey of e-commerce retrieval: *"a naive RAG pipeline that embeds table rows as text will fail at any query requiring calculation, exact numeric matching, or an understanding of relational table structures"* (TechAhead, *Hybrid RAG Architecture*). This is precisely why samesake compiles `price<=X` / `available=true` into **SQL predicates that gate before ranking** rather than embedding them — it is structurally on the correct side of this lesson.

**When to retrieve products vs documents.** Production systems route. Amazon's REAPER (CIKM 2024, evaluated *on Rufus*) frames this explicitly: *"RAG systems retrieve from massive heterogeneous data stores that are usually architected as multiple indexes or APIs instead of a single monolithic source, and for a given query, relevant evidence needs to be retrieved from one or a small subset of possible retrieval sources."* REAPER uses an LLM planner — not a classifier router — to decide *which* source(s) to hit, because *"each reasoning step directly adds to the latency of the system… in the order of multiple seconds"* (REAPER, arXiv:2407.18553).

---

## 2. Foundational product-QA datasets & tasks (2019–2024)

### 2.1 AmazonQA — review-based QA (the canonical task)
**Gupta, Kulkarni, Chanda, Rayasam, Lipton — IJCAI 2019, arXiv:1908.04364**

The seminal "answer a product question from reviews" benchmark. Scale: **923k questions, 3.6M answers, 14M reviews, 156k products.** Task: *"Given a corpus of reviews and a question, the QA system synthesizes an answer."* The method is exactly the RAG shape avant la lettre: *"a method that combines information retrieval techniques for selecting relevant reviews"* + *"reading comprehension models for synthesizing an answer."*

Its most durable contribution for grounded commerce QA is **answerability**: the authors *"collect additional annotations, marking each question as either answerable or unanswerable based on the"* reviews — i.e., the system must know **when the evidence does not support an answer**. This is the dataset-level ancestor of every modern "abstain / say IDK" grounding guardrail. (Note: the abstract reports no headline metric — it positions the task as *challenging*.)

### 2.2 eCeLLM / ECInstruct — instruction-tuning for e-commerce
**Peng, Ning et al., ICML 2024, arXiv:2402.08831**

ECInstruct: *"116,528 samples from 10 real and widely performed e-commerce tasks of 4 categories"* — including **attribute value extraction (AVE), product matching, product relation prediction, answer generation, query-product ranking**, sentiment, sequential rec. Result: *"eCeLLM models substantially outperform baseline models, including the most advanced GPT-4 and the state-of-the-art (SoTA) task-specific models, on almost all the 10 tasks"* with generalization to *"unseen products and unseen instructions."*

**Why it matters for samesake:** AVE (attribute value extraction) is *attribute-extraction-as-grounding* — turning unstructured text into the structured attributes that samesake's typed catalog declares. eCeLLM shows a tuned LLM beats GPT-4 at *populating* the catalog; samesake consumes the populated catalog. This is the **enrich** boundary, complementary to retrieval.

---

## 3. Reference architectures (production & research)

### 3.1 Amazon Rufus — the largest deployed product RAG
**Amazon Science blog (2024); REAPER, CIKM 2024; "Cite Before You Speak", arXiv:2503.04830 (2025)**

The most consequential production reference. Rufus is *"built on a custom LLM trained specifically on Amazon's ecosystem: product catalogs, reviews, Q&A, and curated web data, and uses retrieval-augmented generation (RAG) to fetch the latest product info in real time."* By Amazon's Q4 2025 earnings it generated *nearly $12B in incremental annualized sales* (per trade coverage — **marketed**, not peer-reviewed).

Architecture, verbatim from Amazon Science:
- **Grounding:** *"the LLM first selects information that may be helpful in answering the shopper's questions"* before generating.
- **Sources & routing complexity:** *"The complexity of our RAG process is unique, both because of the variety of our data sources and the differing relevance of each one, depending on the question."* Sources: *"customer reviews, the product catalogue, and community questions and answers, along with calling relevant Stores APIs."*
- **Serving:** continuous batching + token streaming for latency.
- **Planning:** REAPER replaces a classifier router with an LLM that *"generate[s] efficient retrieval plans"* — *"significant gains in latency over Agent-based systems and… scale[s] easily to new and unseen use cases."*

**Mapping to samesake:** Rufus's "select information that may be helpful" + "differing relevance of each source" + "call Stores APIs" *is the retrieval layer* — exactly samesake's territory (hybrid retrieval over typed sources, fused by RRF, gated by SQL filters). What samesake omits is the custom generation LLM and the REAPER-style multi-step planner. samesake's `findProducts()` is closer to a single, grounded retrieval *call* a planner would invoke than to the planner itself.

### 3.2 Cite Before You Speak — citation as the grounding mechanism
**Zeng, Liu, Dai, Tang, Luo, Varshney, Li, He — arXiv:2503.04830 (Mar 2025, rev. May 2025); Amazon**

The single best "grounding + verification" reference for commerce. Two stated problems with conversational shopping agents (CSAs): *"First, LLMs produce hallucinated or unsupported claims… Second, without providing knowledge source attribution in CSA response, customers struggle to verify LLM-generated information."*

Solution and **proven** results (verbatim):
- *"citation generation paradigm substantially improves grounding performance by 13.83%."*
- A **Multi-UX-Inference** system *"appends source citations to LLM outputs while preserving existing user experience features and supporting scalable inference."*
- *"Large-scale online A/B tests show that grounded CSA responses improves customer engagement by 3% - 10%."*

**This is the key insight for samesake's scope debate.** Citation/verification is the part of "trustworthy product RAG" with the highest proven business value — and it is *fed by retrieval*. samesake already returns the attributable units (product + "why" + verification/grounding) that a citation layer cites. samesake should make that contract crisp; it need not generate the prose.

### 3.3 Contextually-aware e-commerce product QA pipeline
**arXiv:2508.01990 (2025)**

A clean modular reference: **Standalone Query (SAQ) → Catalog Search → Intent Model → Retrieval → Generation.**
- **SAQ** rewrites the conversational query into a self-contained one (resolves pronouns, disambiguates products) — the analog of samesake's **NLQ parser** turning language into a constrained query.
- **Intent Model** (BERT classifier, 93.17% top-1) routes **objective→structured attributes, subjective→reviews**, and uses *"entropy-based selection"* for multi-intent: *"low entropy indicates a clear dominant intent, triggering focused retrieval, while high entropy reflects ambiguity, prompting retrieval for the top-N."*
- **Retrieval** is two-stage: backend APIs then a domain-adapted bi-encoder STS model (98.32% Recall@k) to cut noise — i.e., **structured+unstructured hybrid**, exactly samesake's design.
- **Grounding:** generation is *"strictly within the retrieved context"*; on gaps the system returns **"IDK"** rather than hallucinate. Reported **97.7% precision, ~2% hallucination rate** (single-paper claim — treat as **promising, not independently verified**).

### 3.4 Retail-GPT — open-source RAG shopping agent
**arXiv:2408.08925 (2024)**

A *"product-agnostic"*, *"cross-platform"* open-source RAG chatbot doing *"product recommendations… cart operations… human-like conversations."* Useful as an existence proof of the full-stack assistant pattern, but the abstract carries **no eval** and limited architectural detail (5-page workshop-style paper). Treat as **reference design, not benchmark.** Note: it explicitly *includes cart operations* — the downstream surface samesake intentionally excludes.

### 3.5 Graph-enhanced e-commerce RAG
**arXiv:2509.14267 (2025) and related**

KG + text dual retrieval for customer support: extract entities/relations from *"vendor catalogs, user reviews, and solved tickets"*, then *"parallel retrievals of both knowledge graph subgraphs and text documents."* Stated grounding benefit: *"the LLM cannot readily alter structured triples it sees in text format (reducing hallucination), while document excerpts prevent answers from sounding too terse."* This validates samesake's instinct that **structured facts gate/anchor and unstructured text fills color** — though samesake uses SQL+pgvector rather than a graph DB (simpler, fewer containers, consistent with its no-extra-infra ethos).

---

## 4. Chunking product data (the data-modeling question)

The literature's clearest e-commerce-specific guidance: **product records are usually already self-contained semantic units — do not over-chunk them.** Per Weaviate's chunking guide: *"If your data source already has small, complete pieces of information like product descriptions, you usually do not need to chunk them."* Reviews are the exception — long reviews chunk; many short reviews aggregate.

Patterns relevant to samesake:
- **One product = one (or few) embedding(s)** — aligns with samesake's typed catalog row → embedding model. Avoid fragmenting an SKU across chunks.
- **Typed "spaces" vectors** (segmented embeddings per facet, which samesake already supports) are a principled answer to the *"single granularity"* problem the chunking literature laments: *"forces a single granularity choice… preventing the system from simultaneously accessing both fine-grained details and coarse-grained context."*
- **Parent-document retrieval** (retrieve small, return large) is the doc-RAG analog of samesake returning the *whole product object* even when a single field matched.

---

## 5. Hallucination control, citation & grounding

Three distinct failure modes the literature separates (and samesake should not conflate):

1. **Faithfulness / groundedness** — answer supported by retrieved context. Operationally defined *"strictly with respect to retrieved context."*
2. **Factuality** — answer correct against the world, even if retrieval was wrong.
3. **Faithful-but-wrong** — the structural RAG trap: *"the model reads the right document and still generates something different"*, and the inverse, *"a RAG answer can be grounded in the retrieved context and still be wrong if the retrieval supplies the wrong document."*

The dominant levers, in order of evidence strength:
- **Better retrieval** (the upstream cause). RGB (Chen et al., AAAI 2024, arXiv:2309.01431) shows LLMs *"struggle significantly in terms of negative rejection, information integration, and dealing with false information"* — i.e., they fail when retrieval is noisy, incomplete, or contradictory. Garbage in → confident garbage out.
- **Abstention / "IDK"** — descends from AmazonQA answerability; deployed in §3.3 and recommended by RGB's "negative rejection" axis.
- **Citation/attribution** — §3.2, the highest proven-ROI mechanism (+13.83% grounding).
- **KG/structured anchoring** — §3.5, structured triples are hard for the LLM to overwrite.

**samesake's position:** it owns the upstream lever (retrieval quality, hard-filter gating, RRF, dedup) and already emits the artifacts the other levers need — provenance for citation, and a grounded result set against which abstention is decidable. It does **not** own the generation-time guardrail (constrained decoding, claim-verification re-prompt) because it does not generate.

---

## 6. Evaluation (faithfulness / groundedness)

### 6.1 RAGAS — reference-free RAG eval
**Es, James, Espinosa-Anke, Schockaert — 2023, arXiv:2309.15217**

The de-facto standard, *reference-free* (no gold answers needed). Core metrics (verbatim mechanics):
- **Faithfulness** `F = |V|/|S|`: LLM decomposes the answer into statements, verifies each against context (V = verified, S = total). *"claims that are made in the answer can be inferred from the context."*
- **Answer Relevance** `AR = (1/n) Σ sim(q, qᵢ)`: LLM generates n questions from the answer; cosine-similarity to the real question.
- **Context Relevance** `CR = extracted / total sentences`: fraction of retrieved context actually needed.

The decomposition: **context precision/recall measure the *retriever*; faithfulness/answer-relevance measure the *generator*.** samesake is evaluable on the **retriever** half (recall@k, precision, context relevance) *today*. The generator-half metrics only become measurable once a consumer adds generation — meaning samesake can publish honest retrieval-quality numbers without claiming generation quality it doesn't produce.

### 6.2 Other benchmarks/tools
- **RGB** (AAAI 2024): four RAG robustness axes — *noise robustness, negative rejection, information integration, counterfactual robustness.* The "negative rejection" and "counterfactual" axes are directly relevant to **contradictory reviews** in product QA.
- **RAGChecker** (NeurIPS 2024 D&B, arXiv:2408.08067): fine-grained, claim-level diagnosis separating retriever vs generator error — useful as the eval a samesake consumer would run on the *combined* stack.

---

## 7. Comparison table — RAG responsibilities: who owns what

| RAG responsibility | Owned by samesake today? | Evidence / how | A consumer's generation layer adds |
|---|---|---|---|
| Heterogeneous source retrieval (catalog+reviews+specs) | **Yes (core)** | FTS + pgvector ANN + typed spaces, RRF fusion | — |
| Hard-filter gating before ranking (price/availability) | **Yes (core)** | filters compile to SQL predicates, gate pre-rank | — |
| Structured/unstructured hybrid (§1, §3.5 lesson) | **Yes** | SQL for structured, vectors for unstructured | — |
| Query understanding / NLQ → constrained query (§3.3 SAQ) | **Yes** | constrained-schema NLQ parser | conversational rewrite/history (SAQ-style) |
| Source routing across indexes (REAPER, §3.1) | **Partial** | single grounded `findProducts()` call | multi-step LLM retrieval *planner* on top |
| Dedup / entity resolution | **Yes** | entity-resolution/dedup module | — |
| Provenance / "why" / auditability (citation input, §3.2) | **Yes** | `/search/explain`, findProducts "why"+verification+grounding | render as user-facing **citations** |
| Abstention / answerability (§2.1, RGB) | **Partial** | grounded set makes "no good match" decidable | "IDK" *phrasing* at generation time |
| Faithful answer **generation** | **No (by design)** | stops at retrieval | the LLM that writes the prose |
| Citation/attribution UX (+13.83% grounding, §3.2) | **No (emits inputs)** | returns attributable evidence objects | append citations to generated text |
| Recommendations / cart / checkout | **No (by design)** | retrieval boundary | downstream (Retail-GPT does cart; samesake won't) |
| Generation-quality eval (RAGAS faithfulness) | **N/A** | not generating | run RAGAS on combined stack |
| Retrieval-quality eval (recall@k, context precision) | **Measurable today** | grounded result set | — |
| **VERDICT** | **samesake = the retrieval+grounding+provenance half of product RAG, complete and on the architecturally-correct side of every structured/unstructured lesson. The generation half is a deliberate, swappable, BYO-LLM omission — not a gap.** | | |

---

## 8. Recommendation for samesake (adopt / avoid / differentiate / integrate)

**Verdict: DIFFERENTIATE + INTEGRATE. Do NOT expand into generation.**

- **Differentiate:** Lean into being *the grounded-retrieval substrate for product RAG/agents*, not another shopping chatbot. The market is saturated with end-to-end assistants (Rufus, Retail-GPT, Trendyol, Flippi); it is *thin* on rigorous, self-hostable, two-container retrieval layers that emit machine-checkable provenance. The literature is unanimous that **retrieval quality is the binding constraint on faithfulness** — that is samesake's moat, not a commodity.
- **Integrate (the one concrete build):** Harden the **contract handed to the generator**. Today `findProducts()` returns product + why + verification. Make the "why" *field-level and machine-attributable* — e.g., "`waterproof=true` supported by `spec.materials`; 'runs small' supported by review#412, review#888" — so a downstream LLM can cite **without re-deriving grounding**. This is exactly the input "Cite Before You Speak" needs, and it converts samesake's existing `/search/explain` into a first-class RAG-citation feed (the +13.83%/+3–10% mechanism).
- **Adopt (concepts, not code):** answerability/abstention signaling (return an explicit "no grounded match" verdict so the generator can say IDK — RGB negative-rejection); and publish **retrieval-half RAGAS-style metrics** (context precision/recall, recall@k) so consumers can trust the substrate independently of their LLM.
- **Avoid:** building the generation LLM, the conversational/multi-turn planner (REAPER-style), recommendations, and cart/checkout. Every reference architecture that bundled these did so as a *product*, not a *framework*; samesake's BYO-model, no-extra-infra, retrieval-boundary stance is a deliberate and defensible position. Generation is where vendor lock-in, hallucination liability, and model churn live — keep it on the consumer's side of the line.

**One open strategic question to surface, not silently decide:** abstention/answerability sits *on the boundary*. Deciding "there is no grounded answer" is a retrieval judgment (samesake can make it); *phrasing* the refusal is generation (it cannot). Recommend samesake **emit the verdict, not the sentence.**

---

## 9. Open questions

1. Does samesake's `findProducts()` currently expose **field-level** provenance (which catalog field / which review supports which asserted attribute), or only product-level "why"? The citation-feed recommendation depends on the answer. *(Needs codebase check — not resolved in this web survey.)*
2. For **subjective** review-grounded questions ("runs small?"), does samesake aggregate signal across many reviews, or return individual review matches? AmazonQA/Rufus both *synthesize over many reviews* — pure top-k retrieval may under-serve aggregate-opinion queries.
3. How should samesake represent **contradictory reviews** (RGB counterfactual axis) in the evidence object so a downstream LLM can present "mixed" rather than pick one side?
4. The §3.3 and Rufus numbers are **single-source / production-marketed** — no independent replication of the 97.7% precision or $12B figures. What retrieval-quality benchmark would samesake publish to be *provably* better than "embed-the-row" baselines?

---

## Sources

**Datasets & tasks**
- AmazonQA: A Review-Based Question Answering Task — Gupta et al., IJCAI 2019 — https://arxiv.org/abs/1908.04364
- eCeLLM / ECInstruct — Peng, Ning et al., ICML 2024 — https://arxiv.org/abs/2402.08831 ; site https://ninglab.github.io/eCeLLM/

**Reference architectures**
- The technology behind Amazon's GenAI-powered shopping assistant, Rufus — Amazon Science (2024) — https://www.amazon.science/blog/the-technology-behind-amazons-genai-powered-shopping-assistant-rufus
- REAPER: Reasoning based Retrieval Planning for Complex RAG Systems — Amazon, CIKM 2024 — https://arxiv.org/abs/2407.18553
- Cite Before You Speak: Enhancing Context-Response Grounding in E-commerce Conversational LLM-Agents — Zeng et al., 2025 — https://arxiv.org/abs/2503.04830
- Contextually Aware E-Commerce Product Question Answering using RAG — 2025 — https://arxiv.org/html/2508.01990v1
- Retail-GPT: leveraging RAG for building E-commerce Chat Assistants — 2024 — https://arxiv.org/abs/2408.08925
- Graph-Enhanced Retrieval-Augmented Question Answering for E-Commerce Customer Support — 2025 — https://arxiv.org/html/2509.14267v1

**Chunking / structured+unstructured**
- Chunking Strategies to Improve LLM RAG Pipeline Performance — Weaviate — https://weaviate.io/blog/chunking-strategies-for-rag
- Hybrid RAG Architecture: Bridging Structured and Unstructured Data — TechAhead — https://www.techaheadcorp.com/blog/hybrid-rag-architecture-definition-benefits-use-cases/

**Hallucination / grounding / citation**
- RAG hallucinations (faithful-but-wrong, groundedness vs factuality) — Towards Data Science — https://towardsdatascience.com/rag-hallucinates-i-built-a-self-healing-layer-that-fixes-it-in-real-time/

**Evaluation**
- RAGAS: Automated Evaluation of Retrieval Augmented Generation — Es et al., 2023 — https://arxiv.org/abs/2309.15217 ; docs https://docs.ragas.io/
- Benchmarking LLMs in Retrieval-Augmented Generation (RGB) — Chen et al., AAAI 2024 — https://arxiv.org/abs/2309.01431
- RAGChecker: A Fine-grained Framework for Diagnosing RAG — NeurIPS 2024 D&B — https://proceedings.neurips.cc/paper_files/paper/2024/file/27245589131d17368cccdfa990cbf16e-Paper-Datasets_and_Benchmarks_Track.pdf

**Fetch notes:** PDF text extraction failed for arXiv:2408.08925, :2402.08831, :2503.04830 (binary/encoding); recovered via arXiv abstract pages, firecrawl HTML scrape, and corroborating secondary sources. Production figures for Rufus ($12B incremental sales) and the §3.3 precision/hallucination numbers are single-source/marketed and flagged as not independently verified.
