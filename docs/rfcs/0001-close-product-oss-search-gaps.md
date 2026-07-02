# RFC 0001: Close Product OSS Search Gaps

Status: Draft

Date: 2026-06-19

Owner: Product/Search Framework maintainers

Related documents:

- `docs/product-oss-search-report.md`
- `docs/product-report-code-gap-audit.md`
- `docs/product-report-code-gap-audit-report.md`

## 1. Problem Statement

Samesake has a credible technical foundation for app-owned product discovery, but the repo does not yet meet the product expectation set in `docs/product-oss-search-report.md`.

The expected product category is:

```text
Postgres-native product discovery framework for TypeScript commerce teams who need app-owned AI search with hard filters, hybrid retrieval, and auditable ranking.
```

The current code/docs create a trust gap:

- Public positioning still reads as visual-commerce/fashion-first.
- Fashion APIs/routes leak into core framework surfaces.
- Integration docs reference generic deletion APIs that do not exist.
- Production, multilingual, security, OSS, comparison, and support docs are missing or partial.
- Evaluation primitives exist, but proof is not packaged into a reproducible multi-domain adoption path.
- CLI onboarding is still entity-matching oriented, not product-discovery-template oriented.

This RFC defines a focused productization program. It does not propose a broad refactor. It closes misleading claims first, then packages existing strengths into docs, tests, examples, and small API gaps.

## 2. Background

### Source-of-truth Product Expectations

The product report states that the strongest wedge is "typed, app-owned, Postgres-native product discovery" rather than general search or fashion toolkit: `docs/product-oss-search-report.md:9`.

It requires three proof points:

- Reproducible benchmark against alternatives across at least three commerce domains: `docs/product-oss-search-report.md:45`.
- Public production guide covering reindexing, deletes, migrations, rollback, observability, backups, security, and scale limits: `docs/product-oss-search-report.md:46`.
- Multilingual/global readiness page with tested matrix, provider limitations, and eval results: `docs/product-oss-search-report.md:47`.

The report also calls out missing pages and adoption blockers: `docs/product-oss-search-report.md:55`, `docs/product-oss-search-report.md:114`, `docs/product-oss-search-report.md:222`.

### Current Strengths

The codebase already has strong product-search substrate:

- Hybrid search, hard filters, and RRF in `packages/server/src/core/search.ts:306`.
- Soft-filter relaxation for no-result mitigation in `packages/server/src/core/search.ts:593`.
- Variant diversification and optional rerank seams in `packages/server/src/core/search.ts:800` and `packages/server/src/core/search.ts:816`.
- BYO embed/generate/rerank/ground-image contracts in `packages/server/src/types.ts:43`, `packages/server/src/types.ts:79`, and `packages/server/src/types.ts:89`.
- Search evaluate/calibrate APIs in `packages/server/src/core/calibrate-search.ts:103`.
- HTTP evaluate/calibrate routes in `packages/server/src/app-builder.ts:427`.
- Shopify/Woo/JSONL connectors in `packages/server/src/connectors/index.ts:15`.
- Metrics and health endpoints in `packages/server/src/app-builder.ts:163` and `packages/server/src/app-builder.ts:178`.
- Migration planning/destructive guards in `packages/server/src/core/projects.ts:153` and `packages/server/src/core/projects.ts:167`.

### Current Gaps

Evidence from the audit:

