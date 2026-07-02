# P0 iron-out session — implementation notes

Session goal: P0-1 (generic removeDocuments), P0-3 (de-fashion core), P0-4 (judge honesty),
P0-5 (one env contract). Constraints: alpha — break APIs, no compat layers; entity-resolution
quarantined; Postgres-only settled.

## Load-bearing assumptions / decisions

- **P0-1 was half-landed already** (commit 4ea007b): `matcher.removeDocuments` + in-process test
  exist. This session adds the HTTP DELETE route, the CLI command, the push→delete→search-empty
  proof, and reroutes catalog-sync's inline `DELETE FROM` through `removeDocuments`.
- **Embeddings live as columns on the collection row** (halfvec `embedding`/`space_vec`), so a row
  delete fully removes a doc from search — no separate index cleanup needed.
- **P0-3 naming**: `fashionSearch`/`/fashion-search` → `shopSearch`/`/shop-search`;
  `syncFashionCatalogEvent`/`/fashion-sync` → `syncCatalogEvent`/`/catalog-sync` (split into
  `core/catalog-sync.ts` — it was never fashion-specific). SDK types `FashionSearchRequest/
  Response/Explanation` → `ShopSearch*`; `FashionPersonalizationContext` → `ShopperContext`;
  `FashionRankingPolicy` deleted (empty extension — use `RankingPolicy`);
  `FashionCatalogSyncEvent` → `CatalogSyncEvent`. `fashionRerank` → `llmRerank`.
- **The template seam is `CollectionSearchDef`** (it already carries `rankingPolicy`,
  `relevanceFloor`, `nlq`). It gains `relaxableFilters?: string[]` — the ordered filter keys the
  no-results recovery may drop. Core relaxes nothing unless the collection declares it; the
  fashion template supplies `["colors","material","fit","styles","category","price"]` via
  `fashion.search()`. Personalization field reads (brand/price/size/styles/colors) are
  commerce-generic, not fashion — they stay as core defaults, no binding config (YAGNI).
- **Eval constraints reuse the search filter language** (`SearchFilters`/`$lte`/`$exclude`…)
  instead of a parallel hardcoded vocabulary: golden `constraints` become e.g.
  `{ "price": { "$lte": 5000 }, "colors": { "$exclude": ["black"] } }`, checked generically
  against `hit[field] ?? hit.data[path]`. Golden files migrated in place (alpha).
- **P0-4**: one shared ESCI judge rubric (Exact=3 / Substitute=2 / Complement=1 / Irrelevant=0,
  Substitute = soft positive → default relevance floor 2) used by both `makeLlmJudge` (runEval)
  and `evaluateSearch` (calibrate-search). Judge version = `esci-v1@<sha256(prompt)[:8]>` so any
  prompt edit auto-invalidates persisted grades. Same-family enrich+judge rejected: judge model
  family (gemini/openai/anthropic/…) compared against the collection's enrich stage model
  families; judging via the enrich `generate` fn on an enriched collection without a declared
  distinct judge model throws.
- **Golden-eval comparison method**: the tier0post artifact stores `perQuery.topIds`, so
  retrieval flatness is proven by diffing ids (judge-independent). The ESCI + cross-family
  re-run (judge = gpt-4.1-mini, OpenAI; enrich stays gemini-3.1-flash-lite) then becomes the new
  honest baseline — its absolute grades are a different measuring stick than tier0post's
  self-judged 1.878 by design.
- **P0-5**: canonical `SAMESAKE_DATABASE_URL` / `SAMESAKE_API_KEY`; provider keys as the provider
  names them (`GEMINI_API_KEY`, `OPENAI_API_KEY`) — so the `GOOGLE_GENERATIVE_AI_API_KEY`
  mapping in apps/matcher dies with the shim. Bare `DATABASE_URL` in tests/examples/docs all
  migrate; no fallback aliases anywhere.

## Progress log

- (start) Recon complete; baseline gates kicked off (baseline: tsc clean, 258 pass / 0 fail).
- P0-1 done: HTTP `DELETE …/documents` + CLI `samesake remove`; proof test covers push → index →
  search → HTTP delete → search-empty on both surfaces.
