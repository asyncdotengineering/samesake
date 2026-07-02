# E-commerce RAG & Conversational Shopping-Assistant Architectures

**Prior-art dossier for samesake** — a TypeScript-first "search engine compiler" for visual commerce. samesake compiles a typed catalog declaration into a Postgres + pgvector hybrid retrieval layer (FTS + cosine ANN over BYO embeddings + typed "spaces" vectors, fused via RRF) that runs *inside the user's own app*. Hard filters compile to SQL predicates and gate before ranking. It exposes `findProducts()` (intent + constraints + image -> grounded products with verification/grounding/why) and **deliberately stops at retrieval** — cart/checkout/generation are downstream.

This survey maps the **full conversational-commerce stack** — query understanding -> retrieval -> rerank -> generate/ground -> action — across published retailer systems and cloud blueprints, so we can locate samesake's exact handoff contract to the generation/agent layer above it.

> **PROVEN vs MARKETED:** I flag each claim. "PROVEN" = the operator's own engineering blog/paper with mechanism described. "MARKETED" = vendor product page or press, mechanism unverified. Internal details of closed systems (Rufus, Sparky) are partially published; I quote only what the operators stated.

---

## 0. The canonical pipeline (and where samesake sits)

The reference shape that recurs across every system below:

```
user turn (NL + maybe image + session)
   │
   ▼
[1] QUERY UNDERSTANDING   intent classify · entity/SRL extract · constraint parse · query rewrite/reformulation
   │
   ▼
[2] RETRIEVAL PLANNING    which sources/tools? (catalog, reviews, Q&A, inventory API) · one-shot plan vs agentic loop
   │
   ▼
[3] RETRIEVAL            hybrid lexical + vector ANN · hard-filter gate (price/stock/category) · per-source fetch
   │
   ▼
[4] RERANK / FUSE        cross-encoder or RRF · business signals (conversion, margin) · dedup
   │
   ▼
[5] GROUND + GENERATE    LLM conditioned ONLY on retrieved set · cite/verify · markup for product cards
   │
   ▼
[6] ACTION              add-to-cart · checkout · reorder · (ACP/AP2/MCP protocols)
```

**samesake owns [1-partial], [3], [4] and the grounding *substrate* of [5].** It produces the verified, filtered, ranked candidate set that the LLM layer is *allowed* to talk about. It does **not** own [5-generation] or [6-action]. The central design question this dossier answers: *what does the contract between [4] and [5] look like in production systems?*

---

## 1. Amazon Rufus — the most-published large-scale shopping RAG

**Source:** Amazon Science engineering blog, *"The technology behind Amazon's GenAI-powered shopping assistant, Rufus"* (2024). PROVEN (operator blog, mechanism described).

### Architecture
- **Custom shopping LLM**, not a general model: *"a custom large language model (LLM) specialized for shopping"* trained on *"the entire Amazon catalogue, for starters, as well as customer reviews and information from community Q&A posts."* Press reporting adds it draws on multiple Bedrock models (Claude, Nova) plus the custom model.
- **RAG over heterogeneous sources with differing relevance.** *"Before generating responses, the LLM first selects information that may be helpful in answering the shopper's questions."* The hard part is explicitly that *"the variety of our data sources and the differing relevance of each one, depending on the question"* — i.e. retrieval planning is source-selection, not just top-k. Sources: *"customer reviews, the product catalogue, and community questions and answers, along with calling relevant Stores APIs."*
- **Two-stage grounding ("hydration"):** the model generates an answer skeleton, then performs *"hydration"* by *"making queries to internal systems"* and emits *"markup instructions that specify how various answer elements should be displayed"* — i.e. the LLM emits a layout/widget plan and real product data is injected by deterministic backend calls, not free-generated.

### Serving / latency (the genuinely hard part at Amazon scale)
- **Continuous batching:** *"a novel LLM inference-specific technique that makes routing decisions for new requests after every token is generated,"* letting the system *"start serving new requests as soon as the first request in the batch finishes, rather than waiting for all the requests to finish."*
- **Streaming architecture:** token-by-token so *"customers don't need to wait for a long answer to be fully generated."*
- **Custom silicon:** Trainium + Inferentia via the Neuron compiler for inference efficiency.
- **RL from customer feedback** for continuous improvement.

