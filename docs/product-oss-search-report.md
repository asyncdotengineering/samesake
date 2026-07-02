# Samesake OSS Product Strategy Audit

Date: 2026-06-19

## 1. Executive Verdict

Samesake currently reads as a **promising, technically credible commerce search framework**, not yet as a broadly adoptable OSS alternative to Algolia, Typesense, Meilisearch, Elasticsearch, OpenSearch, Vespa, pgvector DIY, or commercial commerce-search SaaS.

A serious developer team would probably **not adopt it yet as their primary production search layer** unless they are founder-led, TypeScript/Postgres-native, comfortable with early OSS, and specifically want app-owned AI-native product search. They might absolutely prototype with it. The strongest current wedge is not "general search engine" and not "fashion toolkit"; it is **typed, app-owned, Postgres-native product discovery for teams that want hybrid retrieval, hard filters, explainability, and BYO models without running Elasticsearch or sending their catalog to a black-box SaaS**.

The product has unusually strong raw ingredients: a clear compiler mental model, in-process/HTTP/Hono surfaces, hard-filter SQL semantics, `/search/explain`, evaluation harnesses, Shopify/Woo/Medusa integration docs, NPM packages, MIT license, and real benchmark caveats. The adoption blocker is that these ingredients are not packaged into a trust-building OSS journey. The docs still over-index on fashion, the production guide is referenced but missing, multilingual support is not productized, community/readiness signals are thin, and the competitive story is implied rather than explicit.

**Verdict category:** credible commerce search framework in early OSS packaging. Not yet a credible general search framework. Not yet a drop-in OSS alternative to incumbent search infrastructure.

## 2. Best Current Positioning

Recommended position:

```text
Samesake is a Postgres-native product discovery framework for TypeScript commerce teams who need app-owned AI search with hard filters, hybrid retrieval, and auditable ranking.
Unlike Algolia, Constructor, Bloomreach, or Coveo, samesake runs inside your app on your Postgres with BYO models instead of sending your catalog to a hosted black box.
It is best for headless commerce, marketplaces, and AI-native shopping experiences, and not yet best for non-commerce document search, very large enterprise catalogs, or teams that need a polished merchandiser dashboard today.
```

Homepage headline:

```text
Build AI-native product search inside your TypeScript app
```

Homepage subheadline:

```text
Declare your catalog in TypeScript. Samesake compiles hybrid keyword, vector, image, and hard-filter retrieval into a Postgres-backed search layer you own.
```

Three value props:

- **Own the search layer:** Postgres + app process, no hosted search cluster, no separate vector database.
- **Keep strict constraints strict:** price, inventory, availability, and typed filters compile to SQL gates before ranking.
- **Debug relevance instead of guessing:** `/search/explain`, eval harnesses, query-time weights, and calibration make ranking inspectable.

Three proof points that need to exist:

- A reproducible "Samesake vs Algolia/Typesense/Meilisearch/pgvector DIY" benchmark on at least three commerce domains.
- A public production guide covering reindexing, deletes, migrations, rollback, observability, backups, security, and scale limits.
- A multilingual/global readiness page with tested language matrix, provider limitations, and eval results.

Honest "not for you if":

```text
Samesake is not for you yet if you need a hosted merchandiser dashboard, a general-purpose web/document search engine, enterprise SLA/support, clickstream personalization, or proven million-SKU scale without doing your own evaluation.
```

## 3. Biggest Adoption Blockers

