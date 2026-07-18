# RFC: Multi-aspect retrieval — named per-aspect vectors, query-aware routing, MaxSim evidence leg

**Category:** Architectural Change (eval-gated; successor to the spaces experiment)
**Author:** Claude Fable 5 (session 2026-07-16, article adaptation)
**Date:** 2026-07-16
**Status:** Approved for build (2026-07-18) — full scope, next major version
**Reviewers:** mithushancj
**Related:** ["Multi-Aspect E-Commerce Semantic Engine Using Qdrant Multivectors"](https://pub.towardsai.net/multi-aspect-e-commerce-semantic-engine-using-qdrant-multivectors-e1e7aacaeab3) (Divy Yadav, 2026-07) · V02g spaces gate verdict (removed doc, recoverable: `git show b8a618a:docs/spaces-gate.md`) · `BENCHMARKS.md:62-73` (spaces failed the gate) · `ROADMAP.md:53-55` (SPLADE/ColBERT non-goals) · `packages/server/src/core/spaces.ts` · `packages/server/src/core/search.ts` · GitHub issue #88 (adjacent: trust/explain surface praised) · baseline SHA `02af1f8`

---

## 0. Decision (2026-07-18)

Approved at **full scope** — aspect columns + NLQ routing + the evidence/MaxSim leg together, no
lean phase — shipping as the **next major version** (alpha policy: breaking changes embraced, no
compat layers). The `spaces` subsystem is **deleted in the same release** (REQ-10, C10) once
image-query parity holds: at no point do two vector-composition systems ship together, and there
is no deprecation window.

Spaces' signals migrate to their proper mechanisms rather than being replicated as similarity —
the V02g lesson made permanent:

| Spaces segment | Destination |
|---|---|
| `visual` (image) | the `visual` aspect (also the image-query/`similar`-mode target — Q4 resolved) |
| `price` ramp | NLQ hard filters / budget hints + `RankingPolicy` business axis |
| `freshness` decay | existing `recency` RRF channel + `RankingPolicy` newness axis |
| `category` one-hot | category filter + category-coherence cutoff |

Gate semantics are unchanged (REQ-8): a below-gate result still merges the intent-mode aspect
legs OFF by default — but spaces deletion proceeds regardless, because spaces failed its own gate
and is not the fallback; the `visual` aspect serves image/`similar` queries independent of the
intent gate (REQ-10).

## 1. Problem Statement

A product is several kinds of evidence — what its text says (specs), what it looks like (image),
what its extracted attributes claim (facets) — but samesake retrieves with **one** dense vector per
document: `def.embeddings` is a map, yet only the first key is ever indexed or queried
(`packages/server/src/core/embed-index.ts:293,516`, `search.ts:639`). Compressing distinct signals
into one embedding yields "roughly in the neighborhood of everything, precise about nothing" — the
article's Chelsea-boots failure. Samesake's own evidence:

- The per-type eval shows **style** (2.04 vs spike 2.23) and **local** (1.50 vs 1.68) as the weak
  intent types (`BENCHMARKS.md:34-45`) — exactly the queries where a second signal (visual,
  attribute) should carry weight.
- The V02g spaces experiment — a single concatenated segment vector as a third RRF leg — **failed
  its gate** (mean@10 2.328→2.242) for two diagnosed reasons: flat weights let structural segments
  inject similarity for queries that never referenced them, and the style segment double-counted
  the cosine leg. The gate's own verdict listed the fixes: **query-aware weights** ("described
  params → weights"), **replace not duplicate** the cosine leg, calibrated defaults.

The article's architecture is those fixes, generalized: separate named vector fields per aspect,
query decomposition **before** embedding (route intent to aspects; unreferenced aspects get zero
weight), per-aspect candidate retrieval fused at ranking time, and MaxSim over row-per-evidence
matrices for repeated evidence. This RFC adapts that architecture to samesake's Postgres/pgvector
stack — without importing ColBERT token-level late interaction, which `ROADMAP.md:53-55` names an
explicit non-goal.

Success (all eval-gated, mirroring V02g's criteria so the successor is judged where the
predecessor failed):

- Collections can declare multiple named aspect embeddings; each gets its own column, HNSW index,
  and cosine channel — `Scorers.cosine({ embedding: "visual" })` (already typed,
  `packages/sdk/src/types.ts:257-261`) becomes real.
- NLQ decomposition routes query intent to aspects: an aspect not referenced by the query
  contributes **zero** (the V02g noise fix).
- Repeated evidence (multiple images, per-facet claims) can be indexed as row-per-evidence with a
  MaxSim retrieval leg.
- Gate to ship ON: mean@10 ≥ 2.30, P@5 ≥ 0.82, and **style + local improve** over the no-aspect
  baseline on the standing harness (V02g's exact thresholds).

### 1.1 Non-Goals / Out of Scope

- Non-goal: ColBERT/SPLADE token-level embeddings or any late-interaction over token matrices
  (`ROADMAP.md:53-55`). MaxSim here operates over *evidence rows* (an image, a facet claim), not
  tokens.
- Non-goal: migrating off Postgres/pgvector or adding Qdrant. The article's Qdrant mechanics map
  onto pgvector (§2 mapping table); the architecture is the import, not the database.
- Non-goal: user-profile personalization (article's reranking layer). `RankingPolicy`
  (`types.ts:341-364`) already provides multiplicative/additive post-fusion boosts; profile
  plumbing is a separate product decision.
- Non-goal: review ingestion/moderation pipeline. The MaxSim leg is built generic
  (row-per-evidence); *review* documents as an evidence source land whenever a reviews data model
  exists (none today — the current "review" module is enrichment QA, `review.ts`).
- Deferred: query-image → aspect routing refinements (image queries already force `similar` mode;
  interaction with decomposition kept minimal in v1).
- In scope (decided 2026-07-18, §0): deleting the `spaces` subsystem in this same release —
  REQ-10, C10. No deprecation window; the major ships exactly one vector-composition system.

## 2. Background

**What the article builds** (all claims verified against the article + its diagrams, 2026-07-16):
one Qdrant point per product with three named multivector fields — SigLIP visual `[1,768]`,
ColBERT token matrix `[~28,96]` (HNSW disabled; reranker only), BGE per-review-finding `[N,384]` —
all MAX_SIM comparators; keyword-based query decomposition into per-aspect sub-queries; text+review
prefetch (candidate retrieval) with visual final scoring; payload pre-filter indexes; multiplicative
personalization rerank; `update_vectors` append without rebuild. Benchmarks are 4 fixture products
— the architecture is the transferable part, not the numbers.

**Mapping onto samesake:**

| Article (Qdrant) | Samesake today | This RFC |
|---|---|---|
| Named vector fields per point | `def.embeddings` map, first key only | Per-aspect `emb_<name>` columns + HNSW each |
| MAX_SIM over `[N,d]` matrix | — | Child table row-per-evidence + `max()` ANN leg |
| Query decomposition → sub-queries | NLQ parses filters/intent (`nlq.ts`), single semantic text | NLQ additionally emits per-aspect sub-queries + aspect relevance |
| Prefetch union → final scoring | RRF over 4 legs (`search.ts:434-449`) | Same RRF; aspects are additional legs with query-aware weights |
| Payload indexes, filter-before-score | Filters compiled into every leg (`buildFilterSql`) | Unchanged (already ahead) |
| `update_vectors` no-rebuild appends | Upsert re-embeds changed docs | Unchanged; evidence rows insert/delete independently |
| Personalization multiplicative boost | `RankingPolicy` hard/soft axes | Unchanged (already exists) |
| Per-aspect score explanation | Explain has per-leg ranks + `space_cosines` | Per-aspect ranks/cosines in explain |

**Why spaces failed and why this differs.** Spaces packs all segments into ONE `space_vec` column
and ONE HNSW index (`assembleDocVector`, `spaces.ts:123`): retrieval geometry is fixed at index
time, weights apply only at query-vector assembly (`assembleQueryVector`, `spaces.ts:144`) — so a
"price segment" perturbs every query's neighborhood even at low weight, and per-aspect candidate
sets cannot differ. Separate columns + separate legs give each aspect its own candidate set (the
article's prefetch insight), and a zero weight cleanly removes an aspect's leg from the SQL
(`hasCos`-style gating already exists per leg, `search.ts:294-297`).

**What already exists to reuse:** typed `CosineChannel<E>` with embedding name; multi-embedding
config type (`CollectionEmbeddingDef` map); leg gating + RRF fusion + `FULL OUTER JOIN` assembly;
NLQ LLM pass (adding decomposition costs prompt tokens, not a new call); eval channel attribution
(`run.ts:93-116`) which will attribute wins per aspect leg out of the box.

### 2.1 Terminology

- **Aspect:** a named retrieval signal with its own embedding space (e.g. `doc`, `visual`,
  `facets`). Declared as a key of `def.embeddings`.
- **Evidence row:** one embeddable unit of repeated evidence for a doc under an aspect (one image,
  one facet claim). Lives in the aspect-evidence table, not on the doc row.
- **MaxSim leg:** retrieval leg scoring a doc by the maximum cosine over its evidence rows for an
  aspect (`[N,d]` matrix × query vector → max), the article's MAX_SIM with N evidence rows.
- **Aspect routing:** NLQ decomposition assigning the query (or a sub-query) to aspects with
  weights; unrouted aspects weigh zero.

### 2.2 Alternatives Considered

- **Alt A — fix spaces in place (query-aware weights on the concatenated vector):** V02g's own
  option 1. Rejected: shared-index geometry still couples aspects at candidate selection; segment
  dims are capped by the single-column HNSW dim limit (the fashion config already had to skip a
  second text space for this, `samesake.config.ts:24-28`); per-aspect candidate sets impossible.
- **Alt B — Qdrant sidecar for multivectors:** native named vectors + MAX_SIM. Rejected: violates
  the one-database thesis (`ROADMAP.md`), adds CDC/consistency machinery the stage-fit audit
  reserves for the >few-million-SKU escape hatch.
- **Alt C — token-level late interaction (ColBERT via pgvector rows):** highest ceiling on text
  precision. Rejected: explicit roadmap non-goal; storage blow-up (~28 rows × docs); the
  evidence-row MaxSim captures the mechanism where it pays (repeated discrete evidence) without
  token matrices.
- **Alt D — LLM query decomposition as a separate call:** cleaner separation. Rejected: NLQ
  already runs an LLM parse per query with caching (`parseNlq`); extending its schema is one
  prompt change, zero added latency/cost.

### 2.3 Drawbacks and Tradeoffs

- Storage/write cost: one halfvec column + HNSW index per aspect, plus the evidence table. At the
  ICP scale (100k–1M) this is measurable (the scale RFC's grid gains an aspects config-point).
- NLQ decomposition adds schema surface to the parse; wrong routing zeroes a leg that would have
  helped. Mitigation: fallback = full query routed to every declared aspect with default weights
  (the article's fallback), decomposition only *narrows* on confident parses.
- Resolved by decision (§0): spaces is deleted in the same major release (C10) — no
  coexistence, no deprecation window, no config-surface ambiguity to document.

## 3. Strict Requirements

- REQ-1: Collections declaring one embedding behave **byte-identically** to SHA `02af1f8` on
  every surface (SQL, DDL, explain, eval `topIds`).
- REQ-2: Every key of `def.embeddings` materializes: column `emb_<name> halfvec(dim)` (first key
  keeps the legacy `embedding` column name for zero-migration), an HNSW index, and index-time
  population from its declared `source`/surface. Dims validated per key (existing
  `vector-dim.ts` ceiling applies per column).
- REQ-3: `Scorers.cosine({ embedding: <name> })` creates one retrieval leg per named aspect;
  each leg gates on `weight > 0 AND queryVector != null` exactly like today's `sem` leg; RRF
  fusion and `CANDIDATES=150` per leg unchanged.
- REQ-4: A declared aspect may set `evidence: true`: index-time writes evidence rows to
  `c_<coll>_evidence (doc_id, aspect, ord, vec halfvec, src text)` instead of a doc column; its
  leg scores docs by MaxSim (max cosine over the doc's rows) with candidates from an HNSW scan on
  the evidence table grouped to doc ids.
- REQ-5: NLQ decomposition: the parse result gains optional `aspects: Record<name, { subQuery?:
  string; weight: number }>`. When present and confident, per-aspect query embeddings use the
  sub-query and channel weights multiply by the routed weight; aspects absent from the routing get
  weight 0 for that query. When absent (parse fallback/disabled), every declared aspect leg runs
  with its configured default weight on the full query — never fewer legs than a confident route.
- REQ-6: Multimodal aspects (image-embedding models) embed text sub-queries through the same
  model's text tower (existing Gemini multimodal embedder path used by spaces) — aligned spaces,
  no bridge model (the article's SigLIP property).
- REQ-7: `searchExplain` reports per-aspect rank and cosine per hit (extending
  `ExplainDocBreakdown`), and eval channel attribution names aspect legs individually.
- REQ-8: Ship-ON gate on the standing fashion harness: mean@10 ≥ 2.30, P@5 ≥ 0.82, style and
  local strictly improve vs same-corpus baseline. Below gate: capability ships **off by default**
  with the artifact recorded (the V02g protocol).
- REQ-9: Scope/tenancy, filters, dedup collapse, cutoff, and relevance-floor semantics apply to
  aspect legs identically to existing legs (structural guards, not per-leg opt-ins).
- REQ-10: The `visual` aspect replaces the spaces image path for image/`similar`-mode queries
  (active independent of the C9 intent gate, mirroring today's mode rules), and the existing
  image-query fixtures must hold parity or better BEFORE C10 executes. C10 then deletes the
  spaces subsystem wholesale in the same major release — `spaces.ts`, `space_vec` DDL/index,
  `SpacesChannel` + the `s.*` space builders, spaces weights/plumbing in
  `search.ts`/`search-query.ts`, `space_cosines` explain, the eval `spaces` attribution key, and
  the `hello-spaces` example — sweeping producers, consumers, fixtures, and tests (full-surface
  sweep, not just the runtime path). `space_vec` columns drop via the apply diff (destructive
  migration, documented as the major-version break).

## 4. Interface Specification

### 4.1 Config — aspect embeddings

- **Location:** `packages/sdk/src/types.ts` (`CollectionEmbeddingDef`)
- **Signature:**

```ts
export interface CollectionEmbeddingDef {
  source?: string;            // existing: template over data/enriched
  model?: string;             // existing
  dim: number;                // existing
  /** Aspect kind: how query text is embedded for this aspect. Default "text". */
  kind?: "text" | "image";    // image → multimodal text-tower for text queries (REQ-6)
  /** Row-per-evidence storage + MaxSim leg instead of a single doc vector (REQ-4). */
  evidence?: boolean;
  /** Evidence extractor: doc → embeddable units. Required when evidence:true. */
  extract?: (ctx: DerivedDocContext) => string[];   // or image URLs for kind:"image"
}
```

- **Behavior:** map order defines column order; first key = legacy `embedding` column. Validation:
  `extract` iff `evidence`; per-key dim ceiling.
- **Error cases:** duplicate normalized names; `evidence` on the first (legacy) key rejected in v1
  (keeps the zero-migration guarantee simple).

### 4.2 NLQ decomposition

- **Location:** `packages/server/src/core/nlq.ts` (`parseNlq` result type + prompt/schema)
- **Signature (result extension):**

```ts
aspects?: Record<string, { subQuery?: string; weight: number }>; // keys ⊆ declared aspect names
```

- **Behavior:** prompt lists declared aspects with one-line descriptions (from a new optional
  `describe` field per embedding, else the key name); LLM assigns each aspect a relevance weight
  0–1 and an optional focused sub-query. Cached with the existing NLQ cache (key includes aspect
  descriptions).
- **Error cases:** unknown aspect keys in the parse are dropped; malformed weights clamp to
  [0,1]; empty routing → fallback (REQ-5).

### 4.3 Evidence table + MaxSim leg

- **Location:** `packages/server/src/core/collections-schema-gen.ts` (DDL),
  `search.ts` (leg CTE), `embed-index.ts` (population)
- **Convention (DDL):**

```sql
CREATE TABLE IF NOT EXISTS <schema>.c_<coll>_evidence (
  doc_id text NOT NULL REFERENCES <schema>.c_<coll>(id) ON DELETE CASCADE,
  aspect text NOT NULL,
  ord int NOT NULL,
  vec halfvec(<dim>) NOT NULL,
  src text,
  PRIMARY KEY (doc_id, aspect, ord)
);
CREATE INDEX ... USING hnsw (vec halfvec_cosine_ops);  -- partial per aspect when >1 evidence aspect
```

- **Behavior:** reindex of a doc replaces its evidence rows transactionally (delete+insert);
  scope columns mirrored when the collection is scoped (REQ-9).
- **Error cases:** `extract` returning >64 units per doc is truncated with a pipeline warning
  (unbounded matrices are the article's storage caveat).

### 4.4 Search leg SQL (per-aspect)

- **Location:** `packages/server/src/core/search.ts` (`runHybridQuery`)
- **Signature (internal):** aspect legs are generated from a resolved
  `AspectPlan[] = { name, column | evidenceAspect, queryVector, weight }` computed in `retrieve()`.
- **Behavior:** column aspects emit a `sem`-shaped CTE per aspect; evidence aspects emit the
  MaxSim CTE (§7). All feed `rankLegs` and RRF unchanged.

## 5. Architecture and System Dependencies

### 5.1 Structural Changes
- `packages/sdk/src/types.ts` — §4.1 config; optional `describe` per embedding.
- `packages/server/src/core/collections-schema-gen.ts` — per-aspect columns/indexes + evidence
  table DDL.
- `packages/server/src/core/embed-index.ts` — populate all aspect keys (today: first only) +
  evidence extraction/embedding.
- `packages/server/src/core/nlq.ts` — decomposition schema + prompt.
- `packages/server/src/core/search-query.ts` — per-aspect query embedding + routed weights
  (`parseSearchWeights` gains aspect resolution).
- `packages/server/src/core/search.ts` — aspect leg CTEs, explain extension.
- `packages/server/src/core/eval/run.ts` — attribution keys per aspect (mostly free).
- `examples/fashion-search/` — gate experiment config: `doc` (existing) + `visual`
  (image-embedding aspect over product images) + `facets` (evidence aspect over enrichment
  claims: colors/occasions/styles/pattern/material/fit rendered as short claims).

### 5.2 Service and Library Dependencies
- Embedding providers: existing Gemini multimodal embedder (image + text towers). No new vendors.
- LLM: existing NLQ model; prompt grows by the aspect table.

### 5.3 Data and Schema Changes
- Additive columns + one new table per collection that opts in; single-embedding collections get
  no DDL diff (REQ-1). Backfill = `matcher.embedIndex` re-run over ready rows (existing pipeline
  status machinery); aspects populate incrementally.

### 5.4 Network and Performance Considerations
- Query cost: +1 embed call per routed *distinct* sub-query (aspects sharing the full query share
  one embedding); +1 HNSW scan per active aspect leg. Zero-weight routing keeps the common
  keyword query at today's cost. Latency budget: p95 within +20% of baseline at 5k docs with 2
  extra aspects active (cmd:aspect-latency); scale behavior lands in the scale RFC grid.
- Evidence HNSW indexes N×docs rows — the extractor cap (§4.3) bounds N.

## 6. Pseudocode

```
# retrieve() additions
FUNCTION resolveAspectPlans(def, nlqResult, q, image):
    plans = []
    FOR (name, emb) IN def.embeddings WHERE cosineChannel(name).weight > 0:
        route = nlqResult.aspects?[name]
        weight = route ? channelWeight(name) * route.weight : channelWeight(name)  # REQ-5
        IF route AND route.weight == 0: CONTINUE                                    # zeroed leg
        text = route?.subQuery ?? q
        vec = emb.kind == "image" ? multimodalTextEmbed(text) : textEmbed(text)     # REQ-6
        plans.push({name, weight, vec, evidence: emb.evidence})
    RETURN plans

# runHybridQuery: per plan
IF NOT plan.evidence:
    CTE sem_<name>: SELECT id, row_number() OVER (ORDER BY emb_<name> <=> $vec) rn, cos
                    FROM c_<coll> WHERE <where> LIMIT 150
ELSE:                                                       # MaxSim leg (REQ-4)
    CTE ev_<name>:  SELECT doc_id, max(1 - (vec <=> $vec)) AS maxsim
                    FROM c_<coll>_evidence e
                    WHERE e.aspect = '<name>'
                      AND e.doc_id IN (docs passing <where>)      # via join to base table
                    GROUP BY doc_id
                    ORDER BY maxsim DESC LIMIT 150
    # candidate acquisition: HNSW scan on evidence.vec with over-fetch (150 * capFactor)
    # then group — evidence rows for the same doc collapse to its best row (article's MAX_SIM)
rankLegs.push({cte, weight: plan.weight})                   # RRF fusion unchanged

# index-time (embed-index)
FOR (name, emb) IN def.embeddings:
    IF emb.evidence:
        units = emb.extract(ctx)[:64]
        rows  = embedBatch(units) → (doc_id, name, ord, vec, src)
        REPLACE evidence rows for (doc_id, name)
    ELSE:
        emb_<name> = embed(surfaceFor(name))
```

## 7. Code Blueprint

```ts
// packages/server/src/core/search.ts — evidence (MaxSim) leg CTE
// Over-fetch on the row-level ANN, then collapse to per-doc best (MAX_SIM with N evidence rows).
ctes.push(`ev_${name} AS (
  SELECT e.doc_id AS id,
         row_number() OVER (ORDER BY max(1 - (e.vec <=> ${vecRef}::halfvec)) DESC) AS rn,
         max(1 - (e.vec <=> ${vecRef}::halfvec))::float AS maxsim
  FROM (
    SELECT doc_id, vec FROM ${evidenceTable}
    WHERE aspect = ${aspectRef}
    ORDER BY vec <=> ${vecRef}::halfvec
    LIMIT ${CANDIDATES * 4}
  ) e
  JOIN ${table} d ON d.id = e.doc_id
  WHERE ${where}                       -- filters/scope/visibility on the base row (REQ-9)
  GROUP BY e.doc_id
  ORDER BY maxsim DESC
  LIMIT ${CANDIDATES}
)`);
```

```ts
// packages/server/src/core/nlq.ts — decomposition schema fragment (zod)
aspects: z.record(z.object({
  subQuery: z.string().optional(),
  weight: z.number().min(0).max(1),
})).optional(),
// prompt addition:
// "The collection retrieves along these aspects: doc — full product text; visual — what the
//  product looks like; facets — extracted attribute claims (colors, occasions, fit...).
//  For the query, assign each aspect a relevance weight 0–1 and, when a focused fragment of the
//  query targets it, a subQuery. Omit aspects the query does not touch."
```

Attribution: MAX_SIM-as-group-max and route-before-embed patterns from the referenced article;
prefetch-union analog is the existing RRF FULL OUTER JOIN (`search.ts:439-449`).

## 8. Incremental Task Breakdown

| ID | Chunk | Files | Grounding (REQ/test) | Acceptance criteria |
|----|-------|-------|----------------------|---------------------|
| C1 | Config surface: multi-key embeddings honored types + validation (`kind`, `evidence`, `extract`, `describe`) | `packages/sdk/src/types.ts` | REQ-2, test:aspect-config | Single-key configs parse identically; invalid combos rejected |
| C2 | Schema-gen: `emb_<name>` columns + HNSW per key; evidence table DDL; single-key DDL snapshot-locked | `collections-schema-gen.ts` | REQ-1, REQ-2, REQ-4, test:aspect-ddl | Snapshot: single-key byte-identical; multi-key emits expected DDL |
| C3 | Index-time population: all aspect columns + evidence extraction/embed/replace | `embed-index.ts`, `enrich-pipeline.ts` | REQ-2, REQ-4, test:aspect-index | Fixture doc indexes N aspects + evidence rows; reindex replaces rows |
| C4 | Aspect column legs: per-aspect sem CTEs from AspectPlan; weights via channels | `search.ts`, `search-query.ts` | REQ-3, test:aspect-leg-sql | Two-aspect config emits two gated CTEs; zero weight emits none |
| C5 | MaxSim evidence leg CTE + filters/scope join | `search.ts` | REQ-4, REQ-9, test:maxsim-leg | Doc with 3 evidence rows scores by its best row; scoped query cannot see cross-scope evidence |
| C6 | NLQ decomposition: schema, prompt, cache key, fallback | `nlq.ts` | REQ-5, test:nlq-aspects | Confident parse routes weights; disabled/failed parse → all legs default |
| C7 | Query-side wiring: routed sub-query embeddings, multimodal text tower, weight multiplication | `search-query.ts`, `search.ts` | REQ-5, REQ-6, test:routing | "black floral dress for a beach wedding" routes visual+facets; "nike" keyword routes doc only |
| C8 | Explain + eval attribution per aspect | `search.ts`, `eval/run.ts` | REQ-7, test:explain-aspects | Explain lists per-aspect rank/cosine; eval artifact attributes wins per aspect |
| C9 | Gate experiment: fashion config with `visual` + `facets` aspects; run standing harness vs baseline; record artifact + verdict | `examples/fashion-search/`, `evals/runs/` | REQ-8, cmd:gate | Artifact committed; ON/OFF default decided by V02g thresholds |
| C10 | Supersede spaces: port image-query path to the `visual` aspect (parity on image fixtures), then delete the spaces subsystem, DDL, config surface, examples, and tests | `spaces.ts` (deleted), `search.ts`, `search-query.ts`, `collections-schema-gen.ts`, `embed-index.ts`, `packages/sdk/src/types.ts`, `examples/hello-spaces/` (deleted), `examples/fashion-search/` | REQ-10, test:no-spaces-gate | Image fixtures ≥ parity via visual aspect; grep gate: no `spaces` symbols in `packages/server/src/core`; no-spaces collections' DDL/SQL still byte-identical (REQ-1) |

## 9. Validation and Testing

### 9.0 Validation Contract

| ID | Source | Assertion |
|----|--------|-----------|
| REQ-1..9 | §3 | As stated |
| test:aspect-config / test:aspect-ddl | §9.1 | Config + DDL contracts incl. single-key byte-identity |
| test:aspect-index / test:aspect-leg-sql / test:maxsim-leg | §9.1 | Index + query semantics |
| test:nlq-aspects / test:routing | §9.1 | Decomposition + routing incl. fallback |
| test:explain-aspects | §9.1 | Per-aspect explain/attribution |
| cmd:gate | §9.3 | Standing-harness gate run, artifact recorded |
| cmd:aspect-latency | §9.3 | p95 within +20% of baseline at 5k docs, 2 aspects active |

### 9.1 Fail-to-Pass Tests
As per the contract table — notable semantics:
- `test:maxsim-leg` — a doc whose *second* evidence row is the best match must outrank a doc whose
  single row is mediocre (proves group-max, not first-row).
- `test:routing` — a pure keyword query produces zero extra embed calls (aspect legs zeroed or
  sharing the full-query embedding).

### 9.2 Regression Tests (Pass-to-Pass)
- `bun test packages/server` — incl. the single-embedding SQL/DDL snapshots (REQ-1).
- `bun run bench` — unchanged nDCG@5 for single-embedding configs.
- Existing dedup/scope/cutoff suites — REQ-9 seams.

### 9.3 Validation Commands

```bash
bun test packages/server --filter aspect
bun examples/fashion-search/eval-search.ts --config baseline   # same-corpus baseline artifact
bun examples/fashion-search/eval-search.ts --config aspects    # gate candidate artifact
jq '{mean10:.metrics.meanAt10, p5:.metrics.pAt5, style:.byType.style, local:.byType.local}' evals/runs/*aspects*.json
# latency check (5k corpus, warm)
bun examples/fashion-search/bench-latency.ts --configs baseline,aspects --p 95
```

## 10. Security Considerations

Evidence `src` text is derived from the collection's own data/enrichment (no new external input).
The evidence table mirrors scope columns and every leg joins through the base row's
visibility+scope predicate (REQ-9) — cross-tenant evidence leakage is structurally impossible, and
`test:maxsim-leg` covers the scoped case. NLQ aspect routing output is clamped and
whitelist-filtered to declared aspect names (no LLM-controlled SQL identifiers).

## 11. Rollback and Abort Criteria

- Abort if: C9's gate shows the V02g failure signature again (mean@10 drops with aspects ON,
  style/local flat) despite query-aware routing — the thesis "routing was the missing piece" is
  then falsified; stop, record the artifact, do not iterate weights past two calibration runs
  (sunk-cost guard). The capability still merges OFF-by-default (V02g protocol).
- Abort if: MaxSim leg p95 blows the +20% budget at 5k docs and the over-fetch factor can't be
  tuned within it — re-evaluate evidence candidate acquisition (e.g. per-aspect partial HNSW
  indexes) before shipping the leg.
- Rollback: aspects are opt-in per collection config; removing extra embedding keys restores
  single-vector behavior; evidence table drops with the config (apply diff). REQ-1 guarantees
  non-opted collections never moved.
- Spaces deletion (C10) is not runtime-rollbackable — a deployment that needs `spaces` stays on
  the previous major. That is the major-version contract, chosen deliberately (§0).

## 12. Open Questions

- Q1: Aspect leg fusion — plain RRF legs (rank-based, consistent with everything else) vs the
  article's final-stage scoring (one aspect rescores the union). Tradeoff: consistency +
  simplicity vs a deliberate precision stage. **Proposal:** RRF legs in v1 (the reranker slot
  already provides a second stage); revisit only if C9 shows aspect wins diluted by rank fusion.
- Q2: Facet evidence rendering — embed enrichment claims as short natural phrases ("good for
  beach weddings", "floral pattern") vs key:value strings ("occasions: beach_wedding").
  Tradeoff: embedding-space naturalness vs determinism. **Proposal:** natural phrases via a
  per-collection template (deterministic string build, no LLM at index time).
- Q3 — RESOLVED (2026-07-18, §0): delete `spaces` in this release (REQ-10, C10). The
  number/recency/categorical segments are deliberately NOT replicated as similarity signals —
  that encoding was the diagnosed V02g defect; each migrates to its proper mechanism per the §0
  table.
- Q4 — RESOLVED (2026-07-18, §0): yes — the `visual` aspect is the single visual system and the
  image-query (`similar` mode) target; parity on the existing image-query fixtures is REQ-10's
  precondition for C10.

## 13. Review findings (2026-07-18 validation pass)

All code/doc/line citations were verified against `02af1f8` (first-key-only indexing in
`embed-index.ts`, `search.ts:639`; typed-but-dead `CosineChannel.embedding`; spaces
single-column geometry; V02g gate numbers and verdict; ROADMAP non-goals; `BENCHMARKS.md`
per-type figures) — all accurate. The referenced article was re-read in full: the RFC represents
it honestly (including the 4-fixture-product caveat); note the article's "text vectors are
reranker-only" framing contradicts its own code (they are a prefetch leg), and its benchmark
numbers carry no evidence value — the RFC correctly imports only the architecture. Findings
execution MUST address:

- **F1 — routing is unreachable for short queries (REQ-5 vs C7).** `shouldSkipNlq`
  (`nlq.ts:142-146`) skips the LLM parse for queries ≤2 tokens with no digits. "nike" therefore
  never gets aspect routing, and REQ-5's fallback runs EVERY declared aspect leg at default
  weight — directly contradicting C7's acceptance criterion ("'nike' keyword routes doc only")
  and §5.4's "zero-weight routing keeps the common keyword query at today's cost." Resolve
  explicitly: either (a) skip-NLQ queries route to the `doc` aspect only (cheap static default —
  short keyword queries are exactly where extra aspects add noise, mirroring the existing
  intent-mode rule that zeroes `spaces` for text queries, `search-query.ts:98-108`), or
  (b) per-aspect `defaultWeight` config consulted when no route exists. (a) is recommended and
  makes C7's test pass as written.
- **F2 — MaxSim leg loses filtered recall (§7 blueprint vs REQ-9).** The blueprint CTE applies
  scope/filters by joining the base table AFTER the inner ANN scan's `LIMIT CANDIDATES*4`. Under
  a selective filter (scoped tenant, price band), all 600 over-fetched evidence rows can belong
  to filtered-out docs → the leg starves — the exact HNSW post-filter starvation the doc-column
  legs avoid by putting `WHERE` inside the ANN scan (`search.ts:398-404`) with
  `hnsw.iterative_scan`. Fix: mirror scope columns onto the evidence table (§4.3 already
  requires this) AND push the scope predicate + a join-free visibility condition into the inner
  scan, or join the base table inside the inner scan so iterative scans apply. `test:maxsim-leg`
  must include a selective-filter case, not just the cross-scope case.
- **F3 — aspect legs need mode rules, not just routing.** `parseSearchWeights` zeroes `spaces`
  for text intent queries and `fts` for similar mode (`search-query.ts:95-108`). The RFC never
  states the analogous defaults for aspect legs (is `visual` active on a text-only intent query
  when NLQ routes it? — presumably yes, that is the point — but `similar`-mode and
  image-query interactions are only "deferred"). Specify a mode × aspect default matrix in C7
  or the gate experiment will conflate mode effects with routing effects.
- **F4 — attribution is not "out of the box" (§2).** `attributeWinsToChannels`
  (`eval/run.ts:93-116`) hardcodes the four channel ranks (`fts/cosine/spaces/recency`).
  Per-aspect attribution requires the explain extension (REQ-7) plus this function generalizing
  over dynamic leg names — real work inside C8, not "mostly free."
- **F5 — NLQ cache key must change (§4.2 is right, underline it).** `nlqCacheKey`
  (`nlq.ts:15-21`) hashes instructions+model+collection+query but NOT the schema; adding
  aspects to the derived schema without touching instructions would serve stale parses for up
  to 7 days. §4.2's "key includes aspect descriptions" is therefore load-bearing — implement it
  as part of C6, and include the aspect-description set in the hash.
- **External cross-check.** The design matches the 2024–26 industry pattern independently
  (per-field/per-aspect signals fused by rank, query understanding routing weights before
  retrieval — NYMag/Shaped case study runs the same shape in one SQL query; DoorDash/Instacart
  ground query understanding in the catalog). Two published cautions to carry into C9: (1)
  differentiated per-aspect weights beat equal weights (NYMag ablation), so calibrate defaults
  before the gate run rather than shipping flat 1.0s — this is exactly the V02g failure mode
  resurfacing at the aspect level; (2) free-form MLLM caption prose as evidence text adds
  alignment noise — facet evidence rows should stay short, schema-constrained claims (Q2's
  natural-phrase proposal, bounded).
- **Verdict: SOUND — the strongest of the three RFCs** (correct diagnosis of why spaces failed,
  right architectural fix, honest gating), conditional on F1–F5. Sequencing note: run this
  gate AFTER the lexical A/B fixture exists (BM25 itself was dropped 2026-07-18; the fixture
  survives — `rfc-bm25-lexical-leg.md` §0), so per-leg attribution can separate lexical-leg
  effects from aspect effects on the same harness.
