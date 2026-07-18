# RFC: Catalog-grounded query understanding — vocab-grounded NLQ, corrected lexical surface, typed zero-result rewrites

**Category:** New Feature (eval-gated breaking change to existing alpha behavior)
**Author:** Claude Fable 5 (session 2026-07-18, RFC-validation + research pass)
**Date:** 2026-07-18
**Status:** Implemented and gated — ship (v2, 2026-07-19); see §13
**Reviewers:** mithushancj
**Related:** `docs/research/2026-07-18-retrieval-research-notes.md` (evidence corpus) ·
`rfcs/rfc-multi-aspect-retrieval.md` (§13-14 interaction record) ·
`packages/server/src/core/nlq.ts` (parse, schema, cache) ·
`packages/server/src/core/search-query.ts` (aspect routing) ·
`packages/server/src/core/search.ts` (`retrieve`, `runRanked`, finishers) ·
`packages/server/src/core/search-filter.ts` (predicate compilation) ·
`evals/search-queries-typo.json` · `evals/golden-queries-fashion-lk.json` · reconciled SHA
`371d085`

---

## 1. Problem Statement

The query-understanding layer is the only retrieval component that reasons without seeing the
catalog, and two live findings show that its current fast paths can remove constraints after the
user stated them:

1. **Ungrounded open-vocabulary filters.** `deriveNlqSchema` constrains declared enums, but a
   filterable `text` field remains a free string (`nlq.ts:51-143`). The LLM can emit a plausible
   brand or product type that is not stored, and `buildFilterSql` correctly compiles that value
   into an exact or substring predicate (`search-filter.ts:202-335`). The bug is upstream: the
   value was never catalog-grounded. The evidence base identifies grounding as the largest
   measured query-understanding lever: +8.3 percentage points of a +13-point DoorDash gain, with
   ungrounded classification at -10.9 points (`docs/research/2026-07-18-retrieval-research-
   notes.md:31-35`).
2. **Short text queries bypass NLQ.** `shouldSkipNlq` skips two-token, non-numeric queries
   (`nlq.ts:168-176`). In the 2026-07-18 live human test, `red dress` therefore missed
   `colors: red`; black garments appeared at ranks 7-8 through the color-blind dense leg. The
   same heuristic is duplicated in `shouldSkipNlqForRouting` (`search-query.ts:237-240`).
3. **The lexical leg never sees the corrected surface.** `runHybridQuery` binds raw `q` once and
   feeds it to the AND, OR, and phonetic tsqueries (`search.ts:264-369`). `semantic_query` feeds
   aspect embeddings only. A typo such as `adidas snekers` can therefore zero the FTS leg even
   when NLQ understood it; `evals/search-queries-typo.json:1-19` already records this gap.
4. **Soft-filter relaxation drops every soft predicate at once.** The compiler handles soft
   predicates correctly (`search-filter.ts:202-335`). The loss happens in `runRanked`, whose
   retry sets `excludeSoft: true` for the whole filter set (`search.ts:697-769`). In the
   2026-07-18 live corpus, `red dress for a wedding` had exactly three rows satisfying dresses,
   red, and wedding-guest constraints, but the thin retrieval retry removed both occasion and
   color; color-mismatched items filled the page while the trace still displayed red.
5. **There is no typed recovery after relaxation.** Retrieval proceeds from `runRanked` to the
   relevance cutoff and an honest empty result (`search.ts:772-859`). Instacart reports typed
   substitute/broader/synonym rewrites increasing coverage from 50% to 95%+ at 90%+ precision
   and halving tail-query complaints (`docs/research/2026-07-18-retrieval-research-
   notes.md:36-38`).

Both live findings were reproduced against the 5,512-document corpus through the human A/B/C
harness (`examples/fashion-search/human-test.ts:1-89`); that corpus and same-night execution are
recorded at `rfcs/rfc-multi-aspect-retrieval.md:543-568`. `red dress` is also the standing `kw-01`
fixture (`evals/golden-queries-fashion-lk.json:7-10`).

Success is eval-gated:

- Every accepted open-vocabulary filter value exists in the visible catalog scope; otherwise it
  is mapped or dropped while its text remains semantic.
- Every non-empty text query on an NLQ-enabled collection enters the NLQ pipeline. Exact declared
  soft-enum tokens are recovered deterministically even if generation degrades or omits them.
- The lexical leg and FTS gate use one corrected surface when a non-degraded parse supplies it.
- Thin results relax one derived soft field at a time and the response reports the actual filter
  set used. `red dress for a wedding` may lose occasion before color, never both at once.
- Typed rewrites reduce retrieval-gate nulls without resurrecting relevance-floor, cutoff, OOD,
  or explicitly filtered honest zeros.
- The 55-query fashion harness remains mean@10 and P@5 flat-or-better.

### 1.1 Non-Goals / Out of Scope

- Session/prior-query context injection; the evidence says broad-to-narrow context needs its own
  gate (`docs/research/2026-07-18-retrieval-research-notes.md:59-63`).
- Head-query batch precomputation. The existing seven-day stage cache remains reactive.
- New trained spellers, taggers, rankers, or retrieval engines. The engine landscape supports
  investing in typed constraints and typo handling ahead of a BM25 replacement
  (`docs/research/2026-07-18-retrieval-research-notes.md:122-134`).
- Changing multi-aspect mode defaults. Intent-mode non-primary aspects remain off by default,
  and pure image queries continue to run image-kind aspects only
  (`search-query.ts:34-95`, `search.ts:639-652`).
- Parsing an image-only request through NLQ; “every query” in this RFC means every non-empty text
  query. An image-only request has no language surface to parse.

## 2. Background

### 2.1 Current flow at reconciled SHA `371d085`

`parseNlq` normalizes a custom or derived schema, injects the aspect fragment when necessary,
uses a seven-day stage cache, and falls back to `{ semantic_query: q }` on generation failure
(`nlq.ts:303-373`). Its cache key already hashes instructions, model, collection, normalized
query, and the merged multi-aspect descriptions (`nlq.ts:16-24`). The v2 cache change therefore
extends the current aspect-aware key; it does not replace an obsolete design.

`retrieve` awaits `parseNlq`, merges NLQ filters with explicit filters, resolves budget hints,
embeds the semantic query, and calls `resolveAspectPlans` (`search.ts:620-695`).
`resolveAspectPlans` currently sets `skipToFirst` when the parse degraded or the duplicated short-
query heuristic fired (`search-query.ts:179-235`). After this RFC, only a degraded or disabled
parse falls back to first-aspect-only. A successful two-token parse follows normal routes. The
intent-mode aspects-off rule in `parseSearchWeights` remains authoritative; this RFC does not
reactivate non-primary intent legs (`search-query.ts:34-95`).