- README opens with "visual commerce, starting with fashion": `README.md:3`.
- Docs homepage says "visual commerce": `apps/docs/src/content/docs/index.mdx:3`.
- What-is page says "starting with fashion": `apps/docs/src/content/docs/start/what-is-samesake.mdx:8`.
- Root SDK exports and defines fashion presets: `packages/sdk/src/index.ts:55`, `packages/sdk/src/index.ts:337`, `packages/sdk/src/index.ts:421`.
- Core `Matcher` exposes `fashionSearch` and `syncFashionCatalogEvent`: `packages/server/src/createMatcher.ts:82`.
- HTTP routes expose `/fashion-search` and `/fashion-sync`: `packages/server/src/app-builder.ts:492`.
- Integration docs call `matcher.removeDocuments(...)`: `apps/docs/src/content/docs/integrations/shopify.mdx:102`, `apps/docs/src/content/docs/integrations/woocommerce.mdx:89`, `apps/docs/src/content/docs/integrations/medusajs.mdx:109`.
- `Matcher` exposes `pushDocuments` but no generic `removeDocuments`: `packages/server/src/createMatcher.ts:86`.
- Only fashion sync has a delete branch: `packages/server/src/core/fashion-search.ts:339`.
- Production link points to absent `docs/production.md`: `deploy/README.md:70`.
- Product search hard-codes English FTS: `packages/server/src/core/collections-schema-gen.ts:88`, `packages/server/src/core/search.ts:313`.
- CLI `init` scaffolds an entity/customer matcher config: `packages/cli/src/index.ts:862`.
- CLI `eval` is retrieval-only and explicitly says no LLM judge: `packages/cli/src/index.ts:779`.
- Root scripts do not expose `test` or `lint`: `package.json:7`.

## 3. Strict Requirements

REQ-1: Public positioning must consistently describe Samesake as a Postgres-native product discovery framework, with fashion presented as one optional template/example.

REQ-2: Public docs must include a Core vs Templates page defining framework core, commerce assumptions, fashion template, and entity matching.

REQ-3: Any public code sample must call real APIs. `matcher.removeDocuments(...)` must either be implemented and tested, or all docs must be corrected to an existing deletion strategy.

REQ-4: A production guide must exist and replace the broken `docs/production.md` reference.

REQ-5: Production docs must cover reindexing, deletes, partial updates, migrations, rollback, observability, backups, security, jobs, and scale limits.

REQ-6: Multilingual product search must be documented honestly, including current English FTS behavior and provider-dependent dense retrieval behavior.

REQ-7: A multilingual regression fixture must exist before any strong multilingual product-search claim is made.

REQ-8: The proof/eval path must support at least three commerce domains: fashion, electronics, and one of furniture or grocery.

REQ-9: Evaluation docs must define reproducibility tiers: no-model smoke, labeled local fixture, live-model run, and optional real-catalog benchmark.

REQ-10: Non-fashion examples must be runnable and documented.

REQ-11: Provider abstraction docs must cover the BYO contracts, at least Gemini, OpenAI-compatible, Voyage/Cohere-style input type caveats, local Ollama, rerank, and image/grounding expectations. A docs matrix may mark recipes as examples, not official endorsements.

REQ-12: Connector docs must distinguish implemented code connectors from integration recipes. Unsupported connectors must be labeled as guides or roadmap, not implemented features.

REQ-13: OSS trust files must be added: `CONTRIBUTING.md`, `SECURITY.md`, `ROADMAP.md`, and issue/release/support policy docs.

REQ-14: Package metadata must be aligned with the product category and package versions/dependencies must be reviewed for drift.

REQ-15: Competitive comparison docs must exist for Why Samesake plus Algolia, Typesense, Meilisearch, Elasticsearch/OpenSearch, and pgvector DIY.

REQ-16: CLI onboarding must eventually support product-discovery templates. Until then, docs must not imply `samesake init` creates product-search projects.

REQ-17: All new examples/docs must be validated by commands listed in this RFC before release.

REQ-18: No docs may claim production-readiness, multilingual-readiness, or connector coverage beyond code/tests/examples that exist in the repo.

## 4. Interface Specification

### Documentation Interfaces

Create or update the following docs pages:

