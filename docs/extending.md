# Extending samesake — usage blueprint & extension seams

How the framework hangs together, where the seams are, and the house rules for adding features. Companion to [`spaces.md`](./spaces.md), [`production.md`](./production.md), and the design history in `CHANGELOG.md`.

## 1. Usage blueprint (the 6 moves every consumer makes)

```ts
// 1. Describe the catalog — the ONLY domain-specific file
const products = collection("products", {
  fields: { title: f.text({ searchable: true }), price: f.number({ filterable: true, budget: true }), ... },
  enrich: pipeline(stage("classify", {...}), stage("extract", { condition: ctx => ..., ... })),
  embeddings: { doc: { source: "$title. $enriched.search_document", model: "...", dim: 1536 } },
  spaces: { ... },                          // optional; see spaces.md before enabling the leg
  search: { channels: [Channels.fts({...}), Channels.cosine({...})], combiner: "rrf", nlq: {...} },
});

// 2. Construct — BYO models as plain functions
const m = createMatcher({ databaseUrl, embed, generate, policy?, logger?, jobs? });

// 3. Apply — generates/diffs the Postgres schema (returns a MigrationPlan; destructive ops refuse)
await m.apply("shop", { entities: [], collections: [products] });

// 4. Feed it
await m.ingest("shop", "products", { connectors: [shopifyFeedConnector({...})] }); // or m.pushDocuments
await m.enrich("shop", "products", { concurrency: 8 });   // resumable, per-stage cached
await m.index("shop", "products");                        // composed docs + vectors + filter columns

// 5. Serve it — any of three surfaces
await m.search("shop", "products", { q, filters?, weights?, facets? });  // in-process
export default { fetch: m.fetch };                                       // Worker/Bun/Node/Deno
app.route("/search", m.app);                                             // compose into Hono

// 6. Watch it
m.metrics(); POST .../search/explain; m.reviewList/reviewCorrect; samesake dev (watch-mode)
```

Key behaviors to remember: NLQ turns explicit constraints into SQL filters (embeddings provably ignore "under 5000"); soft filters relax when over-constrained; NLQ parses and query results are cached; enrichment never re-pays for unchanged inputs (content hashes everywhere).

## 2. The extension seams (where new features plug in)

| You want to add… | Touch these (and ONLY these) | The pattern to copy |
|---|---|---|
| **A new source connector** (e.g. Magento, BigCommerce) | `packages/server/src/connectors/<name>.ts` + export in `connectors/index.ts` | `shopify.ts`: implement `PullConnector { name, pull(): AsyncIterable<{id, data}> }`; normalize to the flat doc shape; content-hash fields. Test against a trimmed REAL feed fixture (see `test/fixtures/`) |
| **A new space type** (e.g. `s.geo`) | `packages/sdk` (factory + type), `packages/server/src/core/spaces.ts` (pure encoder), `embed-index.ts` (segment build), `search.ts` (query-side encoding) | `encodeNumber`/`encodeRecency`: pure function → L2-normed segment; obey the normalization law (see `spaces.md` math); query side must produce the same-dim segment. Numeric tests proving the law are MANDATORY |
| **A new search channel** | sdk `Channels.*` + `core/search.ts` (a ranked CTE leg fused via RRF) | The spaces leg: same `compiled.where` filter push, LIMIT 150, rank capture for `explain` |
| **A new field type** | sdk `f.*` + `collections-schema-gen.ts` (column type) + `core/search.ts` filter compiler (operators) + `collections-migrate.ts` (differ awareness) | `f.number`: typed column, validated operators, params ALWAYS bound, idents through `sanitiseIdent` (reject-on-invalid) |
| **A new enrichment capability** | `core/enrich-pipeline.ts` only if mechanics change; otherwise it's just a new `stage()` in consumer config | Stages are consumer-land. Framework changes only for cross-cutting mechanics (caching, policy, few-shot) |
| **A new NLQ behavior** (e.g. date ranges) | `core/nlq.ts` (`deriveNlqSchema` + `nlqParsedToFilters`) | Budget hints: derive schema property from field config → map parsed output to the SAME filter compiler (never a second SQL path) → degrade-safe |
| **A new BYO model slot** | `packages/server/src/types.ts` + `createMatcher.ts` | `generate`: optional fn + lazy error NAMING the slot with a copy-paste example in the message |
| **A new job backend** | new `packages/jobs-<name>/` (deps isolated there) | `jobs-pgboss`: implement `JobRunner.run(name, payload, fn)` — one method, resolves on completion |
| **A new route** | `app-builder.ts` | `requireApiKey(c)` first line; project-scoped routes accept project keys; parse with zod schemas; 4xx for input errors (never 500 — see `search-validation.test.ts`) |
| **A new vertical** (groceries, electronics…) | consumer config only — zero framework changes | `examples/fashion-search/fashion.ts`: taxonomy, enums, stage schemas, NLQ instructions. If the framework needs a change to support your vertical, THAT change is the feature |

## 3. House rules (non-negotiable, learned the hard way)

1. **Eval-gate retrieval changes.** Anything touching ranking/retrieval quality runs the golden-query harness before it ships (`evals/golden-queries-fashion-lk.json` + your judged harness; the bge-reranker and flat-weight spaces both *failed* their gates and shipped as decision artifacts instead — `history/` has both). New idea → ≤200-call spike → decision artifact → only then framework code. See `docs/spaces-gate.md` for the spaces weight-flip example.
2. **Rebuild dists after sdk/server edits** (`bun run build` per package). Tests import source and will pass while examples/CLI run stale dist — this asymmetry has caused two phantom bugs.
3. **SQL discipline**: values are parameters, never interpolated; identifiers go through `sanitiseIdent` (which rejects, not rewrites); two `next()` placeholder calls must interleave with `params.push` (42P18 class bug).
4. **Failure semantics**: per-doc failures log + continue (zero-vector / skip), never kill a batch; input errors are 4xx with structured codes; degrade paths (NLQ) must keep serving.
5. **Caching is a feature contract**: anything that calls a model gets a content-hash cache (embed cache, stage cache, NLQ cache); changing prompts/instructions intentionally invalidates (key includes the hash).
6. **Tests**: every new capability ships with behavior tests (not shape tests) against the real Postgres in a throwaway `t_*` schema dropped in `afterAll`; stub `embed`/`generate` — live models never run in the suite.
7. **The manual release gate** (`release.md`): suite + typecheck + `pack-assert` (includes a real npm-install-from-tarball smoke) + both hello examples + rename/debris greps.
8. **Compile-time safety is part of the API**: config references (channels→embeddings, weights→spaces) must fail at `collection()` typecheck time — extend the const-generic machinery and prove it with `@ts-expect-error` lines in `packages/sdk/test/type-safety.ts`.

## 4. Reference points

- The math behind spaces and why segment normalization matters: `docs/spaces.md`
- Why each retrieval mechanic exists (evidence): `docs/QUALITY.md`, `BENCHMARKS.md`
- What was tried and rejected, with numbers: `docs/spaces-gate.md`, and the aggregator repo's `evals/results/*-DECISION.md`
- The full build/process record: `CHANGELOG.md`
