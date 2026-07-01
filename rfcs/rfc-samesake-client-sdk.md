# RFC: `@samesake/client` + `@samesake/react` — frontend search SDK

Status: Ready to implement (design) · Date: 2026-07-01 · Owner: search · Scope: DESIGN ONLY (no impl
in this RFC). Grounds the L3 "toolkit" layer from `docs/architecture/full-scale-fashion-search.md`.

## 1. Motivation

samesake has a strong retrieval core and three consumption surfaces (in-process, `fetch`, Hono), but a
frontend developer wiring intent search into a React storefront today writes all the plumbing by hand:
debounced as-you-type, request abort/dedup, facet-refinement state, URL sync, SSR hydration, and — the
part nobody else has — surfacing samesake's **NLQ transparency, intent/similar modes, image search,
spaces weights, and `/explain`**. Algolia ships InstantSearch for exactly this DX; the OSS engines
(Typesense/Meilisearch) ship InstantSearch *adapters*. We have nothing. This is the biggest adoption
lever and the L3 gap flagged in the architecture doc and the industry research.

**The "1":** the fastest way to put samesake's *intent-driven fashion search* into a React app — a
typed, transport-agnostic client + **headless** hooks that expose our differentiators — with
InstantSearch-grade DX but without InstantSearch's widget/CSS bloat.

## 2. Prior art — steal / avoid

**Algolia InstantSearch / React InstantSearch**
- STEAL: the **connectors/headless** split (logic hooks decoupled from UI) — `useSearchBox`, `useHits`,
  `useRefinementList`, `useInfiniteHits`, `usePagination`, `useCurrentRefinements`, `useStats`; a single
  **search-state manager** that batches all widget state into **one request per keystroke**; **URL
  routing/sync** of search state; SSR support.
- AVOID: the widget "batteries" + bundled CSS, the heavy `<InstantSearch>` ceremony, federated
  multi-index complexity, and a proprietary query DSL. The modern React norm (shadcn era) is
  headless-first: give devs the state + a11y, let them bring markup.

**`autocomplete-js`** — STEAL the sources/state/plugins model + keyboard a11y for the as-you-type
dropdown; but it's imperative/vanilla — we want React hooks.

**Typesense / Meilisearch InstantSearch adapters** — STEAL the "adapter maps our API to a stable client
protocol" idea, but as **optional interop later**, not the core. Our differentiators (modes, NLQ chips,
spaces weights, `/explain`, image) do not fit the InstantSearch protocol, so a native client is the
core; an IS adapter is a bridge for teams already invested in InstantSearch.

**TanStack Query / Router** — STEAL the async/caching/dedup + URL-state discipline. Decision: **do not
hard-depend** on TanStack (keep the core zero-dep) but design hooks so a TanStack Query integration is a
trivial recipe.

## 3. The real API we wrap (grounding — verified against `packages/server`)

Request (`SearchOpts` / `POST …/search`): `{ q, image{url|bytesBase64|mimeType}, filters (Mongo-style),
weights (Record<channel, number | Record<space,number>>), mode:"intent"|"similar", rerank?, diversify?,
limit?, offset?, facets? }`.
Response (`SearchResult`): `{ hits:[{id,score,data,...}], parsed?, constraintTrace, nlq_degraded?,
relaxed, took_ms, facets?:Record<name,FacetResult>, total_candidates?, cached? }`.
Also: `POST …/facets {filters,facets}` (query-free) → `Record<name, FacetResult>`; **`POST
…/collections/:collection/search/explain`** → `ExplainDocBreakdown {id, fts_rank, cosine_rank,
spaces_rank, recency_rank, rrf_score, space_cosines}` (in-process `matcher.searchExplain`); in-process
`matcher.search/facets`; agent tools `findProducts/findSimilarProducts`. Every client method maps 1:1
to one of these — all verified to exist in `packages/server`.

The client is a **thin, exact, typed** wrapper over this — no fictional fields.

## 4. Architecture — three layers, transport-agnostic

```
@samesake/react  (L3)   hooks + <SearchProvider> + optional headless components   [peer: react]
        │ binds
@samesake/client/headless (L2)  framework-agnostic search-state controller
        │  (debounce · abort · dedupe · merge refinements · URL codec · subscribe/getState)
@samesake/client  (L1)  typed transport-agnostic client                          [zero deps]
        │  createClient({ baseUrl,apiKey } | { matcher })  →  search/facets/explain
        ▼
   HTTP fetch  ──or──  in-process matcher   (same interface; SSR/edge uses in-process)
```

Two published packages: **`@samesake/client`** (L1 core + L2 headless as `@samesake/client/headless`,
zero runtime deps) and **`@samesake/react`** (L3, `react` as a peer dep). Rationale: keep the core
usable in any framework / server / worker; only the React bindings pull React.

### L1 — core typed client (`@samesake/client`)