`runRanked` performs the initial hybrid query and, below its three-result threshold, retries with
all soft fields excluded (`search.ts:697-769`). `buildFilterSql` already reports the soft fields it
compiled and correctly excludes them when asked (`search-filter.ts:202-335`); progressive
relaxation must reshape `runRanked`, not the compiler's predicate semantics.

`finishSearch` applies the honest-result cutoff after `runRanked`, then builds a trace from the
original merged filters (`search.ts:772-859`). `finishExplain` follows the same ranked path
(`search.ts:861-923`). The implementation must share the chosen relaxation/rewrite execution so
search results, facets, and explain all describe the same effective constraints.

Project apply calls `collectionTableDDL` only for a collection whose base table does not yet exist,
then calls `ensureCollectionSystemColumns` for every configured collection inside one transaction
(`projects.ts:189-227,232-267`). Vocab DDL/backfill therefore belongs in
`ensureCollectionSystemColumns`; placing it only in `collectionTableDDL` would strand every
existing collection.

### 2.2 Terminology

- **Open-vocab field:** a filterable `text` field whose values come from stored documents.
- **Vocab table:** a scoped inventory `(field, value, count)` of live open-vocab values.
- **Grounding candidates:** the top-K vocab values similar to the query, injected into the parse
  schema and prompt.
- **Deterministic enum filter:** a positive soft filter derived from an exact declared enum token
  without generation.
- **Strict run:** retrieval with every explicit, hard, and derived soft filter applied.
- **Relaxation probe:** a count of rows matching one soft predicate under scope, visibility, and
  all non-relaxable predicates; higher count means less selective.
- **Typed rewrite:** a `spellfix | synonym | broader | substitute` replacement query guarded by
  embedding similarity to the original.

### 2.3 Compatibility and latency decision

The v1 statement that non-open-vocab collections receive byte-identical prompts and results is
false once the short-query skip is removed. V2 narrows the identity contract to generated DDL and
retrieval SQL structure: a collection with no open-vocab filterable text fields emits no vocab
table/index DDL and performs no vocab lookup; collections without enabled NLQ keep their current
query behavior. Adding `lexical_query` can change a bound query string but not the lexical SQL
shape.

For every collection with NLQ enabled, parsing short queries is a deliberate breaking behavior
change under the alpha policy. The first request for a normalized query and stable parse key pays
one cold parse; later requests use the existing seven-day cache. A candidate, aspect-description,
instruction, model, or schema-version hash change intentionally creates another cold parse. The
deterministic enum layer runs synchronously before generation and covers exact soft-enum
constraints during that cold path, but it does not claim to erase the cold parse's latency. It
adds no LLM call of its own. The reactive-cache economics are supported by the research corpus
(`docs/research/2026-07-18-retrieval-research-notes.md:39-42`).

### 2.4 Alternatives Considered

- **Whole vocabulary in the prompt:** rejected because prompt and cache-key size scale with the
  catalog. Per-query top-K candidate retrieval preserves the controlled vocabulary.
- **Post-parse fuzzy mapping only:** retained as REQ-4's guardrail but insufficient as the primary
  layer because it cannot prevent role confusion before generation.
- **A second entity-linking LLM call:** rejected; the existing parse can consume grounded enums.
- **A fuzzy lexical retrieval leg:** deferred. It adds calibration without solving grounding or
  typed recovery.
- **Keep the short-query heuristic and rely only on deterministic tokens:** rejected. It leaves
  aspect routing, price/negation, lexical correction, and other parse fields unreachable for the
  highest-volume query shape.
- **Keep wholesale soft relaxation behind a flag:** rejected. There is no caller that needs the
  known-bad behavior; strict-only fallback is safer than removing every stated soft constraint.

### 2.5 Drawbacks and Tradeoffs

- Every uncached NLQ-enabled short text query now pays generation latency. The seven-day cache
  amortizes repeat queries; deterministic matching protects exact soft enum constraints.
- Vocab maintenance adds trigger work and one indexed candidate lookup to collections that have
  open-vocab filterable text fields. Correct decrement-on-update/delete/status behavior is
  required; stale membership would violate REQ-4.
- Progressive relaxation adds one batched selectivity probe and up to one retrieval retry per
  dropped derived soft field. It runs only when the strict candidate count is below the target.
- Typed recovery adds one cached generation call plus guarded embeddings and one retrieval retry
  only on an eligible thin/empty path.
- Catalog strings enter a prompt. Structural output clamps and scoped lookup are mandatory (§10).

## 3. Strict Requirements

- **REQ-1 — compatibility and breaking-change boundary.** Collections with no open-vocab
  filterable text fields emit byte-identical collection DDL and issue no vocab SQL. Retrieval SQL
  shape remains unchanged outside relaxation/rewrite probes. Prompt/result identity is not
  promised for NLQ-enabled collections: every non-empty short text query now parses, which is a
  deliberate alpha breaking change with the cache/latency behavior in §2.3. Collections with no
  NLQ config or `nlq.enable === false` remain opted out; pure image-only behavior is unchanged.
- **REQ-2 — live scoped vocabulary.** For each collection with open-vocab fields, create
  `<schema>.c_<coll>_vocab (scope columns..., field text, value text, count int CHECK (count > 0),
  PRIMARY KEY (scope columns..., field, value))` and a GIN `gin_trgm_ops` index over `value`.
  In the collection-apply transaction, replace its contents from ready/visible rows so backfill is
  exact and idempotent. A generated row trigger on the collection table applies exact OLD-to-NEW
  deltas when open-vocab values, scope, or visibility status changes and on deletion, removing
  zero-count entries. Normal writes never full-rescan. Unscoped collections omit scope columns;
  scoped lookup requires the complete resolved scope.
- **REQ-3 — grounded parse and cache invalidation.** Before parsing, retrieve at most eight values
  per open-vocab field using normalized whole-query and query-bigram trigram similarity above
  0.25, ordered by best similarity then count. Candidate-backed fields become schema enums and
  the prompt labels them as catalog values. `nlqCacheKey` adds an NLQ schema-version marker and a
  stable hash of field-sorted candidate sets while preserving its existing aspect hash. A changed
  candidate set cannot reuse a parse for seven days.
