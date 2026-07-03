# Stage-Fit Audit & Iron-Out Plan

Status: Ready for review · 2026-07-02.
Companion to [`system-behavior-spec.md`](./system-behavior-spec.md) (what the system does). This doc is the
verdicts: what fits the stage, what is baggage, and the ordered plan to become **the enrichment +
fast-search toolkit anyone can replace their ecommerce search with — especially multi-vendor
marketplaces — with DX as a moat**.

Stage assumption: pre-adoption OSS product, catalogs well under 10M SKUs, no behavioral/click data
at any installation yet.

---

## 1. Infrastructure & abstraction verdicts

| Item | Verdict | Why |
|---|---|---|
| **Postgres + pgvector only, two containers** | **KEEP — it's the moat, not a shortcut** | Research is unanimous: 100k–1M products fit comfortably; the HNSW-in-RAM wall is ~10M×1536d, 100× beyond ICP. "Start with what your engineers know" / "libraries before databases" (MICES). Adding Elasticsearch/Typesense/VectorChord now is planning for scale we don't have; AGPL traps besides. |
| **RRF (k=60) hybrid fusion** | **KEEP** | The industry's standard pre-LTR fusion. Keep the seam swappable for a learned reranker later; expose per-arm provenance now (explain already does). |
| **BYO embed/generate/rerank** | **KEEP, but incomplete** | Model rankings reshuffle per catalog (idealo). But un-tuned models are the #1 failure mode — BYO without shipped provider adapters + guardrail defaults is DX friction masquerading as flexibility. See P0-3, P1-2. |
| **`ts_rank_cd` lexical leg, hardcoded `'english'`** | **CHALLENGE — the one genuine quality ceiling** | No IDF/BM25, no multilingual, while cross-script primitives already exist in-repo for the entity path. Fix the free wins now (`setweight`, wire `samesake_normalise`/`samesake_phonetic`, configurable FTS config); BM25 extension bake-off **only if the eval proves lexical is the bottleneck** (deployment decision, not code). |
| **StorageAdapter half-migration** | **STOP the migration; shrink the abstraction** | 8 core modules still run raw SQL via `client()`. A second dialect has no demand signal; Postgres-only *is the pitch*. Declare PostgresAdapter the only backend, keep it as the tidy home for shared queries, delete the "future dialect" aspiration from the doc comment. Don't spend more sessions relocating methods (s59 was one). |
| **Entity-resolution product (`entity()`/match)** | **QUARANTINE, then decide** | 2,000+ lines, 9 routes, 8 CLI commands, one internal consumer (bom-quotation). It is not the ecommerce-search product — but **cross-merchant SKU dedup is load-bearing for multi-vendor marketplaces** (DoorDash). End state: keep the *capability*, re-aim it as marketplace offer-dedup (same product from N vendors → one result with N offers) instead of a general record-linkage toolkit. Until that build starts, stop expanding its surface. |
| **Fashion template** | **KEEP as the proof path; stop the leaks** | Great-defaults-by-template is the right generality mechanism. But fashion leaks into the generic core: `fashionSearch` on the Matcher, `/fashion-search` route, fashion-hardcoded eval constraint fields. Templates must be additive, not baked in. |
| **Typed spaces (`space_vec`)** | **KEEP** | Differentiated, now intent-safe via `mode`. No MICES team has an equivalent typed-multi-signal column; it's the "compiler" story made real. |
| **Agent tools / MCP surface** | **KEEP — promote** | dm-drogerie runs a public MCP server over their search; "one retrieval stack, assistants as thin clients" is exactly Zalando/Coveo guidance. This is a differentiator for the agentic-commerce wave. |
| **Inline pipelines, no job runner** | **KEEP** | Durability via the caller's platform (6 guides) is stage-honest. Building an internal queue is speculative infra. |
| **In-process search cache** | **KEEP** | Sufficient at stage; a shared cache is scale we don't have. |

## 2. Executed this session (verified: `tsc --noEmit` clean, sdk 4/4, server 253/253 pass)

1. **Deleted the legacy fashion preset layer** — `fashionAttributes`, `fashionAttributeSchema`,
   `fashionEnrichmentPreset`, `fashionSearchPreset` (~215 lines, `packages/sdk/src/index.ts`).
   Zero code callers; a second divergent fashion vocabulary competing with the live `fashion.*`
   template. Updated the one stale doc (`guides/conversational-search.mdx`) to the live template.
