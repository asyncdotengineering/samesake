# Product Report to Code Gap Audit

Date: 2026-06-19

Source of truth: `docs/product-oss-search-report.md`

Audit prompt: `docs/product-report-code-gap-audit.md`

RFC: `docs/rfcs/0001-close-product-oss-search-gaps.md`

## Audit Report

### Scope and Method

This audit compared product expectations in `docs/product-oss-search-report.md` against the current repository. The inspection covered package metadata, public docs, README, examples, CLI, server and SDK APIs, ingestion/connectors, eval harnesses, tests, and deployment docs.

Commands/material checks included:

- Required file inventory: `find . -maxdepth 3 -type f | sed 's#^\./##' | sort`
- Package inventory: `find . -maxdepth 4 -name package.json -print`
- Gap searches for fashion/domain coupling, eval/benchmarks, multilingual support, connectors, production docs, missing OSS files, and delete APIs.
- No `.env` contents were read.

### Executive Findings

| ID | Finding | Status | Priority | Evidence |
|---|---|---|---|---|
| F1 | Product positioning is still narrower than the product report expectation. Public docs say "visual commerce" and "starting with fashion" instead of "Postgres-native product discovery framework." | Partial | P0 | Product report expected positioning: `docs/product-oss-search-report.md:19`; README fashion opening: `README.md:3`; docs homepage visual-commerce description: `apps/docs/src/content/docs/index.mdx:3`; "starting with fashion": `apps/docs/src/content/docs/start/what-is-samesake.mdx:8`. |
| F2 | Core vs template boundary is leaky. Fashion is exported/implemented through root SDK/server surfaces, not only isolated examples/templates. | Risky | P0 | SDK root exports fashion template: `packages/sdk/src/index.ts:55`; SDK root defines `fashionAttributes`/presets: `packages/sdk/src/index.ts:337`; Matcher interface exposes `fashionSearch`: `packages/server/src/createMatcher.ts:82`; HTTP routes expose `/fashion-search` and `/fashion-sync`: `packages/server/src/app-builder.ts:492`. |
| F3 | Several production docs claim generic deletes, but the code does not expose `matcher.removeDocuments(...)`; only fashion sync has a delete branch. | Misleading | P0 | Docs call `matcher.removeDocuments`: `apps/docs/src/content/docs/integrations/shopify.mdx:102`, `apps/docs/src/content/docs/integrations/medusajs.mdx:109`, `apps/docs/src/content/docs/integrations/woocommerce.mdx:89`; Matcher interface has `pushDocuments` but no `removeDocuments`: `packages/server/src/createMatcher.ts:75`; fashion-only delete: `packages/server/src/core/fashion-search.ts:339`. |
| F4 | Production guide is referenced but missing. The repo has useful production primitives, but not the public operations guide the product report requires. | Missing | P0 | `deploy/README.md:70` links `docs/production.md`; file is absent; product report requires guide for reindexing, deletes, migrations, rollback, observability, backups, security, and scale limits: `docs/product-oss-search-report.md:45`. |
| F5 | Multilingual product search is not productized and has hard-coded English FTS. Cross-script work exists for entity matching, not product-search docs/evals. | Partial/Risky | P0 | Product report requires multilingual readiness: `docs/product-oss-search-report.md:47`; collection DDL hard-codes `to_tsvector('english', ...)`: `packages/server/src/core/collections-schema-gen.ts:88`; search uses `websearch_to_tsquery('english', ...)`: `packages/server/src/core/search.ts:313`; report calls this weak: `docs/product-oss-search-report.md:178`. |
| F6 | Evaluation/proof primitives exist, but they are not packaged as buyer-facing, multi-domain proof. | Partial | P1 | Core evaluator/calibrator: `packages/server/src/core/calibrate-search.ts:1`; HTTP evaluate/calibrate: `packages/server/src/app-builder.ts:415`; CLI `eval` says retrieval only and no judge: `packages/cli/src/index.ts:747`; two-domain benchmark exists but only fashion/electronics: `examples/fashion-search/bench-retrieval.ts:1`. |
| F7 | Non-fashion proof is thin. Electronics appears in a benchmark, but docs/examples do not first-class electronics, furniture, grocery, B2B parts, or marketplaces. | Partial | P1 | Product report requires non-fashion examples: `docs/product-oss-search-report.md:125`; examples list has generic/fashion but no `electronics-search`, `furniture-search`, or `grocery-search`; electronics appears only inside `bench-retrieval.ts:31`. |
| F8 | Connector surface is partial. Shopify/Woo/JSONL code exists; docs mention Medusa/Porulle and deletion flows that code does not fully support generically; requested connectors are missing. | Partial | P1 | Connector switch supports only `shopify`, `woocommerce`, `jsonl`: `packages/server/src/connectors/index.ts:15`; product report asks BigCommerce, Magento/Adobe, commercetools, CSV/GMC/direct Postgres: `docs/product-oss-search-report.md:131`. |
| F9 | Provider abstraction is real, but docs do not present a support/provider matrix and the canonical examples remain Gemini/Ollama/stub-heavy. | Partial | P1 | BYO `EmbedFn`/`GenerateFn`/rerank/ground-image contracts: `packages/server/src/types.ts:43`, `packages/server/src/types.ts:79`, `packages/server/src/types.ts:89`; inline Gemini/Ollama comments: `packages/server/src/types.ts:182`. |
| F10 | OSS readiness is incomplete: no top-level contributing/security/roadmap/code-of-conduct files, no CI discovered, root scripts do not expose a test/lint workflow. | Missing | P0 | Product report calls this out: `docs/product-oss-search-report.md:61`; root scripts include `typecheck` and examples but no `test`/`lint`: `package.json:7`; `.github` has no files in this worktree. |
| F11 | Package metadata/version story does not fully match search/product-discovery adoption. | Partial | P1 | Product report notes NPM discoverability/version drift: `docs/product-oss-search-report.md:62`; package versions: core/server `1.3.0`, CLI `1.2.0`, jobs adapter `1.0.0`; jobs depends on `@samesake/server` `^1.0.0`. |
| F12 | Competitive comparison pages and migration pages are missing from public docs. | Missing | P0/P1 | Product report requires Why Samesake and comparison pages: `docs/product-oss-search-report.md:118`, `docs/product-oss-search-report.md:122`; current docs navigation/pages inspected did not include these pages. |

