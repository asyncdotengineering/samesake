# iron-out-stand — implementation notes (2026-07-02)

Session: YouTube (MICES) research + system mapping + behavior spec + stage-fit audit + first
debt removals. Autonomous IC mode.

## Load-bearing assumptions / decisions not in the spec

1. **Direction pivot accepted as stated.** The prompt ("anyone should be able to replace their
   current ecommerce search with our product, especially multi-vendor marketplaces") supersedes the
   June "internal-only, shelve OSS ambitions" call. Memory updated; the old posture is preserved as
   history inside the memory file.
2. **"Plan for scale we do not have"** read as *don't* plan for scale we don't have, consistent
   with the adjacent "challenge any infrastructure or abstraction that does not fit this stage."
3. **"Relevant videos related to samesake"** — the channel (MICES conference) never mentions
   samesake; interpreted as talks relevant to samesake's problem space. 11 of 30 talks selected,
   captions pulled, synthesized to `docs/research/mices/README.md`.
4. **Root scratchpads were moved, not deleted** (`docs/notes/`), tracked files via `git mv`.
5. **`DEFAULT_PRODUCT_PARSE_INSTRUCTIONS` export replaced by `DEFAULT_PRODUCT_PARSE_BODY`**
   (the canonical name) so the documented "reuse the default prompt" use-case survives. Breaking
   change, allowed by the alpha/no-compat rule.
6. **Legacy fashion preset layer deleted outright** (no deprecation period): zero code callers,
   divergent duplicate vocabulary vs the live `fashion.*` template.
7. **Plan Desk MCP tools were not available in this session** (per instructions, saying so);
   harness task list used instead.

## Root causes found

- README claimed 1.0.0 because "Status & naming" was written pre-2.x and never touched by release
  automation — consider folding the version claim into the changeset release step.
- One flaky server test observed (fail on run 1, 253/253 pass on run 2) — DB-timing related, not
  investigated further; worth a look if it recurs.

## Verification

- `bun run typecheck` — clean.
- `packages/sdk` tests 4/4; `packages/server` tests 253/253 (second run; first run had 1 flaky fail).
- `apps/docs` `bun run build` — 30 pages, success (verifies the conversational-search.mdx edit).
- Greps confirm no residual references to removed symbols outside `dist/` build artifacts
  (regenerated on next build).

## Follow-up session — Tier-0 defaults (halfvec, iterative scans, efSearch, setweight) + minimal-path fix

- **Root cause found while verifying**: `hello-search` (a release gate) failed at baseline —
  commit `3d59088` (S1c) removed embedding-`source` resolution from core, so collections without
  an enrich pipeline never populated `doc` and indexed zero rows. The SDK type had also made
  `indexing` required, so the README/quickstart code didn't even typecheck. Fixed both:
  `indexing` optional, `source` restored, surfaces built inline at index time (declared surfaces
  win; enrich-owning collections unchanged). Lesson feeding P1-5: CI must run the release-gate
  examples.
- Entity-resolution tables deliberately stay `vector` (2000-dim HNSW cap); only collections moved
  to `halfvec` (4000 cap). `assertIndexableVectorDimension` now takes `columnType`.
- `SET LOCAL` settings require one transaction — added `StorageAdapter.unsafeWithSettings` using
  the raw postgres-js `begin` (`getPgSql` in `core/db-utils.ts`). `pgvectorVersion()` is cached
  per adapter instance.
- setweight is opt-in mechanism only (`ftsWeight: "A"` / fts surface `weight: "A"`): no existing
  config changes behavior until someone declares a weight, so no relevance regression risk; the
  fashion template still ships title-only fts (already effectively top-weighted).
- fp16 note: halfvec round-trip loosens L2 norms to ~1e-3 (one test precision relaxed 4→3).
- Tests are on a **Neon** database — 5s default timeouts flake under latency (two unrelated
  migration tests each flaked once, passed on rerun); heavy setup moved into a 60s test block.
- Verification: `tsc --noEmit` clean; server suite **261/261** (was 253, +8 new); sdk 4/4;
  `hello-search`, `hello-spaces`, `quickstart` examples all pass (hello-search failed at
  baseline). Breaking-change changeset: `.changeset/tier-zero-defaults.md`.

## P1 session (2026-07-02) — the DX pack

### P1-5a CI

- `.github/workflows/ci.yml` extended: existing `typecheck` job kept; added `test` (sdk + server
  suites) and `examples` (hello-search, hello-spaces, quickstart) jobs, each against a
  `pgvector/pgvector:0.8.0-pg16` service container (contrib ships pg_trgm/unaccent/fuzzystrmatch;
  `migrate()` runs `CREATE EXTENSION IF NOT EXISTS` for all four). CI never touches the Neon dev DB.
- Tests run from the repo root so the root `bunfig.toml` 20s test timeout applies.
- **User decisions mid-session**: (1) the workflow must exist but NOT be active — `on:` is
  `workflow_dispatch` only, with the PR+main trigger block left as a comment for one-line
  activation; (2) no local proof run (Docker verification declined). Verification is therefore
  limited to YAML parse (3 jobs, dispatch-only) — the pipeline has not been executed end-to-end.

### P1-5b Trust surface

- `CONTRIBUTING.md`, `SECURITY.md`, `ROADMAP.md` (distilled P0→P2 from the plan doc),
  `docs/production.md` (the guide `deploy/README.md` referenced but which never existed — gap F4).
- Root scripts: `test` = `bun test packages/sdk packages/server` (root cwd so bunfig timeout
  applies — verified path-filtering works), `lint` = oxlint over the four packages' `src/`
  (new devDep `oxlint@^1.72`; zero-config, currently 0 errors / ~30 warnings, exit 0).
- **Found + fixed a doc lie**: `deploy/README.md` recommended `@samesake/jobs-pgboss`
  (**experimental**) — no such package exists anywhere in the repo. Replaced with the real
  pipeline guides (Inngest/Upstash/CF/Vercel).
- Verified: `bun run lint` exit 0; every relative link in the new docs resolves.

### P1-1 `samesake init`

- `packages/cli/src/init.ts`: `samesake init [dir] [--force]` scaffolds a complete runnable
  project — `samesake.config.ts` (vertical-neutral products collection), docker-compose
  (`pgvector/pgvector:0.8.0-pg16`, port 54321 to dodge local-Postgres clashes), ~20-line HTTP
  server, `src/local-embed.ts` (deterministic token+trigram hash embedder — **no LLM key needed
  for first search**), 24-product seed catalog, `.env` with generated API key, README. The old
  entity-flavored `init --name` (single config file) is deleted — it scaffolded the quarantined
  product.
- **`bunx samesake init` naming**: the bare `samesake` npm name is our own stale 0.2.0 publish
  (no bin). The command ships in `@samesake/cli` (bin `samesake`), so `bunx @samesake/cli init`
  works today; republishing the bare name as a CLI alias is a release-time follow-up.
- **Timed proof** (scaffold → first search, published npm 3.0.0 packages): scaffold 0.2s,
  `bun install` 2.4s, seed (apply + push 24 + index) 12.2s *against Neon over the internet*,
  first search 1.2s — **≈16s of command time**; with a cold `docker pull` a genuinely fresh
  machine lands well under the 10-minute bar. Deviation: Docker was declined this session, so
  the DB was Neon; `docker-compose.yml` is validated by eye + the identical image/tag is what CI
  uses. Re-run idempotency verified (0 newly indexed, search still green).
- **Root-cause fix found via the walkthrough**: every boot spammed dozens of Postgres NOTICEs
  ("already exists, skipping") — idempotent DDL is the design, so `createDbFromUrl` now sets
  `onnotice: () => {}` (`packages/server/src/db/client.ts`). Scaffold also uses
  `migrate: "manual"` so ad-hoc search scripts never re-run DDL.
- Root README gained a Quickstart section (the on-ramp is no longer buried in `apps/`).
  Changeset: `.changeset/init-scaffolder.md` (cli minor, server patch).
- Checkpoint: workspace `tsc --noEmit` clean; `hello-search` release gate green post-changes.

### P1-2 `@samesake/providers`

- New package (`packages/providers`, 3.0.0): zero-dependency fetch adapters returning exactly the
  matcher's closures — `geminiEmbedder` (multimodal) / `geminiGenerator` / `geminiParser`,
  `openaiEmbedder` / `openaiGenerator` / `openaiParser`, `voyageEmbedder` / `voyageReranker`,
  `cohereEmbedder` / `cohereReranker`. Shared plumbing: lazy env-key resolution, 429/5xx retry
  with backoff, optional `minIntervalMs` call spacing (absorbs the ecommerce-assistant's
  hand-rolled throttle), `baseUrl` override.
- **Mid-session user question ("can we use the AI SDK? learn from Mastra")** → answered with the
  hybrid Mastra actually uses: added `@samesake/providers/ai-sdk` subpath (`aiSdkEmbedder/
  aiSdkGenerator/aiSdkParser/aiSdkReranker`) bridging any Vercel AI SDK model object into the
  seams — `ai` is an **optional** peer dep, only loaded via that subpath. Native fetch adapters
  stay default because AI SDK `embed()` is text-only (samesake's visual spaces need image
  vectors) and because zero-dep installs matter. Notably AI SDK v6 *does* now have `rerank()` —
  bridged too.
- Consumers cut over; hand-rolled glue deleted (`apps/matcher/src/embedder.ts`,
  `apps/playground/lib/{embed,generate}.ts`, `apps/ecommerce-assistant/src/providers.ts`).
  **Diff shrink proof: +19/−232 lines across the three apps.** `ai`+`@ai-sdk/google` removed from
  matcher deps. Also deleted `apps/playground/lib/embed.test.ts` (untracked WIP) — it tested the
  deleted playground copy; equivalent coverage now lives in `packages/providers/test/`.
- ParseFn (zod schema) handled via zod v4's `z.toJSONSchema`; the AI SDK parser passes zod
  natively to `generateObject`.
- Verified: providers tests 15/15 (mock-fetch + `ai/test` mock models), root `tsc --noEmit`
  clean, per-app tsc clean ×3, lint clean, matcher app smoke-booted through the adapter
  (healthz 200 against Neon, pgvector 0.8.0 listed). Root `test`/`lint`/`build` scripts + both CI
  jobs now include the package. Changeset: `.changeset/provider-adapters.md`.
- **Pre-existing red (not mine)**: `apps/playground/lib/search-relevance.test.ts` (untracked WIP,
  3/5 failing) expects judge-fallback behavior `makeLlmJudge` doesn't implement — failures
  predate this session's changes (my diff there is import/signature only) and look like someone's
  mid-TDD state. Left untouched.
- Pre-existing dead weight noticed, not removed (out of scope): `pg-boss` + `xlsx` in
  apps/matcher deps (no imports anywhere), `ai` in apps/ecommerce-assistant (only
  `@ai-sdk/openai` is imported).

### P1-3 Result cutoff + honest zero-results

- `CollectionSearchDef.cutoff` (sdk) + `core/cutoff.ts` (server): strategies `score-drop`
  (default ON for every collection), `category-coherence` (requires `field`), `none`. FTS-anchored
  hits are never cut (lexical match = real evidence); strategies only judge semantic-only hits.
  Shared honest-zero rule: unanchored list whose best cosine < `minAnchor` (default 0.3,
  conservative — calibrate per model like relevanceFloor) → empty. Score-drop adds a relative
  cosine-cliff tail cut (`maxDrop` 0.5); coherence adds top-10 majority-share scatter detection.
- Retrieval evidence (`fts_present`, `cos_sim`) is now always selected by the hybrid SQL (was
  only under relevanceFloor); cutoff runs in `finishSearch` before diversify/rerank. Response
  gains `cutoff_dropped`; metrics gain `search_cutoff_dropped_total`. relevanceFloor untouched
  (it remains the SQL-level threshold strategy; cutoff is the adaptive layer above it).
- **Deviation from the plan text**: bypass is broader than relevanceFloor's — ANY hard filter
  (explicit or NLQ-derived) skips the cutoff, not just NLQ filters. Reason: default-ON cutoff
  with hash/stub-style embeddings would break the P0 "hard filter returns every match despite
  adversarial vectors" guarantee; structured intent defines relevance wherever filters exist.
- **Bug found by unit test**: an FTS-anchored hit with a junk cosine reset the cliff baseline,
  letting an irrelevant semantic tail survive — fixed (only semantic-only hits move the baseline).
- Proof: `test/cutoff.test.ts` — the plan's adversarial eval verbatim ("laptop" vs a clothing
  catalog → 0 hits, `cutoff_dropped` > 0; anchored "red dress" → hits; `none` opts back into
  padding; hard filter + "laptop" → both bags return, recall total; coherence scatter unit tests).
  Full server suite **276/276** (58 files) after the change — default ON regresses nothing —
  and all 3 release-gate examples pass. Docs: tuning-search.mdx §5. Changeset:
  `.changeset/result-cutoff.md` (core minor, server minor).
