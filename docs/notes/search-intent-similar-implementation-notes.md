# search-intent-similar — implementation notes

## Goal
Search robust to intent-based filtering AND not biased toward keywords; "similar" = genuine
visual + semantic similarity, not keyword matching. Framework changes allowed.

## Root cause (diagnosed earlier this session, with live repros)
1. Flat RRF (`fts=1, cosine=1`) gives any keyword-title match a guaranteed top seat → word-
   decoys outrank genuinely similar items ("similar" collapses into keyword matching).
2. The "semantic" leg is a *text* embedding → lexical content leaks into the vector (a sloganed
   tee embeds near "evening gown"). Only a *visual* signal separates look from words.
3. Intent vs similarity are different objectives: dropping keyword entirely regresses intent
   exactness (`q3 "linen shirt men"` 1.0→0.33), while keeping it flat keeps the bias. No single
   global weighting serves both (proven in `eval-configs-lk.ts`).

## Design decision: a search `mode`
`SearchMode = "intent" | "similar"` (core). Resolved = `opts.mode ?? (image ? "similar" : "intent")`.
Mode-aware effective weights computed in `parseSearchWeights(def, override, mode, hasImage)`:
- **intent**: keyword capped to a tiebreaker `min(fts, 0.3·cosine)`; spaces/visual leg off for
  text queries (visual on a text query is cross-modal noise; structured spaces unproven for
  intent and historically failed the parity gate). NLQ hard filters unchanged.
- **similar**: keyword = 0; semantic (cosine) + visual decide. For pure-image (image, no text)
  the cosine text leg is also dropped so the visual space carries ranking.