- `apps/docs/src/content/docs/index.mdx`
- `apps/docs/src/content/docs/start/what-is-samesake.mdx`
- `apps/docs/src/content/docs/start/quickstart.mdx`
- `apps/docs/src/content/docs/concepts/core-vs-templates.mdx`
- `apps/docs/src/content/docs/concepts/known-limitations.mdx`
- `apps/docs/src/content/docs/concepts/why-samesake.mdx`
- `apps/docs/src/content/docs/guides/production.mdx`
- `docs/production.md` as a stable link target or redirecting overview
- `apps/docs/src/content/docs/guides/multilingual-search.mdx`
- `apps/docs/src/content/docs/guides/provider-recipes.mdx`
- `apps/docs/src/content/docs/guides/evaluation-proof.mdx`
- `apps/docs/src/content/docs/integrations/jsonl-csv.mdx`
- `apps/docs/src/content/docs/integrations/google-merchant-center.mdx`
- `apps/docs/src/content/docs/comparisons/algolia.mdx`
- `apps/docs/src/content/docs/comparisons/typesense.mdx`
- `apps/docs/src/content/docs/comparisons/meilisearch.mdx`
- `apps/docs/src/content/docs/comparisons/elasticsearch-opensearch.mdx`
- `apps/docs/src/content/docs/comparisons/pgvector-diy.mdx`

### API Interfaces

Preferred small API addition:

```ts
matcher.removeDocuments(project: string, collection: string, ids: string[]): Promise<{ removed: number }>
```

HTTP route:

```http
DELETE /v1/projects/:project/collections/:collection/documents
Content-Type: application/json

{ "ids": ["sku_1", "sku_2"] }
```

Behavior:

- Hard delete rows from the collection table by `id`.
- Invalidate search result cache for the project/collection.
- Return count of removed rows.
- Respect project API key auth on HTTP route.
- Do not perform schema mutation.

If implementation is deferred, all docs must use the currently implemented route only and clearly mark deletes as pending. The recommended path is to implement the small API because production docs and commerce webhooks need it.

### Eval Interfaces

Add fixture schema:

```ts
type ProductDiscoveryEvalFixture = {
  domain: "fashion" | "electronics" | "furniture" | "grocery";
  products: Array<{ id: string; data: Record<string, unknown> }>;
  queries: Array<{
    id: string;
    q?: string;
    image?: { url?: string };
    filters?: Record<string, unknown>;
    relevant: Record<string, number>;
    expectations?: {
      minNdcgAt5?: number;
      minRecallAt5?: number;
      requiredIds?: string[];
      forbiddenIds?: string[];
      noRelaxedHardFilters?: boolean;
    };
  }>;
};
```

CLI target:

```bash
samesake eval product-discovery --fixture evals/product-discovery/electronics.json --project eval --collection products
```

If CLI subcommand expansion is deferred, provide a Bun script under `scripts/` with the same fixture schema.

### CLI Interfaces

Milestone 1 only updates docs around current behavior.

Milestone 3 adds:

```bash
samesake init --template=commerce --name=myshop
samesake init --template=electronics --name=myshop
samesake init --template=fashion --name=myshop
samesake init --template=shopify --name=myshop
```

The existing entity-matching template remains available as:

```bash
samesake init --template=entity-match --name=myproject
```

## 5. Architecture/System Dependencies

No new infrastructure is required.

Core dependencies:

- Existing Postgres/pgvector runtime.
- Existing collection table structure and `collectionTableName` helpers.
- Existing cache invalidation via `searchResultCache.invalidateProjectCollection`.
- Existing auth flow via `requireProjectKey`.
- Existing docs app under Astro/Starlight.
- Existing Bun test runner.

Design constraints:

- Do not move fashion code in the first pass. First document and de-risk boundary, then deprecate or namespace in a later version if needed.
- Do not claim multilingual support before tests/docs exist.
- Do not add a competitor benchmark that cannot be reproduced locally.
- Keep examples small enough to run in CI or mark live-model tiers explicitly.

## 6. Pseudocode

### Generic Remove Documents

```ts
async function removeDocuments(projectSlug, collectionName, ids) {
  if ids.length === 0 return { removed: 0 }

  project = await projectsService.getProject(projectSlug)
  if !project throw project not found

  def = await projectsService.getCollectionDef(projectSlug, collectionName)
  if !def throw collection not found

  table = collectionTableName(project.schema_name, collectionName)
  rows = await pg.unsafe(`DELETE FROM ${table} WHERE id = ANY($1::text[]) RETURNING id`, [ids])

  if rows.length > 0:
    searchResultCache.invalidateProjectCollection(projectSlug, collectionName)

  return { removed: rows.length }
}
```

