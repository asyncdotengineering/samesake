# Conversational / Agentic Commerce Search — Research Dossier

> **Status:** ✅ complete + completeness pass done. **32 firsthand dossiers** (21 initial + 11
> gap-fill in `10-gaps/`); decisions written in `07-decisions/` (start there — 25 decisions) +
> `BUILD-READY.md`. This README holds the frame, the rubric, and the verdict.
>
> **Completeness-pass headline (CORRECTED after code inspection):** the "local"-query weakness is
> real, but **narrower than the gap dossier first claimed.** samesake *already* ships cross-script
> Sinhala/Tamil/Latin matching (`samesake_normalise` + `samesake_phonetic` Indic-Soundex,
> `db/system-ddl.ts:47,64`) — but only the **entity-resolution** path uses it; the **collection
> product-search keyword leg is hardcoded `to_tsvector('english')`** (`collections-schema-gen.ts:88`).
> So the **#1 build is REUSE** (wire those existing primitives into the product-search keyword
> channel), not a from-scratch transliteration front-door. BGE-M3/learned-transliteration are
> optional upgrades. See the CORRECTED notes in `07-decisions/07-completeness-pass-additions.md`
> (D16) and `10-gaps/multilingual-and-codemixed-retrieval.md`. The pass also named the previously
> abstract choices (reranker `bge-reranker-v2-m3`, embedding default Qwen3-0.6B/Marqo-FashionSigLIP,
> `halfvec`, doc2query), corrected one over-absolute claim (**personalization** — context vectors
> need no behavioral log), and added five omitted capability areas (auditable merchandising,
> agentic-MCP security, fit-as-retrieval, GEO feed-legibility, visual late-interaction). See
> `07-decisions/07-completeness-pass-additions.md` and `10-gaps/README.md`.

## The decision this research serves

We are building **samesake** — a TypeScript-first search-engine *compiler* that compiles a
typed catalog declaration into a Postgres + pgvector retrieval layer running **inside the
brand's own app** (hybrid FTS + cosine ANN + optional typed "spaces", fused with RRF; hard
SQL filters; NLQ parser; multimodal enrich; `findProducts()` agentic surface that stops at
grounded retrieval). The question this dossier answers:

> **What does a *robust* conversational/agentic-commerce search framework have to get right —
> in retrieval quality, ranking, relevance, and scaling as catalog count grows — and where
> should samesake commit, differentiate, and integrate, given the Marqo thesis, the YC
> agentic-commerce segment, and the academic + OSS + commercial + protocol prior art?**

## Rubric — what must be true for an answer to be "right"

1. **Retrieval quality** holds up on hard intent (vague/visual/negation/budget/occasion), not just keyword.
2. **Ranking & relevance** are auditable and tunable without reindexing, and don't collapse on cold-start / new products (the behavioral-only failure mode).
3. **Scaling** is characterized: what happens to recall, latency, and filtered-ANN quality as the catalog goes 10k → 1M+ docs.
4. **Agent-readability**: the layer is consumable by *external* buyer agents (protocols) AND powers *on-site* conversational agents.
5. **Provenance**: every load-bearing claim (license, benchmark, method) is verified firsthand, not paraphrased.

## Blast radius of being wrong

High. These conclusions shape the framework's retrieval architecture, the eval gate, the
"spaces" decision, and the protocol/integration surface — choices that are expensive to
reverse once connectors and the index schema are committed.

## Folder index

| Folder | Contents |
|---|---|
| `01-marqo/` | The Marqo thesis mined firsthand — positioning, conversational/agentic (Sibbi), models/training, scaling, visual/fashion, competitor teardowns, metrics philosophy |
| `02-yc-segment/` | The 9 YC companies in/near agentic commerce — overlap vs complement with samesake |
| `03-academic/` | Large-retailer product-search papers, conversational/generative retrieval, hybrid-fusion & vector-scaling literature |
| `04-oss-engines/` | OSS/self-hostable search & vector engines — hybrid support, scaling, license verdicts |
| `05-commercial/` | Commercial discovery platforms (Constructor, Algolia, Bloomreach, Coveo, …) and the market gap |
| `06-protocols/` | Agentic-commerce protocols & buyer-agent surfaces (ACP, AP2, MCP, Rufus, …) — the integration surface |
| `07-decisions/` | Opinionated decision docs with flip conditions — **25 decisions** (start at `07-decisions/README.md`) |
| `08-rag/` · `09-recommendations/` | RAG (products/fashion/ecommerce) and recommendation-engine prior art |
| `10-gaps/` | Completeness pass — 11 gap dossiers (multilingual, embeddings, query-side, merchandising, personalization, fit, security, GEO, visual, vendors, eval) + nugget log |

## Verdict (hypothesis → confirmed)

The hypothesis held, and the evidence is stronger than expected. **samesake's contrarian bet —
brand-owned, in-app, typed, auditable hybrid retrieval over commodity Postgres with BYO models —
is architecturally validated by competitors and the academic literature alike.** Marqo's own CEO
manifesto makes samesake's exact argument ("the retrieval infrastructure is the most important
component of the agentic storefront, not the LLM"); Walmart/Taobao/Instacart/Etsy/Mercari all
independently converge on hybrid FTS+ANN+fusion; Amazon's REAPER and the protocol stack both
draw the discovery/checkout line exactly where samesake's `findProducts()` stops; and the one
direct OSS analog (Marqo OSS) just deprecated. The robust-framework opportunity is **not "train a
better embedding"** — it is **"make hybrid retrieval + hard constraints + agent protocols
correct, explainable, and scale-honest by construction."**

→ **Read `07-decisions/README.md` for the verdict-at-a-glance table (15 decisions + flip
conditions), then `BUILD-READY.md` for the prioritized first commits.**

## Corrections / notable findings surfaced during mining

- **CORRECTED (Marqo "Series A"):** the 2026-dated funding post actually re-skins a **Feb-2024
  $12.5M round** (total $17.8M, Lightspeed-led) and documents Marqo's pivot from open-source
  vector-search to hosted ecommerce SaaS — not a new raise. (`01-marqo/positioning-ai-native.md`)
- **Marqo's technical posts are generated SEO collateral.** A scrape leaked the Claude Code
  generation transcript: mandated keyword frequencies, a banned-term list forbidding "embeddings"
  /"vector search," and **self-contradicting hero numbers** (38.9% vs 88% MRR over Amazon Titan).
  Treat all Marqo-specific latency/relevance/revenue figures as unaudited marketing.
  (`01-marqo/scaling-performance.md`)
- **CORRECTED (Alibaba EBR):** "Mobius" is **Baidu's** sponsored-search framework, not Alibaba's;
  the correct Alibaba e-commerce EBR paper is **MGDSPR** (KDD 2021). (`03-academic/large-retailer-product-search.md`)
- **The checkout layer is commercially contested:** OpenAI **rolled back ChatGPT Instant
  Checkout in March 2026** — validating "stop at retrieval." (`06-protocols/agentic-commerce-protocols.md`)
- **License hazards mapped:** SPLADE weights = NC; ParadeDB pg_search + Elasticsearch-AGPL =
  network-copyleft traps for embed-in-product. Safe stack = pgvector + native FTS (+ pgvectorscale
  / pg_textsearch, PostgreSQL-licensed). Safe fashion models = FashionCLIP (MIT) / Marqo-Fashion
  (Apache-2.0). ESCI dataset = eval-only (CC BY-NC-SA). (`04-oss-engines/`, `03-academic/`)