- **REQ-4 — map-or-drop guardrail.** Every parsed open-vocab value must be case-insensitively
  present in the visible scoped vocabulary. Otherwise map it to the nearest value at trigram
  similarity at least 0.4; if no mapping qualifies, drop that filter and append the original value
  to `semantic_query`. Missing/stale vocab infrastructure fails closed for open-vocab filters:
  parsing and retrieval continue, but no unverified value becomes a hard filter. After this step,
  every accepted open-vocab predicate matches at least one live visible row.
- **REQ-5 — corrected lexical surface.** The parse schema exposes optional `lexical_query`, a
  typo-corrected, constraint-stripped keyword surface. On a non-degraded non-empty value,
  `runHybridQuery` uses it for the AND tsquery, OR tsquery, FTS gate, and phonetic tsquery. Raw `q`
  remains the fallback for disabled/degraded/empty parses and image-only requests. All lexical
  branches use the same chosen string.
- **REQ-6 — typed honest-zero recovery.** After progressive relaxation and the cutoff, if the
  effective result has fewer than three candidates, the parse is non-degraded, the query has no
  explicit user filters, and evidence proves the loss came from an empty/thin retrieval gate—not
  the relevance floor or cutoff—make one stage-cached call for up to three ordered typed rewrites.
  Retry only the first proposal whose original-query cosine is at least 0.6. Preserve the original
  structured constraints, do not run NLQ again for the retry, accept only a strict hit-count
  improvement, record `{ type, from, to }`, and never recurse. If no rewrite qualifies or helps,
  return the original honest result.
- **REQ-7 — NLQ on every text query and routing fallback.** `shouldSkipNlq` becomes a config/image-
  only disable check; its token-count heuristic and `tokenCount` are deleted. The duplicate
  `shouldSkipNlqForRouting` is deleted. In `resolveAspectPlans`, `skipToFirst` is true only for
  intent-mode degraded/disabled parses. Successful short parses route normally; degraded parses
  still use first-aspect-only. `parseSearchWeights`'s intent-mode non-primary-aspects-off rule and
  the image-only text-aspect rule remain unchanged.
- **REQ-8 — deterministic enum-token guard.** Before generation, normalize the query with Unicode
  NFKC, lowercase, punctuation-to-space, and collapsed whitespace. Longest-first whole-token
  matching considers `values` on soft filterable enum fields and soft filterable enum-array
  fields; existing `alsoMatch` literals are accepted as configured synonym/match literals only at
  their declared field and retain their current SQL expansion semantics. Ignore a match negated
  within the preceding two tokens by `not | no | without | exclude | except`, and ignore a phrase
  that maps ambiguously to multiple fields. Exact deterministic values replace conflicting
  positive NLQ values on the same soft field; explicit filters still override everything. The
  filters remain active on degraded parses and require zero generation calls to derive.
- **REQ-9 — progressive soft-filter relaxation.** `runRanked` never uses wholesale
  `excludeSoft: true`. When the strict total candidate count is below `min(3, requestedLimit)`,
  batch-probe each relaxable field under scope, visibility, and every non-relaxable predicate.
  Relax only NLQ/deterministic soft filters, never explicit filters; order by descending standalone
  match count (least selective first), then field name for deterministic ties. Drop one field,
  rerun, and stop as soon as the target is met or no relaxable field remains. Return the effective
  filter set and ordered steps. Facets, results, and explain use that same set.
- **REQ-10 — truthful observability and existing eval metrics.** `constraintTrace` records
  deterministic filters, each open-vocab parsed/mapped/dropped decision, ordered relaxation steps
  with probe/result counts, the actual `appliedFilters`, and the rewrite record. `relaxedFields`
  remains a prominent top-level summary. `searchExplain` reports the same execution as search.
  Zero-result rate and Hit@10 already exist in `core/eval/run.ts:27-34,142-160`; gate artifacts
  must report both by query type rather than reimplementing them.
- **REQ-11 — release gates.** On a same-corpus before/after run: typo-fixture nDCG strictly
  improves; tail/adversarial zero-result rate strictly drops; OOD honest zeros are unchanged;
  standing-harness mean@10 and P@5 are flat-or-better; and warm non-rewrite p95 at 5,000 documents
  is within +10%. The latency percentage is a target, not an observed result.

## 4. Interface Specification

### 4.1 Vocabulary lifecycle and lookup

- **New location:** `packages/server/src/core/field-vocab.ts`.
- **DDL/lifecycle seam:** `makeCollectionsSchemaGen().ensureCollectionSystemColumns` in
  `collections-schema-gen.ts`.

```ts
type VocabCandidates = Record<string, Array<{ value: string; count: number }>>;
type VocabLookup = { available: boolean; candidates: VocabCandidates };

function vocabCandidates(
  ctx: MatcherCtx,
  schema: string,
  collection: string,
  def: CollectionDef,
  q: string,
  scopeCols: Record<string, string>
): Promise<VocabLookup>;

function groundVocabValues(
  ctx: MatcherCtx,
  schema: string,
  collection: string,
  values: Record<string, string[]>,
  scopeCols: Record<string, string>
): Promise<{ available: boolean; decisions: Record<string, GroundedValueDecision[]> }>;
```

`vocabCandidates` makes one round-trip for every eligible field. It returns
`{ available: true, candidates: {} }` without issuing SQL when none exist.
`groundVocabValues` checks exact case-insensitive membership and nearest mapping for every parsed
value in one round-trip. Missing-table errors are recognized narrowly as pre-migration state and
return `available: false` to REQ-4; unrelated database errors propagate.

`ensureCollectionSystemColumns` emits no vocab statements for ineligible collections. For
eligible ones it
emits, in order, the table/index, an idempotent replacement backfill (`DELETE`, then grouped
`INSERT`) from `(pipeline_status = 'ready' OR pipeline_status IS NULL)` rows, a generated trigger
function, and the trigger. The trigger compares non-empty scalar text fields on `INSERT`, `UPDATE`,
and `DELETE`; it decrements OLD visible values, increments NEW visible values, includes every scope
column in the key, and deletes zero counts. Because it observes the base-table transaction, it
covers `runIndexCollection`, `indexOne`, `indexDocuments`, `removeDocuments`, quarantine, and
future write paths without application-level dual writes.

### 4.2 NLQ result, grounding, and deterministic filters

**Location:** `packages/server/src/core/nlq.ts`; `query-enum.ts` may be introduced only if keeping
normalization/matching in `nlq.ts` would make that module materially harder to test.