### Requirement Inventory

| Requirement from product report | Expected state | Current state | Status |
|---|---|---|---|
| Reposition around Postgres-native product discovery | Homepage/README/docs use product discovery and commerce search language | Docs/README still emphasize visual commerce/fashion | Partial |
| Explain "Why Samesake?" | Explicit comparison against hosted SaaS, search clusters, vector DBs, pgvector DIY | No public comparison path found | Missing |
| Core vs templates | Clear boundary between framework core, commerce template, fashion template, entity matching | Fashion exports/API/routes live in root SDK/server surfaces | Risky |
| Public production guide | Reindexing, deletes, migrations, rollback, observability, backups, security, scale limits | Deploy README links absent `docs/production.md`; primitives exist but no complete guide | Missing |
| Known limitations | Scale, language, jobs adapter, no hosted dashboard, no SLA, no clickstream personalization | Not found as public docs page | Missing |
| Evaluation proof | Docs proof page with reproducibility tiers and multiple commerce domains | Harnesses exist; proof is mainly examples/internal report framing | Partial |
| Non-fashion examples | Electronics, furniture, grocery, B2B parts, marketplace listings | Generic smoke and fashion; electronics only in benchmark fixture | Partial |
| Multilingual readiness | Language matrix, provider caveats, evals, FTS strategy | Hard-coded English FTS; no docs/evals surfaced | Partial/Risky |
| Connectors/ingestion | Shopify, Woo, Medusa, Porulle, CSV/JSONL/GMC, direct Postgres, background indexing | Shopify/Woo/JSONL code; Medusa/Porulle docs; no generic delete; missing CSV/GMC/direct Postgres docs | Partial |
| Provider abstraction | BYO model contracts plus provider recipes/migration guidance | Contracts exist; provider docs matrix missing | Partial |
| OSS trust | Contributing, security, roadmap, supported versions, release policy, issue path | Missing top-level files/policies | Missing |
| CLI templates | `samesake init` product-discovery templates | `init` scaffolds entity/customer matching config | Missing |

