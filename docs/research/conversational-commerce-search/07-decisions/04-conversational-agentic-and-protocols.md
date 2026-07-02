# Decision 04 — Conversational Surface, Agentic Boundary & Protocols

## TL;DR
> **Stay at the retrieval boundary; make the boundary richer, not wider.** Add **one bounded
> clarifying question** gated on retrieval-score entropy + hard-filter cardinality; keep the
> **constrained-schema NLQ parser** (no free-form LLM rewrite on the hot path). Harden the
> **handoff contract** to the generation/agent layer (grounding payload + calibrated scores +
> freshness re-verify). Build protocol adapters in order: **UCP-Catalog MCP server → ACP
> product-feed exporter → agent-identity gating → serializable parsed-intent for AP2.**
> **Flip condition:** expand past retrieval only if a checkout standard wins so decisively that
> "retrieval-only" becomes unsellable — the evidence currently runs the *opposite* way.

---

## 1. The agentic boundary is correct — three independent proofs

1. **Agents fail downstream of retrieval, not at it.** WebShop (NeurIPS 2022): best model 29%
   task success vs 59% human. ShoppingBench (2025): GPT-4.1 = 48.2% overall, collapsing to
   **30.4% on Coupon & Budget** (planning/constraint-optimization) vs 59.6% on simple product
   finding. The hard, unsolved part is planning/checkout; retrieval is the tractable
   sub-problem samesake owns. (`03-academic/conversational-and-generative-retrieval.md`)
2. **Even Amazon went anti-agentic for latency.** REAPER (Amazon, 2024): an agentic multi-hop
   retrieval loop is "too slow… multiple seconds"; they replaced it with **a single LLM planner
   that emits the whole retrieval plan up front**, then deterministic execution. samesake's
   compiled, single-shot hybrid query with SQL hard-filter gating is the structural extreme of
   this philosophy. (`08-rag/ecommerce-rag-systems.md`)
3. **The market retreated from in-chat checkout.** OpenAI **rolled back ChatGPT Instant
   Checkout in March 2026** (a 4% fee throttled merchants; adoption stagnated) and reverted to
   *discovery + redirect*. The durable, high-volume agent behavior is **product discovery** —
   samesake's lane. (`06-protocols/agentic-commerce-protocols.md`)

## 2. The conversational surface: one clarifying question, gated, typed

Multi-turn clarification **measurably raises** retrieval HIT@10/MRR@10 (ProductAgent, 2024:
"retrieval performance improves with increasing dialogue turns") — but **over-asking is a known
UX failure** (ClarQ-LLM, AGENT-CQ). The right design:

- **Ask at most one bounded clarifying question, over a *typed facet*** (color, silhouette,
  occasion, price band) — the principled descendant of "System Ask, User Respond" (aspect-value
  questions) grounded in samesake's typed catalog.
- **Gate the decision on a retrieval signal, not always-on.** Mercado Libre's **entropy-driven
  policy** is the template: model the *entropy of the retrieval score distribution* — low
  entropy (sharp intent) → answer directly; high entropy (ambiguous) → ask. samesake **already
  computes these scores during RRF**; surfacing score-spread + hard-filter result cardinality is
  the cheap control signal. (`08-rag/ecommerce-rag-systems.md`,
  `03-academic/conversational-and-generative-retrieval.md`)
- **Negative feedback → soft-filter relaxation.** "Not this" should compile to soft-filter
  down-weighting, not a hard exclude (Conversational Product Search w/ Negative Feedback, 2019).

## 3. Keep the constrained-schema NLQ parser (don't add free-form rewrite)

MiniELM (ACL Findings 2025) is the empirical case *against* a free-form LLM rewriter on the hot
path: vanilla LLMs "generate long-tail queries with excessive length," and generative rewriting
has "high inference latency and computational costs… unsuitable for direct online deployment."
samesake's **constrained-schema NLQ parser sidesteps both failure modes**. Instacart's and
Wayfair's production "intent → constrained categories with a guardrail" pipelines are the same
move — adopt the **guardrail/verification framing** (it matches `findProducts()` grounding).
Differentiator: samesake's intent→filter step is **typed, compiled, and auditable**
(`/search/explain`), not an opaque in-house service.
(`03-academic/conversational-and-generative-retrieval.md`, `03-academic/large-retailer-product-search.md`)

## 4. The handoff contract — the actual product surface above retrieval

