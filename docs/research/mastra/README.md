# Mastra RAG: Rerank & Retrieval — How It Works (API + Internals)

Research wiki for the samesake project. Covers how Mastra (`mastra-ai/mastra`, package `@mastra/rag`)
implements RAG reranking and retrieval at the API level and in source, then maps each mechanism to
samesake's design and the pipeline-integrity RFC (G4/G5/G7 + eval).

**Sources**
- Docs: <https://mastra.ai/reference/rag/rerank>, <https://mastra.ai/reference/rag/rerankWithScorer>,
  <https://mastra.ai/docs/rag/retrieval>, <https://mastra.ai/reference/rag/graph-rag>
- Internals (deepwiki on `mastra-ai/mastra`) — file paths quoted inline below
- context7 `/mastra-ai/mastra` — current API signatures
- Caveat: deepwiki returned `packages/rag/src/...` paths but elided some exact line numbers (shown as
  "elided" below). The formula, defaults, and provider wiring are corroborated across docs + context7 + deepwiki.

---

## Rerank (API + internals + scoring formula)

### API surface

Two entry points, both in `packages/rag/src/rerank/index.ts`:

```ts
// Convenience wrapper: picks a scorer from the model id.
function rerank(
  results: QueryResult[],
  query: string,
  modelConfig: MastraLanguageModel,   // any Vercel AI SDK LanguageModel
  options?: RerankerFunctionOptions,
): Promise<RerankResult[]>

// Explicit: you pass the scorer instance.
function rerankWithScorer(args: {
  results: QueryResult[],
  query: string,
  scorer: RelevanceScoreProvider,
  options?: RerankerFunctionOptions,
}): Promise<RerankResult[]>
```

`RerankerFunctionOptions`:
- `weights?: { semantic: number; vector: number; position: number }` — defaults `0.4 / 0.4 / 0.2`
  (`DEFAULT_WEIGHTS`). The three must sum to 1.
- `topK?: number` — number of results to return.
- `queryEmbedding?: number[]` — optional; enables the query-analysis score adjustment (below).

`RerankResult` shape (per result):
```ts
{
  result: QueryResult,
  score: number,                 // combined, 0-1
  details: {
    semantic: number,            // 0-1
    vector: number,              // original vector store score
    position: number,            // 0-1
    queryAnalysis?: { magnitude: number; dominantFeatures: number[] },
  },
}
```

`rerank()` chooses the scorer by `modelConfig.modelId`:
- `'rerank-v3.5'` → `CohereRelevanceScorer`
- otherwise → `MastraAgentRelevanceScorer` (LLM-as-judge using the given model)

### Scoring formula (the core: `executeRerank()` in `packages/rag/src/rerank/index.ts`)

```
finalScore = weights.semantic * semanticScore
           + weights.vector   * vectorScore
           + weights.position * positionScore
```

Component definitions:
- **semanticScore** — from the `RelevanceScoreProvider` (`scorer.getRelevanceScore(query, text)`),
  in [0,1]. **Only computed if `result.metadata.text` exists**; otherwise it is `0`:
  ```ts
  let semanticScore = 0;
  if (result?.metadata?.text) {
    semanticScore = await scorer.getRelevanceScore(query, result.metadata.text);
  }
  ```
