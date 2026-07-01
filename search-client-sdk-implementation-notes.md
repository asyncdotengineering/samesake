# Frontend search client SDK — design notes (task #16)

Deliverable: **design only** (per the task), ironed out to implementation-ready. The RFC is
`rfcs/rfc-samesake-client-sdk.md`. No package scaffolded (respects "no impl yet" + YAGNI — no caller
until P1 is approved).

## Intent (restated)
A typed, transport-agnostic client + **headless** React hooks that give InstantSearch-grade DX
(as-you-type, facet refinement, URL sync, SSR) while surfacing samesake's differentiators (intent/similar
modes, NLQ hard-filter chips + relaxation transparency, image/similar search, spaces weight tuning,
enriched facets, `/explain`). Headless-first, no bundled widgets/CSS.

## Load-bearing decisions (+ why)
- **Two packages:** `@samesake/client` (L1 core + L2 headless controller as `/headless` subpath, zero
  runtime deps) and `@samesake/react` (L3 hooks, `react` peer). Keeps the core usable in any framework /
  server / worker; only React bindings pull React.
- **Native client is the core; InstantSearch adapter deferred.** Our differentiators (modes, NLQ chips,
  spaces weights, `/explain`, image) don't fit the InstantSearch protocol, so an adapter would flatten
  the product's best DX. Ship native; offer an IS bridge later only if demand appears.
- **Headless-first, no bundled CSS/widgets.** Deliberate anti-InstantSearch choice for the shadcn era.
- **Zero-dep core; TanStack Query is a recipe, not a dependency.** Don't force a data lib.
- **Types re-exported from `@samesake/core`** so client/server share one contract (no drift).
- **One batched request per state change**, debounce 150ms, abort stale, dedupe identical (the DX Algolia
  gets right, minus the bloat).
- **Facets in the search call by default** (one round-trip); standalone `client.facets()` for browse pages.

## Grounding (verified against packages/server — no fictional fields)
- Request maps to `SearchOpts`/`SearchBody`: `q, image{url|bytesBase64|mimeType}, filters, weights
  (Record<channel, number | Record<space,number>>), mode, rerank, diversify, limit, offset, facets`.
- Response maps to `SearchResult`: `hits{id,score,data}, parsed, constraintTrace, nlq_degraded, relaxed,
  took_ms, facets:Record<name,FacetResult>, total_candidates, cached`.
- Endpoints: `GET/POST …/search`, `POST …/facets`, `POST …/search/explain` (→ `matcher.searchExplain`),
  in-process `matcher.search/facets`. All confirmed to exist.
- Hook↔field map: `useConstraintChips`→parsed/constraintTrace/relaxed/nlq_degraded · `useStats`→
  total_candidates/took_ms/cached · `useFacet`→facets · `useExplain`→search/explain · `useMode`→mode ·
  `useWeights`→weights · `useImageSearch`→image.

## Deferred / non-goals
Package scaffolding (until P1 approved), bundled UI theme, widget library, federated multi-index,
analytics client (separate L3 gap), `useSuggest`/autocomplete (needs a `/suggest` endpoint — its own
toolkit item), typed-hits codegen from the collection config (start generic `Hit<T>`, add later).

## Verification
This is a design artifact — "verification" = every API in the RFC maps 1:1 to a real, verified endpoint/
type in `packages/server` (cross-checked above), and the internal type surface is self-consistent. No
code shipped, so no tests/typecheck to run yet; P1's tracer-bullet (`client.search()` round-trip against
`examples/fashion-search`) is the first executable proof.