- Note: the minted p0honesty eval baseline was NOT re-run (LLM eval against Neon; retrieval is
  provably unchanged for anchored/filtered golden queries, and gemini cosines sit well above the
  0.3 anchor). First post-cutoff eval run should confirm nullRate stays 0% on goldens.

### P1-4 Multilingual lexical leg

- `CollectionDef.language` (validated `/^[a-z_]+$/`, default "english") now drives both the `fts`
  generated column and `websearch_to_tsquery` — both hardcoded `'english'` sites are gone
  (collections-schema-gen.ts, search.ts). Doc side normalises via `samesake_normalise`
  (IMMUTABLE, so legal in a generated column); query side folds accents with `unaccent()` only,
  preserving websearch operators (quotes/minus) that full normalisation would strip.
- Cross-script phonetic: new `samesake_phonetic_tokens` system function (installed with the
  phonetic provider) → generated `fts_phon` tsvector column + GIN index when a collection
  declares `search.phonetic: true`; the lex CTE ORs the query's phonetic codes into the candidate
  set and ranks them after AND/OR ts_rank. Declaring phonetic without a provider fails fast with
  a clear error. Enabling it on an existing collection is additive (generated column backfills).
- `makeCollectionsSchemaGen` config gained `systemSchema` + `hasPhonetic` (breaking for the three
  test call sites, updated). Language change on an existing collection → `plan.destructive`
  (the migration differ now compares stored vs incoming `language`).