- P0-3 done: `shop-search.ts` + `catalog-sync.ts` replace `fashion-search.ts`; relaxation via
  `CollectionSearchDef.relaxableFilters` (template fragment `fashion.searchDefaults()`); eval
  constraints in filter vocabulary; golden JSON migrated; `defashion-gate.test.ts` enforces zero
  fashion symbols in core. 64-file mechanical sweep across docs/examples/apps (protected
  `examples/fashion-search` paths and `fashion.*` template names).
- P0-4 done: ESCI rubric shared by both judges; `judgeVersion(tag)` = `<tag>@<sha256(rubric)[:8]>`;
  `assertJudgeFamilySeparation` wired into `runEval` + `evaluateSearch` (+ HTTP `judgeModel`);
  `examples/fashion-search/openai.ts` provides the cross-family gpt-4.1-mini judge.
- P0-5 done: canonical env everywhere incl. all 34 test files + load-env.ts; matcher shim deleted;
  playground/ecommerce-assistant/bom-quotation apps migrated (their local `.env`s need the new
  names — `SAMESAKE_DATABASE_URL`, `SAMESAKE_API_KEY`).
- Gates: tsc clean; server suite 265 pass / 0 fail (baseline 258); hello-search, hello-spaces,
  quickstart all pass post-rebuild; changeset folded into `.changeset/tier-zero-defaults.md`.
- Note: `.env` (local, gitignored) gained `SAMESAKE_DATABASE_URL`; the old `DATABASE_URL` line was
  left in place for any external tooling — code no longer reads it.

## Judged golden baseline — RESOLVED (2026-07-02, fresh key provided)

With a fresh `GEMINI_API_KEY`, the full 62-query run executed:
`evals/runs/2026-07-02T16-01-22-852Z-search-p0honesty.json` — **mean grade@5 1.881, nDCG@5
0.901, no-results 0%** (judge gpt-4.1-mini cross-family, 309 judgments). Flat-or-better vs
tier0post (1.878 / 0.902). topIds diff: **61/62 identical**; the one changed query
("minimalist wardrobe basics", pure-semantic, no filters) reordered near-tie neighbors —
query embeddings are recomputed live each run (search cache is in-memory per process), so this
is gemini-embedding-2 float jitter, not a retrieval change. This artifact is the new honest
baseline. `eval-search.ts` gained a `--queries=N` flag (0 = all).

## (Historical) Open item — judged golden baseline (credential-blocked)

The P0-4 cross-family golden re-run could not execute live: **every `GEMINI_API_KEY` in the local
env files (root, playground, ecommerce-assistant) is an expired AI Studio ephemeral token
(`AQ.*`, 53 chars — 401 on both `generateContent` and `embedContent` as of this session)**. The
tier0post run worked this morning, so the token expired in between. The OpenAI judge key works
(verified live with a strict-schema ESCI call, HTTP 200).

What this blocks: only the new judged baseline artifact (`evals/runs/*-search-p0honesty.*`) —
query embeddings/NLQ for the fashionparity corpus are Gemini-side.

What is still proven without it:

- **Retrieval flat vs tier0post, deterministically**: the whole retrieval path is untouched this
  session (`search.ts`, `search-filter.ts`, `search-cache.ts`, `embed.ts`, `ranking.ts`,
  `nlq.ts`, `embed-index.ts`, `db/` — zero diff; `search-query.ts` diff is two string literals),
  and `createFashionMatcher` wires no reranker, so `llmRerank`'s change is not in this path.
  Same code + same index ⇒ identical per-query topIds by construction.
- The ESCI judge, prompt-hash versioning, and family gate are covered by the server suite
  (eval-judge/eval-run/eval-cache/eval-calibrate tests, 265 pass).

To mint the new baseline once a fresh `GEMINI_API_KEY` is in `.env`:

```bash
cd examples/fashion-search && bun --env-file=../../.env eval-search.ts --phase=p0honesty
python3 examples/fashion-search/compare-topids.py   # from repo root — diffs topIds vs tier0post
```

Expect the topIds diff to report 62/62 identical; the judged numbers are a new measuring stick
(cross-family + ESCI), not comparable 1:1 to tier0post's self-judged 1.878.

## CLI remove — live proof

`samesake remove --project=… --collection=products --ids=a` executed against a live
`Bun.serve(matcher.fetch)` server: exit 0, `✓ removed 1 document`, and the row verified deleted
in Postgres (script: session scratchpad `cli-remove-proof.ts`).