- **vectorScore** — taken directly from `result.score` (the vector store's original similarity).
  **Not clamped or min-max normalized** in the rerank code; relies on the store returning ~[0,1] cosine.
- **positionScore** — `calculatePositionScore`: `1 - position / totalChunks`
  (top of the original list scores ~1, bottom ~0).

**Optional query-analysis adjustment** (`adjustScores` / `analyzeQueryEmbedding`, only when
`options.queryEmbedding` is provided): `finalScore` is *multiplied* by:
- `magnitudeAdjustment = 1.1` if query-embedding L2 norm > 10,
- `featureStrengthAdjustment = 1.05` if norm > 5,
where `dominantFeatures` = indices of the 5 embedding dims with largest absolute value.
This is a heuristic embedding-magnitude nudge, not a learned re-weighting.

### Reranker backends (RelevanceScoreProvider implementations)

| Provider | Class | How invoked | Notes |
|---|---|---|---|
| LLM / agent | `MastraAgentRelevanceScorer` | default in `rerank()` when modelId ≠ `rerank-v3.5` | wraps an internal `Agent`; prompt below |
| Cohere | `CohereRelevanceScorer('rerank-v3.5')` | `rerank()` auto-selects on modelId, or pass to `rerankWithScorer` | native cross-encoder rerank API |
| VoyageAI | `VoyageRelevanceScorer` (`@mastra/voyageai`) | pass `reranker: { model: voyage.reranker }` to `createVectorQueryTool`, or to `rerankWithScorer` | not auto-selected by `rerank()` |
| ZeroEntropy | `ZeroEntropyRelevanceScorer('zerank-1')` | pass to `rerankWithScorer` | documented in retrieval.mdx |

**MastraAgentRelevanceScorer prompt** (verbatim instructions, expects a bare float 0-1):
> You are a specialized agent for evaluating the relevance of text to queries. Your task is to rate
> how well a text passage answers a given query. Output only a number between 0 and 1, where 1.0 =
> Perfectly relevant, directly answers the query; 0.0 = Completely irrelevant. Consider: direct
> relevance, completeness, quality/specificity. Always return just the number, no explanation.

The agent is called once per candidate with `(query, text)`; output parsed as float.

### What text the reranker sees

Every backend reads **`result.metadata.text`** — the chunk text the embedding was produced from.
There is **no purpose-built rerank representation**; it reuses the stored chunk text. (Directly relevant
to samesake G5 below.)

---

## Retrieval (vector query, hybrid, metadata filters, graph RAG)

### `createVectorQueryTool` (`@mastra/rag`)

The primary agent-facing retrieval tool. Runs a vector query, then optionally reranks.

```ts
createVectorQueryTool({
  vectorStore / vectorStoreName: ...,
  indexName: string,
  model: <embedding model>,
  reranker?: { model, options?: { topK, weights } },   // optional
  databaseConfig?: { pinecone?: { sparseVector }, ... },// store-specific hybrid config
})
```

- **topK default = 10** (`createVectorQueryTool`). Overridable at creation or at runtime via
  `requestContext` / `inputData`.
- **Execution order** (tool `execute`): `vectorQuerySearch()` → if `reranker` configured, pass results
  to `rerank()`/`rerankWithScorer()` → map to `relevantContext` + `sources`. Rerank is strictly a
  post-query refinement on the topK already returned by the store.

### Hybrid (dense + sparse)

- "Hybrid search" in Mastra = the **vector store** combining dense + sparse vectors at query time
  (e.g. Pinecone `sparseVector`, Upstash `sparseVector` + `fusionAlgorithm`), passed through
  `databaseConfig` → `vectorQuerySearch` → store `query()`. Mastra does **not** implement the fusion;
  it delegates to the store.
- **No Reciprocal Rank Fusion anywhere in Mastra's retrieval/rerank code.** Score combination is the
  weighted rerank formula above, not RRF. (A separate `workspace/search` feature does BM25+vector with
  a `vectorWeight` knob, but that is unrelated to `createVectorQueryTool`.)

### Metadata filtering

MongoDB/Sift-style operators (called "hybrid vector search" in docs — vector similarity + metadata
predicate, store-side):
- equality `{ source: 'a.txt' }`
- comparison `{ price: { $gt: 100 } }`
- arrays `{ tags: { $in: ['sale','new'] } }`
- logical `{ $or: [...] }`, `{ $and: [...] }`

### Graph RAG (`GraphRAG` class; `createGraphRAGTool`)

Builds a kNN-style semantic graph over chunks, then random-walk-with-restart traversal at query time.
- Constructor: `dimension` (default 1536), `threshold` (edge similarity cutoff, default 0.7).
- `createGraph(chunks, embeddings)` — edges where pairwise similarity > `threshold`.
- `query({ query: embedding, topK=10, randomWalkSteps=100, restartProb=0.15 })` — combines direct
  vector similarity with graph traversal to surface indirectly-related chunks; returns ranked nodes
  (id, content, metadata, combined score).
- Purpose: multi-hop / "related context" retrieval for document corpora. Doc-RAG-shaped.

### Query rewriting / extension

Not part of the retrieval/rerank code. No query expansion or rewriting in `@mastra/rag` retrieval.

---

## Pipeline shape

Mastra's RAG composition (doc-RAG lifecycle):

```
document → chunk (MDocument.chunk) → embed → store (vector DB index)
        → query (createVectorQueryTool: vector search + metadata filter [+ store-side dense/sparse])
        → rerank (optional, post-topK: semantic·0.4 + vector·0.4 + position·0.2)
        → relevantContext → agent/LLM answer
```

Key properties:
- Rerank is **opt-in** (only if `reranker` configured) and operates on the **already-truncated topK**.
- The reranker text source is the **stored chunk text** (`metadata.text`) — no second representation.
- Fusion of multiple retrieval channels is **delegated to the vector store**, not done by Mastra; the
  only Mastra-level multi-signal combination is the 3-term weighted rerank.
- GraphRAG is an alternative retrieval path, not layered on top of vector query.

---

## Learnings for samesake (mapped to RFC G4/G5/G7 + eval)

samesake = TS visual+intent fashion product search; Postgres+pgvector; ingest → enrich(LLM vision) →
compose `embed_doc` → index (doc cosine + visual/price/category/recency spaces + FTS) → search
(**RRF** over FTS+cosine+spaces+recency + optional BYO cross-encoder rerank, off by default + NLQ).
RFC `rfcs/rfc-pipeline-integrity-seams.md`: G4 default reranker in fashion template, G5 purpose-built
`rerank_doc`, G7 normalized/multiplicative business boosts, + LLM-as-judge eval harness.

### G4 — default reranker in the fashion template

- **Validates the RFC's direction.** Mastra ships exactly the pattern G4 wants: a default LLM-judge
  reranker (`MastraAgentRelevanceScorer`) built from a model the consumer already has, plus a clean
  `RelevanceScoreProvider` abstraction with named backends (Cohere/Voyage/ZeroEntropy). RFC Q1's
  "default to `fashionRerank({ mode: 'llm' })`" mirrors Mastra's default-to-agent-scorer choice.
- **Concrete pattern to borrow: the `RelevanceScoreProvider` interface** — a one-method
  `getRelevanceScore(query, text) → number[0,1]` contract with provider impls (Cohere/Voyage/LLM).
  samesake's `RerankFn` (`packages/server/src/types.ts:96-110`) is a batch reranker; adopting Mastra's
  per-candidate scorer interface would make BYO cross-encoders (Cohere/Voyage) drop-in and give the
  template a default that is one provider switch away from a hosted reranker. This satisfies REQ-21
  (provider-agnostic, BYO default) cleanly.
- **Borrow the LLM-judge prompt shape** for `fashionRerank({mode:'llm'})`: "output only a number
  0-1, no explanation," parsed as float. Cheap, deterministic to parse, one call per candidate.
  Caveat: per-candidate LLM calls scale with `RERANK_POOL=50` — samesake should batch or cap, which
  Mastra does not (it scores serially). This is a place samesake can do better than Mastra.

### G5 — purpose-built `rerank_doc`

- **Mastra is the cautionary case, not the model.** Mastra has **no rerank-specific text** — the
  scorer reads the same `metadata.text` the embedding used. That is precisely the gap G5 identifies in
  samesake (`search.ts:826-831` scrapes title/name/description ad-hoc). Mastra **does not transfer** a
  solution here; it shares samesake's defect.
- **Takeaway:** samesake's planned `composeFashionRerankDoc` (verbose, attribute-dense, includes
  `raw_color`/`styles`) is an improvement *over* Mastra, not a copy of it. One structural lesson worth
  keeping: Mastra's scorer reads a single named field (`metadata.text`), so the contract is "reranker
  reads field X." samesake should keep the same discipline — `rerank_doc` as a first-class named field
  the rerank step reads (REQ-13), with an explicit fallback, rather than ad-hoc scraping.