- **Known migration edge (in changeset)**: pre-existing collections keep the un-normalised fts
  column until recreated; since queries are now accent-folded, accented docs in OLD tables can
  stop matching accented queries until the collection is rebuilt. Alpha-acceptable, documented.
- Proof: `test/multilingual-search.test.ts` — spanish gender-inflection stemming matches where
  the english control doesn't (plural "-s" was a bad probe: english strips it too — first test
  iteration caught that), accent folding both directions, Sinhala "අම්මා" finds Latin "amma"
  via the phonetic branch (and misses without it), language change rejected as destructive,
  injection-shaped language rejected. Multilingual golden queries `ml-01…ml-05` added to
  `evals/golden-queries-fashion-lk.json` for the LLM-judged eval.
- Final sweep: **301/301** tests (62 files) across server+sdk+providers, `tsc --noEmit` clean,
  lint clean, all 3 release-gate examples green. Changeset: `.changeset/multilingual-lexical-leg.md`.

## P1 follow-up session (2026-07-02/03)

### Eval regression re-run (user request 1)

- Re-ran the judged eval (`--phase=p1cutoff`): **mean grade@5 1.883 / nDCG@5 0.901 / no-results
  0%** vs baseline 1.881/0.901/0% — flat-or-better. Per-query: **61/62 identical topIds**; the
  one change ("minimalist wardrobe basics") is a 4/5-overlap reorder on a pure-semantic query —
  the same embedding-jitter class the baseline itself documented. **Zero queries blanked by the
  cutoff.** New `multilingual` bucket: 1.67/0.901, 0% no-results (Gemini embeddings carry
  Sinhala/Tamil semantically). `p1cutoff` is the new curated baseline.