1. **Positioning is still too fashion/visual-commerce-coded.** The public docs say "visual commerce" and "starting with fashion"; the README opens with "60-second fashion search"; the strongest example is fashion. That is a valid wedge, but it makes the framework look narrower than its DSL and architecture.
2. **No explicit "Why Samesake?" comparison path.** The docs never directly answer "why not Algolia, Typesense, Meilisearch, Elasticsearch, Vespa, pgvector, Qdrant, or hosted commerce search?"
3. **Production credibility is incomplete.** There is a deploy folder, package tests, migrations, metrics, project keys, and explain endpoints, but `deploy/README.md` references `docs/production.md` and that file is absent in the current worktree.
4. **Multilingual readiness is not productized.** The research notes cross-script entity matching exists, but product-search docs do not explain multilingual search, CJK, RTL, accents, cross-lingual behavior, or multilingual evals.
5. **Community and OSS trust signals are thin.** I found no top-level `CONTRIBUTING.md`, `SECURITY.md`, roadmap, governance note, issue templates, or supported-version policy.
6. **NPM discoverability lags the product.** `@samesake/core` and `@samesake/server` are published at 1.3.0, but keywords still emphasize entity resolution/fuzzy matching more than product search, commerce search, semantic search, or hybrid search. `@samesake/cli` is at 1.2.0 while core/server are 1.3.0.
7. **The demo/proof story is real but internally framed.** `BENCHMARKS.md` is unusually honest, but it is not yet packaged as a buyer-facing proof page with reproduction tiers, caveats, and non-fashion domains.

## 4. Competitive Landscape

| Alternative | What it is | Why teams choose it | Where samesake can win | Where samesake is weaker | Required proof |
|---|---|---|---|---|---|
| Algolia | Hosted AI search/retrieval platform | Fast API, mature DX, global infra, analytics, personalization, enterprise trust | App-owned deployment, Postgres-native, typed catalog, BYO models, no black box | SaaS polish, analytics, scale, enterprise proof, docs, integrations | Side-by-side commerce quickstart, cost/ops comparison, relevance/eval demo |
| Constructor | Enterprise commerce product discovery SaaS | KPI optimization, merchandising, personalization, enterprise retail trust | Developer-owned retrieval, deterministic explain, no hosted lock-in | Merchandiser UI, behavior optimization, analyst trust, enterprise case studies | "Build your own Constructor-like retrieval layer" demo with explain and eval |
| Bloomreach | Enterprise personalization/search suite | Search + merchandising + CDP/marketing + A/B testing | Lightweight owned retrieval for headless teams not buying a suite | Personalization, A/B testing, business UI, enterprise implementation support | Clear "not a suite" positioning and integration handoff story |
| Typesense | OSS, typo-tolerant search engine | Fast setup, simple API, Algolia-like search-as-you-type, vector/semantic features | Commerce-specific typed filters, NLQ to constraints, image/intent search, Postgres-owned data | Speed story, broad OSS adoption, community, generic docs, language SDKs | "Typesense vs Samesake for product discovery" guide |
| Meilisearch | OSS search and AI retrieval platform | Very easy setup, great defaults, under-50ms positioning, broad use cases | App-embedded TypeScript compiler, hard commerce constraints, BYO retrieval pipeline | Simplicity, polish, hosted/self-host maturity, docs, community | "From Meilisearch to Samesake when commerce constraints matter" migration guide |
| Elasticsearch | Mature search infrastructure | Scale, Lucene/BM25, enterprise ops, hybrid/vector support, ecosystem | Avoid separate cluster; compile search into Postgres; lower operational burden | Scale ceiling, query language depth, observability ecosystem, enterprise features | Postgres-scale envelope and "no Elasticsearch needed until X" guide |
| OpenSearch | OSS search cluster with vector/neural/hybrid search | Elasticsearch-compatible OSS path, AWS ecosystem, neural search | Lower ops, typed commerce-specific API, app-owned Postgres path | Cluster maturity, AWS managed option, vector/neural breadth | OpenSearch comparison focused on ops and commerce abstractions |
| Vespa | High-scale serving/ranking engine | Web-scale hybrid search, ranking flexibility, tensors, high update rates | Much simpler for small/mid commerce teams; TypeScript catalog compiler | Massive scale, ranking sophistication, production serving maturity | "Vespa is overkill until..." scale/complexity guide |
| pgvector DIY | Postgres extension plus custom code | Full control, cheap, stays in app DB | Less glue code, typed DSL, filters/facets/NLQ/explain/evals/templates | DIY has no framework lock-in; simpler for tiny needs | Show 200 lines of DIY replaced by Samesake with tests/evals |
| Qdrant/Weaviate/Pinecone DIY | Vector DBs and managed vector infra | Semantic search, vector scale, hosted options, hybrid features | Product-search semantics, SQL hard filters, no extra vector datastore, BYO app logic | Vector-specific scale, hosted operations, ecosystems | "Vector DB is not product search" guide with hard-filter examples |
| Klevu/Searchspring/Athos | Hosted ecommerce search/merch/personalization suite | Shopify/mid-market packaged commerce UX | Open-source, self-owned retrieval for headless/custom teams | Merchandiser UX, apps, reporting, non-engineer workflows | Clear "for engineering teams, not merchandiser suite" page |

