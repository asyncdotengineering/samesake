# Samesake positioning

Samesake is a TypeScript-first search engine compiler for visual commerce, starting with fashion.

The shortest product promise is:

> Search for shoppers who do not know the product name.

Fashion shoppers often arrive with a screenshot, a vague intent, a budget, an occasion, a style constraint, and inventory reality. They do not search like database users. Samesake turns a typed catalog configuration into a Postgres-backed retrieval layer that can combine image similarity, natural-language intent, hard filters, merchant policy, and product availability.

## Category

Samesake is a developer framework for building visual-commerce search platforms.

It is not a hosted vector database, a generic RAG framework, a consumer shopping app, or an Algolia clone. It is the search layer you compile into your own commerce system when keyword search, flat vector search, and exact product-name lookup are not enough.

## Wedge

The first wedge is fashion search:

- reverse-image search for similar-looking catalog items
- fashion intent search for vague prompts like "modest wedding guest dress under 20k"
- constraint search across brand, price, size, color, material, occasion, availability, and merchant policy
- explainable hybrid ranking that lets developers inspect why a result matched

The same primitives can support other visual-commerce categories, but the public proof starts with fashion.

## System model

Samesake compiles `collection()` and `entity()` declarations into per-project Postgres schema.

For fashion search, the important model is multi-space retrieval:

- visual/image space for similar-look matching
- text intent space for shopper language
- structured attributes for filters and facets
- occasion/style/material signals from enrichment
- recency and availability signals for inventory reality
- merchant ranking policy through channel weights and hard constraints

The result is not "vector search with metadata." It is a typed retrieval plan where each signal has a declared purpose and can be measured or turned off.

## What It Is Not

Samesake is not:

- a hosted vector DB
- only keyword search
- only semantic search
- a generic document-chat/RAG framework
- a consumer shopping frontend
- a replacement for your product catalog, checkout, PIM, or OMS

It owns retrieval, matching, enrichment, indexing, and explainability for commerce search.

## Proof Standard

The proof standard is measured retrieval quality and constraint compliance on a real fashion catalog against weaker baselines.

Public claims should stay tied to:

- the corpus and eval method in [Fashion Search Proof](./fashion-search-proof.md)
- rerunnable commands in [`examples/fashion-search/`](../examples/fashion-search/)
- current limitations, especially visual search maturity, personalization, catalog scale, and merchant-specific tuning

If a claim cannot be traced to an eval output or runnable example, treat it as unproven.