- **Root cause found while comparing**: grades moved on identical topIds because
  `evaluateSearch`'s persisted judge-grade write was fire-and-forget (`void …setStageCache`) —
  writes raced process exit, dropping grades; next run re-rolled the judge. Fixed (awaited);
  proven by two back-to-back runs **byte-identical 67/67** (run B fully cache-served).
  Changeset: `.changeset/judge-cache-await.md`.

### Playground search-relevance WIP (user request 2) — finished, not deleted

- Kept the shared ESCI judge (`makeLlmJudge`); added the missing behavior the tests spec'd: a
  judge outage (every hit marked `reason: "judge-error"`) now falls back to the retrieval
  results instead of emptying the page. Test fakes rewritten to the judge's real
  `{grades:[{id,esci}]}` contract. 5/5 pass.

### Dead deps (user request 3)

- Removed `pg-boss` + `xlsx` from apps/matcher and `ai` from apps/ecommerce-assistant (grep-clean,
  zero imports); installs + per-app tsc green.

### P1-6 repo presentation

- `.gitignore` already covered the agent dirs and docs/{rfcs,research,design} were already
  tracked (284 files) — done in an earlier pass.
- **evals/runs policy**: runs are now gitignored by default with explicit `!`-exceptions for
  curated baselines (final adversarial, enrichment-reenrich-post-final, tier0post, p0honesty,
  p1cutoff); 22 noise artifacts untracked via `git rm --cached` (files remain on disk).
  `evals/.cache/` ignored.