```ts
export interface SearchClient {
  search(project: string, collection: string, params: SearchParams, opts?: CallOpts): Promise<SearchResult>;
  facets(project: string, collection: string, params: FacetParams, opts?: CallOpts): Promise<FacetsResult>;
  explain(project: string, collection: string, id: string, params: SearchParams, opts?: CallOpts): Promise<ExplainResult>;
}
export interface CallOpts { signal?: AbortSignal }  // abort stale requests

// HTTP transport (browser/edge) OR in-process (SSR) — same shape:
export function createClient(cfg:
  | { baseUrl: string; apiKey?: string; fetch?: typeof fetch }
  | { matcher: MatcherLike }        // reuse the running matcher on the server
): SearchClient;
```

`SearchParams`/`SearchResult`/`FacetResult` are **re-exported from `@samesake/core`** so client and
server share one source of truth (no drift). The HTTP transport builds the `POST …/search` body; the
in-process transport calls `matcher.search`. Errors normalize to a typed `SamesakeError`.

### L2 — headless search-state controller (`@samesake/client/headless`)

A tiny store (subscribe/getState/dispatch) that owns the full search UI state and turns interactions
into **one batched request**:

```ts
export interface SearchState {
  query: string; mode?: "intent" | "similar"; image?: ImageInput | null;
  refinements: Record<string, unknown>;         // facet selections → filters
  weights?: WeightsInput;                        // spaces/channel weights
  page: number; hitsPerPage: number;
  status: "idle" | "loading" | "stalled" | "error";
  results?: SearchResult; error?: SamesakeError;
}
export function createController(client: SearchClient, cfg: {
  project: string; collection: string;
  debounceMs?: number;      // default 150
  facets?: FacetParams;     // request facet counts alongside hits (one round-trip)
  initialState?: Partial<SearchState>;
  router?: UrlRouter;       // optional URL <-> state sync
}): SearchController;

export interface SearchController {
  getState(): SearchState; subscribe(fn: () => void): () => void;
  setQuery(q: string): void; setMode(m?: Mode): void; setImage(i: ImageInput | null): void;
  toggleRefinement(field: string, value: unknown): void; clearRefinement(field: string): void;
  setWeights(w: WeightsInput): void; setPage(n: number): void;
  removeConstraint(c: ConstraintRef): void;   // remove an NLQ-parsed hard filter (see §5)
}
```

Guarantees (the DX Algolia gets right): **debounce** keystrokes, **abort** the in-flight request when a
newer one starts, **dedupe** identical requests, mark `stalled` if a response is slow, and **merge**
query + refinements + weights + page into a single `client.search` call. `UrlRouter` is a pure
codec (`stateToQuery`/`queryToState`) so state is shareable/back-buttonable; framework routers plug in.

### L3 — React bindings (`@samesake/react`)

`<SearchProvider client project collection [initialState] [initialResults] [facets]>` creates the
controller and provides it via context; `useSyncExternalStore` subscribes (SSR/concurrent-safe). Hooks
are **headless** (return state + handlers, no markup):

```ts
useSearchBox()      → { query, setQuery, clear, isSearching }
useHits<T>()        → { hits: Hit<T>[], results, status }
useInfiniteHits<T>()→ { hits, loadMore, hasMore, isLoadingMore }
usePagination()     → { page, nbPages, setPage, next, prev }
useStats()          → { nbHits: total_candidates, tookMs, cached }
useFacet(field)     → { items:{value,count,refined}[], toggle(value), clear }   // enriched facets
useCurrentRefinements() → { items, remove(ref), clearAll }
useMode()           → { mode, setMode, autoSimilar }                            // intent/similar
useImageSearch()    → { setImage, image, clear }                               // screenshot / "more like this"
useConstraintChips()→ { chips:{field,label,value}[], removeChip, relaxed, nlqDegraded }  // NLQ transparency
useWeights()        → { weights, setWeight(path,val), reset }                  // spaces sliders (dev/merch)
useExplain(id)      → { breakdown, isLoading }                                 // /explain dev overlay
```

Optional **unstyled headless components** (thin wrappers, bring-your-own-markup, shadcn-friendly):
`<SearchBox/> <Hits/> <RefinementList field/> <CurrentRefinements/> <ModeToggle/> <ImageDropzone/>
<Pagination/>`. **No bundled CSS. No widget zoo.** (This is the deliberate anti-InstantSearch choice.)

## 5. The samesake differentiators the SDK surfaces (why this isn't an Algolia clone)