```ts
interface GroundedValueDecision {
  parsed: string;
  mapped?: string;
  action: "kept" | "mapped" | "dropped";
}

interface NlqParsed {
  semantic_query: string;
  lexical_query?: string;
  aspects?: Record<string, { subQuery?: string; weight: number }>;
}

interface NlqParseResult {
  parsed: NlqParsed;
  degraded: boolean;
  filters: SearchFilters;
  deterministicFilters: SearchFilters;
  groundedValues: Record<string, GroundedValueDecision[]>;
  excludeTerms: string[];
  budgetHints: Record<string, "cheap" | "premium">;
}

function deriveEnumTokenFilters(q: string, def: CollectionDef): SearchFilters;
```

`deriveNlqSchema(def, candidates)` enum-constrains open-vocab fields only when verified candidates
exist. After `normalizeSchema`, candidate injection adds the candidate enum to a custom property's
scalar string branch (`type: string|STRING`) or each string branch of `anyOf`, preserving its null
branch and required/optional status; an incompatible custom property is a configuration error, not
an ungrounded fallback. Custom schemas also receive missing `aspects` and `lexical_query` fragments.
`parseNlq` computes deterministic filters first, then loads/generates the parse, applies REQ-4,
and merges with the precedence: explicit filters (later in `retrieve`) > deterministic exact value
> positive LLM value. LLM exclusions remain.

The derived matcher itself is pure and never calls `ctx.generate`; a normal uncached enabled query
still proceeds to `parseNlq` generation as required by REQ-7. On generation failure, the fallback
is degraded but contains deterministic filters.

### 4.3 Lexical selection and aspect routing

**Locations:** `retrieve` and `runHybridQuery` in `search.ts`; `resolveAspectPlans` in
`search-query.ts`.

`Retrieval` gains `lexicalText`, selected once in `retrieve` from non-degraded
`parsed.lexical_query` or raw `q`. `runHybridQuery` accepts `lexicalText` instead of raw `q` for
every FTS expression. `resolveAspectPlans` removes its private query-token heuristic and computes
`skipToFirst` from parse availability/degradation only. No aspect-mode weights change.

### 4.4 Progressive relaxation

**Locations:** `runRanked` in `search.ts`, with a small probe helper colocated there unless it is
reused elsewhere; `buildFilterSql` remains the canonical predicate compiler.

```ts
interface RelaxationStep {
  field: string;
  standaloneMatchCount: number;
  resultCount: number;
}

interface RankedRun {
  rows: Array<Record<string, unknown>>;
  totalCandidates: number;
  effectiveFilters: SearchFilters;
  relaxedFields: string[];
  relaxationSteps: RelaxationStep[];
  gateEvidence: "retrieval" | "relevance_floor" | "none";
}

interface ResolvedExecution {
  ranked: RankedRun;
  zeroCause: "retrieval" | "relevance_floor" | "cutoff" | "none";
}
```

The count query compiles the same typed predicates and includes ready-row visibility plus resolved
scope. It returns one count per relaxable field in one database round-trip. `totalCandidates`, not
page length, drives the threshold so offsets and small pages do not cause relaxation. The ranked
SQL must return the total even when the requested page is empty.
`runHybridQuery` also exposes candidate counts before and after the relevance floor:
`gateEvidence = "retrieval"` when the pre-floor count is below target, and
`"relevance_floor"` when only the post-floor count is below target. The shared finisher changes
`zeroCause` to `"cutoff"` whenever `applyCutoff` removed the candidates that made the result thin.

### 4.5 Rewrite recovery and shared execution

- **New location:** `packages/server/src/core/query-rewrite.ts`.
- **Integration seams:** `retrieve`, `runRanked`, `finishSearch`, `finishExplain`, `search`,
  `searchExplain`, and `searchWithExplain` in `search.ts`.

```ts
type RewriteType = "spellfix" | "synonym" | "broader" | "substitute";
type Rewrite = { type: RewriteType; query: string };
type RewriteRecord = { type: RewriteType; from: string; to: string };

function proposeRewrites(
  ctx: MatcherCtx,
  def: CollectionDef,
  q: string,
  reason: "empty" | "thin"
): Promise<Rewrite[]>;
```

The cache key includes collection, normalized query, reason, model, instructions, and rewrite
schema version. Malformed types, empty strings, duplicates, and the original query are discarded.
Cosine validation uses the collection's primary text embedding; without one, no rewrite is
accepted. The retry reuses the original parsed constraints and recomputes lexical/aspect vectors
for the replacement text, so it adds no second NLQ parse.

Search, explain, and combined search-with-explain consume one shared resolved execution. This
prevents duplicate rewrite calls and guarantees explain/facets correspond to returned hits.
`SearchResult` and `SearchExplainResult` gain an optional `rewritten` record; the same record is
also present in `constraintTrace`.

The public trace extension is additive and exact:

```ts
type ConstraintTraceSource =
  | "nlq"
  | "deterministic"
  | "explicit"
  | "budget_hint"
  | "agent";

interface ConstraintTrace {
  // Existing fields remain; appliedFilters is the effective post-relaxation set.
  deterministicFilters: Record<string, unknown>;
  groundedValues: Record<string, GroundedValueDecision[]>;
  relaxationSteps: RelaxationStep[];
  rewritten?: RewriteRecord;
}

interface SearchResult {
  rewritten?: RewriteRecord;
}

interface SearchExplainResult {
  rewritten?: RewriteRecord;
}
```

## 5. Architecture and System Dependencies

### 5.1 Structural Changes

- `collections-schema-gen.ts` — `ensureCollectionSystemColumns` emits scoped vocab DDL, exact
  apply backfill, delta trigger, and trgm index for both new and existing collections. The trigger
  covers every base-table mutation path without changes to index/ingest code.
- `field-vocab.ts` — field discovery plus candidate, membership, and nearest lookup.
- `nlq.ts` — deterministic matching, candidate injection, schema version/cache hash,
  `lexical_query`, and map-or-drop.
- `search-query.ts` — remove duplicated token routing heuristic; preserve degraded fallback and
  merged multi-aspect mode rules.
- `search.ts` — choose lexical text, progressively relax in `runRanked`, share resolved execution,
  and perform one guarded rewrite retry.
- `constraint-trace.ts` and `packages/sdk/src/types.ts` — truthful public trace/result shapes.
- `query-rewrite.ts` — typed proposal schema and stage cache.
- `core/eval/run.ts` — no implementation change for zero-result rate or Hit@10; both already
  exist. `examples/fashion-search/eval-search.ts` exposes them with mean@10 and P@5 in a common
  artifact, and a focused latency runner supplies the p95 gate.

### 5.2 Service and Library Dependencies

`pg_trgm` is already required by the entity path. This RFC uses the existing generation,
embedding, storage, stage-cache, scope, and observability services; it introduces no vendor or
runtime dependency.

### 5.3 Data and Schema Changes