### G7 — normalized / multiplicative business boosts

- **Partial validation + a warning.** Mastra's rerank combines on **un-normalized** scores:
  `vectorScore` is fed in raw (no clamp/min-max), and the query-analysis adjustment is **multiplicative
  (×1.1, ×1.05)** on top of a weighted sum. This is exactly the scale-mixing hazard G7 calls out in
  `fashion-search.ts:rankHits` (raw RRF ~0.0-0.05 vs `score -= 2`). Mastra's design shows the failure
  mode at small scale — its position term (0-1) and vector term (often 0-1 cosine) are roughly
  commensurable *only by luck of cosine range*, and it explicitly bets on that.
- **Borrow: the multiplicative-adjustment idea, but with normalization first.** RFC REQ-20 (normalize
  relevance, then apply boosts on the same scale) is the right call and is *stronger* than Mastra.
  The pattern to lift is "compute a base relevance, then apply bounded multiplicative adjustment
  factors" (Mastra's `magnitudeAdjustment`/`featureStrengthAdjustment` are clamped constants) — but
  samesake must min-max/rank-normalize the RRF base first (which Mastra skips). So: borrow the
  *multiplicative boost shape*, reject the *no-normalization*.

### Eval harness (LLM-as-judge)

- `MastraAgentRelevanceScorer` is itself a reusable **LLM-as-judge primitive**: model + fixed
  "score 0-1" instructions + float parse. samesake's planned eval harness can reuse this exact shape
  for offline relevance grading of search results (query, candidate → 0-1), independent of whether the
  same judge is used at serve time. This is a direct, low-cost borrow.

### Honest non-transfers (Mastra is doc-RAG-shaped)

- **RRF:** Mastra has none; samesake's RRF over 4 channels (FTS/cosine/spaces/recency) is already more
  sophisticated than Mastra's single weighted rerank. No lesson to import here.
- **Multi-channel fusion:** Mastra delegates dense+sparse fusion to the vector store and never fuses
  channels itself. samesake fuses in-engine (Postgres). Mastra's hybrid story does not map.
- **Chunking / GraphRAG / query expansion:** document-corpus concepts; products are atomic rows, not
  chunked documents. RFC non-goals already exclude these — Mastra confirms they are doc-RAG-specific.
- **topK=10 default + rerank-on-topK:** Mastra reranks only the 10 it retrieved; samesake's
  `RERANK_POOL=50` over a fused candidate set is the better choice for recall before rerank. Keep it.

### Summary table

| RFC item | Mastra signal | Action for samesake |
|---|---|---|
| G4 default reranker | Has it (agent scorer default) + clean provider abstraction | Borrow `RelevanceScoreProvider` interface + LLM-judge default; batch/cap calls |
| G5 rerank_doc | Has NONE (reuses embed text) — shares the defect | Keep planned `rerank_doc`; named-field contract |
| G7 boosts | Un-normalized weighted sum + multiplicative nudge | Borrow multiplicative shape; **add** normalization (REQ-20) |
| Eval | Agent scorer = ready-made LLM judge | Reuse "score 0-1" judge for offline eval |
| RRF / fusion | Absent / store-delegated | No transfer; samesake's RRF is ahead |
