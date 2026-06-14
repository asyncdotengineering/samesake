# Search Expert Lessons For Samesake

Researched on 2026-06-14.

Sources:

- Article: [Make Retrieval / Search More Relevant With An LLM](https://sarthakai.substack.com/p/make-retrieval-search-more-relevant)
- Repository inspected locally from [`sarthakrastogi/search-expert`](https://github.com/sarthakrastogi/search-expert)
- Hugging Face model metadata: [`search-expert-json-0.8b`](https://huggingface.co/sarthakrastogi/search-expert-json-0.8b), [`search-expert-yaml-0.8b`](https://huggingface.co/sarthakrastogi/search-expert-yaml-0.8b)
- Hugging Face benchmark dataset: [`amazon-search-dataset`](https://huggingface.co/datasets/sarthakrastogi/amazon-search-dataset)

## TL;DR

Search Expert is useful prior art because it frames search relevance as a hard-constraint extraction problem before ranking. We should not copy its Python stack, Chroma path, or model weights into Samesake. We should copy the product contract: natural language constraints must compile into typed filters, and search quality must be judged by top-k constraint satisfaction as well as semantic relevance.

## What It Actually Builds

Search Expert turns natural language search queries into a small structured object. The canonical ecommerce shape is:

```json
{
  "product": "headphones",
  "feature": "noise cancelling",
  "color": ["ne:black"],
  "price": "lt:200"
}
```

The important design choice is the operator vocabulary: `lt:N`, `lte:N`, `gt:N`, `gte:N`, `between:LOW:HIGH`, `approx:N`, and `ne:value`.

This is intentionally backend-neutral. The repo shows conversion into Chroma filters, but the same contract maps cleanly to Samesake's SQL filter compiler.

## Article Claims Verified Against Source

The article argues that marketplace search often retrieves semantically relevant products that still violate explicit constraints such as price, color, or rating. It positions Search Expert as a pre-filtering component, not a recommender replacement.

The repository supports that framing:

- The external repo's main expert module exposes `SearchExpert.parse(query)` and returns a `ParseResult`.
- The external repo's result module preserves raw parsed fields and adds `get_numeric_constraint`.
- Its ecommerce example demonstrates `structured parse -> metadata where filter -> vector ranking`.
- Its Amazon benchmark module measures top-k constraint satisfaction for Amazon, hybrid, and pure vector pipelines.

The article gives the model training recipe:

- LoRA fine-tune of Qwen3.5-0.8B.
- Adapter targets include attention and MLP projection modules.
- Rank `r=16`, `lora_alpha=16`.
- 4-bit NF4 quantization with bitsandbytes.
- Unsloth backend.
- Effective batch size 16.
- 300 training steps.
- Cosine schedule, 100 warmup steps, peak learning rate `2e-4`.
- Synthetic 100k query/output pairs across 10 domains.

The public repo does not include a reproducible fine-tuning script despite documenting one in the README structure. Its training directory contains prompt and evaluation helpers, not the full training script.

## Provenance And Reuse Verdict

| Asset | Evidence | Samesake Verdict |
|---|---|---|
| Repository code | `pyproject.toml` says MIT, but the cloned repo has no LICENSE file even though README links one. | Do not copy code. Use as prior art only. |
| Model adapters | HF API lists public, ungated adapter repos with no explicit license in `cardData`. | Do not depend on or redistribute weights. |
| Training dataset | HF API for `sarthakrastogi/search-expert` returns 401. | Not available for reproducible training. |
| Amazon benchmark dataset | HF API reports public dataset, `license: mit`, 1K-10K rows. | Useful as conceptual benchmark shape; avoid using scraped Amazon data as a core dependency. |
| Benchmark methodology | Source code is inspectable and simple. | Reimplement the metric shape in Samesake-owned evals. |

## What Samesake Should Copy

### 1. Treat Constraint Extraction As A Product Surface

Samesake already has NLQ parsing and SQL filters. The missing product-level framing is sharper:

```ts
parseConstraints("red cotton dress under 100 not polyester")
// {
//   semanticQuery: "red cotton dress",
//   filters: {
//     price: { $lte: 100 },
//     material: { $ne: "polyester" },
//     colors: ["red"]
//   },
//   confidence: { ... },
//   unparsed: []
// }
```

This should be a first-class observable artifact, not an incidental field in `searchExplain`.

### 2. Evaluate Result Correctness, Not Parser Beauty

Parser F1 is not enough. A parser can look good while retrieval still returns products that violate constraints. Search Expert's benchmark asks the right question: in the top K results, what fraction actually satisfy the hard constraints?

Samesake's evals should track:

- `priceSatisfaction@K`
- `availabilitySatisfaction@K`
- `colorRequiredSatisfaction@K`
- `colorExcludedSatisfaction@K`
- `overallConstraintSatisfaction@K`
- `perfectConstraint@K`
- `zeroResultRate`
- `relaxationRate`

The local fashion eval now reports `constraint overall@5` and `perfect constraint@5` alongside relevance.

### 3. Keep Hard Constraints Out Of Vector Semantics

The repo's best insight is operationally important:

```txt
hard filters first -> vector ranking inside survivors
```

For Samesake this means price, availability, size, stock, blocked attributes, policy constraints, and strict agent requirements must remain SQL verification gates. Embeddings can rank style, use-case, occasion, and intent residuals.

### 4. Make Operator Semantics Backend-Neutral

Search Expert's operator strings are easy to demo, but Samesake should keep structured operators:

```ts
{ price: { $lte: 100 }, colors: { $nin: ["black"] } }
```

String operators are acceptable at the model boundary only if immediately normalized into typed filters with validation.

### 5. Build Domain Adapters, Not A Generic Parser Myth

Search Expert covers 10 broad verticals, but the value comes from bounded schemas. Samesake should go the other direction: own fashion and commerce deeply first.

Better:

- fashion parser schema
- grocery parser schema
- travel parser schema later

Worse:

- one universal query parser with vague fields and weak constraints

## What Samesake Should Not Copy

- Do not add a Python model runtime to Samesake's TypeScript server.
- Do not make ChromaDB part of the architecture; Postgres/pgvector already owns storage, filters, and hybrid retrieval.
- Do not ship a bundled model. Keep BYO `generate`, then optionally document how to fine-tune a small parser model later.
- Do not claim model reproducibility from Search Expert. The full training data/script is not public in the cloned repo.
- Do not optimize for parser leaderboard metrics before result-level commerce metrics.

## Recommended Samesake Direction

Pick this direction:

> Samesake should become the TypeScript commerce retrieval framework where natural language, image intent, and merchant constraints compile into auditable SQL filters plus vector ranking, and every claim is backed by constraint-satisfaction evals.

Concrete next slices:

1. Done: add a `constraintTrace` object to `search`, `searchExplain`, `fashionSearch`, and `findProducts`.
2. Done: normalize filter/NLQ output into a typed constraint plan before compiling SQL.
3. Done: expand `examples/fashion-search/eval.ts` into a real corpus runner with top-k hard-constraint metrics.
4. Done: document why Samesake measures constraint satisfaction separately from relevance in the fashion-search how-to.
5. Add synthetic commerce-query generation later, but only after the evaluator is stable.

## Flip Conditions

Revisit this direction if:

- A hosted LLM with structured output gets cheap and fast enough to make local small-model parsing irrelevant for Samesake customers.
- Merchants report that the main failure mode is not hard constraints but semantic ranking quality after constraints are already correct.
- The framework expands beyond commerce into domains where SQL filters are less central than graph traversal or long-context reasoning.

## Decision

Do not integrate Search Expert. Learn from it.

The durable lesson is that the search framework should be judged by whether it obeys the user's explicit constraints in the returned results. That is more important for commerce than another generic vector-search abstraction.