### Repo Inventory

Packages and apps found:

- Root workspace: private monorepo with packages, apps, examples. Scripts include dev/start/cli/examples/typecheck/pack assert, but no root `test` or `lint`: `package.json:7`.
- `packages/sdk`: `@samesake/core` `1.3.0`; DSL, templates, sources, scorers.
- `packages/server`: `@samesake/server` `1.3.0`; createMatcher, HTTP app, search, ingestion, connectors, eval/calibration, auth/metrics.
- `packages/cli`: `@samesake/cli` `1.2.0`; commands for apply/migrate/ingest/index/eval/calibrate/search explain/dev/init.
- `packages/jobs-pgboss`: `@samesake/jobs-pgboss` `1.0.0`; stale server dependency range relative to core/server.
- Apps: docs, matcher, playground, ecommerce assistant.
- Examples: hello, hello-search, hello-spaces, quickstart, fashion-search, agentic-commerce.

### Implemented Strengths

| Capability | Evidence | Notes |
|---|---|---|
| Typed collection DSL and Postgres runtime DDL | `packages/server/src/core/collections-schema-gen.ts:81` | Supports generated collection tables, FTS, vectors, fields, indexes. |
| Hybrid retrieval with SQL hard filters | `packages/server/src/core/search.ts:306`, `packages/server/src/core/search.ts:326` | FTS and vector candidate legs combine under query filters. |
| Search modes, soft-filter relaxation, diversification, rerank seam | `packages/server/src/core/search.ts:593`, `packages/server/src/core/search.ts:800`, `packages/server/src/core/search.ts:816` | Strong technical substrate for product search and tuning. |
| BYO model seams | `packages/server/src/types.ts:43`, `packages/server/src/types.ts:79`, `packages/server/src/types.ts:104`, `packages/server/src/types.ts:117` | Embedding, generation, rerank, grounding are external functions. |
| HTTP/in-process surfaces | `packages/server/src/createMatcher.ts:57`, `packages/server/src/app-builder.ts:357` | Usable library plus web-standard fetch/Hono routes. |
| Ingestion/upsert | `packages/server/src/core/ingest.ts:20`, `packages/server/src/app-builder.ts:303` | Upsert invalidates cache and resets enrichment/index timestamps on content changes. |
| Eval/calibration primitive | `packages/server/src/core/calibrate-search.ts:1`, `packages/server/src/app-builder.ts:427` | nDCG/grade@k with labeled relevance or configured LLM judge. |
| Observability primitives | `packages/server/src/core/observability.ts:12`, `packages/server/src/app-builder.ts:178` | Counters and `/v1/metrics` exist, but are not enough alone for production docs. |
| Migration planning/destructive guard | `packages/server/src/core/projects.ts:103`, `packages/server/src/core/projects.ts:167` | Good foundation for production migration guide. |
| Connector tests | `packages/server/test/connectors.test.ts:10` | Shopify/Woo normalization tested. |

### Fake, Demo-Only, or Misleading Surface

| Surface | Classification | Why |
|---|---|---|
| `matcher.removeDocuments(...)` in integration docs | Misleading | Docs use this method but `Matcher` does not expose it. Only fashion sync deletes directly. |
| "Production guide" link | Broken/missing | `deploy/README.md` points to missing `docs/production.md`. |
| Multilingual product search | Risky | Product search FTS is English-configured; no product-search language matrix/evals. Entity-resolution cross-script work cannot be presented as product-search proof. |
| CLI `init` for product discovery | Missing | Existing `cmdInit` creates a customer/entity matching config, not product search templates: `packages/cli/src/index.ts:862`. |
| Multi-domain proof | Partial | Electronics benchmark exists, but there are no first-class non-fashion examples/docs/evals for the domains required by the product report. |