### REAPER — Rufus's retrieval planner (the [2] layer)
**Source:** Joshi, Sarwar, Varshney, Nag, Agrawal, Naik, *"REAPER: Reasoning based Retrieval Planning for Complex RAG Systems"* (arXiv:2407.18553, 2024; Amazon authors). PROVEN (paper).

The load-bearing insight for samesake's positioning:
- Agentic multi-hop retrieval is **too slow** for conversational shopping: *"each reasoning step directly adds to the latency of the system. For large models this latency cost is significant — in the order of multiple seconds."*
- REAPER replaces the agent loop with **a single LLM planner that emits the whole retrieval plan up front**: *"an LLM based planner to generate retrieval plans in conversational systems."*
- Claimed result: *"significant gains in latency over Agent-based systems and are able to scale easily to new and unseen use cases as compared to classification-based planning."*

**Takeaway:** even Amazon concluded that for latency-bound shopping, you want *one* planning step that decides all retrievals, then deterministic execution — not an open agentic ReAct loop. samesake's compiled, single-shot hybrid query with SQL hard-filter gating is the structural extreme of this philosophy.

---

## 2. Instacart — the most detailed published query-understanding + RAG pipeline

**Source:** *"Building The Intent Engine: How Instacart is Revamping Query Understanding with LLMs"*, company.instacart.com / tech.instacart.com (Nov 2025). PROVEN (operator blog, deep mechanism). The richest public account of the [1]+[3]+guardrails layers.

### Pipeline (consolidates 3 legacy ML models into one LLM-centric QU system)
1. **Query Category Classification** — maps queries to a hierarchical taxonomy over *"billions of items, from broad departments like 'Meat' down to specific sub-categories like 'Beef Ribs > Short Ribs'."*
2. **Query Rewrites** — three types (Substitutes, Broader, Synonyms) to lift recall when results are thin.
3. **Semantic Role Labeling** — extracts *"product, brand, and attributes"* for retrieval/ranking/ads.

### RAG = inject proprietary context into the prompt
*"automatically enriches the prompt with crucial context from our internal data systems"* — historical conversion data (top converted brands/categories), catalog items ranked by embedding similarity, and downstream session-search signals. Example: "verdant machine" -> enriched context lets the model infer it's a *smoothie/juice brand*.

### Hallucination guardrails — TWO post-generation gates (directly relevant to samesake's grounding claim)
- **Semantic-similarity filtering:** *"computes a semantic similarity score between the embeddings of the original query and the LLM's predicted category path, discarding any pair that falls below our relevance threshold."*
- **Catalog validation:** *"After generation, a post-processing guardrail validates the tags against our catalog."*
  > i.e. the LLM may *propose* categories/tags, but nothing survives that isn't verified against the real catalog. This is exactly the grounding contract samesake can *guarantee* at retrieval time rather than patch post-hoc.

### Hybrid online/offline serving (the cost/latency design)
- **Offline (head queries):** heavy RAG pipeline precomputes + caches results, also generates training data.
- **Online (tail queries):** lightweight fine-tuned model on cache miss. *"determined simply by a cache-hit"* — routing is just cache hit/miss.
- **Model:** Llama-3-8B fine-tuned with LoRA; *"fine-tuned 8B model achieves performance on par with a much larger foundation model."*
- **Latency:** ~700ms (A100) -> 300ms target via LoRA-adapter merging, H100 upgrade, GPU autoscaling; FP8 quantization rejected (10% faster but recall loss — quality won).
- Their effectiveness hierarchy: **"Fine-tuning > Context-Engineering (RAG) > Prompting"** and *"context is the defensible moat."*

**Takeaway for samesake:** Instacart's headline guardrail — *validate every LLM-proposed concept against the real catalog* — is a post-hoc patch on a generative path. samesake inverts this: the catalog *is* the index, so retrieved items are catalog-true by construction. Their offline-cache-head / online-tail split is also a serving pattern samesake users will need above the retrieval layer.

---

## 3. Mercado Libre — entropy-driven dialogue policy over a giant catalog

**Sources:** Jarboui & Memari, *"Modeling shopper interest broadness with entropy-driven dialogue policy in the context of arbitrarily large product catalogs"* (arXiv:2509.06185, Sept 2025); ZenML LLMOps case studies. PROVEN (paper + case study).