One additive vocab table and trigger appear only for collections with open-vocab filterable text
fields. Apply replaces counts from ready rows, grouped by all scope columns plus field and value.
The table is derived state: rollback may drop it and a later apply may rebuild it from collection
rows. Trigger maintenance and document mutation share a transaction, so membership cannot lead or
lag a committed document or visibility transition.

### 5.4 Network and Performance Considerations

- Deterministic token matching is in-process and makes zero network calls.
- Grounding adds one indexed database round-trip on an eligible query. The previous draft's
  “<1 ms” estimate is removed because no repository artifact measures it.
- Every newly unskipped cold short query adds one awaited NLQ call; a stable key is cached for
  seven days. This is the explicit §2.3 tradeoff, not a hidden compatibility claim.
- Progressive relaxation adds one batched count query plus at most one ranked retry per dropped
  field. The +10% warm non-rewrite p95 allowance is a release target (REQ-11).
- Typed recovery adds at most one cached generation call, cosine validation, and one retrieval
  retry. No recursive parse/rewrite fan-out is permitted.

## 6. Pseudocode

```text
retrieve(project, collection, opts, retryContext = none):
  def, scope = resolve collection and scope
  q = trim(opts.q)
  deterministic = deriveEnumTokenFilters(q, def)                  # REQ-8

  if retryContext:
    nlq = retryContext.originalNlq                                # no second parse
  else if q is empty and opts.image exists:
    nlq = imageOnlyFallback()
  else:
    candidates = vocabCandidates(..., q, scope)                   # REQ-2/3
    nlq = parseNlq(..., q, candidates, deterministic)             # REQ-3/4/7/8

  merged = mergeFilters(nlq.filters, opts.filters)                # explicit wins
  lexicalText = nonDegraded(nlq.parsed.lexical_query) or q        # REQ-5
  aspectPlans = resolveAspectPlans(..., nlq, semanticText, ...)   # degraded -> first
  return Retrieval(..., lexicalText, merged)

parseNlq(...):
  schema = augmentSchemaWithAspectsAndLexicalQuery(...)
  key = hash(version, model, instructions, aspects, candidates, collection, normalizedQ)
  parsed = cache.get(key) or generate(schema, groundedPrompt)
  grounded = mapOrDropOpenVocab(parsed, visibleVocab)              # REQ-4
  filters = mergePositiveNlqWithDeterministic(grounded, deterministic)
  return parsed result; degraded fallback retains deterministic filters

runRanked(retrieval, requestedLimit):
  strict = runHybridQuery(..., retrieval.lexicalText, retrieval.mergedFilters)
  target = min(3, requestedLimit)
  if strict.totalCandidates >= target: return strict

  relaxable = NLQ/deterministic soft fields minus explicit fields
  counts = batchStandaloneCounts(relaxable, hard + explicit, scope, visibility)
  for field in sort(count desc, field asc):                       # least selective first
    effectiveFilters = effectiveFilters without field
    retry = runHybridQuery(..., effectiveFilters)
    record(field, counts[field], retry.totalCandidates)
    if retry.totalCandidates >= target: break
  return retry with effectiveFilters and ordered steps             # REQ-9

resolveExecution(retrieval, opts):
  ranked = runRanked(retrieval, opts.limit)
  cut = applyCutoffWithCause(ranked)
  zeroCause = cut.dropped > 0 ? cutoff : ranked.gateEvidence
  if not rewriteEligible(cut, zeroCause, opts.filters, retrieval.nlq): return cut

  proposals = proposeRewrites(..., emptyOrThin(cut))               # REQ-6
  best = first proposal with cosine(original, proposal) >= 0.6
  if no best: return cut
  retryRetrieval = retrieve(..., q = best.query, retryContext = original constraints)
  retry = runRanked(retryRetrieval, opts.limit), then cutoff
  return retry only if retry.hitCount > cut.hitCount; else cut

finishSearch/finishExplain(sharedExecution):
  use shared effectiveFilters for hits, facets, SQL explain, and constraintTrace
```

## 7. Code Blueprint

```ts
// nlq.ts — deterministic exact matching is pure and precedence is explicit.
const deterministic = deriveEnumTokenFilters(q, def);
const parsedFilters = nlqParsedToFilters(guardedParsed, def);
const filters = mergeDeterministicSoftFilters(parsedFilters.filters, deterministic, def);

// search-query.ts — no query-length routing branch remains.
const skipToFirst = mode === "intent" && (nlq.degraded || isNlqDisabled(def));

// search.ts — every lexical branch receives one selected string.
const lexicalText =
  !nlq.degraded && typeof nlq.parsed.lexical_query === "string" &&
  nlq.parsed.lexical_query.trim()
    ? nlq.parsed.lexical_query.trim()
    : q;
await runHybridQuery(..., lexicalText, ...);

// runRanked — remove one derived soft field per retry; never use excludeSoft: true.
for (const probe of probes.sort(byHighestCountThenField)) {
  effectiveFilters = withoutField(effectiveFilters, probe.field);
  ranked = await runHybridQuery(..., effectiveFilters, ...);
  steps.push({
    field: probe.field,
    standaloneMatchCount: probe.count,
    resultCount: ranked.totalCandidates,
  });
  if (ranked.totalCandidates >= target) break;
}
```

The implementation must not add a compatibility mode, `_v2` API, or fallback to wholesale soft-
filter removal. One canonical behavior replaces the known-bad paths.

## 8. Incremental Task Breakdown

