# Agentic Commerce Retrieval Demo

This demo proves the narrow agentic-commerce claim: Samesake is the product retrieval layer an agent can call for grounded candidates. It stops before cart, checkout, payment, or autonomous purchase execution.

## Run

Prerequisite: `DATABASE_URL` for a Postgres database with pgvector.

```bash
bun examples/agentic-commerce/run.ts
```

The script uses a deterministic local embedder and mocked example images. No paid AI API is required.

## What It Shows

1. Applies a tiny fashion catalog with text and image spaces.
2. Pushes products with price, stock, size, URL, image, and inventory timestamp fields.
3. Calls `matcher.findProducts` with a text-only shopper intent.
4. Calls `matcher.findProducts` again with image + text retrieval.
5. Prints grounded product candidates with:
   - product IDs
   - price and currency
   - availability freshness
   - constraint verification
   - explanation payloads
   - grounding metadata
6. Prints a downstream handoff payload and explicitly names cart/payment as out of scope.

## Agent Tool Endpoints

```txt
POST /v1/projects/:project/collections/:collection/agent/find-products
POST /v1/projects/:project/collections/:collection/agent/find-similar-products
GET  /v1/agent-tools/openapi.json
GET  /v1/agent-tools/tools.json
```

HTTP calls use the same project-key auth rules as collection search.

## Eval Shape

Use the demo output to compare the agent tool against raw search baselines:

- keyword-only: call `matcher.search` with `weights: { fts: 1, cosine: 0, spaces: 0 }`
- vector/spaces: call `matcher.search` with `weights: { fts: 0, cosine: 0, spaces: 1 }`
- agent tool: call `matcher.findProducts` with constraints and `explain: true`

The important agent metric is not only ranking. It is whether returned candidates are grounded, purchasable, and honest about unknown freshness before a downstream system acts.
