# Agentic-Commerce Protocols & Buyer-Agent Surfaces (2024–2026)

**Prior-art dossier for samesake** — the integration surface a brand-owned retrieval layer must speak to be readable by *external* buyer agents (ChatGPT, Gemini, Copilot, Perplexity, Amazon) while also powering *on-site* agents (`findProducts()`).

**Date of survey:** June 2026. **Author:** research subagent.

---

## 0. TL;DR for samesake

The 2024–2026 agentic-commerce stack splits cleanly into **four layers**, and samesake lives in exactly one of them:

| Layer | What it standardizes | Who owns it | samesake's relationship |
|---|---|---|---|
| **Discovery / Catalog** | How an agent reads a merchant's products: search, lookup, variant resolution, structured product schema | UCP Catalog (Shopify/Google), ACP feed (OpenAI), MCP tool surfaces | **THIS IS samesake's lane.** samesake is the retrieval engine that answers these calls. |
| **Checkout / Cart** | Session lifecycle, cart construction, fulfillment options, totals | ACP Agentic Checkout, UCP Checkout | **Downstream of samesake.** `findProducts()` deliberately stops before cart. samesake hands grounded products to whatever checkout layer the brand wires. |
| **Payment authorization** | Proving a user authorized an agent to pay; tokenized credentials | AP2 (Google), Visa Intelligent Commerce, Mastercard Agent Pay, ACP Delegate Payment | **Not samesake's concern.** Pure pass-through. |
| **Identity / Agent auth** | Who is this agent, what is it allowed to do | UCP agent profiles, ACP OAuth delegate-auth, MCP OAuth 2.1 | **Edge of samesake's lane** — samesake must be able to gate/scope on an agent identity. |

**The single most important finding:** samesake's *typed catalog declaration → hybrid retrieval → `/search/explain`* architecture is, almost line-for-line, the data shape and capability surface that **UCP Catalog**, **Shopify Storefront Catalog MCP**, and **OpenAI's ACP product feed** all standardize. samesake should treat **UCP Catalog (search/lookup/get_product over MCP)** and the **OpenAI/ACP product feed** as its two primary *output adapters*, not as competitors. The retrieval quality is the moat; the protocol is the socket.

**The second finding (PROVEN vs MARKETED):** The *checkout/payment* protocols are heavily marketed but commercially fragile — **OpenAI scaled back ChatGPT Instant Checkout in March 2026** after a 4% merchant fee throttled adoption, reverting ChatGPT to *discovery + redirect*. This validates samesake's "stop at retrieval" stance: the durable, high-volume agent traffic is **product discovery**, not in-chat purchase.

---

## 1. Agentic Commerce Protocol (ACP) — OpenAI + Stripe

### What it standardizes
ACP is the most fully-specified of the open standards. It standardizes **three things**: (a) a **product feed** ChatGPT ingests for discovery, (b) an **agentic checkout** REST contract on the merchant, and (c) **delegated payment** token passing.

> "The **Agentic Commerce Protocol (ACP)** is an interaction model and open standard for connecting buyers, their AI agents, and businesses to complete purchases seamlessly." — [ACP README](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol/blob/main/README.md)

The protocol explicitly preserves the merchant as merchant-of-record:
> "Embed commerce into your application. Let your users discover and transact directly with businesses in your application, **without being the merchant of record**." — ACP README