- playground `@samesake/*` deps back to `workspace:*` (tsc green; resolves to packages/ symlinks).
- **porulle override**: upstream fixed in 0.8.0 (adapters publish real semver), but playground
  still pins `@porulle/*@^0.1.0`, so the override stays load-bearing; comment updated with the
  drop condition. Upgrading playground 0.1→0.8 is a functional change, deliberately not done here.

### "Why Samesake?" page + docs pass

- `apps/docs/src/content/docs/start/why-samesake.mdx` — comparison table (hosted search /
  search engines / vector DBs / RAG frameworks), the Postgres-only argument, explicit non-goals,
  and an honest "when to pick something else" section; in the sidebar after "What is samesake".
- Docs updated for the P1 changes: quickstart leads with the `bunx @samesake/cli init` fast path;
  `reference/providers.mdx` now leads with `@samesake/providers` (+ AI SDK bridge) and reframes
  the hand-rolled AI SDK wiring as the fully-custom fallback; the Mastra guide's provider section
  matches the app's real code (adapters, not raw fetch). Cutoff + multilingual sections were
  already added to tuning-search in the previous session. Docs build green: **31 pages**.

## P2 session (2026-07-03) — tenancy for collections (P2-1)

### Design decisions (before code)

1. **Scope semantics = hard isolation** (the plan's words: "compiled to a scoped column +
   mandatory filter"). `scopes: ["tenant_id"]` on a collection means every read/write surface
   requires all scope keys; there is no cross-scope search. Vendor-within-one-marketplace
   (shopper searches all vendors) remains a plain facet field as today — P2-2 offer-dedup will
   operate *within* a scope. Scopes answer "whose catalog is this row", not "which brand".
2. **`id` stays the sole primary key** (Option B). Scoped collections require collection-unique
   ids (marketplace listing/SKU ids are global in practice). The isolation guarantee is enforced
   at the boundaries instead of the PK: reads/deletes are mandatory-filtered, and an upsert that
   would overwrite an id owned by a *different* scope is rejected (cross-tenant takeover
   blocked). Rejected alternative: composite PK (scope, id) — more "right" for id-space
   autonomy but ripples scope-threading through every pipeline row-update (enrich, embed-index,
   retry, review, catalog-sync); revisit only on real adopter id-collision demand.
3. **Column shape mirrors the entity side**: `scope_<key> text NOT NULL` + composite btree
   index. Adding scopes to an existing collection is a destructive migration (existing rows
   have no scope values).
4. **Scope flows per-document on write** (`{ id, scope, data }`, matching entity seeds) and
   per-call on read (`SearchOpts.scope`); connectors can declare a fixed `scope` (one feed =
   one vendor). Pipelines (enrich/embed/retry) are scope-agnostic — they process rows; scope is
   an attribution + access concern, not a processing concern.
5. **Out of scope now**: per-scope quotas/keys (plan marks optional), cross-scope admin search,
   per-scope relevance policy. Review endpoints stay unscoped (operator surface).

### Implementation

- Surfaces wired: schema-gen (`scope_<key> text NOT NULL` + composite index; key validation +
  field-collision guard), migration differ (scopes change → destructive), storage adapter
  (scope-aware upsert with takeover guard via `ON CONFLICT … DO UPDATE … WHERE same-scope
  RETURNING id` — zero rows returned ⇒ cross-scope conflict ⇒ loud error; scoped deletes),
  ingest (per-doc `scope`, connector-pinned scope via `ConnectorDef.scope`), search (mandatory
  `SearchOpts.scope` resolved in `retrieve`, injected as a structural guard beside
  pipeline-status visibility in every CTE), facets (both paths), getDocument/grepDocument,
  shopSearch passthrough, evaluateSearch/calibrate (`SearchEvalQuery.scope`), search cache key
  (scope-separated), HTTP routes (`scope` bodies + `scope.<key>=` GET params), CLI
  (`remove`/`search-explain --scope k=v`). One resolver (`core/scope.ts`) so every surface fails
  with the same message shape.
- **Real bug found by the adversarial test**: the score-drop cutoff couldn't cut a semantic junk
  tail behind an fts-anchored head — the P1 fix stopped anchored hits from LOWERING the cliff
  baseline but also stopped them SETTING it (prev stayed null → no cliff). Rule now: anchored
  hits may raise the baseline, never lower it. Cutoff unit tests still green.
- **Eval verdict on the cutoff fix** (`p2tenancy` run, 1.91/0.913/0%): retrieval provably
  unchanged on the real corpus — **topIds 67/67 identical** to the p1cutoff baseline; with
  gemini embeddings no top-5 cosine falls 50% behind an anchored head, so the stricter tail rule
  only bites degenerate embeddings (exactly the tenancy/unit test cases). The overall-number
  movement vs 1.883/0.901 is residual judge-grade settlement from the pre-fix cache gap (p1cutoff
  predates the awaited-write fix), not retrieval; runs from here compare byte-cleanly.
- Proof: `test/tenancy.test.ts` (12 tests) — NOT NULL scope column asserted via
  information_schema; push without/with-unknown scope rejected; scope on unscoped collection
  rejected; **identical titles in two tenants never leak either direction**; unscoped search on
  scoped collection rejected; facets scoped (foreign category absent); getDocument scoped
  (foreign scope → null); scoped delete removes 0 foreign rows (row still searchable by owner);
  cross-tenant id takeover rejected; HTTP GET search with `scope.tenant_id` + unscoped 4xx;
  scopes change → destructive migration error.

## Where everything lives

- Spec: `docs/system-behavior-spec.md`
- Audit + plan: `docs/stage-fit-audit-and-iron-out-plan.md`
- MICES research: `docs/research/mices/README.md`
- Archived process docs: `docs/notes/`

---

# P2-2 — Cross-vendor offer dedup (RFC `rfcs/rfc-offer-dedup.md`)

Session 2026-07-03. Executing C1→C9 of RFC Section 8. This section is a running log
of decisions not spelled out by the RFC, deviations, and root causes.

## Load-bearing decisions (logged before writing code)

1. **`matcher.dedup` public-method collision — REPURPOSED (safe).** The public
   `matcher.dedup` binding currently points at the *entity* `matchService.runDedup`
   (`{project,kind,scope,...}`). The RFC (REQ-2, §4.2) names the NEW collection dedup
   `matcher.dedup(project, collection, opts?)`. Investigation: the entity dedup is
   consumed ONLY via the HTTP route `GET /v1/projects/:p/duplicates` (which calls
   `services.match.runDedup` directly — see `hello/run.ts`), and the in-process
   `matcher.dedup` binding has **zero** consumers or tests. So the public binding is
   repurposed to the collection dedup; `matchService.runDedup` and the `/duplicates`
   route stay untouched. The entity engine (tables, 9 routes, feedback machinery) is
   left exactly as-is per RFC §2. Verified: no bom-quotation/test reference to the
   in-process `matcher.dedup`.

2. **Eval baseline reference exists** at repo-root
   `evals/runs/2026-07-02T21-56-59-647Z-search-p2tenancy.json` (NOT under
   `examples/fashion-search/` as the task text implies — `eval-search.ts` resolves
   `REPO_ROOT = <repo>` and writes to `<repo>/evals/runs/`). Gate #4 diffs the
   `--phase=p2dedup` run's per-query `topIds` against this file's `perQuery[].topIds`.

3. **Delegation posture.** C1–C8 are one tightly-coupled TS feature across shared files
   (`core/dedup.ts` spans C3/C4/C6, `search.ts` C5, `collections-schema-gen.ts` C2).
   Parallel delegation would conflict and still require full understanding to verify, and
   C3+C4 are the RFC's stated risk core needing first-party proof. So core is built by the
   lead IC; delegation reserved for isolated C9 docs and a final adversarial review.

4. **Build order.** `@samesake/core` is `packages/sdk` (published name); `packages/server`
   consumes it via built `dist`. After SDK type changes (C1) the SDK must be rebuilt before
   server typechecks/tests resolve the new `dedup` field (RFC way-forward #4).

## C3+C4 build notes (risk core — proven at CHECKPOINT-A)

- **`assigned` skip-set (correctness fix, not in RFC pseudocode).** The row snapshot
  is `SELECT ... WHERE group IS NULL` taken ONCE. But when row A auto-links to a
  not-yet-clustered candidate B, B is founded as the leader (its group is set) mid-loop.
  If the loop later reprocesses B from the stale snapshot, B could re-found a *different*
  leader and thrash the cluster apart (A left orphaned at B.id while B moves to C.id).
  Fix: an in-memory `Set<string>` of ids given a group this run (leaders founded +
  each processed row); skip a snapshot row if already assigned. This is what makes
  membership converge (RFC §5.4 "membership converges regardless of leader identity").
  Proven: 3 same-mpn vendors → exactly one 3-member cluster; distinct product separate;
  re-run processes 0.
- **`matcher.dedup` repurposed** — entity `runDedup` stays; public binding now the
  collection dedup service (createMatcher.ts). Human-loop methods exposed:
  `dedupClusters`, `dedupSuggestions`, `confirmGroup`, `splitGroup`.
- **Candidate SQL** — one UNION CTE: exactKey btree ∪ trigram GIN top-20 (`%` + ORDER BY
  similarity) ∪ ANN top-20 (`embedding <=> $vec::halfvec`), every probe scope-pinned and
  `id <> self`; outer join filters `pipeline_status='ready'`. Trigram/cosine similarities
  computed in the outer SELECT reusing the same param refs.

## Gate results (C8 / FINAL)

- **Gate #2 full suite: 332/332 green** (313 baseline + 19 new `test/dedup.test.ts`). The single
  transient failure on the first run — `observability.test.ts › nlq cache hit counter` — was
  cross-RUN contamination I caused: my *earlier timed-out* suite run persisted the `obs` NLQ parse
  result into the GLOBAL `samesake_stage_cache` (`nlqCacheKey` = sha1 of model|instr|def.name|query,
  no project-schema component; 7-day TTL), so the re-run hit the cache and `generateCalls` was 0
  instead of 1. Not a dedup regression (the `obs` collection has no dedup; every dedup path is gated
  on `def.dedup`). Cleared the stale `stage_name='__nlq'` row and observability.test.ts passes 2/2
  cold. Pre-existing test-isolation weakness, not introduced here.

- **Gate #4 neutrality: PROVEN, 67/67.** `eval-search.ts --phase=p2dedup` on the real
  fashionparity corpus → per-query `topIds` **67/67 identical** to
  `evals/runs/2026-07-02T21-56-59-647Z-search-p2tenancy.json`. The dedup-less `products`
  collection is byte-identical on the read path. Airtight by construction: for a collection with
  no `dedup`, the group-column projection (`extraCols`) is empty, collapse falls back to
  `search.variantGroup` only, `attachOffers` is gated on `def.dedup`, and the cache key's offers
  component is inert. Run artifact: `evals/runs/2026-07-03T06-48-45-418Z-search-p2dedup.json`.
- **Gate #3 examples:** hello-search 5/5, hello-spaces 4/4, quickstart green (against dist).
- **Gate #5:** workspace `tsc --noEmit` clean; `oxlint` clean (0 errors; removed my one unused
  `CollectionDef` import in dedup.ts); `apps/docs` build green (marketplace-search dedup section).

## Adversarial review — findings resolved

An independent adversarial review pass ran over the whole diff against the RFC. It confirmed
tenancy, SQL-injection safety, neutrality, and offers correctness are CLEAR, and surfaced 4 real
issues — all fixed, each with a regression test:

1. **BLOCKER — declined pair re-merged on rebuild (directional decline memory).** The decline was
   stored/checked one-directionally `(row_id, candidate_group)`, but clustering is symmetric — on a
   `{rebuild:true}` the cluster re-founds the other way and the reverse-direction link was NOT
   blocked, silently re-merging (auto-link band) a pair a human had split. My original review test
   missed it (it used the suggest band and only asserted the exact declined direction). **Fix:**
   `isDeclined(a,b)` checks BOTH orderings; used in both the auto-link and suggest branches.
   Regression: `test/dedup.test.ts` "BLOCKER-1" (equal-mpn auto-link pair, split, rebuild → not
   re-merged).
2. **MAJOR — splitting a cluster leader was a silent no-op.** `SET group = id` on the leader (whose
   group already == its id) left every member attached and recorded no decline. **Fix:** `splitGroup`
   now re-homes the remaining members onto a new leader before evicting, and records the decline
   against EVERY former co-member (not just one), so no rebuild leader-reshuffle can re-merge the
   split row with any co-member. Regression: "MAJOR-2" (split the trio's leader → separated + survives
   rebuild against both co-members).
3. **MINOR — `dedupClusters` materialized the whole clustered table then sliced in JS.** **Fix:** a
   `grp` CTE selects the top-N qualifying clusters (bounded by `limit`) in SQL, then only those
   members are fetched.
4. **MINOR — `exactKey` on a non-text field would error at query time (`col <> ''`).** **Fix:**
   `validateDedupConfig` now rejects an `exactKey` channel on a non-text/enum field at apply, naming
   the field.

`test/dedup.test.ts` is now 21 tests (was 19). Server typecheck + lint clean after the fixes.

## Final gate sweep (all green)

- **#1 dedup.test.ts:** 21 tests — scoring units, 3-vendor cluster / distinct no-cluster, DDL,
  offers + quarantine + offers:false, suggest→confirm→split with decline surviving re-run+rebuild,
  cross-scope isolation (+ row-level count(DISTINCT scope)=1) + without-scope rejection, HTTP
  lifecycle + auth, and the two review regressions (BLOCKER-1 auto-link rebuild, MAJOR-2 leader split).
- **#2 full suite:** `bun test packages/sdk packages/server packages/providers` → **334 pass / 0 fail**
  on a cold run (313 baseline + 21 dedup). The observability NLQ-cache flake is a pre-existing global
  `samesake_stage_cache` cold-dependency, unrelated to dedup; clean once the stale __nlq row is cleared.
- **#3 examples:** hello-search / hello-spaces / quickstart green against rebuilt dist.
- **#4 neutrality:** 67/67 topIds identical to p2tenancy baseline (review fixes touched no search path,
  so unchanged).