### Docs Claim Gate

```ts
for each docs page:
  extract API symbols that start with matcher.
  verify symbol exists on Matcher interface
  fail docs check if symbol is unknown
```

### Product Eval Runner

```ts
fixture = readFixture(path)
apply collection for fixture.domain
push fixture.products
index until no indexed docs remain

for query in fixture.queries:
  result = matcher.search(project, collection, query)
  grades = result.hits.map(hit => query.relevant[hit.id] ?? 0)
  compute ndcg@5, recall@5, constraint compliance
  compare against query.expectations

print summary table
exit nonzero on failed gates
```

### Multilingual Regression Runner

```ts
for each language case:
  index products with language/script-specific titles/descriptions
  run query
  assert documented expectation:
    exact lexical works
    dense-only mode works when multilingual embedding fixture is enabled
    unsupported FTS case is explicitly marked expected-limited
```

## 7. Code Blueprint

### Files to Add

- `docs/production.md`
- `CONTRIBUTING.md`
- `SECURITY.md`
- `ROADMAP.md`
- `.github/ISSUE_TEMPLATE/bug_report.yml`
- `.github/ISSUE_TEMPLATE/feature_request.yml`
- `.github/workflows/ci.yml`
- `examples/electronics-search/`
- `examples/furniture-search/` or `examples/grocery-search/`
- `evals/product-discovery/electronics.json`
- `evals/product-discovery/furniture.json` or `evals/product-discovery/grocery.json`
- `scripts/eval-product-discovery.ts`
- `scripts/check-docs-api-symbols.ts`

### Files to Update

- `README.md`
- `package.json`
- `packages/sdk/package.json`
- `packages/server/package.json`
- `packages/cli/package.json`
- `packages/jobs-pgboss/package.json`
- `packages/server/src/createMatcher.ts`
- `packages/server/src/core/ingest.ts`
- `packages/server/src/app-builder.ts`
- `packages/server/test/*`
- `packages/cli/src/index.ts`
- `apps/docs/src/content/docs/index.mdx`
- `apps/docs/src/content/docs/start/what-is-samesake.mdx`
- `apps/docs/src/content/docs/start/quickstart.mdx`
- Existing integration docs under `apps/docs/src/content/docs/integrations/`
- `deploy/README.md`

### Implementation Notes

- Implement generic deletion in the ingestion service because ingestion owns document lifecycle upsert today.
- Add the Matcher method as `removeDocuments`, mirroring docs and webhook terminology.
- Add HTTP delete route next to `/documents`.
- Add tests beside current ingestion/search-cache tests.
- Reuse the electronics fixture already embedded in `examples/fashion-search/bench-retrieval.ts` as seed material, but move it to a dedicated example/eval fixture.
- Keep fashion template exports working; mark future namespacing/deprecation as a separate compatibility RFC if needed.

## 8. Incremental Task Breakdown / WBS