- **Two-stage neural search** whose input is an **LLM-generated query** assembled from live context: *conversation turns, pages visited, cart contents, past orders*.
- **Embeddings:** multilingual encoder fine-tuned with **triplet loss (E5)**; candidates via **HNSW ANN**.
- **Two modes:** *Identification* (match the expressed need) vs *Recommendation* (cross-sell/up-sell complements).
- **Entropy-driven clarification:** model *"the breadth of user interest via the entropy of retrieval score distributions"* — low entropy (sharp intent) -> recommend directly; high entropy (ambiguous) -> ask a clarifying question. Crucially this keeps the *"LLM agent... aware of an arbitrarily large catalog in real-time without bloating its context window."*
- Multi-LLM orchestration grew from a 2-node to a 7-node pipeline (adaptive prompts, consensus).

**Takeaway for samesake:** the **retrieval score distribution itself is a control signal** for the dialogue layer above. If samesake surfaced calibrated relevance scores / score-spread per query, the generation layer could decide "recommend now vs ask a clarifying question" *without* loading the catalog into context. This is a high-value, low-cost addition to a handoff contract — samesake already computes these scores during RRF.

---

## 4. Shopify Sidekick — the agentic-loop + tool-governance case study

**Source:** ZenML LLMOps DB, *"Building Production-Ready AI Assistant with Agentic Architecture"* (Shopify); Shopify Engineering. PROVEN (operator-derived).