2. **Deleted the deprecated `DEFAULT_PRODUCT_PARSE_INSTRUCTIONS` alias** ("removed in 0.7.x", we
   ship 2.6.0); server now exports the canonical `DEFAULT_PRODUCT_PARSE_BODY`.
3. **Fixed the README version lie** (1.0.0 → 2.6.0, added `@samesake/mcp`).
4. **Archived 37 root process files** (`*-implementation-notes.md`, `*-scratchpad.md`,
   `AUDIT-SUMMARY.md`, `bom-quotation-feature-audit.csv`) into `docs/notes/`. Root now presents as
   a product repo, not a build log.
5. **Wrote the missing baselines**: `docs/system-behavior-spec.md`.

### Follow-up session (same day) — P0-2 + Tier-0 defaults shipped (261/261 tests, all 3 release-gate examples pass)

6. **Found and fixed a silent break in the minimal path**: since the S1c indexing migration,
   collections without an enrich pipeline indexed nothing (surfaces were only built during
   enrich; `hello-search`, quickstart, and the README example were all broken — "expected 5
   indexed, got 0" — and no CI runs the examples). `indexing` is optional again:
   `CollectionEmbeddingDef.source` is restored, and `embed-index` composes surfaces inline
   (declared surfaces when present, else source-template + searchable-field defaults).
7. **halfvec by default**: collection `embedding`/`space_vec` are `halfvec` with
   `halfvec_cosine_ops` HNSW (schema-gen + migration planner); dim ceiling 4000 for collections,
   2000 kept for entity `vector` columns; apply fails fast on pgvector < 0.7.
8. **Iterative index scans + `efSearch`**: `SET LOCAL hnsw.iterative_scan = relaxed_order` on
   vector legs (pgvector ≥ 0.8, version-detected), `efSearch` (10–1000) exposed in SearchOpts and
   the HTTP search routes, both scoped per query via a `SET LOCAL` transaction
   (`StorageAdapter.unsafeWithSettings`).
9. **Weighted lexical leg**: `fts` generated column is now
   `setweight(fts_src_a,'A') || setweight(fts_src,'B')`; opt-in via
   `f.text({ searchable: true, ftsWeight: "A" })` or an fts indexing surface with `weight: "A"`;
   dead `CollectionTextFieldDef.weight` removed.
10. **Filtered-recall + default-surface test coverage** (`test/default-surfaces.test.ts`):
    hard filter returns every match despite adversarial vectors; setweight A-beats-B proven;
    halfvec column type asserted. Changeset: `.changeset/tier-zero-defaults.md` (major).

### P0 session (2026-07-02) — P0-1/3/4/5 shipped (265/265 tests, tsc clean, all 3 release-gate examples pass)

11. **P0-1 `removeDocuments` on every surface**: HTTP `DELETE …/documents` (body `{ids}`) + CLI
    `samesake remove --ids=…` join the existing in-process method; catalog-sync deletes now route
    through it. Proof: `test/remove-documents.test.ts` push → index → search finds → HTTP delete →
    search returns nothing (both surfaces).
12. **P0-3 de-fashioned the core**: `fashionSearch`/`/fashion-search` → vertical-neutral
    `shopSearch`/`/shop-search` (+ `syncCatalogEvent`/`/catalog-sync`, split into
    `core/catalog-sync.ts`); no-results relaxation is collection-declared
    (`CollectionSearchDef.relaxableFilters`, template fragment `fashion.searchDefaults()`); eval
    constraints are schema-driven in the search filter vocabulary (`{price:{$lte:N}}`), golden
    files migrated. Grep gate shipped as `test/defashion-gate.test.ts` — zero fashion symbols in
    `src/core/*`. SDK types renamed (`ShopSearch*`, `ShopperContext`, `CatalogSyncEvent`);
    `FashionRankingPolicy` deleted; `fashionRerank` → `llmRerank`.
13. **P0-4 judge honesty**: shared 4-class ESCI rubric (E=3/S=2 soft positive/C=1/I=0,
    default floor 2) across `makeLlmJudge` and `evaluateSearch`; judge version content-hashed
    (`esci-v1@<sha256(rubric)[:8]>`) so prompt edits invalidate caches; same-family enrich+judge
    rejected in `runEval` + `evaluateSearch`/`calibrateSearch` (+ HTTP `judgeModel` field).
    Retrieval flatness vs tier0post is proven deterministically: the entire retrieval path
    (search.ts, search-query.ts logic, search-filter, embed, ranking, nlq, db/) is untouched this
    session and the eval matcher wires no reranker — same code + same index ⇒ identical topIds.
    The judged cross-family baseline (gpt-4.1-mini over the Gemini-enriched corpus) is
    **minted**: `evals/runs/2026-07-02T16-01-22-852Z-search-p0honesty.json` — mean grade@5
    1.881, nDCG@5 0.901, no-results 0% (flat-or-better vs tier0post 1.878/0.902; topIds
    61/62 identical, the one delta being embedding float jitter on a pure-semantic query).
    This artifact is the honest baseline for future gates.
14. **P0-5 one env contract**: `SAMESAKE_DATABASE_URL` / `SAMESAKE_API_KEY` canonical across
    `.env.example`, README, docs, examples, apps, tests, CLI; `apps/matcher` shim deleted;
    provider keys provider-named (`GEMINI_API_KEY`, `OPENAI_API_KEY`);
    `GOOGLE_GENERATIVE_AI_API_KEY` no longer read. No fallback aliases.
    All folded into `.changeset/tier-zero-defaults.md` (pending major).

### P1 session (2026-07-02) — the DX pack shipped (301/301 tests, tsc clean, all 3 release-gate examples pass)

15. **P1-5a CI**: `.github/workflows/ci.yml` gained `test` + `examples` jobs on a
    `pgvector/pgvector:0.8.0-pg16` service container (never Neon). **Inactive by user request**
    (`workflow_dispatch` only; PR+main trigger left as a comment for one-line activation).
16. **P1-5b trust surface**: CONTRIBUTING.md, SECURITY.md, ROADMAP.md, `docs/production.md`
    (the guide deploy/README referenced but never existed), root `test`/`lint` scripts (oxlint).
    Fixed a doc lie: deploy/README recommended the non-existent `@samesake/jobs-pgboss`.
17. **P1-1 `samesake init`**: scaffolds a complete runnable project (config, docker-compose
    Postgres, ~20-line server, deterministic local embedder — no LLM key, 24-product seed, .env).
    Timed zero-to-first-search ≈16s of command time on published npm 3.0.0 packages.
18. **P1-2 `@samesake/providers`**: zero-dep Gemini/OpenAI/Voyage/Cohere factories for
    embed/generate/parse/rerank + a Vercel AI SDK bridge subpath (optional `ai` peer). The three
    apps' hand-rolled glue deleted: **+19/−232 lines**.
19. **P1-3 result cutoff**: `search.cutoff` strategies (score-drop default ON,
    category-coherence, none); FTS-anchored hits never cut; hard-filtered queries bypass.
    Adversarial proof: "laptop" vs a clothing catalog → 0 hits (`test/cutoff.test.ts`).
20. **P1-4 multilingual lexical leg**: `CollectionDef.language` (both hardcoded `'english'`
    sites gone), `samesake_normalise` in the fts column + accent-folded queries,
    `search.phonetic` cross-script branch via new `samesake_phonetic_tokens`; multilingual
    goldens `ml-01…ml-05` in the eval set (`test/multilingual-search.test.ts`).

### P1 close-out (2026-07-03)

21. **Eval regression proof + judge-cache fix**: p1cutoff run flat-vs-baseline (1.883/0.901/0%,
    61/62 identical topIds, 0 blanked); found + fixed `evaluateSearch`'s fire-and-forget grade
    write (grades now byte-stable across runs, 67/67). p1cutoff is the new curated baseline.
22. **P1-6 repo presentation**: evals/runs gitignored with curated `!`-exceptions (22 noise
    artifacts untracked), playground back to `workspace:*`, porulle override documented as
    droppable once playground upgrades off `@porulle/*@0.1.0` (upstream fixed in 0.8.0).
23. **"Why Samesake?"** page shipped (`start/why-samesake`), quickstart leads with
    `bunx @samesake/cli init`, providers reference leads with `@samesake/providers`.
    Docs build 31 pages. Playground search-relevance WIP finished (judge-outage fallback, 5/5);
    dead deps removed (matcher: pg-boss/xlsx; ecommerce-assistant: ai).

**P1 is complete.** Next: P2 (marketplace wedge).

### P2 session (2026-07-03) — P2-1 tenancy shipped (313/313 tests)

24. **P2-1 tenancy for collections**: `CollectionDef.scopes` → indexed `scope_<key>` columns +
    MANDATORY scope on every surface (push/connectors/search/facets/explain/get/grep/remove/
    eval; HTTP bodies + `scope.<key>=` GET params; CLI `--scope k=v`); cross-tenant id-takeover
    guard; scope-keyed search cache; scopes change = destructive migration. Isolation proof:
    `test/tenancy.test.ts` (12 tests — identical titles in two tenants never leak either
    direction). Design: scopes are hard isolation ("whose catalog"); vendor-in-marketplace stays
    a facet; ids remain collection-unique (composite-PK autonomy deferred until demanded).
    Bonus root-cause fix: score-drop cliff baseline can be raised (never lowered) by anchored
    hits — junk tails behind keyword matches now cut; eval-verified retrieval-neutral on the
    real corpus (topIds 67/67 identical, p2tenancy baseline minted).

25. **P2-2 cross-vendor offer dedup** (C1–C9): `CollectionDef.dedup`
    (exactKey/trigram/cosine channels, autoLink/suggest two-band, offerFields) clusters
    same-product listings via an explicit incremental `matcher.dedup()` stage; search collapses on
    the cluster id and attaches an `offers` array (declared fields only, one batched query/page,
    quarantined members drop out). Human loop: suggestions → `confirmGroup` / `splitGroup` with
    decline memory surviving re-runs + `{rebuild:true}`. HTTP (5 routes) + CLI parity. Candidates
    are scope-pinned → clusters never span tenants. `matcher.dedup` repurposed to collection dedup;
    the entity engine + `/duplicates` route untouched. Proof: `test/dedup.test.ts` (19 tests —
    scoring, 3-vendor cluster / distinct no-cluster, offers + quarantine, suggest→confirm→split,
    cross-scope isolation, HTTP lifecycle); dedup-less collections eval-verified inert
    (topIds 67/67 vs p2tenancy baseline).

Remaining P2: enrichment ROI upgrades (3), staged rollout (4), training-pair export (5).

## 3. The iron-out backlog (ordered; each item names its proof)

### P0 — correctness & honesty (the product's claims must be true)

1. **Generic `removeDocuments`** on the Matcher. Docs already promise it; only fashion-sync can
   delete. A search engine you can't delete from is not replaceable-search. *Proof: integration
   test push→delete→search returns nothing; docs claim matches code.*
2. **Filtered-recall eval + pgvector iterative scans (0.8) + `halfvec` default.** "Hard filters
   stay hard" is unverified under filtered-ANN over-filtering — the exact collision point NLQ
   creates (dm leans on native ANN filters; this is our equivalent risk). `halfvec` is a
   day-one-or-painful retrofit. *Proof: new eval slice measuring recall under hard filters,
   before/after.*
3. **De-fashion the generic core.** Move `fashionSearch`/`/fashion-search` behind the template
   (collections declare facades, core stays neutral); make eval constraint fields
   (`run.ts:62–78`) schema-driven instead of price/color/gender/category-hardcoded. The 360-audit
   guardrail ("fashion logic out of `core/*`") is currently violated. *Proof: grep gate — no
   `fashion` symbol imported by `packages/server/src/core/*` except the template seam; eval runs
   against a non-fashion collection.*
4. **Judge-family separation + ESCI-grade rubric.** Never enrich and judge with the same model
   family (self-preference flatters our own LLM-written `search_document`); version-pin/hash the
   judge prompt; grade 4-class Exact/Substitute/Complement/Irrelevant with Substitute as soft
   positive (four independent MICES sources). *Proof: eval config rejects same-family
   enrich+judge; golden runs re-scored on the 4-class rubric.*
5. **One env contract.** Canonical `SAMESAKE_DATABASE_URL` / `SAMESAKE_API_KEY` (namespaced —
   we're embedded in host apps) everywhere: `.env.example`, docs quickstart, README, examples;
   delete the mapping shim in `apps/matcher/src/index.ts`. No fallback aliases (alpha — break it).
   *Proof: grep for the old names returns only CHANGELOG.*

### P1 — adoption path (DX as moat)

1. **`bunx samesake init`: zero-to-searching in ≤10 minutes.** Scaffold `samesake.config.ts` + a
   Docker Compose (Postgres with all 4 extensions preinstalled) + the ~40-line `apps/matcher`
   server as the template, seeded sample catalog. Today the cleanest on-ramp is buried in `apps/`.
   *Proof: fresh-machine walkthrough, timed.*
2. **Shipped provider adapters** — `@samesake/providers` (or core-adjacent): Gemini, OpenAI,
   Voyage/Cohere `embed`/`generate`/`rerank` factories. Every consumer currently hand-rolls the
   same 40–110 lines of Gemini glue; Mastra's one-method provider interface is the shape to
   borrow. BYO stays; the default just stops being "write it yourself." *Proof: playground +
   ecommerce-assistant + matcher consume the adapter; hand-rolled copies deleted.*
3. **Result-cutoff strategies + designed zero-results.** Pluggable: threshold table / score-drop
   detector / category-coherence / judge gate. A single `relevanceFloor` float is
   known-insufficient (Delivery Hero, Digitec: bad results are worse than honest zero results).
   *Proof: adversarial eval suite ("laptop" in a clothing store) passes with each strategy.*
4. **Multilingual lexical leg.** Configurable FTS config + wire the existing
   `samesake_normalise`/`samesake_phonetic` into collection search (they already serve the entity
   path). The #1 quality investment per BUILD-READY; unblocks non-English adopters. *Proof:
   multilingual golden queries added to eval; cross-script retrieval demonstrated.*
5. **OSS trust surface**: CONTRIBUTING, SECURITY, ROADMAP, CI running typecheck + both suites +
   release-gate examples, root `test`/`lint` scripts, the missing production guide
   (`deploy/README.md` references it), "Why Samesake?"/comparison page. *Proof: files exist, CI
   green on PR.*
6. **Repo presentation**: gitignore `.agents/ .codex/ .metadata_cache/ .wrangler/`; decide
   `evals/runs/` policy (commit curated baselines, ignore the rest); commit or fold the untracked
   `docs/design`; playground back to `workspace:*` and resolve the
   `porulle#24` override.

### P2 — the marketplace wedge (the differentiated bet)

1. **Tenancy model for collections.** `scopes` on `CollectionDef` (the entity side already has
   it) → compiled to a scoped column + mandatory filter, per-scope quotas/keys optional. "Replace
   your marketplace search" requires a first-class answer to "whose catalog is this row?"
2. **Cross-vendor offer dedup** — re-aim the existing match/dedup engine at "same product, N
   vendors → one result, N offers." This is where the bolted-on second product becomes the
   marketplace moat (DoorDash flags exactly this as load-bearing for multi-vendor).
3. **Enrichment upgrades with proven ROI** (in order): per-row ANN-retrieved few-shots
   (PatternRAG +34% recall — sibling products fill missing attributes, compounds in multi-vendor
   catalogs); waterfall/tiered extraction (cheap precise tiers before vision LLM); version lineage
   on enrich outputs (re-embed without re-LLM); LLM image-captions→text as the Postgres-friendly
   visual signal (Pinterest OmniSearchSage) before any raw-CLIP ambition.
4. **Staged-rollout routing primitive** — per-query-segment switch (zero-results → low-results →
   all queries); how every MICES team shipped hybrid safely. For samesake it's how an adopter
   migrates off their incumbent search incrementally — the actual "replace your search" motion.
5. **Training-pair export** (click positives + taxonomy/same-SERP negatives + de-biasing hooks) so
   adopters with traffic can fine-tune their BYO models and plug back in.

### Explicit non-goals at this stage (challenged and rejected)

LTR/learned ranker (no click data), SPLADE/ColBERT (license + stack traps), second storage dialect,
internal job queue, personalization/behavioral CF, semantic IDs, generative carousels, checkout —
and **precision micro-optimization as a conversion play** (OTTO + Walmart measured null; treat
precision as a guardrail metric).

## 4. Direction note

This plan supersedes the earlier "internal fashion tool, shelve OSS ambitions" posture: the goal is
explicitly a replaceable ecommerce search + enrichment product, multi-vendor marketplaces first.
Fashion remains the proof-path template, not the category. Sequencing: P0 makes the current claims
true → P1 makes adoption frictionless → P2 builds the marketplace wedge no incumbent OSS
alternative has (the one direct analog, Marqo OSS, is deprecated; the slot is open).