| ID | Priority | Area | Task | Files | Acceptance Criteria | Validation |
|---|---:|---|---|---|---|---|
| C1 | P0 | Docs truth | Rewrite README/docs homepage/what-is around product discovery and move fashion to template/example framing. | `README.md`, docs index, what-is | No opening page says Samesake is primarily "starting with fashion"; fashion is described as optional template. | Docs grep for forbidden launch-positioning phrases. |
| C2 | P0 | Boundary | Add Core vs Templates page. | docs concepts | Page names core DSL/server, commerce assumptions, fashion template, entity matching, and current compatibility surfaces. | Docs build. |
| C3 | P0 | Delete API | Implement `matcher.removeDocuments` and HTTP delete route. | server ingest/createMatcher/app-builder/tests | Integration docs code samples compile conceptually against `Matcher`; delete removes rows and invalidates cache. | `bun test packages/server/test/...` |
| C4 | P0 | Production docs | Add `docs/production.md` and docs production page. | `docs/production.md`, docs guide, `deploy/README.md` | Broken link fixed; guide covers reindexing, deletes, migrations, rollback, metrics, backups, security, jobs, scale limits. | Link check/docs build. |
| C5 | P0 | OSS trust | Add contributing, security, roadmap, issue templates, support/version policy. | root docs, `.github` | Top-level files exist and explain release/support/security reporting. | File existence check. |
| C6 | P0 | Limitations | Add Known Limitations page. | docs concepts | Clearly states scale/language/jobs/dashboard/SLA/personalization limits. | Docs build and claim audit. |
| C7 | P0 | Multilingual docs | Add multilingual readiness page with current English FTS limitation. | docs guide | Page does not overclaim; includes language matrix and provider caveats. | Docs grep for unsupported claims. |
| C8 | P1 | Multilingual tests | Add multilingual regression fixture/runner. | `evals/`, `scripts/`, tests | At least English, accented Latin, RTL/CJK expectation cases, and one code-mixed case if target market remains LK. | `bun scripts/eval-product-discovery.ts --fixture ...` |
| C9 | P1 | Proof page | Add evaluation proof page with reproducibility tiers. | docs guide | Explains no-model, labeled fixture, live-model, external-corpus tiers. | Docs build. |
| C10 | P1 | Multi-domain examples | Add electronics and furniture/grocery examples. | `examples/electronics-search`, `examples/grocery-search` or furniture | Each has config, seed data, run script, expected results, no-model path when possible. | Root example scripts pass. |
| C11 | P1 | Eval productization | Extract multi-domain eval fixtures and runner. | `evals/product-discovery`, `scripts/eval-product-discovery.ts` | nDCG@5, recall@5, constraint compliance, duplicate/variant checks available. | Runner exits nonzero on failed gate. |
| C12 | P1 | Provider docs | Add provider-recipes matrix. | docs guide | Covers BYO embed/generate/rerank/grounding contracts and provider caveats. | Docs build. |
| C13 | P1 | Connector docs | Add JSONL/CSV/GMC/direct Postgres docs and correct connector claims. | integration docs | Implemented connectors vs recipes are labeled accurately. | Docs API-symbol check. |
| C14 | P1 | Comparisons | Add Why Samesake and comparison pages. | docs concepts/comparisons | Pages compare against Algolia, Typesense, Meilisearch, Elasticsearch/OpenSearch, pgvector DIY without overclaiming scale. | Docs build. |
| C15 | P1 | Package metadata | Align keywords, versions, jobs dependency range, README package version statements. | package json files, README | Package metadata targets product discovery/search; version drift documented/fixed. | `bun run pack:assert`; package JSON diff review. |
| C16 | P2 | CLI templates | Add `samesake init --template` support. | CLI, tests, examples | Commerce/electronics/fashion/shopify/entity-match templates generate valid configs. | CLI tests and generated config typecheck. |
| C17 | P2 | CI | Add workflow for typecheck, tests, pack assert, examples smoke. | `.github/workflows/ci.yml` | PRs run validation gate. | CI green or local equivalent. |
| C18 | P2 | Migration pages | Add migration guides from Algolia/Typesense/Meilisearch/ES/OpenSearch/DIY pgvector. | docs comparisons/guides | Guides are honest about scope and tradeoffs. | Docs build. |

### Milestones

Milestone 0 - Claim safety, 1 week:

- C1, C2, C3, C4, C5, C6.

Milestone 1 - Trust and proof, 2 to 4 weeks:

- C7, C8, C9, C10, C11, C12, C13.

Milestone 2 - Competitive adoption, 4 to 8 weeks:

- C14, C15, C16, C17, C18.

## 9. Validation and Testing

### Validation Contract

This program is complete when:

- No public doc references an API that does not exist.
- The missing production link is fixed.
- Product docs explain current limitations before making adoption claims.
- At least three commerce domains have runnable fixtures/examples.
- Eval output includes relevance and constraint metrics.
- Multilingual behavior is either tested or explicitly marked unsupported/experimental.
- Root OSS trust files exist.
- Package metadata and README do not contradict published package/version state.