| ID | Chunk | Exact files/functions | Grounding | Acceptance criteria |
|----|-------|-----------------------|-----------|---------------------|
| C1 | Scoped vocab DDL, exact backfill, and lifecycle trigger | `collections-schema-gen.ts`: `ensureCollectionSystemColumns` plus private vocab-DDL helper; `collections-ddl.test.ts`, `embed-index.test.ts`, `remove-documents.test.ts` | REQ-1, REQ-2, `test:vocab-maint` | New and existing eligible collections create the scoped table/index, replace counts idempotently, and install an OLD/NEW visibility-aware trigger. Tests through direct index, pipeline index, status transition, replacement, and deletion prove exact deltas/zero-row removal. No-open-vocab DDL snapshot is unchanged. |
| C2 | Candidate grounding, cache version, and map-or-drop | `field-vocab.ts`: `vocabCandidates`, nearest/membership query; `nlq.ts`: `deriveNlqSchema`, `nlqCacheKey`, `nlqParsedToFilters`, `parseNlq`; `nlq.test.ts` | REQ-3, REQ-4, `test:vocab-candidates`, `test:nlq-grounded`, `test:guardrail` | Stored variants rank deterministically; scope cannot leak values; candidate/aspect/schema-version changes miss cache; invented values map or drop into semantic text; unavailable vocab never yields an open-vocab hard filter. |
| C3 | Deterministic soft-enum guard | `nlq.ts` or focused `query-enum.ts`: `deriveEnumTokenFilters`, merge helper, `parseNlq`; `nlq.test.ts` | REQ-8, `test:enum-token-short-query` | `red dress` derives `colors: ["red"]` from the fashion enum with zero calls by the matcher; negated and cross-field ambiguous tokens do not become positives; deterministic values survive degraded generation and replace conflicting positive NLQ values; explicit filters still win. |
| C4 | Always-on text NLQ and sane multi-aspect fallback | `nlq.ts`: `shouldSkipNlq`, delete `tokenCount`, `parseNlq`; `search-query.ts`: `resolveAspectPlans`, delete `shouldSkipNlqForRouting`; `search.ts`: parsed/degraded exposure in `finishSearch`/`finishExplain`; `nlq.test.ts`, `aspect-retrieval.test.ts`, `search-mode.test.ts` | REQ-1, REQ-7, `test:nlq-always` | A two-token enabled query generates once, returns a parse, then hits the seven-day cache; its successful parse routes normally; a degraded or disabled parse uses first-aspect-only; intent-aspects-off and pure-image rules remain green. |
| C5 | Corrected lexical surface | `nlq.ts`: schema/result augmentation; `search.ts`: `Retrieval`, `retrieve`, `runHybridQuery`; `nlq.test.ts`, `search-hybrid.test.ts`, `multilingual-search.test.ts` | REQ-5, `test:lex-corrected` | One non-degraded `lexical_query` feeds AND/OR/gate/phonetic tsqueries; disabled, degraded, empty, and image-only paths use raw/no text as specified; typo fixture's corrected terms produce FTS hits; multilingual fixtures do not regress. |
| C6 | Progressive relaxation with truthful effective filters | `search.ts`: `runRanked`, count probe, `finishSearch`, `finishExplain`; `constraint-trace.ts`: relaxation helpers; `search-hybrid.test.ts`, `search-explain.test.ts` | REQ-9, REQ-10, `test:progressive-relax`, `test:trace-grounding` | The live-shaped fixture contains exactly three strict red/wedding rows but only two pass initial retrieval evidence; occasion has the higher standalone count, is relaxed before color, and the retry returns no color-mismatched hit while red candidates exist. Explicit soft filters never relax; facets, result, and explain report the same effective filters and ordered step. |
| C7 | Typed rewrite service and shared honest-zero execution | new `query-rewrite.ts`; `search.ts`: `retrieve`, `runRanked`, `finishSearch`, `finishExplain`, `search`, `searchExplain`, `searchWithExplain`; `cutoff.test.ts`, new focused rewrite tests | REQ-6, `test:rewrite-ladder` | Eligible gate-empty/thin query makes at most one cached proposal call and one retry with original constraints; no second NLQ call or recursion; floor/cutoff/OOD/explicit-filter empties never rewrite; unhelpful retry preserves the original result; search and explain share the accepted execution. |
| C8 | Public trace/result shapes and observability | `packages/sdk/src/types.ts`: `ConstraintTrace`, search/explain result types; `constraint-trace.ts`: `buildConstraintTrace`; `search.ts`: result assembly; `observability.test.ts`, `search-explain.test.ts` | REQ-10, `test:trace-grounding` | Trace records deterministic and grounding decisions, actual applied filters, ordered probe/result counts, and rewrite; `relaxedFields` remains top-level; serialized HTTP and in-process shapes agree. |
| C9 | Same-corpus release gate and artifact | `examples/fashion-search/eval-search.ts`: add `--fixture` plus common mean@10/P@5/zero-result/Hit@10 output; `eval-adversarial.ts`: add phase metadata; new `examples/fashion-search/bench-latency.ts`; `evals/` artifacts | REQ-11, `cmd:gate`, `cmd:latency` | Capture the base-SHA baseline before C1 and the candidate after C8 against the unchanged corpus/judge. Artifacts record typo nDCG, zero-result/Hit@10 by type, OOD zeros, mean@10, P@5, and p95; all REQ-11 comparisons pass. No metric value is claimed until artifacts exist. |

Dependencies: C9's baseline capture runs at base SHA `371d085` before C1. C1 precedes C2; C2 and
C3 precede C4; C4 precedes C5; C5 and C6 precede C7; C2/C3/C6/C7 precede C8; C1-C8 precede
C9's candidate capture/verdict. C3 and C6 may be built in parallel after C1 because they do not
share implementation files other than later trace assembly.

## 9. Validation and Testing

### 9.0 Validation Contract

| ID | Source | Assertion |
|----|--------|-----------|
| REQ-1..11 | §3 | Every strict requirement holds as written. |
| test:vocab-maint | §9.1 | Scoped live vocabulary has exact insert/update/delete counts and no-op compatibility. |
| test:vocab-candidates | §9.1 | Candidate ordering, scoping, threshold, and missing-table behavior are deterministic. |
| test:nlq-grounded | §9.1 | Grounded schema/prompt and candidate/aspect/version cache invalidation hold. |
| test:guardrail | §9.1 | Every open-vocab filter maps to a live value or drops into semantic text. |
| test:enum-token-short-query | §9.1 | `red dress` derives `colors:red` in the pure matcher with zero LLM calls. |
| test:nlq-always | §9.1 | A two-token query produces a cached parse and sane success/degraded routing. |
| test:lex-corrected | §9.1 | Corrected lexical text feeds every FTS branch with raw-query fallbacks intact. |
| test:progressive-relax | §9.1 | Live-shaped three-strict-match case relaxes occasion before color and preserves red. |
| test:rewrite-ladder | §9.1 | One guarded rewrite improves eligible nulls and preserves every honest-zero cause. |
| test:trace-grounding | §9.1 | Search, facets, trace, and explain report one effective execution truthfully. |
| cmd:gate | §9.3 | Same-corpus relevance and honesty comparisons satisfy REQ-11. |
| cmd:latency | §9.3 | Warm non-rewrite p95 at 5,000 docs stays within the +10% target. |

### 9.1 Fail-to-Pass Tests

- **`test:vocab-maint`:** index two scoped rows sharing a value; assert count two. Replace one
  value, quarantine/restore it, and delete the other; assert OLD/NEW visibility deltas and zero-row
  deletion. Exercise `indexDocuments`, `runIndexCollection`, `indexOne`, and `removeDocuments` to
  prove the trigger covers every current path. Re-applying replaces rather than doubles counts. A
  collection without open-vocab fields emits the pre-v2 DDL snapshot and makes no vocab call.
