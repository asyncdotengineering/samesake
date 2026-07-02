# Decision 01 — Positioning & Thesis

## TL;DR
> **samesake's wedge is deployment + auditability, not model magic.** It is a brand-owned,
> in-app, typed retrieval *compiler* that runs in the team's own Postgres — the structural
> opposite of every hosted-SaaS incumbent (Marqo, Algolia, Constructor, Bloomreach, Coveo,
> Nosto, Athos, Google Vertex). Lead with "your index, your Postgres, your ranking, your
> `/search/explain`." Do **not** chase the full funnel (conversation→cart→checkout) — that is
> a deliberate, defensible boundary, validated by the protocol stack and the ChatGPT
> Instant-Checkout rollback.
> **Flip condition:** revisit if "in-app / owned Postgres / BYO models" stops being a buying
> criterion for premium/fashion/autonomous-brand teams — i.e. if the market proves it will
> trade ownership for hosted convenience even at the high end.

## The market shape (from `05-commercial` + `01-marqo`)

Every commercial platform is **hosted SaaS that ingests the catalog into the vendor cloud and
serves queries from there.** The only "ownable" incumbents — Elastic (run your own cluster)
and Lucidworks Fusion (on-prem) — are *separate search clusters with their own ops*, not a
layer compiled into the Postgres the team already runs. **No incumbent ships "search that runs
in your two-container app over your own pgvector."** That whitespace is the position.

Marqo is the closest *thesis* match and the sharpest contrast:
- **Agreement:** Marqo's CEO manifesto says, almost verbatim, samesake's core belief —
  *"the AI-native product discovery infrastructure is the most important component of the
  agentic storefront, not the LLM itself."* Retrieval is the product; the LLM is downstream.
- **Opposition:** Marqo is a hosted black box — per-tenant catalog-trained models on Marqo's
  infra, "Commerce Superintelligence," a single-line deploy that contradicts its own
  per-retailer training story, and scope sprawling through post-purchase (Sibbi). Its public
  technical posts are **literally generated SEO collateral** (the scrape leaked the Claude
  Code generation transcript with mandated keyword frequencies and a banned-term list that
  forbids "embeddings"/"vector search"), and its hero numbers contradict each other across
  posts (38.9% vs 88% MRR over Amazon Titan; 73–78% relevance with no methodology).

## What samesake should claim (all defensible)

1. **Deployment ownership** — two containers (Postgres + app), BYO embeddings, no hosted
   vector DB / Redis / Elasticsearch, no data exfiltration. The single clearest wedge.
2. **Auditability** — `/search/explain` + hard filters compiled to inspectable SQL predicates
   that gate *before* ranking. Marqo asserts "100% catalog grounded, trust us"; samesake can
   *prove* the gate. No incumbent offers a deterministic per-query retrieval/ranking trace.
3. **Reproducible eval** — samesake publishes a corpus + metric (grade@10≈2.33, P@5 0.83 on
   ~5k LK fashion docs) and an honest **eval gate** ("spaces" off because it failed). The
   entire commercial market is *marketed on conversion outcomes, not proven on retrieval
   metrics* — samesake having any reproducible benchmark is, ironically, more rigorous.
4. **Permissive licensing of the whole stack** — pgvector (PostgreSQL License) avoids the
   AGPL/SSPL/ELv2 traps that make Elasticsearch and ParadeDB hazardous to embed in a product.
5. **Content-first ⇒ cold-start-proof** — hybrid FTS + BYO-content-embedding ANN gives
   relevance from day one with no clickstream. This is exactly the trap Marqo (correctly)
   says behavioral-only ranking falls into ("70–80% of catalog in the long tail with
   insufficient behavioral signal"; resale "perpetually in cold-start"). samesake gets it for
   free, without the per-tenant-model lock-in.

## Where the YC segment confirms the slot (from `02-yc-segment`)

The agentic-commerce stack is **unbundling** into discrete, swappable layers:

```
enrichment (Anglera) → RETRIEVAL/RANKING (samesake's slot — uncontested by these 9)
   → order execution (Zinc) → payment guardrail (Allowance)
```

- **Channel3** is the foil: an *aggregated, hosted* product API — the canonical "buy a hosted
  product graph" alternative to "compile your own brand-owned index." A brand that wants to
  control how it is described/ranked is exactly who Channel3 *can't* serve, because its value
  *is* aggregation.
- **Kinect** validates the brand-owned-catalog thesis from the application layer (and is a
  candidate *consumer* of samesake's retrieval).
- **BIK / Yuma / 14.ai** are agents-over-commerce that creep from support toward the funnel
  but assume "product data is just there" and improvise with an LLM-over-catalog widget. The
  competitive risk is not that one ships a "search compiler" — it's that a *low-rigor*
  in-house retrieval layer is "good enough" for SMBs. samesake's defense is exactly the rigor
  they skip: typed catalog, hard-filter SQL gating, RRF hybrid, eval gates, `/search/explain`.

## What samesake must NOT do

- Not a merchandising suite, CDP, onsite chat widget, analytics dashboard, or offsite GEO
  service. Incumbents win on packaged merchandiser UX and personalization network effects.
- Not a generation or checkout layer (see `04` and `05`).
- Not Marqo's euphemism-driven marketing — samesake's credibility advantage is precisely
  *not* publishing unverifiable hero numbers.

## Sources
`01-marqo/*`, `02-yc-segment/*`, `05-commercial/commercial-platforms.md`,
`06-protocols/agentic-commerce-protocols.md`.