1. **intent / similar modes** — `useMode()`; auto-`similar` when an image is set; `<ModeToggle>`.
2. **NLQ transparency (unique)** — `useConstraintChips()` reads `parsed` + `constraintTrace` and renders
   what the engine *understood* as removable chips ("under ₹5000", "red", "for a wedding"); `removeChip`
   re-issues the search without that hard filter. Surfaces `relaxed`/`nlq_degraded` as a notice ("showing
   close matches — relaxed 'sleeveless'"). No other search SDK has this because no other engine turns NL
   into inspectable hard filters. This is the headline DX.
3. **image / "find similar"** — `useImageSearch()` (upload/screenshot) + a "more like this" affordance on
   a hit (search by that product's image, mode=similar).
4. **spaces weight tuning** — `useWeights()` exposes query-time visual/price/freshness/channel weights
   (the "tune without reindex" capability) — a merchandiser/dev slider panel.
5. **enriched facets** — `useFacet('color'|'occasion'|'style'|…)` over enriched attributes; soft facets
   (relaxable) vs hard, reflected in chip behavior.
6. **`/explain` overlay** — `useExplain(id)` shows per-leg ranks + space cosines; a dev-mode relevance
   debugger baked into the SDK.
7. **variant diversification / buy-again** — passed through on hits for the UI to badge.

## 6. DX essentials (table stakes, from Algolia + OSS)

As-you-type with 150ms debounce · abort stale + dedupe identical · optimistic query echo · URL state
sync (opt-in) · keyboard-a11y search box · infinite scroll + numbered pagination · SSR initial results +
hydrate · explicit loading/empty/error/stalled states · TypeScript-first (generic `Hit<T>` typed to the
collection's field shape) · tiny bundle (core zero-dep; react peer-dep).

## 7. SSR / RSC

Core client runs **in-process** on the server (`createClient({ matcher })`) for React Server Components /
edge, so the first result page renders server-side with zero client JS; `<SearchProvider initialResults
initialState>` hydrates the controller so the first client interaction has no refetch. Next.js App
Router: a server component fetches initial results (in-process or HTTP) and passes them to a client
`<SearchProvider>`. Works on Cloudflare Workers (the matcher already runs there via Hyperdrive→PG).

## 8. Packaging & deps

- `@samesake/client` — L1 + L2 (`/headless` subpath). **Zero runtime deps.** Types from `@samesake/core`.
- `@samesake/react` — L3. Peer deps: `react` (18/19), `@samesake/client`.
- Build: `tsup` (ESM+CJS+DTS), matching the other packages. No `.map` files in the tarball. Tree-shakeable.

## 9. Phased build plan (lean increments)

- **P1 — L1 core client** (HTTP + in-process transports, typed to core, abort/error). Tracer: a typed
  `client.search()` round-trips against `examples/fashion-search`. Ship + eval nothing regresses.
- **P2 — L2 headless controller** (state machine, debounce/abort/dedupe, URL codec). Unit-tested with a
  fake client (deterministic, no network).
- **P3 — L3 React hooks** (`useSearch*`, `useHits`, `useFacet`, `useConstraintChips`, `useMode`,
  `useImageSearch`, `useStats`) + `<SearchProvider>` + SSR hydrate. Verify in a real Next/Vite app.
- **P4 — headless components + docs + example** (wire the `examples/fashion-search` storefront UI;
  a docs guide `apps/docs/.../guides/react-search.mdx`).
- **P5 — optional, deferred:** an autocomplete/`useSuggest` hook (needs a `/suggest` endpoint — ties to
  the L3 toolkit autocomplete gap) and an `@samesake/instantsearch-adapter` interop bridge.

## 10. Decisions (opinionated defaults — this is the "iron-out")

- **Two packages**, headless controller as a `@samesake/client/headless` subpath (not a third package).
- **Headless-first; optional unstyled components; NO bundled CSS/widgets.** (anti-InstantSearch)
- **Zero-dep core**; TanStack Query is a *recipe*, not a dependency.
- **One batched request** per state change; debounce 150ms; abort stale; dedupe identical.
- **Native client is the core; InstantSearch adapter is deferred optional interop** (our differentiators
  don't fit the IS protocol).
- **Facets requested in the search call** (one round-trip) by default; standalone `client.facets()`
  available for query-free browse pages.
- **URL-state codec shipped but opt-in.**

## 11. Non-goals / do-NOT-build (capability discipline)

No bundled UI theme/CSS, no widget library, no federated multi-index, no analytics client (that's the
separate L3 analytics gap), no personalization SDK, and **no package scaffolding in this RFC** — this is
design; implementation is P1+ once approved.

## 12. Open questions (for review, not blockers)

- Do we want typed hits generated from the collection config (`Hit<typeof products>`) in P1, or a generic
  `Hit<T>` the caller parameterizes? (Lean: generic first; codegen later.)
- Ship the InstantSearch adapter at all, or point IS users at the native client? (Lean: defer; measure demand.)

## Related
`docs/architecture/full-scale-fashion-search.md` (L3) · `docs/research/industry-search-practices.md`
(Algolia/OSS prior art) · `docs/research/zepto-search-notes.md` (query-tier/autocomplete ideas) ·
`README.md` (`createMatcher` surfaces the client wraps).
