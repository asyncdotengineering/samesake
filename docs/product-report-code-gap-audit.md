# Product Report → Codebase Gap Audit and RFC

## Objective

Perform a meticulous and deliberate audit of the repository against:

```text
product-oss-search-report.md
````

Treat `product-oss-search-report.md` as the product strategy and requirements source of truth.

Your job is to inspect the actual repository and determine what is:

* implemented;
* partially implemented;
* demo-only;
* undocumented;
* broken;
* missing;
* risky;
* overfit to fashion;
* not framework-general;
* not production-ready;
* not tested;
* not credible as OSS infrastructure.

Then create an RFC for closing the gaps.

This is not a normal code review. This is a product-to-code gap analysis. Hunt for missing product surface, misleading claims, incomplete abstractions, weak examples, lack of tests, and places where the repo does not support the positioning in the report.

Do not implement fixes unless explicitly instructed later. The main deliverable is a rigorous gap audit plus RFC.

## Inputs

Primary product source:

```text
product-oss-search-report.md
```

Repository areas to inspect:

```text
README.md
docs/
examples/
apps/
packages/
tests/
package.json
CHANGELOG*
LICENSE*
CONTRIBUTING*
```

If these paths differ, inspect the closest equivalent files and directories.

Also inspect package-level README files, example apps, templates, scripts, generated docs, and any demo/playground code.

## Rules

* Do not print secrets.
* Do not perform a deep refactor.
* Do not assume a product claim is true because it appears in docs.
* Verify product claims against actual code, examples, tests, scripts, and docs.
* Distinguish framework capabilities from demo-only capabilities.
* Distinguish implemented behavior from aspirational docs.
* Distinguish generic framework logic from fashion-template logic.
* Every important finding must include file paths and line numbers where possible.
* If a requirement from the report has no corresponding repo evidence, mark it as missing.
* If evidence is ambiguous, mark it as unclear and explain what proof is needed.
* Be skeptical. Look for hidden gaps, not only obvious missing pages.

## Phase 1: Read and Extract Requirements from Product Report

Read `product-oss-search-report.md` carefully.

Extract a structured list of product requirements and expectations.

Group them into categories such as:

1. Positioning and homepage messaging
2. ICP and use cases
3. Core vs template separation
4. Domain neutrality
5. Non-fashion examples
6. Multilingual readiness
7. Relevance gating / no-result behavior
8. Duplicate and variant handling
9. Evaluation and relevance regression testing
10. Traceability and debugging
11. Provider abstraction
12. Connectors and ingestion
13. Production operations
14. Security and safety
15. Packaging and CLI
16. OSS readiness
17. Documentation completeness
18. Competitive comparison pages
19. API stability and versioning
20. Community and contribution path

For each requirement, capture:

* requirement name;
* source section in `product-oss-search-report.md`;
* implied user value;
* expected repo evidence;
* severity if missing.

Create a requirement inventory table.

## Phase 2: Repository Inventory

Inspect the repo structure.

Run:

```bash
find . -maxdepth 3 -type f \
  | sed 's#^\./##' \
  | sort \
  | grep -v 'node_modules' \
  | grep -v '.git'
```

Also inspect package scripts:

```bash
find . -name package.json -maxdepth 4 -print
```

For each `package.json`, inspect:

* package name;
* scripts;
* dependencies;
* build/test/lint commands;
* publish readiness;
* CLI entries;
* exports;
* versioning.

Produce a brief map of what exists:

* apps;
* packages;
* examples;
* docs;
* tests;
* scripts;
* templates;
* connectors;
* eval tooling.

## Phase 3: Product Claim Verification

For every meaningful product claim in `product-oss-search-report.md`, verify whether the repo supports it.

Use this classification:

| Status       | Meaning                                                       |
| ------------ | ------------------------------------------------------------- |
| Implemented  | Real code/docs/tests exist and appear usable                  |
| Partial      | Some pieces exist but are incomplete                          |
| Demo-only    | Exists only in playground/demo, not framework                 |
| Aspirational | Mentioned in docs/report but not implemented                  |
| Missing      | No meaningful evidence found                                  |
| Risky        | Exists but likely brittle, overfit, undocumented, or untested |
| Unknown      | Could not verify                                              |

Create a table:

| Product Requirement | Status | Evidence | Missing / Risk | Severity | Suggested RFC Item |
| ------------------- | ------ | -------- | -------------- | -------- | ------------------ |

## Phase 4: Core vs Template Boundary Audit

The product report likely argues that samesake must be a framework, not merely a fashion demo.

Audit whether the repo supports that.

Inspect:

```text
packages/
apps/
examples/
docs/
```

Questions:

* Is the framework core domain-neutral?
* Is fashion logic isolated to templates/examples/playground?
* Do docs explain core vs templates clearly?
* Are there non-fashion templates?
* Are there non-fashion examples?
* Are there tests proving non-fashion domains work?
* Do APIs require fashion-specific concepts such as color, size, gender, garment type, occasion, or style?
* Can a user model electronics, furniture, grocery, books, real estate, jobs, docs, or B2B parts without fighting the API?

Flag any framework-level leakage of fashion assumptions.

Search for domain-specific terms:

```bash
grep -RIn \
  -e "dress" \
  -e "fashion" \
  -e "garment" \
  -e "saree" \
  -e "leggings" \
  -e "nightwear" \
  -e "size" \
  -e "color" \
  -e "gender" \
  -e "occasion" \
  -e "style" \
  packages apps examples docs tests \
  || true
