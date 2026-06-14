# Typed embedding spaces

Spaces let a collection declare **typed sub-embeddings** concatenated into one `space_vec` column. Query-time `weights` scale segments of the query vector — one ANN pass computes weighted multi-aspect similarity. No reindex to re-tune segment emphasis.

**Default: OFF.** Spaces capability ships but failed its quality gate on the fashion corpus. See [`spaces-gate.md`](./spaces-gate.md) for measured numbers and when to enable.

## The math

Each space produces an L2-normalized segment. Document vector:

```
D = concat(d₁/√n, …, dₙ/√n)
```

where `n` = number of spaces (so |D| ≈ 1 when all segments are present). Query vector:

```
Q = concat(w₁·q₁, …, wₙ·qₙ)   then L2-normalize Q
```

Then `cos(D, Q) ∝ Σᵢ wᵢ·cos(dᵢ, qᵢ)` — weighted sum of per-space similarities. A missing/null segment contributes a zero vector for that slot.

Implementation: `packages/server/src/core/spaces.ts` (`assembleDocVector`, `assembleQueryVector`, `weightedSegmentCosines`).

## Encodings

| Factory | Index time | Query time |
|---------|------------|------------|
| `s.text` | Consumer `embed` on `source`, L2-normed | Same embed on query text (reuses doc embedding vector when `source` matches the collection's primary embedding) |
| `s.image` | Image bytes via `embed` with `image` input | Text encoder on query (cross-modal) |
| `s.number` | Value → [0,1] via min/max (+ optional log scale) → triangular ramp over `dims` buckets, L2-normed | `mode: "closer"` encodes filter target; `"max"` / `"min"` encode extremes |
| `s.recency` | `exp(-ln2·age/halfLife)` from `ingested_at`, ramp-encoded | Encodes 1.0 ("now") |
| `s.categorical` | One-hot when \|values\| ≤ dims, else FNV-1a hash buckets | Parsed/filter category or zero-vector |

Σ segment dims must be ≤ **2,000** (pgvector HNSW limit for `vector`). Exceeding it fails at `collection()` validation with an error naming the limit.

## SDK example

```ts
import { collection, f, Channels, s } from "@samesake/core";

export const products = collection("products", {
  fields: {
    title: f.text({ searchable: true }),
    price: f.number({ filterable: true }),
    category: f.text({ filterable: true }),
  },
  spaces: {
    style: s.text({ source: "$title", model: "gemini-embedding-2", dim: 768 }),
    price: s.number({ field: "price", mode: "closer", dims: 8, min: 0, max: 50000, scale: "log" }),
    freshness: s.recency({ field: "ingested_at", halfLifeDays: 60, dims: 8 }),
    category: s.categorical({ field: "category", values: ["shoes", "apparel"], dims: 32 }),
  },
  search: {
    channels: [
      Channels.fts({ fields: ["title"], weight: 1 }),
      Channels.spaces({ weight: 1 }), // add only after your own eval gate
    ],
    combiner: "rrf",
    defaultSpaceWeights: { style: 1, freshness: 0.3, price: 0.2, category: 0.5 },
  },
});
```

## Query-time weights

Pass `weights.spaces` on search (HTTP `weights` JSON param or `matcher.search(..., { weights: { spaces: { style: 2, freshness: 0 } } })`). Only the query vector changes — no schema or index work.

Runnable demo (stub embed, no LLM): [`examples/hello-spaces/run.ts`](../examples/hello-spaces/run.ts) — flipping `style` vs `price` weight reorders results.

## Weight tuning guide

1. **Start with spaces OFF** — hybrid FTS + cosine is validated ([`QUALITY.md`](./QUALITY.md), [`examples/fashion-search/PARITY.md`](../examples/fashion-search/PARITY.md)).
2. **Enable the spaces leg only after a harness run** on your corpus. The fashion gate required mean@10 ≥ 2.30 and P@5 ≥ 0.82; flat default weights did not pass ([`spaces-gate.md`](./spaces-gate.md)).
3. **Zero structural segments** unless the query references them (price, category, freshness). NLQ already parses category/price intent — wire that to `weights.spaces`, not flat 1.0 everywhere.
4. **Do not double-count text** — if `s.text` shares the doc embedding source, prefer spaces *or* the legacy cosine leg, not both at full weight.
5. **Sweep on a golden set** — use `samesake eval` for retrieval smoke, then your consumer harness with an LLM judge for graded metrics. Keep the judged dataset and scoring notes beside your app, and compare against the methodology in [`QUALITY.md`](./QUALITY.md).

## Explain

`POST /v1/projects/:p/collections/:c/search/explain` returns per-channel ranks and per-space cosine contributions (`weightedSegmentCosines` in the search explain path).