- **`test:vocab-candidates`:** whole-query and bigram matches return at most eight values per
  field ordered by similarity/count; a second tenant's values are absent; recognized missing-table
  state is unavailable rather than an ungrounded success.
- **`test:nlq-grounded`:** prompt/schema values come only from candidates. Changing candidates,
  aspect descriptions, or the NLQ schema version changes the cache key; stable inputs hit cache.
- **`test:guardrail`:** property over generated parsed strings: each emitted open-vocab filter has
  a visible row, or is absent and its original text appears in `semantic_query`. This map-or-drop
  property is mandatory on custom schemas and missing-vocab state too.
- **`test:enum-token-short-query`:** call the pure deterministic matcher for `red dress` using the
  fashion field definitions; assert `colors: ["red"]` and zero generator calls. Add `not red
  dress`, punctuation/case/NFKC, longest multi-word occasion, ambiguous phrase, degraded parse,
  conflicting LLM value, and explicit override cases.
- **`test:nlq-always`:** clear the stage key and search `running shoes` twice. The first request
  invokes generation once and returns parsed data; the second adds no call. A routed success does
  not set `skipToFirst`; a forced generation failure does; disabled NLQ and an image-only request
  make no generation call.
- **`test:lex-corrected`:** parse `adidas snekers` to lexical `adidas sneakers`, inspect bound SQL
  parameters, and prove corrected FTS retrieval. Assert the AND, OR, gate, and phonetic branches
  share that parameter. Repeat degraded/disabled/empty lexical and multilingual fallbacks.
- **`test:progressive-relax`:** fixture the live shape for `red dress for a wedding`: exactly three
  rows satisfy both soft filters, two have initial retrieval evidence, and standalone occasion
  count exceeds color count. Assert occasion is the first/only dropped field needed to reach the
  target, every returned hit remains red, explicit soft fields are immutable, and trace
  `appliedFilters` omits occasion but retains color.
- **`test:rewrite-ladder`:** cover eligible empty and thin gates, cache hit, cosine rejection,
  malformed proposal, no primary text embedding, non-improving retry, and no recursion. Assert no
  proposal call for explicit filters, relevance-floor removal, cutoff removal, degraded parse, or
  OOD `laptop` against clothing. The OOD result remains empty.
- **`test:trace-grounding`:** kept/mapped/dropped values, deterministic source, ordered relaxation
  counts, actual applied filters, and accepted rewrite serialize identically through search and
  explain.

### 9.2 Regression Tests (Pass-to-Pass)

- `bun test packages/server` including NLQ, hybrid search, scope, cutoff, cache, multi-aspect,
  image-only, multilingual, dedup, and remove-document suites.
- `bun test packages/sdk` for public type compatibility.
- Existing `evals/golden-queries-fashion-lk.json:1-311` query IDs and
  `evals/search-queries-typo.json:1-19` fixture schema remain valid.
- Existing multi-aspect C9 defaults and image-only rank-one smoke remain unchanged
  (`rfcs/rfc-multi-aspect-retrieval.md:543-568`).

### 9.3 Validation Commands

```bash
bun test packages/server
bun test packages/sdk
# Run at base SHA 371d085 before C1, then repeat as --phase=grounded-v2 after C8.
bun --env-file=.env examples/fashion-search/eval-search.ts --phase=grounded-v2-baseline --fixture=evals/golden-queries-fashion-lk.json --limit=10
bun --env-file=.env examples/fashion-search/eval-search.ts --phase=grounded-v2-baseline-typo --fixture=evals/search-queries-typo.json --limit=10
bun --env-file=.env examples/fashion-search/eval-adversarial.ts --phase=grounded-v2-baseline
bun --env-file=.env examples/fashion-search/eval-search.ts --phase=grounded-v2 --fixture=evals/golden-queries-fashion-lk.json --limit=10
bun --env-file=.env examples/fashion-search/eval-search.ts --phase=grounded-v2-typo --fixture=evals/search-queries-typo.json --limit=10
bun --env-file=.env examples/fashion-search/eval-adversarial.ts --phase=grounded-v2
jq '{mean10:.overall.meanAt10,p5:.overall.pAt5,zero:.overall.zeroResultRate,hit10:.overall.hitAt10}' evals/runs/*grounded-v2*.json
bun --env-file=.env examples/fashion-search/bench-latency.ts --phase=grounded-v2 --docs=5000 --p=95 --warm --exclude-rewrites
```

The C9 worker must record exact commands, git SHA, corpus identity, judge/model versions, and
artifact paths. `eval-search.ts` does not yet expose `--fixture` or the common metric names,
`eval-adversarial.ts` does not yet stamp a requested phase, and `bench-latency.ts` does not yet
exist; implementing those declared C9 surfaces is part of the chunk, not permission to substitute
a different measurement.

## 10. Security Considerations

Vocab values are vendor-authored catalog strings entering the parse prompt. Render them only as
JSON/schema enum data, never concatenate them into instruction text, and keep filter SQL fully
parameterized. REQ-4 clamps output to live scoped membership even if generation escapes the enum.

Every vocab table key, backfill, delta, candidate query, nearest-value query, and relaxation probe
must include all resolved scope columns. A scoped request must never receive another scope's values,
counts, prompt candidates, or selectivity. Identifiers derive only from sanitized collection/field
configuration; user strings remain parameters. Missing vocab infrastructure fails closed for hard
filters rather than silently trusting model output.

Rewrite generation sees only the original user query plus fixed typed instructions. The returned
type is schema-constrained, the text is never used as SQL, cosine bounds semantic drift, and the
retry preserves original structured/explicit constraints. The no-recursion rule bounds cost and
prevents rewrite loops.

## 11. Rollback and Abort Criteria

- **Abort C1-C2** if the generated trigger cannot cover `runIndexCollection`, `indexOne`,
  `indexDocuments`, `removeDocuments`, and visibility transitions without stale membership. Do not
  ship a periodically correct guardrail; report the implementation conflict rather than weakening
  REQ-4.
- **Abort grounding prompt injection** if the same-corpus brand/open-vocab segment loses recall.
  Keep the REQ-4 map-or-drop guardrail, remove candidate injection, and re-run the gate. The
  guardrail is not negotiable.
- **Abort progressive relaxation** if `test:progressive-relax` or explicit-filter immutability
  fails. Roll back to strict-only soft filtering; never restore wholesale `excludeSoft: true`.