- **#5:** workspace typecheck clean, lint clean, apps/docs build green.

Change is left as working-tree edits (not committed) — the kickoff did not request a commit.

## Post-review follow-ups (requested after delivery)

**(a) Fixed the pre-existing `observability.test.ts` isolation flake.** Root cause: the test used a
FIXED NLQ query phrase against the content-addressed, project-independent global NLQ cache
(`samesake_stage_cache`), so any prior run within the 7-day TTL warmed it and turned the "cold parse"
assertion into a cache hit. The cache design is correct (same instructions|model|collection|query →
same parse is intended reuse); the TEST was non-hermetic. Fix: make the probe query unique per run
(`another obs nlq phrase ${random}`). Proven repeatable — `observability.test.ts` now passes on TWO
consecutive runs (the old bug failed the 2nd). The suite is repeatably green without a cache wipe.

**(b) Added a real-embedding dedup QUALITY eval** (`examples/fashion-search/dedup-eval.ts`,
`bun run eval:dedup`). All the dedup unit/integration tests use the hash-embed stub; this grades
clustering on REAL `gemini-embedding-2` vectors over a hand-labelled gold set of cross-vendor fashion
listings (3 truth groups + 6 distinct, some sharing a GTIN), sweeping `autoLink` and scoring pairwise
precision/recall vs the labels. Findings on the real corpus:
- **Precision = 1.000 at every threshold (0.75–0.90) — zero false merges**, even though the distinct
  set contains adjacent categories (AF1 / Ultraboost / Converse are all sneakers). The precision-first
  contract holds on real vectors, not just the stub.
- **GTIN `exactKey` is the reliable auto-link path** (guaranteed precision + recall); title-only
  semantic cosine for same-product variants is modest, so most true dupes land in the SUGGEST band —
  human-reachable recall (auto-link + suggest) ≈ 5/7 at autoLink 0.75. This is the two-band design
  behaving as intended, not a defect.
- Fed back into the guide: `marketplace-search.mdx` example thresholds lowered to a grounded
  `autoLink 0.82 / suggest 0.62` with a calibration Aside pointing at the eval (the old `0.9` was the
  worst-recall point the eval found).