Every production RAG system (Rufus, Instacart, Mercado Libre, Shopify Sidekick, the AWS
blueprint) converges on the same pipeline, and they all bolt grounding guardrails *post-hoc*
onto a generative path. samesake's structural advantage: **the candidate set is hallucination-
free by construction** (only real, hard-filtered catalog rows). The residual risks live in
*generation* (the LLM mis-describing a real product) and in *freshness* (stale price/stock).

**Decision — guarantee these five things across the retrieval→generation boundary** so the
layer above can be thin, fast, and non-hallucinating (`08-rag/ecommerce-rag-systems.md`):

1. **Only real, filtered catalog rows** — hard filters already gated in SQL (Instacart's
   "catalog validation" guardrail, but pre-emptive and free).
2. **Per-result grounding payload** (`verification`/`grounding`/`why` + matched fields) so the
   generator can cite, not invent, and can be cheaply NLI-checked.
3. **Calibrated relevance scores + score-spread** per query — lets the caller decide
   *recommend-now vs ask-a-clarifying-question* without loading the catalog into context
   (Mercado Libre entropy).
4. **A freshness / re-verify hook** — a cheap "re-verify these IDs (price/stock) at generation
   time" call (Rufus "hydration"). This is the one hallucination risk samesake can't kill at
   index time.
5. **A single, stable, typed tool** (`findProducts`), **MCP-exposable** — exactly the "clear
   boundary" Shopify Sidekick lost to tool sprawl ("resist adding tools without clear
   boundaries; avoid multi-agent systems early"). Present samesake as *one* high-quality tool.

**Do not add generation.** The protocol stack and operator architectures draw the
discovery/generation/checkout lines exactly where samesake already draws them.

## 5. Protocols — the integration surface (build order)

The agentic stack splits into four layers; **samesake lives in Discovery/Catalog**, and the
checkout/payment layers are pure downstream pass-through (`06-protocols/agentic-commerce-protocols.md`):

1. **UCP-Catalog MCP server (build #1).** UCP (Shopify + Google, endorsed by Microsoft/MMC,
   Etsy, Wayfair, Target, Walmart) is the cross-vendor catalog lingua franca. Shopify's
   Storefront Catalog MCP exposes three tools — `search_catalog`, `lookup_catalog`,
   `get_product` — which is *almost line-for-line* samesake's retrieval surface. Map
   `search_catalog → hybrid retrieval`, `lookup_catalog → ID resolution`, `get_product →
   variant/availability`; emit the UCP metadata envelope, `availability.available`, and
   `price_range` in **minor units**. **One MCP server makes samesake readable by ChatGPT,
   Gemini, Copilot, Claude, and Perplexity at once.** (Note: Shopify's old `/api/mcp` deprecates
   **June 15, 2026** in favor of `/api/ucp/mcp` — build to the UCP shape, not the legacy one.)
2. **ACP product-feed exporter (build #2).** Typed catalog → ACP feed schema for ChatGPT
   discovery (the half that *survived* the Instant-Checkout rollback). Apache-2.0, beta, latest
   `2026-04-17` (adds an MCP binding — ACP is converging on MCP too).
3. **Agent-identity gating (build #3).** Accept `meta.ucp-agent.profile` / OAuth 2.1; scope what
   catalog/capabilities an *external* agent sees vs the *on-site* `findProducts()`. The
   "scoped to agent + merchant + consent" posture recurs at every layer (UCP profiles, Mastercard
   Agentic Tokens) — samesake is the *merchant scope* in that triad.
4. **Keep parsed-intent + explain serializable (build #4).** So samesake's NLQ output can feed an
   **AP2 Intent/Cart Mandate** audit trail; `/search/explain` is the discovery-side analogue of
   AP2's non-repudiable audit. samesake never *builds* payment — it stays mandate-feedable.

**What samesake must NOT build:** checkout or payment (ACP Agentic Checkout, AP2, Visa
Intelligent Commerce, Mastercard Agent Pay). The differentiator the protocols leave undefined:
**none standardizes retrieval quality** — UCP/ACP say "return products matching the query," not
*how relevant*. samesake's hybrid+RRF+hard-filter+`/search/explain` is the quality/trust layer
the protocols don't specify, running in the brand's own containers.

## Flip conditions
- Add a **second clarification turn** only if eval shows monotonic HIT@10 lift without conversion drop.
- **Reprioritize protocols** if a non-UCP/ACP discovery standard reaches comparable agent reach.
- **Expand past retrieval** only if the checkout layer stops being commercially contested (currently it is).

## Sources
`06-protocols/agentic-commerce-protocols.md`, `08-rag/ecommerce-rag-systems.md`,
`03-academic/conversational-and-generative-retrieval.md`, `05-commercial/commercial-platforms.md`.