- **Agentic loop:** *"human input is processed by an LLM that decides on actions, executes them in the environment, collects feedback, and continues until task completion."*
- **Tool-complexity collapse:** scaling *"from 0-20 tools with clear boundaries to 50+ tools with overlapping functionality"* degraded performance. Fix = **Just-in-Time (JIT) instructions**: *"relevant guidance alongside tool data exactly when needed, rather than cramming everything into the system prompt"* (preserves prompt-cache efficiency).
- **Eval:** **Ground Truth Sets** reflecting *"actual production distributions rather than carefully curated 'golden' datasets"*; LLM judges calibrated to humans (Cohen's Kappa 0.02 -> 0.61).
- **Training:** GRPO with an *"N-Stage Gated Rewards system that combines procedural validation with semantic evaluation"*; fought **reward hacking** (opt-out/tag/schema hacking), syntax accuracy ~93% -> ~99%.
- **Stated principle:** stay simple, *resist adding tools without clear boundaries, avoid multi-agent systems early.*

**Takeaway for samesake:** Sidekick's pain is *tool sprawl*. A retrieval layer that exposes **one well-bounded, typed tool** (`findProducts`) with a stable schema is exactly the "clear boundary" Shopify wishes they'd kept. samesake should present itself to agent frameworks as a single high-quality tool, not a toolkit.

---

## 5. Walmart Sparky / Wallaby — MARKETED

**Source:** retail/trade press; no Walmart engineering deep-dive found. MARKETED (mechanism unverified).
- Customer agent in-app, also surfaced inside ChatGPT and integrating with Gemini; powered by Walmart's **Wallaby** retail LLM plus external LLMs.
- Reporting describes RAG to *"anchor LLM replies in Walmart's live details, like stock levels, product info, and shopper profiles"* and roadmap for image/voice/video + autonomous reorder/booking. No published mechanism — treat as directional.

---

## 6. Cloud reference blueprints

### 6a. Google — Vertex AI Search for commerce + Conversational Commerce agent
**Source:** Google Cloud product + blog. MARKETED (product capability, internals not fully documented).
- Conversational Commerce agent uses *"Google's search expertise and Gemini"* and *"intelligently switches between traditional product search and conversational interactions"* via *"advanced intent classification"* — i.e. an explicit router between deterministic search and LLM dialogue.
- Vertex AI Search = retrieval backend (connectors, vector search, RAG APIs, **grounded Gemini**); retains context across sessions/devices.
- **Pattern to note:** intent-classifier router deciding *search-mode vs converse-mode* — same split as Mercado Libre's entropy gate, productized.

### 6b. AWS — Bedrock AgentCore + OpenSearch shopping-agent blueprint
**Source:** AWS Big Data Blog, *"Building AI shopping agent using Amazon Bedrock AgentCore Runtime and Amazon OpenSearch Service."* PROVEN (reference impl with code).
- **Retrieval:** Amazon Nova Multimodal Embeddings, *"1024-dimensional embeddings of the `title` field"* in an *"hnsw"* KNN index with cosine similarity; *"OpenSearch Service performs semantic search and returns relevant product results."*
- **Agent-tool handoff:** *"The Strands Agent processes the task and invokes the `search_product_catalog` tool"*; tools are *"callable functions that allow agents to perform actions beyond text generation, such as API calls, database queries."* Then *"the Strands Agent invokes Amazon Bedrock LLMs to generate a natural language response"* (Claude Haiku).
- **Note:** *"No explicit guardrails or content filtering mechanisms are documented"* in the reference — grounding is implicit in "only answer from retrieved." Hard filtering is implicit (index query + `size`), not a typed predicate gate.
- Bedrock **Knowledge Bases** add managed RAG: *"in-built session context management and source attribution... the entire RAG workflow from ingestion to retrieval and prompt augmentation"* over an OpenSearch Serverless vector index.

**Takeaway:** the AWS blueprint is structurally *identical to samesake's job* — embed catalog, ANN search, expose as a tool, let the agent LLM narrate. Differences: AWS uses OpenSearch (extra infra) vs samesake's in-app Postgres+pgvector (two containers, no separate vector DB); AWS hard-filtering and grounding are implicit/undocumented vs samesake's compiled SQL predicate gate + `/search/explain` auditability. samesake is a *more opinionated, more grounded, lower-infra* version of this exact reference stack.

---

## 7. Off-catalog hallucination & grounding (the [5] safety layer)

**Sources:** Meilisearch RAG-guardrails guide; CustomGPT; Cresta; general practitioner consensus. MARKETED/PRACTITIONER (patterns, not single-operator metrics).

Recurring production patterns to prevent the LLM recommending products that don't exist / aren't in stock:
1. **Retrieve-before-generate, answer only from corpus** — constrain generation to retrieved chunks.
2. **Refuse on weak evidence** — empty/low-score retrieval -> "I couldn't find that," not a fabricated SKU.
3. **NLI / entailment validators** — check each generated claim is entailed by retrieved context; re-prompt if not.
4. **Post-generation catalog validation** — Instacart's pattern (§2): discard any LLM-proposed entity not present in the real catalog.
5. **Inventory/price freshness** — ground stock + price at *generation time* via live API (Rufus "hydration," §1), because the retrieval index may be stale.

**samesake's structural advantage:** patterns 1, 2, 4 are *post-hoc patches on a generative path*. Because samesake returns only real, filtered catalog rows with `verification`/`grounding`/`why`, the candidate set is hallucination-free **by construction**. The residual risk lives entirely in the generation layer above (the LLM could still mis-describe a real product) and in **freshness** (pattern 5) — which samesake must address by making inventory/price re-checkable at handoff, not just at index time.

---

## 8. The action layer above retrieval — agentic-commerce protocols

**Sources:** ACP GitHub (OpenAI + Stripe); AP2 (Google); MCP (Anthropic); Greyling, *"The Four Protocols of Agentic Commerce."* PROVEN (specs) / PROVEN (announcements).

The [6] action layer is standardizing into a layered stack — and it deliberately separates **discovery/retrieval** from **checkout/payment**, which validates samesake's "stop at retrieval" boundary:

| Protocol | Owner | Layer | Role |
|---|---|---|---|
| **MCP** (Nov 2024) | Anthropic | Tool/data connection | Standard way for an LLM to call tools / fetch data (e.g. a store's catalog). samesake's natural exposure surface. |
| **ACP** (Sep 2025) | OpenAI + Stripe | Checkout/interaction | *"open standard for connecting buyers, their AI agents, and businesses to complete purchases."* Repo separates *Checkout API Spec* from *Delegate Payment Spec*; merchants publish checkout config *"via standard APIs or through MCP."* Powers ChatGPT Instant Checkout. |
| **AP2** (Sep 2025) | Google + 60 partners | Payment authorization | *"cryptographically signed permission slip from a human before [an agent] can spend money."* |

The ACP repo's own structure (`openapi.agentic_checkout.yaml` + `openapi.delegate_payment.yaml` + product **feed**) *"separates product discovery from transactional checkout"* — agents *"discover products through one interface, then route transactions through delegated payment handlers,"* and *"facilitate transactions... rather than controlling commerce directly."*

**Takeaway for samesake:** the entire emerging protocol stack draws the same line samesake drew — **discovery/retrieval is a separate concern from checkout**. samesake should: (a) be cleanly exposable as an **MCP tool** so any agent can call `findProducts`; (b) emit results whose IDs/attributes map onto an **ACP-style product feed** so the downstream checkout layer can transact the *exact* item samesake retrieved (closing the discovery->checkout grounding gap).

---

## 9. Comparison table

| System | Type | Retrieval | Query understanding / planning | Grounding guardrail | Action layer | Infra footprint | Verdict for samesake |
|---|---|---|---|---|---|---|---|
| **Rufus** (Amazon) | Proven | RAG over catalog+reviews+Q&A+Stores API; multi-source relevance | REAPER one-shot LLM retrieval plan (anti-agentic for latency) | "Hydration" = backend fills real data into LLM markup | Internal | Custom silicon, continuous batching | **Differentiate**: validates "one-shot plan beats agent loop"; samesake is the compiled extreme |
| **Instacart** | Proven | Embedding-ranked catalog + conversion signals | LLM QU: classify+rewrite+SRL; head=offline cache, tail=online LoRA-8B | 2 gates: query↔category sim + **catalog validation of every tag** | Search results | A100/H100 GPUs, cache routing | **Adopt** the catalog-validation idea — but samesake gets it for free by construction |
| **Mercado Libre** | Proven | E5 triplet-loss embeds + HNSW; 2-stage | LLM builds query from session; entropy of scores drives clarify-vs-recommend | Retrieval-bounded | Recommendations | Vector DB + multi-LLM (7-node) | **Integrate**: expose score distribution so caller can gate clarify vs answer |
| **Shopify Sidekick** | Proven | Catalog as structured tool context | Agentic loop; JIT tool instructions; GRPO | Schema/validator gates; reward-hack defense | Merchant + agentic storefront | LLM platform | **Differentiate**: be the *one* clean tool that avoids their tool-sprawl pain |
| **Walmart Sparky** | Marketed | RAG to live stock/price/profile (claimed) | n/a published | n/a published | Reorder/booking (autonomous) | Wallaby + external LLMs | Directional only; freshness emphasis worth noting |
| **Vertex AI Commerce** | Marketed | Vertex AI Search (vector + connectors) + grounded Gemini | Intent classifier routes search-mode vs converse-mode | Grounded Gemini | Conversational agent | Fully hosted GCP | **Differentiate**: in-app, BYO-model, no hosted lock-in |
| **AWS AgentCore blueprint** | Proven | Nova embeds + OpenSearch HNSW cosine, top-k | Strands agent invokes `search_product_catalog` tool | Implicit (answer-from-retrieved); none documented | Agent tools | OpenSearch + Bedrock + AgentCore | **Differentiate**: same shape, less infra, explicit SQL hard-filter gate + `/search/explain` |
| **samesake** | — | **Postgres FTS + pgvector ANN + typed spaces, RRF-fused; SQL hard-filter gate before rank** | Constrained NLQ parser -> typed constraints (no open agent loop) | **Catalog-true by construction** + verification/grounding/why + `/search/explain` | **Stops at retrieval** (MCP-exposable -> ACP checkout downstream) | **Two containers, BYO models, in-app, no Redis/ES/hosted vector DB** | **The retrieval substrate the others bolt on — minus the infra and minus the hallucination surface** |

---

## 10. Synthesis — samesake's exact handoff contract to the generation/agent layer

Every production system above converges on the same skeleton, and the industry's protocol direction (§8) and Amazon's own planner research (§1 REAPER) both validate samesake's two boundary decisions: **(a) one-shot constrained planning over open agent loops for latency**, and **(b) discovery/retrieval as a separate concern from generation and checkout.**

What samesake should *guarantee* across the [4]->[5] boundary so the layer above can be thin, fast, and non-hallucinating:

1. **Only real, filtered catalog rows.** Hard filters already gated in SQL — the LLM physically cannot surface an out-of-budget or out-of-stock item. This is Instacart's "catalog validation" guardrail, but free and pre-emptive.
2. **Per-result grounding payload** (`verification` / `grounding` / `why` + the matched fields) so the generation layer can cite, not invent, and so it can be NLI-checked cheaply.
3. **Calibrated relevance scores + score-spread** per query. Mercado Libre's entropy signal: let the caller decide *recommend now vs ask a clarifying question* **without loading the catalog into context.** samesake already computes these in RRF — surface them.
4. **A freshness/re-verify hook.** The one residual hallucination risk samesake can't kill at index time is *stale price/stock*. Offer a cheap "re-verify these IDs at generation time" call (Rufus "hydration," Walmart "live stock") so the answer layer grounds price/availability at the moment of speaking.
5. **A stable, single, typed tool surface** (`findProducts`), MCP-exposable — exactly the "clear boundary" Shopify lost to tool sprawl — and with result IDs/attributes that map onto an **ACP product feed** so the downstream checkout transacts the *exact* retrieved item.

**Should samesake expand beyond retrieval?** No — the protocol stack (§8) and the operator architectures (§1, §8) draw the discovery/checkout line exactly where samesake already draws it. The right move is not to add generation or checkout, but to make the **handoff contract richer**: grounding payload + score distribution + freshness re-verify + MCP/ACP-shaped output. That keeps samesake the best-grounded, lowest-infra retrieval substrate while letting any generation/agent/checkout layer sit cleanly on top.

---

## Sources

1. Amazon Science — *The technology behind Amazon's GenAI-powered shopping assistant, Rufus* (2024). https://www.amazon.science/blog/the-technology-behind-amazons-genai-powered-shopping-assistant-rufus
2. Joshi et al. — *REAPER: Reasoning based Retrieval Planning for Complex RAG Systems* (arXiv:2407.18553, 2024). https://arxiv.org/abs/2407.18553
3. Instacart — *Building The Intent Engine: How Instacart is Revamping Query Understanding with LLMs* (2025). https://company.instacart.com/tech-innovation/building-the-intent-engine-how-instacart-is-revamping-query-understanding-with-llms
4. ZenML LLMOps DB — *Instacart: Rebuilding Query Understanding for E-Commerce Search with LLMs*. https://www.zenml.io/llmops-database/rebuilding-query-understanding-for-e-commerce-search-with-llms
5. Jarboui & Memari — *Modeling shopper interest broadness with entropy-driven dialogue policy in the context of arbitrarily large product catalogs* (arXiv:2509.06185, 2025). https://arxiv.org/abs/2509.06185
6. ZenML LLMOps DB — *Mercado Libre: Multi-LLM Orchestration for Product Matching at Scale*. https://www.zenml.io/llmops-database/multi-llm-orchestration-for-product-matching-at-scale
7. ZenML LLMOps DB — *Shopify: Building Production-Ready AI Assistant with Agentic Architecture*. https://www.zenml.io/llmops-database/building-production-ready-ai-assistant-with-agentic-architecture
8. Shopify Engineering — *Leveraging multimodal LLMs for Shopify's global catalogue* (ICLR 2025 recap). https://shopify.engineering/leveraging-multimodal-llms
9. Mo, Meng, Aliannejadi, Nie — *Conversational Search: From Fundamentals to Frontiers in the LLM Era* (SIGIR '25, arXiv:2506.10635). https://arxiv.org/abs/2506.10635
10. Google Cloud — *Introducing Conversational Commerce agent on Vertex AI*. https://cloud.google.com/blog/products/ai-machine-learning/introducing-conversational-commerce-agent-on-vertex-ai
11. Google Cloud — *Vertex AI Search for commerce*. https://cloud.google.com/solutions/vertex-ai-search-commerce
12. AWS Big Data Blog — *Building AI shopping agent using Amazon Bedrock AgentCore Runtime and Amazon OpenSearch Service*. https://aws.amazon.com/blogs/big-data/building-ai-shopping-agent-using-amazon-bedrock-agentcore-runtime-and-amazon-opensearch-service/
13. AWS — *Amazon Bedrock Knowledge Bases*. https://aws.amazon.com/bedrock/knowledge-bases/
14. Agentic Commerce Protocol (OpenAI + Stripe). https://github.com/agentic-commerce-protocol/agentic-commerce-protocol
15. Cobus Greyling — *The Four Protocols of Agentic Commerce*. https://cobusgreyling.substack.com/p/the-four-protocols-of-agentic-commerce
16. Eco — *AP2 (Agent Payments Protocol) Explained*. https://eco.com/support/en/articles/14845479-ap2-agent-payments-protocol-explained
17. Meilisearch — *RAG guardrails: the foundation of trustworthy AI applications*. https://www.meilisearch.com/blog/rag-guardrails
18. Retail/trade press on Walmart Sparky/Wallaby (MARKETED): https://pacvue.com/blog/meet-walmarts-ai-assistants-marty-and-sparky/ ; https://i10x.ai/news/walmart-ai-pivot-sparky-multi-model

> **Fetches that failed / were skipped:** REAPER PDF body (arXiv:2407.18553) returned corrupted binary; facts taken from the arXiv abstract page instead. Original tech.instacart.com Medium URL 404'd / redirected to company.instacart.com (used the canonical URL). Walmart has no published engineering deep-dive — kept as MARKETED.