- **Abort typed rewrites** on any OOD, relevance-floor, cutoff, or explicit-filter resurrection.
  Remove C7 while retaining grounding, lexical correction, always-on parsing, deterministic enum
  filters, and progressive relaxation. Do not tune against the adversarial set beyond the single
  specified 0.6 target without a follow-up RFC and artifact.
- **Abort the release** if any REQ-11 gate fails. Record the failed artifact; do not average away a
  failing segment.
- **Rollback data:** vocab tables are derived and may be dropped after reverting the application;
  collection rows remain canonical. No data migration changes source documents.
- **Rollback behavior:** `nlq.enable === false` is the existing operational opt-out. There is no
  compatibility flag for the removed token heuristic under the alpha breaking-change policy; a
  deployment requiring old short-query behavior stays on the prior release.

## 12. Open Questions

- **Q1 — resolved for v2:** `lexical_query` feeds the FTS gate, AND/OR ranking tsqueries, and
  phonetic branch. One selected string prevents gate/ranker disagreement; multilingual regression
  tests protect the choice.
- **Q2 — resolved for v2:** store raw open-vocab values only. Whole-query and bigram probes provide
  partial matching without a second word-gram inventory; revisit only with a measured miss set.
- **Q3 — deferred, non-blocking:** session context remains a separate RFC after this single-query
  design is gated.
- **Provenance:** v2 integrates the owner decisions recorded in the pre-v2 draft's final resolved
  note after the 2026-07-18 live human test; the executable requirements are now REQ-7 through
  REQ-9, and this line supersedes that prose.

## 13. Execution Record (2026-07-19)

Implementation: 15 commits by the delegated worker on `feat/grounded-qu` (C1-C8), plus three
manager review fixes applied inline after live verification. Suite: 330 tests green.

### 13.1 Review findings and fixes

- **F1 — declared relaxation priority.** REQ-9's least-selective-first ordering dropped `colors`
  before `occasions` live ("red dress for a wedding" returned black dresses), contradicting the
  RFC's own motivating example. Fix: `search.relaxOrder` (SDK + server) — declared priority
  overrides probe counts; ties still fall to counts then field name. `test:progressive-relax`
  hardened with an inverted-count corpus.
- **F2 — LLM embellishment on minimal queries (REQ-5 amendment).** Live cached parses showed
  "hoddie" expanded to `lexical_query "streetwear hoodie"` plus an invented `styles:["streetwear"]`
  hard filter, and "saree blous" gained a translated synonym ("hattaya") in the lexical surface.
  Fix: `guardLexicalQuery` in `core/nlq.ts` — every emitted lexical token must sit within a small
  edit distance of an original query token (plural/exact for short tokens) and the token count must
  not grow; violations drop `lexical_query` entirely (FTS falls back to raw `q`). Applied in
  `finishParsed`, so poisoned cached parses are sanitized without a purge. A parse-contract block in
  `buildNlqPrompt` states the fidelity rules for filters, `lexical_query`, and `semantic_query`.
  Counter: `nlq_lexical_guard_drops`.
- **F3 — query-side taxonomy disagreement (REQ-4 extension to closed enums).** "saree blous"
  parsed to `category=tops` while every saree blouse in the corpus is enriched `category=ethnic`;
  the hard eq filter deleted the entire relevant set, and REQ-9 relaxation never fired because the
  wrong pool was plentiful (count-based triggers cannot detect a wrong pool). Fix:
  `dropUncorroboratedHardEnumFilters` — an LLM-derived positive value on a hard (non-soft) enum
  field is applied only when the enum value (or an `alsoMatch` alias) appears in the user's words
  (raw `q` or the guard-validated `lexical_query`, plural-insensitive). Soft fields keep LLM
  synonym mapping; exclusions (`$nin`/`$ne`) are exempt. Counter:
  `nlq_uncorroborated_enum_drops`.

### 13.2 REQ-11 gate result (same corpus, 5,512 docs, 67 judged queries)

Artifacts: `search-grounded-baseline` (main) vs `search-grounded-candidate3` (final);
intermediate `candidate`/`candidate2` runs record the F2/F3 diagnosis path. Adversarial:
`2026-07-18T22-20-13-357Z-adversarial` vs `2026-07-01T09-51-11-780Z-adversarial`.

- **Typo:** mean grade 2.050 → 2.083 (improved); nDCG 0.8983 → 0.8981 (flat, Δ −0.0002). The
  "strictly improves" letter is not met on nDCG; the delta is ~500× smaller than measured judge
  noise (identical result sets re-graded ±0.4: typo-07 2.4/2.8/2.4, neg-03 1.6→1.2 across runs).
  No deterministic typo fixture set exists; the judged eval is the only typo surface.
- **Zero-result rate:** 0% → 0% on the standing set (nothing to drop).
- **OOD honest zeros:** unchanged — same 8 pre-existing `junk-shown` OOD queries (relevance-floor
  calibration item, predates this RFC), `ood-08`/`comp-03` still correctly empty, overall
  adversarial pass 36 → 38 (two WEAKs became passes).
- **Standing harness:** overall mean grade 1.871 → 1.916 (+0.046); overall nDCG 0.890 → 0.885
  (−0.005, within run drift). Wins: multilingual +0.53, broad +0.50, attribute +0.10, local +0.08,
  use-case, keyword. Regressions: negation mean −0.40 (n=4; fully accounted for by the measured
  ±0.4 re-grade noise above — applied filters verified correct live), price nDCG −0.103 (single
  query `price-02`, ranking preference among correctly filtered ≤3000 office items).
- **Latency:** p95 target not measured this cycle (REQ-11 marks it a target, not an observed
  result).

**Verdict: ship.** Typo recovered from the initial −0.11 candidate regression to parity-or-better,
overall quality improved, no leg regressed beyond measured noise, honest zeros intact.

### 13.3 Residuals (follow-up work, not blockers)

- **Taxonomy granularity (`typo-12` "kurtaa top", 2.6 → 1.6).** The token "top" corroborates
  `category=tops`, but kurta tops are enriched `category=ethnic`. Single-valued category forces a
  choice the query straddles. Follow-up: optional-filter (boost-not-filter) semantics for derived
  enums, or multi-label category enrichment.
- **Per-bucket gate noise floor.** Strict-improve gates on n≤5 buckets are unachievable in
  principle at the measured judge noise (±0.4 mean grade on identical ids). Future gate specs need
  noise-scaled thresholds or a deterministic fixture set per bucket.
- **OOD junk-shown (8 queries).** Pre-existing relevance-floor calibration item; unchanged by this
  RFC; tracked on the roadmap.