```

Do not mark every occurrence as bad. Classify whether each is acceptable template/example usage or problematic framework leakage.

## Phase 5: Documentation Gap Audit

Audit whether docs make the product adoptable.

Check for these pages or sections:

* What is samesake?
* Why samesake?
* Quickstart
* Installation
* Minimal working example
* Concepts
* Architecture
* Core vs templates
* Collection schema
* Indexing
* Querying
* Filtering
* Ranking and fusion
* Relevance tuning
* No-result / relevance gating
* Duplicate and variant handling
* Multilingual search
* Image search
* Provider setup
* Evaluation
* Debug traces
* Production deployment
* Reindexing and migrations
* Partial updates and deletes
* Observability
* Security
* Connectors
* Examples
* Comparison pages
* FAQ
* Known limitations
* Contributing
* Changelog
* Roadmap

For each page:

| Page / Topic | Exists? | Quality | Evidence | Missing Content | Priority |
| ------------ | ------- | ------- | -------- | --------------- | -------- |

Be strict. A passing mention is not enough for production-adoption docs.

## Phase 6: Examples and Templates Gap Audit

Inspect examples and templates.

Determine whether samesake demonstrates credible usage for:

* fashion;
* electronics;
* furniture;
* grocery;
* books;
* beauty;
* B2B parts;
* real estate;
* jobs;
* documentation search;
* marketplaces.

For each example/template:

| Domain | Exists? | End-to-end? | Uses real framework? | Has tests? | Shows filters? | Shows ranking? | Shows eval? | Notes |
| ------ | ------- | ----------- | -------------------- | ---------- | -------------- | -------------- | ----------- | ----- |

Flag if examples are:

* too toy-like;
* not runnable;
* not documented;
* not connected to tests;
* over-dependent on private env vars;
* only fashion-oriented;
* not demonstrating framework generality.

## Phase 7: Evaluation and Proof Audit

The product report likely says that trust requires evals, traces, benchmarks, and regression testing.

Audit whether the repo has:

* labeled query/product judgments;
* relevance metrics such as NDCG, MRR, recall@k, precision@k;
* no-result accuracy metrics;
* duplicate crowding metrics;
* multilingual evals;
* non-fashion evals;
* before/after snapshots;
* CI-compatible eval command;
* trace/debug output;
* benchmark datasets;
* performance tests;
* docs explaining how to interpret evals.

Search for:

```bash
grep -RIn \
  -e "eval" \
  -e "benchmark" \
  -e "ndcg" \
  -e "mrr" \
  -e "precision" \
  -e "recall" \
  -e "trace" \
  -e "snapshot" \
  -e "relevance" \
  packages apps examples docs tests \
  || true
```

Create:

| Capability | Status | Evidence | Gap | RFC Requirement |
| ---------- | ------ | -------- | --- | --------------- |

## Phase 8: Multilingual and Global Readiness Audit

Audit whether the repo provides credible multilingual support.

Check for:

* multilingual examples;
* multilingual docs;
* cross-lingual examples;
* Unicode normalization;
* CJK behavior;
* right-to-left script handling;
* accent handling;
* language-aware FTS configuration;
* provider caveats;
* multilingual test cases;
* multilingual eval sets.

Search for:

```bash
grep -RIn \
  -e "multilingual" \
  -e "unicode" \
  -e "locale" \
  -e "language" \
  -e "i18n" \
  -e "accent" \
  -e "cjk" \
  -e "arabic" \
  -e "japanese" \
  -e "spanish" \
  -e "french" \
  packages apps examples docs tests \
  || true