### Documentation Gap Audit

| Page/Doc | Current evidence | Gap |
|---|---|---|
| README opening | `README.md:3` says visual commerce/fashion | Rewrite around product discovery and move fashion into template/example language. |
| Docs homepage | `apps/docs/src/content/docs/index.mdx:3` says visual commerce | Update category and add Why/Core/Production paths. |
| What is Samesake | `apps/docs/src/content/docs/start/what-is-samesake.mdx:8` says starting with fashion | Clarify product discovery core vs fashion template. |
| Quickstart | `apps/docs/src/content/docs/start/quickstart.mdx:55` uses dress examples | Add non-fashion product-discovery quickstart or change default fixtures. |
| Production | `deploy/README.md:70` links missing `docs/production.md` | Add production guide and fix link target. |
| Integrations | Shopify/Woo/Medusa docs mention generic deletes | Implement generic delete or correct docs immediately. |
| Comparisons | None found in docs content | Add Why Samesake and competitor pages. |
| OSS readiness | Top-level contributing/security/roadmap absent | Add trust docs and support policy. |

### Eval and Proof Audit

Implemented:

- `evaluateSearch` and `calibrateSearch` support labeled relevance and LLM-as-judge: `packages/server/src/core/calibrate-search.ts:103`.
- HTTP routes expose evaluate/calibrate: `packages/server/src/app-builder.ts:427`.
- `examples/fashion-search/bench-retrieval.ts` has hand-labeled fashion/electronics nDCG and recall gates: `examples/fashion-search/bench-retrieval.ts:1`.
- `examples/fashion-search/eval.ts` covers relevance, constraints, image, latency, zero/relaxation concepts in a fashion fixture: `examples/fashion-search/eval.ts:45`.

Missing:

- A public docs proof page with reproducibility tiers.
- A productized golden-file schema for users.
- First-class electronics/furniture/grocery eval fixtures.
- Multilingual evals and language matrix.
- Duplicate/variant crowding metrics surfaced in eval output.
- CI/root scripts that run eval smoke tests predictably.

### Multilingual and Global Readiness Audit

Status: not credible yet as a productized product-search claim.

Evidence:

- Product report requires a multilingual/global readiness page with tested language matrix and eval results: `docs/product-oss-search-report.md:47`.
- Product-search DDL hard-codes English text search: `packages/server/src/core/collections-schema-gen.ts:88`.
- Product-search query path hard-codes English tsquery: `packages/server/src/core/search.ts:313`.
- Cross-script normalization/phonetic functions exist for entity matching in system DDL, but that does not satisfy product-search multilingual behavior.

Required close:

- Document current behavior honestly.
- Add test fixture covering at least accented Latin, CJK no-tokenization expectations, RTL handling expectations, and Sinhala/Tamil/code-mixed expectations if those are target markets.
- Add an explicit FTS language strategy: configurable `regconfig`, simple lexeme fallback, dense-first multilingual mode, or "English FTS only" limitation.

### Connectors and Ingestion Audit

Implemented:

- Shopify, WooCommerce, JSONL connector factory: `packages/server/src/connectors/index.ts:15`.
- JSONL file connector: `packages/server/src/connectors/jsonl.ts:8`.
- Shopify fetch/normalize connector: `packages/server/src/connectors/shopify.ts:15`.
- WooCommerce fetch/normalize connector: `packages/server/src/connectors/woocommerce.ts:13`.
- Upsert ingestion pipeline: `packages/server/src/core/ingest.ts:20`.

Gaps:

- No generic delete/remove API exposed despite docs calling it.
- No CSV docs/page; JSONL code exists but docs do not make it a first-class integration.
- No Google Merchant Center feed guide.
- No BigCommerce/Magento/commercetools/direct Postgres sync guides.
- Webhook documentation must be aligned to actual methods and idempotency behavior.

### Production Readiness Audit

Implemented primitives:

- Deploy README for Fly and Cloudflare: `deploy/README.md:7`, `deploy/README.md:32`.
- API key and project key auth: `packages/server/src/app-builder.ts:145`.
- Health and metrics routes: `packages/server/src/app-builder.ts:163`, `packages/server/src/app-builder.ts:178`.
- Migration planning/destructive guard: `packages/server/src/core/projects.ts:153`, `packages/server/src/core/projects.ts:167`.
- Observability sanitizes secret-like fields: `packages/server/src/core/observability.ts:26`.
- Optional job runner seam: `packages/server/src/types.ts:128`.

Missing product surface:

- Operational docs for reindexing, deletes, backfills, online migrations, rollback, backups, connection pooling, extension requirements, scale envelope, latency budgets, background jobs, and incident playbooks.
- Security guidance for API keys, project keys, webhooks, provider data flows, prompt/catalog injection, log redaction, tenant isolation, and secrets handling.
- Supported-version/release/deprecation policy.

### Packaging, CLI, and OSS Audit

Findings:

- Root workspace is private; package split is clear.
- Root scripts lack `test` and `lint`; only `typecheck` and examples are exposed: `package.json:7`.
- CLI supports many useful commands, including ingest/index/eval/calibrate/dev/migrate.
- CLI `eval` is retrieval-only and explicitly says no LLM judge: `packages/cli/src/index.ts:779`; this is weaker than the server evaluator.
- CLI `init` scaffolds an entity/customer matcher config, not commerce product-discovery templates: `packages/cli/src/index.ts:862`.
- Top-level `CONTRIBUTING.md`, `SECURITY.md`, `ROADMAP.md`, `CODE_OF_CONDUCT.md` are missing.
- No `.github` workflows or issue templates were found.

### Product Claim Status Table

| Claim/Expectation | Status | Recommendation |
|---|---|---|
| "Postgres-native product discovery framework" | Supported by architecture, not by docs positioning | Rewrite README/docs and add Core vs Templates. |
| "Hybrid retrieval with hard filters" | Implemented | Keep claim; link to explain/eval docs. |
| "Auditable ranking" | Implemented in `/search/explain`, but docs need stronger tuning narrative | Add explain debugging page with traces. |
| "BYO models" | Implemented | Add provider matrix and recipes. |
| "Fashion template" | Implemented | Reframe as optional template, not category identity. |
| "Production-ready" | Not yet | Do not claim until production guide, deletes, security, ops validation exist. |
| "Multilingual ready" | Not yet | Claim only experimental/depends on provider until tested. |
| "Shopify/Woo/Medusa integrations" | Partial | Fix generic delete mismatch; distinguish code connector vs docs recipe. |
| "OSS adoption-ready" | Partial | Add community/security/roadmap/version docs and CI. |

### Priority Stack

P0 - close before serious OSS launch:

1. Correct misleading delete docs or implement generic `removeDocuments`.
2. Add production guide and fix missing link.
3. Rewrite positioning and add Core vs Templates.
4. Add Why Samesake and known limitations.
5. Add top-level OSS trust docs.
6. Add multilingual readiness page with honest limitations.

P1 - build trust after P0:

1. Productize evals with multi-domain fixtures and docs proof page.
2. Add electronics/furniture/grocery examples.
3. Add provider matrix and adapter recipes.
4. Add connector docs for JSONL/CSV/GMC/direct Postgres.
5. Add comparison/migration guides.

P2 - broaden adoption:

1. CLI template generator.
2. Hosted demo gallery.
3. Additional commerce connectors.
4. Versioning/deprecation automation and issue templates.

## RFC

See `docs/rfcs/0001-close-product-oss-search-gaps.md`.