External market facts reviewed:

- Algolia positions itself as an AI search and retrieval platform and claims 18,000+ customers: https://www.algolia.com/
- Typesense positions as a fast, typo-tolerant OSS Algolia/Pinecone alternative: https://typesense.org/
- Meilisearch positions as an OSS search and AI retrieval platform trusted by 20,000+ teams: https://www.meilisearch.com/
- Constructor positions as ecommerce KPI-optimized product discovery: https://constructor.com/
- Bloomreach Discovery emphasizes AI search, conversational shopping, A/B testing, and personalization: https://www.bloomreach.com/en/products/ecommerce-search/search-intelligence
- Coveo positions commerce search around AI relevance, B2B complexity, and conversational product discovery: https://www.coveo.com/en/solutions/ecommerce-search-platform
- Klevu and Searchspring now route to Athos Commerce: https://www.klevu.com/ and https://searchspring.com/
- Elasticsearch and OpenSearch both have current vector/hybrid search documentation: https://www.elastic.co/docs/solutions/search/vector and https://docs.opensearch.org/latest/vector-search/
- Vespa explicitly documents hybrid lexical + embedding search: https://docs.vespa.ai/en/learn/tutorials/hybrid-search.html
- pgvector is positioned as open-source vector similarity search for Postgres: https://github.com/pgvector/pgvector
- Qdrant and Weaviate both document hybrid search/fusion: https://qdrant.tech/documentation/search/hybrid-queries/ and https://docs.weaviate.io/weaviate/search/hybrid

## 5. Product Scorecard

| Area | Score | Evidence | Why it matters | Priority |
|---|---:|---|---|---|
| Positioning clarity | 7 | Homepage and docs clearly say TypeScript compiler, Postgres-backed, app-owned; category still says visual commerce/fashion | A visitor can understand the shape but may misclassify the product as fashion-only | P0 |
| ICP clarity | 5 | Speaks to shoppers, commerce builders, agent docs, entity matching users, and fashion teams | OSS adoption accelerates when one buyer sees themselves immediately | P0 |
| OSS onboarding | 6.5 | Quickstart has install, Postgres extensions, env, collection, push, index, search; still requires Postgres and lacks troubleshooting | Determines whether developers reach first value | P0 |
| Framework generality | 5.5 | DSL is generic; docs/examples are commerce/fashion-heavy | "Framework" claim needs cross-domain proof | P1 |
| Fashion vs domain-neutral balance | 4.5 | Fashion is the first public proof path and dominates examples; electronics appears in benchmarks but not docs | Fashion wedge can become a perception trap | P0 |
| Competitive differentiation | 7 | App-owned Postgres + typed hard filters + explain are genuinely differentiated | Needs explicit comparison pages | P0 |
| Docs completeness | 5.5 | Strong start/tutorial/tuning/eval/integration docs; missing production, roadmap, security, comparisons, FAQ, limitations | Docs are the adoption product for OSS | P0 |
| Eval / proof story | 7 | `BENCHMARKS.md`, eval harness, self-calibration, caveats, fashion + electronics benchmark | Stronger than many early OSS projects, but not yet buyer-packaged | P1 |
| Multilingual credibility | 3 | Entity-resolution has cross-script history; product search docs lack multilingual story | Global commerce teams need confidence before indexing real catalogs | P0 |
| Cross-industry credibility | 4.5 | Electronics benchmark exists; no first-class non-fashion docs/examples for furniture, grocery, B2B, jobs, docs | Prevents "demo disguised as framework" perception | P1 |
| Production readiness story | 5 | Deploy templates, metrics, migrations/tests exist; production doc missing; job adapter experimental | Serious teams need operations answers | P0 |
| Integrations/connectors | 6 | Docs cover Shopify, WooCommerce, Medusa, Porulle; code has Shopify/Woo/JSONL connectors | Connectors reduce adoption friction | P1 |
| Trust / transparency | 6.5 | MIT, NPM packages, benchmarks, explain, caveats; lacks public case studies and security policy | Search is trust-sensitive | P1 |
| Community readiness | 2.5 | No visible contributing/security/roadmap/governance path found | OSS adoption depends on contribution and maintenance confidence | P0 |