The OpenAI commerce surface frames the discovery half as catalog ingestion:
> ACP is "an open standard that serves as the connective layer between merchants and ChatGPT users," enabling ChatGPT to "**ingest structured catalog data, understand merchant inventory, and surface relevant products in context**." — [developers.openai.com/commerce](https://developers.openai.com/commerce)

### Spec / status (load-bearing)
- **License:** Apache 2.0. **Status:** `beta`. **Maintainers:** OpenAI + Stripe as Founding Maintainers, "with a clear path toward broader community governance."
- **Versioning:** date-based `YYYY-MM-DD`. Releases on record: `2025-09-29` (initial), `2025-12-12` (fulfillment), `2026-01-16` (capability negotiation), `2026-01-30` (extensions, discounts, payment handlers), **`2026-04-17` (cart, feed, orders, authentication, and MCP)** — latest stable. Source: [ACP README repo structure](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol/blob/main/README.md).
- Machine-readable: **OpenAPI YAML + JSON Schema** per version. RFCs are the human-readable design docs.
- The `2026-04-17` release adds an **MCP binding** — ACP is converging toward MCP as a transport, mirroring UCP.

### The Agentic Checkout flow (the actual contract a merchant implements)
From `rfc.agentic_checkout.md` (the **Agentic Checkout Specification, ACS**), a "standardized REST API contract that merchants SHOULD implement":

> "The merchant remains the **system of record** for all orders, payments, taxes, and compliance… Orders are processed entirely on the merchant's existing commerce stack. Payment authorization and settlement continue to occur via the merchant's PSP."

**Session lifecycle** (the 5 endpoints ChatGPT calls):
1. `POST /checkout_sessions` — create from `items` + optional buyer/address
2. `POST /checkout_sessions/{id}` — update (items, address, fulfillment option)
3. `GET /checkout_sessions/{id}` — retrieve authoritative state
4. `POST /checkout_sessions/{id}/complete` — finalize with payment, **MUST create an order**
5. `POST /checkout_sessions/{id}/cancel`

**Data-model details relevant to samesake's catalog shape:** amounts are **integers in minor units**; `LineItem` carries `name`, `description`, `images[]`, `unit_amount`, `disclosures`, `custom_attributes`, `marketplace_seller_details`; status enum is `not_ready_for_payment | ready_for_payment | completed | canceled | in_progress`; fulfillment options span `shipping | digital | pickup | local_delivery`. Idempotency via `Idempotency-Key` (required on POST), request signing via `Signature` + `Timestamp`, mandatory `API-Version` header. Source: [rfc.agentic_checkout.md](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol/blob/main/rfcs/rfc.agentic_checkout.md).

**Delegate Payment** (`rfc.payment_handlers.md`, `openapi.delegate_payment.yaml`): "Securely pass payment tokens between buyers, agents, and businesses using payment handlers." The agent collects payment, mints a narrowly-scoped token, hands it to the merchant; merchant charges via its own PSP. **Delegate Authentication** uses OAuth 2.0 to "allow agents to act on a buyer's behalf with a business."

### PROVEN vs MARKETED — the Instant Checkout retreat
- **PROVEN:** ACP launched 2025-09-29 with ChatGPT **Instant Checkout**, live with Etsy day one, then a dozen Shopify brands (Glossier, Vuori, Spanx, SKIMS). PayPal joined as a payment provider 2025-10-28. Stripe shipped its Agentic Commerce Suite 2025-12-11.
- **MARKETED → walked back:** OpenAI announced a **4% service fee** on completed Instant Checkout transactions (starting ~Jan 26, 2026), on top of merchants' existing ~2.9%+30¢. **In early March 2026 OpenAI rolled back Instant Checkout** after a limited pilot; "the 4% ACP transaction fee hindered merchant expansion, and user adoption stagnated. ChatGPT Shopping has since shifted its focus to product discovery and comparison, reverting to a design that redirects actual purchases to external sites." Sources: [American Banker / PaymentsSource](https://www.americanbanker.com/payments/news/openai-moves-ai-checkout-to-third-parties), [Clicky on the 4% fee](https://www.clicky.co.uk/blog/openai-to-charge-4-fee-on-openai-sales/).

**Implication for samesake:** The *checkout* half of ACP is the volatile part; the *feed/discovery* half is durable. samesake should ship an **ACP product-feed adapter** (export typed catalog → ACP feed schema) as a high-value, low-risk integration, and treat the checkout REST contract as an *optional* downstream adapter the brand can enable — never a dependency.

---

## 2. Google Agent Payments Protocol (AP2) + agentic checkout

### What it standardizes
AP2 standardizes **payment authorization and non-repudiation** — *not* discovery, *not* catalog. It answers: "did the human actually authorize this agent to buy this, at this price?"

> "While today's payment systems generally assume a human is directly clicking 'buy' on a trusted surface, the rise of autonomous agents… breaks this fundamental assumption." It addresses **Authorization** ("Proving that a user gave an agent the specific authority to make a particular purchase"), **Authenticity** ("Enabling a merchant to be sure that an agent's request accurately reflects the user's true intent"), and **Accountability**. — [Google Cloud AP2 announcement](https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol)

### Mechanism: Mandates as signed Verifiable Credentials
> "AP2 builds trust by using **Mandates—tamper-proof, cryptographically-signed digital contracts** that serve as verifiable proof of a user's instructions. These mandates are signed by **verifiable credentials (VCs)**."

Three mandate types:
- **Intent Mandate** — captures the user's initial instruction ("Find me new white running shoes"), and for delegated/human-not-present tasks carries the rules of engagement (price limits, timing) as "verifiable, pre-authorized proof."
- **Cart Mandate** — user approval signs "a secure, unchangeable record of the exact items and price, ensuring what you see is what you pay for."
- **Payment Mandate** — links a verified payment instrument to the transaction.

> "This complete sequence—from intent, to cart, to payment—creates a **non-repudiable audit trail**."

### Spec / status
- **Version v0.2** (released alongside a FIDO Alliance announcement). **License:** Apache 2.0. Public GitHub spec + reference implementations (`goo.gle/ap2`).
- **Relationship to other protocols:** "The protocol can be used as an **extension of the Agent2Agent (A2A) protocol and Model Context Protocol (MCP)**." A crypto extension (**A2A x402**) was built with Coinbase, Ethereum Foundation, MetaMask.
- **60+ launch partners** (Sept 2025): Adyen, American Express, Mastercard, PayPal, Coinbase, Salesforce, ServiceNow, Worldpay, JCB, UnionPay, Revolut, Intuit, Etsy, etc. Sources: [Google Cloud blog](https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol), [DigitalCommerce360](https://www.digitalcommerce360.com/2025/09/19/google-ai-payments-protocol-ap2/).

**Implication for samesake:** AP2 is **orthogonal** to samesake — it sits below `findProducts()`. But note the **Intent Mandate** concept: the user's structured intent + constraints. This is *exactly* the shape samesake's NLQ parser already produces (constrained schema: intent + hard/soft filters). If a brand wires AP2, samesake's parsed intent + the products it grounds can *feed* an Intent Mandate / Cart Mandate. samesake should keep its parsed-intent object **serializable and auditable** so it can become evidence in an AP2 mandate chain. samesake's `/search/explain` is conceptually the discovery-side analogue of AP2's audit trail.

---

## 3. Universal Commerce Protocol (UCP) — Shopify + Google

UCP is the **most important protocol for samesake** because it standardizes the *discovery/catalog* layer that samesake actually implements.

### What it standardizes
UCP is "a new open standard co-developed with Google to bring commerce to agents at scale" and "an open standard for AI agents to connect and transact with any merchant." It is the cross-platform evolution of Shopify's per-store MCP — instead of every storefront speaking a slightly different catalog dialect, UCP standardizes the **vocabulary agents use across platforms**. Source: [Shopify "AI commerce at scale" (Jan 11, 2026)](https://www.shopify.com/news/ai-commerce-at-scale).

It spans **both** discovery and checkout, transport-agnostic:
> "With UCP, agents can natively complete checkout on a customer's behalf with a flexible architecture that adapts to any commerce stack using **REST, Model Context Protocol (MCP), Agent Payments Protocol (AP2), or Agent2Agent (A2A)** protocols."

### The Catalog capability — samesake's exact target shape
Shopify's **Storefront Catalog MCP** "implements the UCP Catalog capability and its MCP binding." It exposes **three tools** (this is the contract samesake's retrieval must satisfy):

- `search_catalog` — free-text query + `context` buyer signals (`address_country`, `language`, `currency`, `intent`) + cursor pagination (limit default 10, max 250). Returns products with `title`, `description`, `price_range` (minor units), `media`, `variants`, `rating`, `metadata`, plus a **UCP metadata envelope** declaring `capabilities`.
- `lookup_catalog` — batch resolve up to 10 product/variant IDs; returns `inputs` correlation + `not_found` messages.
- `get_product` — full product with variant selection; option values carry `available` / `exists` signals; `product.selected` reflects effective selections.

Source: [Shopify Storefront Catalog MCP docs](https://shopify.dev/docs/agents/catalog/storefront-catalog), conforming to [UCP catalog spec 2026-04-08](https://ucp.dev/2026-04-08/specification/catalog/).

**Two scopes:** *Storefront* Catalog MCP (single merchant — "use when building a storefront AI agent") vs *Global* Catalog MCP (cross-merchant discovery). samesake maps onto **Storefront / single-merchant** — brand-owned.

**Agent identity is mandatory:** the `/api/ucp/mcp` endpoint "requires an **agent profile** — every request must include a `meta.ucp-agent.profile` URL pointing to your agent's UCP profile. The returned tools depend on the capabilities your agent advertises." This is **capability negotiation gated on agent identity** — directly relevant to samesake gating external vs on-site agents.

### Status / migration / endorsement
- **Migration:** the old `/api/mcp` endpoint is **deprecated June 15, 2026**; new endpoint is `/api/ucp/mcp` using UCP request/response schemas. Hydrogen/store devs must migrate. Source: [Weaverse migration guide](https://weaverse.io/blogs/shopify-storefront-catalog-mcp-ucp-migration-hydrogen-2026).
- **Endorsement:** 20+ retailers/platforms including Etsy, Wayfair, Target, Walmart, plus Adyen, Visa, Mastercard, Stripe.
- **Shopify Agentic plan** (Jan 2026): opens Shopify Catalog to brands **not on Shopify** — "brands on any platform can now use Shopify's infrastructure to sell on AI channels." Shopify Catalog uses "specialized LLMs to categorize, enrich, and standardize product data." Source: [Shopify news](https://www.shopify.com/news/ai-commerce-at-scale).

**Implication for samesake (highest priority):** UCP Catalog over MCP is the canonical external-agent socket. samesake should expose a **UCP-Catalog-compatible MCP server** as a first-class compile target: map `search_catalog → samesake hybrid retrieval`, `lookup_catalog → ID resolution`, `get_product → variant/availability`. samesake's `available=true` hard filter maps to UCP's `availability.available`; samesake's typed price filters map to `price_range` in minor units; samesake's enrich pipeline is the *self-hosted, brand-owned alternative* to Shopify Catalog's "specialized LLMs to categorize, enrich, and standardize." **Differentiation:** Shopify Catalog enrichment is centralized and Shopify-owned; samesake's runs in the brand's own two containers with BYO models. samesake also adds what UCP Catalog does *not* specify: **relevance quality** (hybrid FTS+ANN+RRF) and **auditability** (`/search/explain`). The UCP spec standardizes the *envelope*; it does not standardize *how good the ranking is* — that gap is samesake's moat.

---

## 4. Visa Intelligent Commerce & Mastercard Agent Pay

Both are **payment-authorization** layers (same band as AP2), built on **scoped tokenized card credentials** bound to a specific agent/merchant/consent. Neither touches discovery.

### Visa Intelligent Commerce
- Launched **April 30, 2025**. Combines "scoped tokenized credentials that can be issued to AI agents, behavioral and issuer-side authentication built for machine-initiated payments, and integrations with major LLM platforms like Anthropic, OpenAI, and Microsoft."
- **Intelligent Commerce Connect** = "a single integration into agentic commerce" for merchants/agent-builders/enablers.
- Notably **protocol-agnostic at the payment layer**: supports payments initiated through **Trusted Agent Protocol, Machine Payments Protocol, Agentic Commerce Protocol (ACP), and Universal Commerce Protocol (UCP)**. Sources: [TechInformed](https://techinformed.com/visa-opens-one-integration-for-ai-agent-payments/), [DigitalCommerce360](https://www.digitalcommerce360.com/2025/10/16/visa-mastercard-both-launch-agentic-ai-payments-tools/).

### Mastercard Agent Pay
- Launched **April 2025**. A framework letting "verified AI agents transact on a consumer's behalf using **Agentic Tokens**, an extension of the Mastercard Digital Enablement Service (MDES)."
- **Agentic Tokens "bind a tokenized card credential to a specific agent, a specific merchant scope, and a specific consent policy."** Uses Mastercard Payment Passkeys.
- Live authenticated agentic transactions demoed in Hong Kong (Mar 27) and Thailand (Apr 7). Source: [Eco support: Mastercard Agent Pay](https://eco.com/support/en/articles/15192001-what-is-mastercard-agent-pay-ai-agent-commerce-protocol-in-2026), [RisingWave comparison](https://risingwave.com/blog/mastercard-agent-pay-vs-visa-vs-stripe-agentic-commerce/).

**Implication for samesake:** Fully out of scope — pure downstream pass-through. The relevant lesson is **the "scoped to agent + merchant + consent" pattern** appears at *both* the payment layer (Mastercard tokens) and the discovery layer (UCP agent profiles). samesake's external-agent surface should carry the same posture: an agent presents an identity/profile, samesake scopes what catalog/capabilities it can see. samesake is the *merchant scope* in that triad.

---

## 5. Amazon Rufus & "Buy for Me"

A **closed, vertically-integrated** buyer-agent surface — the anti-pattern to open protocols, and the one samesake cannot directly integrate with (no public merchant socket).

- **Rufus** = Amazon's conversational shopping assistant; helped 300M+ customers in 2025; users ~60% more likely to complete a purchase; **~$12B incremental annualized sales** (Amazon Q4 2025 materials).
- **"Buy for Me"** = agentic purchasing on *external* sites on the customer's behalf — grew from 65,000 products at launch to 500,000+ by Nov 2025.
- **Nov 18, 2025:** Rufus went autonomous — auto-add to cart, conversational reorders, price-monitoring every 30 min, **auto-buy when target price met**.
- **May 2026:** Rufus folded into **"Alexa for Shopping."** Sources: [AboutAmazon](https://www.aboutamazon.com/news/retail/alexa-for-shopping-ai-assistant), [GeekWire](https://www.geekwire.com/2026/amazon-unifies-alexa-and-rufus-as-ai-rivals-move-into-online-shopping/), [Nova Analytics](https://novadata.io/resources/news/amazon-rufus-agentic-auto-buy-250-million-users).

**PROVEN vs MARKETED:** The $12B and 300M figures are Amazon's own earnings/PR (MARKETED, self-reported). The auto-buy/price-monitor features are PROVEN to ship. "Buy for Me" reaching *external* sites is real but operates by Amazon's agent driving the merchant's *human-facing* checkout — i.e., it does **not** need a merchant-exposed protocol; it scrapes/drives the storefront.

**Implication for samesake:** Two takeaways. (1) Amazon proves that the *durable* agent behavior is **discovery + comparison + grounded recommendation**, which is samesake's lane — auto-buy is the cherry, discovery is the cake. (2) Brands fear becoming a faceless SKU inside Amazon/Rufus. samesake's pitch — **a brand-owned retrieval layer the brand controls, that external agents read on the brand's terms** — is the structural counter to Amazon disintermediation. samesake should make its catalog **legible to open protocols (UCP/ACP)** precisely so brands are reachable by *non-Amazon* agents without ceding the relationship.

---

## 6. Perplexity & ChatGPT shopping / instant checkout

### Perplexity "Buy with Pro" / "Instant Buy"
- "Buy with Pro" first unveiled late 2024; in-chat purchase for Pro subscribers; **PayPal** as payment partner; ~5,000 merchants targeted.
- **"Instant Buy"** = in-chat checkout built with PayPal handling billing; merchant handles fulfillment. Free agentic shopping product relaunched for US users (Black Friday push). Sources: [CNBC](https://www.cnbc.com/2025/11/19/perplexity-ai-online-shopping-paypal.html), [eMarketer](https://www.emarketer.com/content/perplexity-agentic-shopping-relaunch-paypal-black-friday).

### ChatGPT shopping (recap of §1)
ChatGPT = the flagship ACP consumer surface. Instant Checkout launched Sep 2025, **scaled back March 2026** to discovery + redirect.

**Implication for samesake:** Perplexity and ChatGPT both demonstrate the **discovery → in-chat answer → (optional) checkout** funnel. Both lean on partner payment (PayPal/Stripe) and both keep merchants as fulfiller/MoR. The pattern that survives commercial reality (post-ChatGPT-rollback) is: **the AI surface does discovery; the brand owns product truth and fulfillment.** samesake powers the "product truth" — it should be readable by *all* of these surfaces via the open feed/catalog standards (ACP feed, UCP Catalog) rather than betting on any single buyer-agent's checkout.

---

## 7. Microsoft / Copilot Merchant

- **Copilot Checkout** — embedded purchase inside Copilot ("without being redirected to external sites"); authenticates against the user's Microsoft Account, pulls payment from **Microsoft Wallet**. Live in the US on Copilot.com.
- **Onboarding:** requires a **Microsoft Merchant Center (MMC)** account + **product feed**. "MMC will support **Universal Commerce Protocol (UCP)**, enabling richer signals (returns/support policies) so AI can assess products with confidence."
- **Brand Agents** — for Shopify merchants, agents "trained on a company's product catalog" to answer in-depth product inquiries.
- Microsoft's own claim: "Early tests with pilot merchants showed a **23% lift in conversion rate** when Copilot Checkout surfaced UCP-powered listings compared to standard Shopping ads" (MARKETED, Microsoft-reported). Sources: [Microsoft Source](https://news.microsoft.com/source/2026/01/08/microsoft-propels-retail-forward-with-agentic-ai-capabilities/), [Microsoft Ads Agentic Commerce](https://about.ads.microsoft.com/en/solutions/technology/agentic-commerce), [ALM Corp guide](https://almcorp.com/blog/microsoft-copilot-checkout-brand-agents-guide/).

**Implication for samesake:** Microsoft adopting **UCP** for MMC confirms UCP as the cross-vendor catalog lingua franca (Google + Shopify + Microsoft all in). The mention of "richer signals (returns/support policies) so AI can assess products with confidence" matches samesake's **enrich pipeline + typed catalog** — samesake can surface exactly these confidence signals. "Brand Agents trained on the catalog" is functionally what samesake's `findProducts()` is, but brand-owned and self-hosted rather than Microsoft/Shopify-hosted.

---

## 8. Model Context Protocol (MCP) for commerce — the transport substrate

MCP is not a commerce protocol; it is the **transport** that ACP (2026-04-17 binding), UCP Catalog (MCP binding), and AP2 (as an extension) all ride on.

- Launched by **Anthropic, Nov 2024**. By March 2026: **10,000+ public MCP servers**, ~97M monthly SDK downloads.
- Remote MCP servers use **HTTP+SSE with OAuth 2.0 / OAuth 2.1** auth; standardized tool discovery via `tools/list`.
- **Dec 2025:** Anthropic donated MCP to the **Agentic AI Foundation under the Linux Foundation**, co-founded by Anthropic, Block, and OpenAI (with Google, Microsoft, AWS, Cloudflare). Sources: [Wikipedia MCP](https://en.wikipedia.org/wiki/Model_Context_Protocol), [enterprise MCP guide](https://guptadeepak.com/the-complete-guide-to-model-context-protocol-mcp-enterprise-adoption-market-trends-and-implementation-strategies/).

**Implication for samesake:** MCP is the **plug**. samesake's external-agent surface should be an **MCP server** exposing UCP-Catalog-shaped tools (`search_catalog`, `lookup_catalog`, `get_product`). This is the single integration that makes samesake readable by Claude, ChatGPT, Gemini, Copilot, and any MCP-speaking agent at once. samesake already has the hard parts (typed catalog, hybrid retrieval, explain); wrapping them in an MCP/UCP binding is the cheap, high-leverage adapter. OAuth 2.1 on the MCP endpoint is how samesake gates external agents.

---

## 9. The integration surface samesake must speak (synthesis)

```
                         EXTERNAL BUYER AGENTS
        ChatGPT · Gemini/AI Mode · Copilot · Perplexity · (Amazon=closed)
                                  │
            ┌─────────────────────┴─────────────────────┐
            │   DISCOVERY/CATALOG  (samesake's lane)     │
            │   • UCP Catalog over MCP (search/lookup/    │  ← samesake EXPOSES this
            │     get_product) — Shopify+Google+MSFT      │     (MCP server, UCP-shaped)
            │   • ACP product feed (OpenAI)               │  ← samesake EXPORTS this
            │   • agent profile / OAuth 2.1 gating        │  ← samesake GATES on this
            └─────────────────────┬─────────────────────┘
                                  │  grounded products + why + verification
                       (findProducts() STOPS HERE)
            ┌─────────────────────┴─────────────────────┐
            │   CHECKOUT  (downstream, optional adapter) │
            │   • ACP Agentic Checkout REST              │  brand wires if desired
            │   • UCP Checkout                           │
            └─────────────────────┬─────────────────────┘
            ┌─────────────────────┴─────────────────────┐
            │   PAYMENT AUTH  (pure pass-through)        │
            │   • AP2 mandates · Visa IC · MC Agent Pay  │  not samesake's concern
            └────────────────────────────────────────────┘
```

**What samesake must build (priority order):**
1. **UCP-Catalog MCP adapter** — the universal discovery socket (one integration → all major agents). Map hybrid retrieval to `search_catalog`/`lookup_catalog`/`get_product`; emit the UCP metadata envelope + `availability`/`price_range` minor-units shape.
2. **ACP product-feed exporter** — typed catalog → ACP feed schema, for ChatGPT discovery (which survived the checkout rollback).
3. **Agent-identity gating** — accept `meta.ucp-agent.profile` / OAuth 2.1; scope which catalog/capabilities an external agent sees vs the on-site `findProducts()`.
4. **Keep parsed intent + explain serializable** — so samesake's NLQ output can feed an AP2 Intent/Cart Mandate audit trail and so `/search/explain` is the discovery-side analogue of the mandate audit.

**What samesake must NOT do:** become a checkout or payment provider. The ChatGPT Instant Checkout retreat proves the checkout layer is commercially contested and fee-throttled; discovery is where the durable, brand-owned value sits — exactly where samesake already is.

**What samesake differentiates on:** every protocol above standardizes the *envelope* (tool names, schemas, tokens) but **none standardizes retrieval quality**. UCP/ACP say "return products matching the query"; they say nothing about *how relevant*. samesake's hybrid FTS+ANN+RRF, hard-filter-gating, and `/search/explain` auditability are the quality + trust layer the protocols leave undefined — and they run in the brand's own containers with BYO models, unlike Shopify's centralized Catalog LLMs or Microsoft/Google-hosted brand agents.

---

## Sources

- ACP README — https://github.com/agentic-commerce-protocol/agentic-commerce-protocol/blob/main/README.md
- ACP Agentic Checkout RFC — https://github.com/agentic-commerce-protocol/agentic-commerce-protocol/blob/main/rfcs/rfc.agentic_checkout.md
- OpenAI Commerce — https://developers.openai.com/commerce
- Stripe ACP docs — https://docs.stripe.com/agentic-commerce/acp
- Stripe "Introducing our agentic commerce solutions" — https://stripe.com/blog/introducing-our-agentic-commerce-solutions
- OpenAI moves AI checkout to third parties (American Banker) — https://www.americanbanker.com/payments/news/openai-moves-ai-checkout-to-third-parties
- OpenAI 4% fee (Clicky) — https://www.clicky.co.uk/blog/openai-to-charge-4-fee-on-openai-sales/
- Google Cloud AP2 announcement — https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol
- AP2 protocol docs — https://ap2-protocol.org/
- Google AP2 partners (DigitalCommerce360) — https://www.digitalcommerce360.com/2025/09/19/google-ai-payments-protocol-ap2/
- Shopify Storefront Catalog MCP docs — https://shopify.dev/docs/agents/catalog/storefront-catalog
- UCP catalog spec 2026-04-08 — https://ucp.dev/2026-04-08/specification/catalog/
- Shopify "AI commerce at scale" (UCP launch) — https://www.shopify.com/news/ai-commerce-at-scale
- Shopify→UCP migration (Weaverse) — https://weaverse.io/blogs/shopify-storefront-catalog-mcp-ucp-migration-hydrogen-2026
- Visa Intelligent Commerce (TechInformed) — https://techinformed.com/visa-opens-one-integration-for-ai-agent-payments/
- Visa/Mastercard agentic tools (DigitalCommerce360) — https://www.digitalcommerce360.com/2025/10/16/visa-mastercard-both-launch-agentic-ai-payments-tools/
- Mastercard Agent Pay (Eco) — https://eco.com/support/en/articles/15192001-what-is-mastercard-agent-pay-ai-agent-commerce-protocol-in-2026
- Mastercard vs Visa vs Stripe (RisingWave) — https://risingwave.com/blog/mastercard-agent-pay-vs-visa-vs-stripe-agentic-commerce/
- Amazon Alexa for Shopping (AboutAmazon) — https://www.aboutamazon.com/news/retail/alexa-for-shopping-ai-assistant
- Amazon Rufus/Alexa unification (GeekWire) — https://www.geekwire.com/2026/amazon-unifies-alexa-and-rufus-as-ai-rivals-move-into-online-shopping/
- Rufus agentic auto-buy (Nova Analytics) — https://novadata.io/resources/news/amazon-rufus-agentic-auto-buy-250-million-users
- Perplexity shopping + PayPal (CNBC) — https://www.cnbc.com/2025/11/19/perplexity-ai-online-shopping-paypal.html
- Perplexity relaunch (eMarketer) — https://www.emarketer.com/content/perplexity-agentic-shopping-relaunch-paypal-black-friday
- Microsoft retail agentic AI (Microsoft Source) — https://news.microsoft.com/source/2026/01/08/microsoft-propels-retail-forward-with-agentic-ai-capabilities/
- Microsoft Ads Agentic Commerce — https://about.ads.microsoft.com/en/solutions/technology/agentic-commerce
- Microsoft Copilot Checkout guide (ALM Corp) — https://almcorp.com/blog/microsoft-copilot-checkout-brand-agents-guide/
- MCP (Wikipedia) — https://en.wikipedia.org/wiki/Model_Context_Protocol
- MCP enterprise adoption guide — https://guptadeepak.com/the-complete-guide-to-model-context-protocol-mcp-enterprise-adoption-market-trends-and-implementation-strategies/