```

Classify:

* credible;
* partial;
* accidental;
* absent.

Be especially skeptical of English keyword-overlap relevance gating that could break non-English queries.

## Phase 9: Connectors and Ingestion Audit

Audit whether the product can ingest real catalogs.

Check for:

* Shopify;
* WooCommerce;
* Medusa;
* BigCommerce;
* Magento / Adobe Commerce;
* commercetools;
* CSV;
* JSON;
* Google Merchant Center;
* Postgres table sync;
* webhook updates;
* incremental indexing;
* deletes;
* partial updates;
* background jobs;
* retry handling;
* provider rate limiting.

Create:

| Ingestion Path | Status | Evidence | Missing | Priority |
| -------------- | ------ | -------- | ------- | -------- |

Flag if the product requires too much custom glue for first adoption.

## Phase 10: Production Readiness Audit

Audit whether the repo supports production use.

Look for:

* deployment guide;
* required infrastructure;
* Postgres extensions;
* schema migrations;
* index creation;
* index versioning;
* reindexing;
* rollback;
* partial updates;
* deletes;
* queues/retries;
* observability;
* logging;
* metrics;
* tracing;
* slow query diagnostics;
* pgvector tuning;
* backup/restore guidance;
* multi-tenant guidance;
* security guidance;
* secrets handling;
* cost guidance.

Create:

| Production Capability | Status | Evidence | Risk | RFC Item |
| --------------------- | ------ | -------- | ---- | -------- |

## Phase 11: Provider Abstraction Audit

Audit whether embedding, image, and LLM providers are truly swappable.

Check:

* provider interfaces;
* OpenAI examples;
* Gemini examples;
* local model examples;
* Voyage/Cohere examples if present;
* image embedding providers;
* task type support;
* dimension validation;
* provider mocks for tests;
* graceful fallback;
* model migration strategy.

Create:

| Provider Concern | Status | Evidence | Gap | Recommendation |
| ---------------- | ------ | -------- | --- | -------------- |

## Phase 12: Packaging, CLI, and OSS Readiness Audit

Audit whether developers can adopt and contribute.

Check:

* license;
* package publishing setup;
* package exports;
* semantic versioning;
* changelog;
* contribution guide;
* issue templates;
* PR templates;
* code of conduct;
* release workflow;
* CLI;
* template generator;
* example app generator;
* docs generation;
* local dev instructions;
* CI config;
* test scripts;
* lint/typecheck scripts.

Create:

| OSS Readiness Area | Status | Evidence | Gap | Priority |
| ------------------ | ------ | -------- | --- | -------- |

## Phase 13: Competitive Surface Audit

Using the report’s competitive claims, verify whether the repo contains enough product surface to credibly compare against:

* Algolia
* Constructor
* Bloomreach
* Typesense
* Meilisearch
* Elasticsearch
* OpenSearch
* Vespa
* pgvector DIY
* Qdrant / Weaviate / Pinecone DIY

Check for comparison pages or docs.

Create:

| Alternative | Claimed Differentiation | Repo Evidence | Missing Proof | Priority |
| ----------- | ----------------------- | ------------- | ------------- | -------- |

## Phase 14: Failure Hunt

Deliberately hunt for places where the product may fail adoption.

Look for:

* impressive claims without runnable examples;
* docs that describe features not present in code;
* demo-only features presented as framework features;
* hidden private environment dependencies;
* no clear install path;
* no simple “hello search”;
* no no-result behavior;
* no evals;
* no non-fashion examples;
* no production story;
* no migration story;
* no connector story;
* no version stability;
* no license or contribution docs;
* no tests around important product promises;
* APIs that require too much framework knowledge;
* unclear package boundaries;
* unclear names;
* undocumented configuration;
* hard-coded assumptions;
* fragile defaults.

For each failure mode:

| Failure | Evidence | User Impact | Severity | RFC Fix |
| ------- | -------- | ----------- | -------- | ------- |

## Phase 15: RFC Creation

Create a new RFC document as the final deliverable.

Suggested path:

```text
docs/rfcs/0001-close-product-oss-search-gaps.md
```

Do not write the file unless explicitly asked. In the final response, provide the full RFC content or state that it should be written to that path.

The RFC must include:

# RFC: Closing Product Gaps for Samesake as an OSS Search Framework

## Summary

A short summary of the gap between current repo state and desired product positioning.

## Motivation

Why these gaps block adoption.

## Goals

Concrete goals.

Examples:

* Make samesake understandable in 30 seconds.
* Prove it is a framework, not a fashion demo.
* Add credible non-fashion examples.
* Add productized evals.
* Add no-result / relevance-gating docs and tests.
* Add production-readiness docs.
* Add connector story.
* Add multilingual proof.
* Add OSS contribution and release basics.

## Non-Goals

Examples:

* Do not build a hosted SaaS.
* Do not compete with Elasticsearch on every general-search workload immediately.
* Do not add enterprise personalization before basic OSS trust exists.
* Do not overbuild connectors before the core adoption path is clear.

## Current State

Summarize what exists now, with evidence.

## Gap Analysis

Include a table:

| Area | Current State | Desired State | Gap | Severity |
| ---- | ------------- | ------------- | --- | -------- |

## Proposed Workstreams

At minimum include:

1. Positioning and docs rewrite
2. Core vs templates clarification
3. Non-fashion example suite
4. Evaluation and regression harness
5. Multilingual readiness
6. Duplicate/variant guide
7. Production operations guide
8. Connector and ingestion path
9. Provider abstraction docs/examples
10. OSS packaging/community basics
11. Competitive comparison pages

For each workstream include:

* problem;
* proposed change;
* affected files/areas;
* acceptance criteria;
* validation plan;
* dependencies;
* priority.

## Milestones

Use this structure:

### Milestone 1: Adoption Clarity, 0–2 Weeks

Focus on docs, positioning, quickstart, repo cleanup, non-fashion hello-world.

### Milestone 2: Trust and Proof, 2–6 Weeks

Focus on evals, traces, multilingual tests, production docs, provider examples.

### Milestone 3: Ecosystem Expansion, 6–12 Weeks

Focus on connectors, migration guides, comparison pages, CLI/templates, benchmark datasets.

## Acceptance Criteria

Define measurable acceptance criteria.

Examples:

* A new developer can run a non-fashion example in under 10 minutes.
* Docs clearly explain core vs templates.
* At least three non-fashion domains have runnable examples.
* Eval command reports relevance metrics and no-result accuracy.
* Multilingual regression queries exist.
* Production guide covers reindexing, partial updates, deletes, and Postgres tuning.
* Comparison pages exist for Algolia, Typesense, Meilisearch, Elasticsearch, and pgvector DIY.
* No framework docs imply fashion-only data model.

## Risks and Tradeoffs

Include:

* overgeneralizing too early;
* spending too much time on docs before core reliability;
* building connectors before evals;
* confusing commerce search with general web search;
* promising multilingual support beyond provider capabilities.

## Open Questions

List unresolved decisions.

Examples:

* Is the primary category “commerce search framework” or “general search framework”?
* Which non-fashion domains should be official examples?
* Should evals be a CLI feature or library API first?
* What provider matrix should be officially supported?
* What production deployment target should be documented first?

## Implementation Plan

Create a prioritized checklist.

## Validation Plan

Define how to verify the RFC work is complete.

## Appendix

Include the detailed audit tables.

## Final Output Required

Return two sections:

1. `Audit Report`
2. `RFC`

The `Audit Report` must include:

* requirement inventory;
* repo evidence summary;
* status table;
* missing pieces;
* high-severity adoption blockers;
* misleading or unsupported claims;
* demo-only features;
* fashion-overfit risks;
* multilingual gaps;
* production gaps;
* OSS readiness gaps.

The `RFC` must be complete enough to copy into:

```text
docs/rfcs/0001-close-product-oss-search-gaps.md
```

## Quality Bar

Be meticulous. Be skeptical. Be concrete.

A good finding looks like:

```text
Finding: The product report recommends multilingual credibility, but the repo has no multilingual examples, no multilingual evals, and no docs explaining provider limitations.

Evidence:
- docs/search.md:45-52 describes semantic search only in English examples.
- examples/fashion-search/... contains only English queries.
- grep for "multilingual" returns no docs page.

Impact:
Developers building global commerce search cannot trust the framework yet.

RFC item:
Add multilingual readiness docs, multilingual eval fixture, and cross-lingual query examples.
```

A weak finding looks like:

```text
Multilingual could be better.
```

Do not produce weak findings.