## 6. Missing Product Surface

Highest-priority missing pages:

- **Why Samesake?** One page comparing hosted SaaS, search clusters, vector DBs, and pgvector DIY.
- **Core vs templates.** Explain what is framework core, what is commerce-specific, what is fashion-specific.
- **Production guide.** Reindexing, deletes, partial updates, migrations, rollback/index versioning, observability, backups, Postgres tuning, job runners, failure modes.
- **Known limitations.** Scale limits, language limits, no hosted dashboard, experimental jobs adapter, no enterprise SLA, no clickstream personalization.
- **Comparison pages.** Algolia, Typesense, Meilisearch, Elasticsearch/OpenSearch, Vespa, pgvector DIY, vector DB DIY.
- **Evaluation.** Turn `BENCHMARKS.md` into docs-site content with reproducibility tiers: no-model smoke, labeled local eval, live model eval, external dataset eval.
- **Multilingual/global search.** Language matrix, tokenizer/FTS behavior, cross-lingual expectations, RTL/CJK/accent support, provider caveats, eval plan.
- **Non-fashion examples.** Electronics, furniture, grocery, B2B parts, marketplace listings.
- **Security.** API key handling, tenant isolation, prompt/catalog injection risk, model/provider data-flow, webhook verification, secrets policy.
- **Contributing and roadmap.** Version support, issue triage, release process, how to add connectors/templates.

Feature/integration gaps:

- BigCommerce, Magento/Adobe Commerce, commercetools, CSV/Google Merchant Center feed, direct Postgres sync guide, background indexing recipe.
- Hosted demo gallery showing the same framework on fashion, electronics, furniture, and grocery.
- CLI template generator: `samesake init commerce`, `samesake init shopify`, `samesake init pgvector-diy-migration`.
- Migration guides from Algolia, Typesense, Meilisearch, Elasticsearch/OpenSearch, and DIY pgvector.

## 7. Domain Neutrality Assessment

Samesake is not technically fashion-only, but it currently **feels fashion-first enough to create a limiting perception problem**.

Evidence:

- README line 3 says "visual commerce, starting with fashion."
- README line 14 starts with "60-second fashion search."
- Public docs "What is samesake" line 8 repeats "visual commerce, starting with fashion."
- The deepest proof path is `examples/fashion-search`.
- The package template includes `packages/sdk/src/templates/fashion.ts`.
- Public docs include a Porulle fashion app guide and fashion-tuning examples.

Counter-evidence:

- The core DSL uses generic `collection`, fields, embeddings, filters, channels, spaces, and facets.
- Quickstart is generic product catalog code, even if the sample records are dresses.
- `BENCHMARKS.md` includes an out-of-domain electronics slice with hand-assigned relevance labels.
- Integration docs for Shopify/Woo/Medusa are not fashion-specific.

Recommended interpretation:

- Keep fashion as the proof wedge, but stop making it the category.
- Lead with **commerce product discovery**, then say "fashion is the first template and proof path."
- Add domain templates without polluting core: `fashion`, `electronics`, `furniture`, `grocery`, `marketplace`.

Domain fit:

| Domain | Current credibility | Why |
|---|---|---|
| Fashion | High | Template, enrich pipeline, visual examples, benchmarks |
| Electronics | Medium | Benchmark evidence exists; docs example missing |
| Furniture/home | Low-medium | Same primitives apply; no example/proof |
| Grocery | Low-medium | Filters and availability fit; no example/proof |
| Beauty | Medium | Similar to fashion; no template yet |
| B2B parts | Low | Needs SKU/fitment/part-number guidance |
| Real estate/jobs | Low | Framework may work, but positioning should not chase this now |
| Documentation search | Low | Existing category is commerce/product discovery, not docs/RAG |
| Marketplace listings | Medium | Strong fit if examples show seller/location/condition/freshness |

## 8. Multilingual and Global Readiness

Product credibility is currently weak. The repo has multilingual heritage in entity resolution, and the research dossier identifies Sinhala/Tamil/Latin cross-script capabilities in matching, but the public product docs do not explain multilingual product search.

Missing from docs:

- Which parts are language-agnostic.
- Which parts depend on Postgres English FTS.
- Whether CJK tokenization works.
- Whether right-to-left scripts are supported.
- Accent/diacritic behavior.
- Cross-lingual query-to-catalog behavior.
- Provider/model limitations.
- Multilingual evals.
- Code-mixed commerce query handling.

Recommendation:

1. Add a "Multilingual search" page immediately, even if the message is "experimental, evaluate with your catalog."
2. Add a language matrix with statuses: English, accented Latin, Spanish/French/German, Sinhala/Tamil, Hindi, Arabic/RTL, Japanese/CJK.
3. Add a small multilingual regression fixture with expected behavior and no-result behavior.
4. Make product-search FTS language strategy explicit: default English config, configurable language, or embedding-first fallback.

## 9. OSS Readiness

Strengths:

- MIT license.
- Public NPM packages for `@samesake/core`, `@samesake/server`, and `@samesake/cli`.
- Clear TypeScript package split.
- Runnable no-model examples.
- Tests exist across server/core behavior, including migrations, observability, policy, search, spaces, connectors, and explain.
- Public docs are deployed at https://samesake-docs.pages.dev/.
- Benchmarks are unusually candid about caveats and failed gates.

Weaknesses:

- No visible top-level `CONTRIBUTING.md`, `SECURITY.md`, `ROADMAP.md`, or code of conduct.
- Version story is inconsistent in docs: README says packages at 1.0.0 while NPM reports core/server at 1.3.0 and CLI at 1.2.0.
- Package keywords do not strongly target search/product discovery.
- No visible public issue roadmap or "good first issue" path.
- No support policy, compatibility matrix, or release cadence.
- No migration/deprecation policy for the DSL.

Adoption score: **6/10 for prototyping, 4/10 for serious production adoption.**

## 10. Roadmap

### 0-2 Weeks: Fix Adoption Clarity

1. Rewrite homepage and README opening around **Postgres-native product discovery framework**, not "visual commerce starting with fashion."
2. Add "Why Samesake?" with four alternatives: hosted commerce SaaS, OSS search engine, vector DB DIY, pgvector DIY.
3. Add "Core vs templates": core DSL, commerce assumptions, fashion template, entity matching.
4. Add one non-fashion quickstart example: electronics or grocery, no LLM.
5. Add `CONTRIBUTING.md`, `SECURITY.md`, `ROADMAP.md`, and "known limitations."
6. Fix version/package drift in README and package metadata.
7. Add a docs page for benchmark/proof, moving the key `BENCHMARKS.md` caveats into public navigation.
8. Add a minimal "Production checklist" page to replace the missing `docs/production.md` reference.

### 2-6 Weeks: Build Trust

1. Productize evals: `samesake eval init`, labeled JSON schema, nDCG/Recall/P@k, constraint compliance, duplicate/variant checks.
2. Add domain examples: electronics, furniture, grocery. Each should include catalog modeling, filters, ranking signals, eval queries, and bad-query behavior.
3. Add multilingual regression suite and docs matrix.
4. Add operational docs: reindexing, deletes, partial updates, migrations, rollback/index versioning, observability, backup/restore, Postgres tuning.
5. Add comparison pages for Algolia, Typesense, Meilisearch, Elasticsearch/OpenSearch, Vespa, pgvector DIY, and vector DB DIY.
6. Add connector docs for CSV/JSONL and Google Merchant Center feeds.
7. Add debug/tracing docs around `/search/explain` with before/after tuning examples.