- Image-kind spaces are zeroed whenever the query has no image (both modes).
- Explicit per-query `weights` still override the mode (wrappers' image logic intact).

`KEYWORD_TIEBREAK = 0.3` — chosen from `eval-configs-lk.ts`: at 0.3, intent relevance@3 equals
the old flat default (0.67) and exactness queries are preserved, while keyword dominance drops.

## Files changed
- `packages/sdk/src/types.ts` — export `SearchMode`.
- `packages/server/src/core/search-query.ts` — `parseSearchWeights` mode transform + `imageSpaceNames`.
- `packages/server/src/core/search.ts` — `SearchOpts.mode`; resolve mode + hasImage in `retrieve`;
  pure-image cosine drop; mode in result-cache key.
- `packages/server/src/core/search-cache.ts` — `mode` in `SearchCacheKey` + `stableKey`.
- `packages/server/src/core/agent-tools.ts` — `findProducts` optional `searchMode`; `findSimilarProducts` → `"similar"`.
- `packages/server/src/app-builder.ts` — `mode` on `SearchBody`; passed to search + explain routes.
- `examples/fashion-search/samesake.config.ts` — spaces + visual ON by default (SPACES/SPACES_VISUAL
  now opt-OUT via `=0`); removed redundant `style` text-space (duplicated the cosine `doc`
  channel and exceeded pgvector's 2000-d HNSW limit); `visual` default weight 2.
- `examples/fashion-search/{repro-similar,repro-visual,eval-configs-lk}.ts` — evidence harnesses.
- `packages/server/test/search-mode.test.ts` — unit tests for the transform.
- `README.md`, `CHANGELOG.md` — docs.

## Root-cause issue found & fixed during the work
Enabling visual by default surfaced `spaces total dimension 2352 exceeds pgvector HNSW limit of
2000`. Cause: the `style` text-space (1536d, source `$enriched.embed_doc`) duplicated the cosine
`doc` channel (same source/model/dim — the indexer even dedups them) and, added to visual(768)+
price(8)+category(32)+freshness(8), blew the budget. Fix = drop `style`; the cosine channel
already carries text semantics and the spaces leg now carries only complementary signals (816d).

## Verification (live, this DB + real gemini-embedding-2 / gemini-3.1-flash-lite)
- `bun run typecheck` — clean.
- `bun test` (packages/server) — 157 pass / 0 fail (incl. `search-mode.test.ts`, 7 tests).
- `repro-similar.ts` — `mode=similar` fixes keyword-decoy pollution: "black dress" → real
  dresses 1-2-3 (3/3), tee → #6. Residual text-contamination ("cocktail dress" tee #1) remains
  for text-only queries — only a visual query fixes it (see below).
- `repro-visual.ts` — IMAGE query (held-out dress) `mode=similar`: ranks real dresses 1-2-3 by
  visual cosine (fts/cos off); a "dress"-stuffed DENIM JACKET that leads the text path
  (fts_rank=1) is buried to #5 by visual. Genuine visual + semantic similarity, immune to words.
- `eval-configs-lk.ts` (intent guardrail) — `mode=intent` == old flat default on every LK intent
  query (mean relevance@3 0.67; short 0.89 / long 0.57): NO intent regression, with keyword
  dominance removed. `mode=similar` is intentionally worse on intent (0.40) — different objective.

## Known limitations (honest)
- Visual embedding is imperfect: in `repro-visual` the rainbow beach dress ranks #6 (genuinely
  looks unlike the red query dress). Ranking quality is the embedding model's, not the framework's.
- Text-only "similar" can still surface a text-contaminated item when its *description* literally
  contains the query words (no image to disambiguate). Use an image query for true visual similarity.
- The LK relevance labels are the keyword snapshot's own results (keyword-biased) and the corpus
  is tiny (30 docs, 3 labels/query) — the intent eval is a directional guardrail, not a precise gate.
- Enabling visual by default makes the full fashion pipeline embed product images at index time
  (more cost/time). Opt out with `SPACES_VISUAL=0`.

## Round 2 — six fashion/e-commerce retrieval primitives baked into core

Research-backed (2025–26 SIGIR/WWW/RecSys incl. Walmart Global Tech). All in the core packages.

1. **FTS soft-OR (AND-coverage-first, OR-fallback)** — `search.ts` lex CTE: gate candidates with the
   OR rewrite of `websearch_to_tsquery` (recall) but `ORDER BY ts_rank_cd(fts, andQuery), ts_rank_cd(fts, orQuery)`
   so full-term matches stay on top (precision) and partial matches only fill in. Fixes the proven
   inert-FTS-on-multi-term-queries bug. **Default on.**
2. **Composed query** — `mode:"similar"` + `image` + `q` keeps visual (anchor) + text-cosine (modifier)
   both active (RRF). `/search` HTTP now accepts `image`. Mostly emergent from the mode model; locked with intent.
3. **Cross-encoder rerank seam** — `createMatcher({ rerank })` → `RerankFn`; `search()` reranks the top
   `RERANK_POOL=50` and slices to `limit`; `SearchOpts.rerank=false` disables. Failures fall back to RRF.
4. **Visual grounding seam** — `createMatcher({ groundImage })` → `GroundImageFn`; applied to bytes in
   `buildQueryImageVectors` (query) and `buildDocSpaceSegments` (index); pass-through when absent.
5. **Self-calibration + LLM-judge eval** — new `core/calibrate-search.ts`: `matcher.evaluateSearch`
   (graded relevance@k + nDCG@k via labels or `generate` LLM judge) and `matcher.calibrateSearch`
   (sweeps mode/weight grid, returns recommendation; never mutates config).
6. **Variant diversification** — `collection({ search:{ variantGroup } })` (typed to a declared field) +
   `SearchOpts.diversify`; `search()` collapses to best-per-group. Off unless `variantGroup` declared.

### Files
core: `sdk/src/types.ts` (variantGroup on CollectionSearchDef), `sdk/src/index.ts` (input-type
variantGroup + collection() validation). server: `core/search.ts` (soft-OR, rerank, diversify, pool),
`core/search-query.ts` + `core/embed-index.ts` (grounding seam), `core/calibrate-search.ts` (new),
`types.ts` + `createMatcher.ts` + `index.ts` (RerankFn/GroundImageFn config+ctx+exports, calibrate
wiring), `app-builder.ts` (image/rerank/diversify on /search). test: `test/search-primitives.test.ts`.

### The one real tradeoff (decided, not hidden)
Soft-OR broadens lexical recall. On the LK intent eval it **lifted** the keyword leg (relevance@3
0.37→0.80) and flat (0.67→0.77), but intent-mode dipped 0.67→0.63, driven almost entirely by q3
"linen shirt **men**" and q9 in a 30-item, 3-label, **keyword-biased** corpus. q3's "men" lives in the
gender field (enforced by NLQ's hard filter, not title FTS), so the dip is not a real intent regression
— it's small-corpus noise on a metric that structurally rewards keyword behavior. AND-coverage-first
recovered `similar` and kept the recall win, so soft-OR ships on: it fixes a *proven* bug (4-term query
→ FTS matched nothing) at the cost of noise on a biased micro-benchmark. similar-mode and visual gates
are unaffected (fts=0 there).

### Round 3 — benchmark verdict (soft-OR tradeoff was NOT real)

Built `examples/fashion-search/bench-retrieval.ts`: multi-domain (fashion + **electronics**,
out-of-domain), **hand-assigned unbiased graded relevance** (vs LK's keyword-biased labels), real
gemini-embedding-2, with a temporary `SAMESAKE_FTS_STRICT` A/B toggle (since removed). nDCG@5:

| config (nDCG@5) | electronics strict-AND | electronics soft-OR | fashion strict-AND | fashion soft-OR |
| keyword | 0.362 | **0.938** | 0.477 | **0.977** |
| flat    | 0.893 | 0.934 | 0.997 | 0.997 |
| intent  | 0.893 | 0.934 | 0.997 | 0.997 |
| similar | 0.893 | 0.893 | 0.997 | 0.997 |

Findings: (1) soft-OR is **neutral-to-better** for intent/flat on unbiased labels — the LK 0.67→0.63
dip was a labeling artifact of keyword-biased labels, not a real regression. (2) strict-AND keyword
goes **inert (0.00)** on vocab-mismatch/use-case queries; soft-OR lifts the keyword leg +0.50–0.58.
(3) similar/semantic identical across arms (fts=0), as predicted. (4) improvements **generalize
out-of-domain** — electronics mirrors fashion (intent≈flat; similar correctly cedes precision on exact
queries by turning keyword off). Decision: keep soft-OR (AND-first) as the default; the strict toggle
was removed. `bench-retrieval.ts` kept as a permanent unbiased multi-domain harness.

### Round 2 verification
- `bun run typecheck` clean. `bun test` (server) **161 pass / 0 fail / 30 files** (warm); new
  `search-primitives.test.ts` 4/4 (soft-OR, diversify, rerank, calibrate) + `search-mode` 7/7.
- Gates: `repro-similar` similar-mode 3/3 (decoys gone); `repro-visual` image query 3/4 dresses, the
  "dress"-stuffed denim decoy buried #5; `eval-configs-lk` intent guardrail per above.
- dist rebuilt (core+server); throwaway DB projects dropped.

## Follow-up worth considering (not done; out of scope)
- A dedicated *similarity* eval (visual/style nearest-neighbour agreement) to gate similar-mode
  quality, complementing the keyword-relevance intent eval. The intent eval structurally can't
  see similarity quality — that blindness is why spaces were historically disabled.