### Commands

Run after each milestone:

```bash
bun run typecheck
bun run pack:assert
bun test packages/server/test
bun test packages/cli/test
bun examples/hello-search/run.ts
bun examples/hello-spaces/run.ts
bun examples/quickstart/run.ts
```

After C3:

```bash
bun test packages/server/test/ingest-delete.test.ts
bun test packages/server/test/query-cache.test.ts
```

After C9-C11:

```bash
bun scripts/eval-product-discovery.ts --fixture evals/product-discovery/electronics.json
bun scripts/eval-product-discovery.ts --fixture evals/product-discovery/fashion.json
bun scripts/eval-product-discovery.ts --fixture evals/product-discovery/grocery.json
```

After docs work:

```bash
bun --cwd apps/docs run build
bun scripts/check-docs-api-symbols.ts
```

### Regression Tests to Add

- Delete one product, search for it, assert not returned.
- Delete invalid/missing IDs, assert removed count is stable and no throw.
- Delete invalidates cached search results.
- Integration docs API-symbol checker catches unknown `matcher.*` methods.
- Multilingual fixture documents and tests current limits.
- Multi-domain eval runner fails on low nDCG/recall/constraint compliance.

## 10. Security

Security work must be part of P0 docs and P1 validation:

- Document master API key vs project key behavior.
- Document webhook signature verification for Shopify/Woo/Medusa recipes.
- Document provider data flow: catalog text/images sent to embedding/generation providers.
- Document prompt/catalog injection risk in NLQ/enrichment/generation.
- Document log redaction and current sanitizer behavior from `packages/server/src/core/observability.ts:26`.
- Document tenant isolation via project schemas and project API keys.
- Add `SECURITY.md` with private vulnerability reporting path, supported versions, and disclosure expectations.
- Ensure new docs and examples never read or print secrets from `.env`.

## 11. Rollback / Abort

Rollback strategy:

- Documentation-only changes can be reverted page-by-page.
- `removeDocuments` is additive. If it fails validation, remove the public docs references or mark delete API experimental before release.
- CLI templates are additive behind `--template`; keep existing init behavior as default or alias until a major release.
- Eval fixtures/scripts are additive and can be disabled from CI if unstable, but docs must then avoid claiming those gates as release proof.

Abort conditions:

- Do not publish a production-readiness claim if C3/C4/C5/C6 are incomplete.
- Do not publish a multilingual-readiness claim if C7/C8 are incomplete.
- Do not publish comparison pages with quantitative superiority claims unless the benchmark is reproducible.
- Do not move/remove fashion APIs without a compatibility plan and deprecation notice.

## 12. Open Questions

Q1: Should generic deletion be implemented immediately or docs corrected to avoid the method?

Proposal: Implement `removeDocuments` immediately. It is small, aligns with existing docs, and is required for production webhook correctness.

Q2: Which third commerce domain should be first-class after fashion and electronics?

Proposal: Grocery. It stresses availability, freshness, substitutions, units, and hard filters differently from apparel/electronics.

Q3: Should the first multilingual work be code changes or docs/tests?

Proposal: Start with docs/tests. Current English FTS must be stated honestly before changing strategy. Add configurable FTS or dense-first multilingual mode in a follow-up RFC.

Q4: Should fashion APIs be moved out of core in this RFC?

Proposal: No. Document boundary now, keep compatibility, and create a later deprecation/namespacing RFC only after docs and examples establish the broader product category.

Q5: Should comparison pages include live benchmark numbers?

Proposal: Not initially. Start with qualitative, source-backed tradeoff pages and link to reproducible local Samesake fixtures. Add competitor numbers only when benchmark methodology is stable.

Q6: What production deployment target should be documented first?

Proposal: Keep Fly.io plus external Postgres and Cloudflare Workers as first targets because `deploy/README.md` already documents them. Add generic Postgres operations guidance independent of host.