### 6-12 Weeks: Expand Adoption

1. Ship `samesake init` templates for generic commerce, Shopify, WooCommerce, Medusa, electronics, and fashion.
2. Add migration guides from Algolia, Typesense, Meilisearch, Elasticsearch/OpenSearch, and DIY pgvector.
3. Build hosted demo gallery with same UI across multiple domains.
4. Add BigCommerce, Magento/Adobe Commerce, commercetools, and direct Postgres sync guides.
5. Publish stable API/versioning policy and deprecation rules.
6. Add public benchmark corpus strategy: small bundled fixtures, optional real-catalog harness, and external-dataset recipes.
7. Add community contribution path: connector/template contribution guide, issue templates, release checklist.

## 11. Prioritized Recommendations

P0:

- Pick one category: **Postgres-native product discovery framework**.
- Make fashion a template/proof path, not the product category.
- Add production, limitations, security, contributing, roadmap, and comparison pages.
- Fix README/package version drift and NPM keywords.
- Add at least one non-fashion public example.

P1:

- Productize evals as a first-class adoption feature.
- Build multilingual docs and regression tests.
- Add migration guides and direct competitor comparisons.
- Package `/search/explain` as a trust story for both developers and agents.

P2:

- Build connector/template ecosystem.
- Add hosted demos and case-study-quality proof.
- Add advanced merchandising controls only after the retrieval/eval/ops foundation is trusted.

## 12. Evidence Reviewed

Local artifacts:

- `README.md`
- `BENCHMARKS.md`
- `CHANGELOG.md`
- `package.json`
- `packages/*/package.json`
- `packages/*/README.md`
- `apps/docs/src/content/docs/**`
- `deploy/README.md`
- `examples/**`
- `packages/server/test/**`
- `docs/research/conversational-commerce-search/**`
- Public docs fetched from https://samesake-docs.pages.dev/
- NPM package metadata for `@samesake/core`, `@samesake/server`, `@samesake/cli`

Key local evidence:

- Homepage says TypeScript search engine compiler, hard filters, image/intent, two-container production: `apps/docs/src/content/docs/index.mdx`.
- "What is" page says visual commerce starting with fashion, Postgres-backed, no hosted vector DB: `apps/docs/src/content/docs/start/what-is-samesake.mdx`.
- Quickstart covers install, Postgres extensions, env, collection, push, index, search: `apps/docs/src/content/docs/start/quickstart.mdx`.
- README documents search modes, explain, eval/calibration, connectors, examples, and architecture.
- `BENCHMARKS.md` includes fashion + electronics benchmark evidence and honest caveats.
- `deploy/README.md` references `docs/production.md`, which is missing in the current worktree.
- `npm view` reports `@samesake/core` and `@samesake/server` at 1.3.0, `@samesake/cli` at 1.2.0.

External sources:

- Algolia: https://www.algolia.com/
- Typesense: https://typesense.org/
- Meilisearch: https://www.meilisearch.com/
- Constructor: https://constructor.com/
- Bloomreach Discovery: https://www.bloomreach.com/en/products/ecommerce-search/search-intelligence
- Coveo Commerce: https://www.coveo.com/en/solutions/ecommerce-search-platform
- Athos/Klevu/Searchspring: https://athoscommerce.com/, https://www.klevu.com/, https://searchspring.com/
- Elasticsearch vector search: https://www.elastic.co/docs/solutions/search/vector
- OpenSearch vector search: https://docs.opensearch.org/latest/vector-search/
- Vespa hybrid search: https://docs.vespa.ai/en/learn/tutorials/hybrid-search.html
- pgvector: https://github.com/pgvector/pgvector
- Qdrant hybrid queries: https://qdrant.tech/documentation/search/hybrid-queries/
- Weaviate hybrid search: https://docs.weaviate.io/weaviate/search/hybrid
