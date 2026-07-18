# RFC: Catalog-grounded query understanding — vocab-grounded NLQ, corrected lexical surface, typed zero-result rewrites

**Category:** New Feature (eval-gated change to existing code)
**Author:** Claude Fable 5 (session 2026-07-18, RFC-validation + research pass)
**Date:** 2026-07-18
**Status:** Draft
**Reviewers:** mithushancj
**Related:** `docs/research/2026-07-18-retrieval-research-notes.md` (evidence corpus) ·
`packages/server/src/core/nlq.ts` (parse + cache) · `packages/server/src/core/search.ts`
(`runRanked` relaxation ladder, lex CTE) · `packages/server/src/core/search-filter.ts` (text
predicates) · `examples/fashion-search/samesake.config.ts` (open-vocab fields: `brand`,
`product_type`, `store_domain`) · `evals/search-queries-typo.json` · baseline SHA `02af1f8`

---

## 1. Problem Statement

The NLQ layer is the only part of the retrieval core that reasons **without seeing the
catalog**. Three concrete failure modes, all on the fashion harness's weak segments:

1. **Ungrounded open-vocabulary filters.** Enum fields are schema-constrained in the derived
   NLQ schema (`deriveNlqSchema`, `nlq.ts:53-64` — the LLM picks from declared values), but
   `text` filterable fields (`brand`, `product_type`, `store_domain` in the fashion config)
   are free strings: the LLM invents the value from world knowledge, and the filter compiles to
   exact/near-exact string predicates against stored values (`search-filter.ts`). "nike jacket"
   → `brand: "Nike"` vs stored vendor string `"NIKE"`/`"Nike Sportswear"` → a silently wrong or
   empty **hard** filter. Industry measurement says this is the single biggest QU lever:
   DoorDash's intent system gains **+8.3pp of a +13pp total** from catalog grounding alone, and
   ungrounded LLM classification is its documented failure mode (−10.9pp); Instacart constrains
   every classification to catalog-retrieved candidates and guards output with embedding
   similarity (see research notes §2).
2. **The lexical leg never sees a corrected query.** The lex CTE consumes the **raw** `q`
   (`search.ts:310,383-390`); `semantic_query` only feeds the dense leg. A typo ("adidas
   snekers") inertly zeroes FTS — the exact eBay/Instacart tail-query failure. The typo eval
   fixture (`evals/search-queries-typo.json`) exists but nothing in the query path fixes typos
   for the lexical leg (`fts_phon` is cross-script, not typo tolerance).
3. **No recovery between "few results" and "empty page".** The ladder today is: soft-filter
   drop retry (`runRanked`, `search.ts:744-769`) → cutoff/relevance floor → honest zero.
   There is no query-rewrite step. Instacart's typed rewrites (substitute/broader/synonym)
   took rewrite coverage 50%→95%+ at 90%+ precision and cut tail-query complaints by half —
   the highest-precision null-recovery pattern published.

Success (eval-gated):

- Grounded parses: open-vocab filter values always resolve to values that exist in the catalog
  (or the filter is dropped and the term stays semantic) — a hard filter can no longer be
  silently unsatisfiable due to LLM phrasing.
- Typo queries reach the lexical leg corrected; the typo fixture's nDCG strictly improves.
- Zero-result rate on the tail/adversarial set strictly drops without polluting honest zeros
  (OOD queries still return empty — relevance-floor semantics untouched).
- Standing fashion harness (55 golden queries): mean@10 and P@5 flat-or-better.

### 1.1 Non-Goals / Out of Scope

- Non-goal: session/prior-query context injection (Walmart SIGIR'24 shows it needs a
  broad→narrow gate to avoid harm) — deferred to a follow-up once single-query grounding lands.
- Non-goal: head-query batch precompute. The 7-day NLQ stage-cache already amortizes head
  queries reactively; precompute is an optimization with no new capability.
- Non-goal: multi-intent (primary/secondary) output and product-vs-store disambiguation
  policies — needs marketplace routing surfaces that don't exist yet.
- Non-goal: any trained component (spellers, taggers, rankers). LLM + Postgres only.
- Non-goal: changing enum-field parsing — already grounded by schema; untouched (REQ-1).

## 2. Background

**Current flow** (`nlq.ts`): `shouldSkipNlq` skips ≤2-token no-digit queries; otherwise one
LLM call with a schema derived from filterable fields, 7-day stage-cache keyed on
instructions+model+collection+normalized query, degraded fallback = raw query. `parseNlq`
output feeds: hard filters (`mergeFilters` — NLQ + explicit), `semantic_query` (dense leg
only), `excludeTerms`, `budgetHints`. The lexical leg and the FTS gate consume raw `q`.

**Why grounding is cheap here:** the schema-derivation seam already exists — enum fields prove
the pattern (constrain the LLM to known values and quality follows). The missing piece for
open-vocab fields is *which* values to constrain to, and that is a per-query top-K lookup
against a small vocabulary table, not a design change. One pg_trgm-indexed lookup (<1ms at
vocab cardinalities: a 5k-doc corpus has ~10² distinct brands; 1M docs maybe 10⁴) injected
into the existing prompt — zero added LLM calls on the happy path.

### 2.1 Terminology

- **Open-vocab field:** a `text`-typed filterable field (values defined by data, not schema).
- **Vocab table:** per-collection `(field, value, count)` inventory of distinct stored values
  for open-vocab fields, maintained at index time.
- **Grounding candidates:** top-K vocab values trigram-similar to the query, injected into the
  NLQ prompt per field.
- **Typed rewrite:** an LLM-generated replacement query labeled `spellfix | synonym | broader |
  substitute`, guarded by embedding similarity to the original.

### 2.2 Alternatives Considered

- **Alt A — embed the whole vocabulary in the prompt:** correct for tiny catalogs, blows the
  prompt (and the cache key) past 10³ values. Rejected; candidate retrieval scales.
- **Alt B — post-parse fuzzy mapping only (no prompt change):** map whatever the LLM invents to
  the nearest stored value by trigram. Cheaper, but cannot disambiguate role confusion
  ("DKNY jeans": brand vs product_type) and corrects after the fact what grounding prevents.
  Kept as the **guardrail layer** (REQ-4), not the primary mechanism — same layering DoorDash
  and Instacart use (grounded prompt + output validation).
- **Alt C — separate entity-linking LLM call after parse:** cleaner separation, +1 call latency
  on every NLQ query. Rejected: the parse call already exists; injection is free (mirrors the
  multi-aspect RFC's Alt D reasoning).
- **Alt D — pg_trgm query-side fuzzy FTS (no LLM):** `similarity(title, q)` as a lexical
  fallback leg. Solves typos without NLQ but adds a fourth leg with its own calibration burden,
  and does nothing for grounding or recovery. Rejected for v1; noted as a fallback if REQ-5
  underperforms on the typo fixture.

### 2.3 Drawbacks and Tradeoffs

- Vocab freshness: values indexed after the last vocab refresh are invisible to grounding until
  the next index pass. Bounded by refreshing within `embedIndex` (REQ-2); worst case the
  guardrail (Alt B layer) still maps to the nearest existing value.
- Prompt-injection surface: vocab values are vendor-authored strings entering the prompt.
  Mitigated structurally (REQ-4 clamps output to vocab membership; §10).
- The rewrite step adds one LLM call — but only on the zero/thin-result path, which is
  precisely where latency is worth spending (the alternative is an empty page). Cached.
- Two more NLQ output fields (`lexical_query`, grounding-aware filters) grow the parse schema;
  cache invalidation must include the grounding candidate set (REQ-3, mirrors the multi-aspect
  RFC's F5 finding).

## 3. Strict Requirements

- REQ-1: Collections with no open-vocab filterable text fields produce byte-identical NLQ
  prompts, SQL, and results vs `02af1f8`. Enum-field parsing unchanged everywhere.
- REQ-2: Index-time vocab maintenance: `<schema>.c_<coll>_vocab (field text, value text,
  count int, PRIMARY KEY (field, value))` with a `gin (value gin_trgm_ops)` index, upserted
  incrementally as rows index (delta counts, no full rescan), scope-blind (values are not
  secrets within a collection; scoped collections mirror scope columns and scope the lookup).
- REQ-3: Grounded parse: for each open-vocab filterable field, retrieve top-K (default 8)
  vocab values with `similarity(value, q) > 0.25`; when any exist, the NLQ schema for that
  field becomes an enum of those candidates (plus absent), and the prompt lists them under the
  field's description. The NLQ cache key incorporates a hash of the injected candidate sets.
- REQ-4: Guardrail: any parsed open-vocab filter value not case-insensitively present in the
  vocab is trigram-mapped to the nearest value at similarity ≥ 0.4, else the filter is
  **dropped** and its text is retained in `semantic_query`. A hard filter that would match
  zero stored values is structurally impossible after this step.
- REQ-5: The parse emits optional `lexical_query` (typo-corrected, constraint-stripped keyword
  surface). When present and non-degraded, the lex CTE's tsquery inputs use it instead of raw
  `q`; the FTS **gate** and phonetic branch follow the same string. Raw `q` remains the
  fallback everywhere (skip-NLQ, degraded, empty rewrite).
- REQ-6: Zero-result recovery: when the post-ladder result is empty (or < 3 hits), the query
  was not degraded, and emptiness is caused by the retrieval gate (not by the relevance floor
  or an explicit user filter — honest zeros stay honest), one cached LLM call proposes up to 3
  typed rewrites (`spellfix|synonym|broader|substitute`); the best rewrite with query-embedding
  cosine ≥ 0.6 vs the original is retried once; the response records
  `rewritten: { type, from, to }`. No recursion.
- REQ-7: Observability: `constraintTrace` gains `groundedValues` (field → {parsed, mapped}) and
  the rewrite record; `searchExplain` surfaces both; eval metrics add zero-result rate and
  Hit@10 per query type.
- REQ-8: Gates on the standing harness + fixtures: typo fixture nDCG strictly improves;
  zero-result rate on the tail/adversarial set strictly drops; adversarial OOD suite unchanged
  (no junk resurrection); mean@10 / P@5 flat-or-better; p95 latency within +10% at 5k docs on
  the non-rewrite path.

## 4. Interface Specification

### 4.1 Vocab service

- **Location:** `packages/server/src/core/field-vocab.ts` (new), DDL in
  `collections-schema-gen.ts`
- **Signature:** `vocabCandidates(ctx, schema, coll, def, q, scope): Promise<Record<string,
  Array<{ value: string; count: number }>>>` — one round-trip for all open-vocab fields.
- **Behavior:** trigram similarity against whole-query and query bigrams; top-K by
  `(similarity, count)`; empty map when the collection has no open-vocab fields (REQ-1).
- **Error cases:** vocab table missing (pre-migration) → empty map, never an error.

### 4.2 NLQ extensions

- **Location:** `packages/server/src/core/nlq.ts`
- **Signature (result extension):**

```ts
lexical_query?: string;           // typo-corrected keyword surface (REQ-5)
// open-vocab fields' schema entries become enums of grounding candidates (REQ-3)
```

- **Behavior:** `deriveNlqSchema(def, candidates)` gains the candidates argument;
  `nlqCacheKey` gains `sha1(candidateSets)`; `nlqParsedToFilters` applies the REQ-4 guardrail
  with the vocab in hand.
- **Error cases:** candidate lookup failure degrades to today's ungrounded schema (never
  blocks the query path — same posture as the existing cache try/catch).

### 4.3 Rewrite recovery

- **Location:** `packages/server/src/core/search.ts` (`finishSearch`), new
  `core/query-rewrite.ts`
- **Signature:** `proposeRewrites(ctx, def, q, reason: "empty" | "thin"):
  Promise<Array<{ type: RewriteType; query: string }>>` — stage-cached like NLQ.
- **Behavior:** ladder position: after cutoff, before returning empties (REQ-6 conditions).
  Rewritten retry reuses the same `retrieve()` path with the rewrite as `q` and
  `rewritten` annotated.

## 5. Architecture and System Dependencies

### 5.1 Structural Changes
- `collections-schema-gen.ts` — vocab table DDL + trgm index (additive; only for collections
  with open-vocab filterable fields).
- `embed-index.ts` — vocab delta upsert alongside row writes.
- `nlq.ts` — candidate injection, schema/prompt/cache-key changes, guardrail.
- `search.ts` / `search-query.ts` — `lexical_query` wiring; rewrite ladder step.
- `eval/run.ts` — zero-result rate + Hit@10 metrics; fixtures for brand-intent queries.

### 5.2 Service and Library Dependencies
- `pg_trgm` (already a required extension for the entity path). Existing NLQ + generate
  models; no new vendors.

### 5.3 Data and Schema Changes
- One additive table per opted-in collection; backfill = one `INSERT ... SELECT field-wise
  GROUP BY` per open-vocab field at apply time.

### 5.4 Network and Performance Considerations
- Happy path: +1 indexed trigram lookup (<1ms at 10⁴ vocab rows), zero extra LLM calls.
- Rewrite path: +1 LLM call + 1 retrieval retry, only when the alternative is an empty page;
  cached per (collection, query, reason).

## 6. Pseudocode

```
# retrieve() — before parseNlq
candidates = vocabCandidates(ctx, schema, coll, def, q, scope)      # REQ-3
nlq = parseNlq(ctx, def, q, candidates)                             # schema + cache key aware

# nlqParsedToFilters — open-vocab guardrail (REQ-4)
FOR field IN openVocabFields(def):
    v = parsed[field]
    IF v AND NOT vocabHas(field, v):
        mapped = vocabNearest(field, v)          # trigram ≥ 0.4
        IF mapped: filters[field] = mapped
        ELSE: drop filter; semantic_query += " " + v

# lex CTE input (REQ-5)
lexQ = (!nlq.degraded AND nlq.parsed.lexical_query?.trim()) || q

# finishSearch — recovery ladder (REQ-6)
IF hits.length < 3 AND NOT nlq.degraded AND gateEmpty(evidence) AND NOT explicitFilters:
    rewrites = proposeRewrites(ctx, def, q, hits.length == 0 ? "empty" : "thin")
    best = first r IN rewrites WHERE cos(embed(r.query), embed(q)) >= 0.6
    IF best:
        retry = retrieve(..., { ...opts, q: best.query, _noRewrite: true })
        IF retry.hits.length > hits.length: return { ...retry, rewritten: best }
```

## 7. Code Blueprint

```ts
// packages/server/src/core/field-vocab.ts — candidate lookup (one query, all fields)
const rows = await ctx.storage.client("field-vocab").unsafe(
  `SELECT field, value, count FROM ${vocabTable}
   WHERE similarity(value, $1) > 0.25
   ORDER BY field, similarity(value, $1) DESC, count DESC`,
  [q]
);
// deriveNlqSchema(def, candidates): open-vocab text field with candidates present →
properties[name] = {
  type: "STRING",
  enum: [...candidates[name].map((c) => c.value)],
  description: `Filter by ${name}. Only use a listed value, and only when the query
    clearly references it.`,
};
```

## 8. Incremental Task Breakdown

| ID | Chunk | Files | Grounding (REQ/test) | Acceptance criteria |
|----|-------|-------|----------------------|---------------------|
| C1 | Vocab table DDL + apply backfill + index-time delta upsert | `collections-schema-gen.ts`, `embed-index.ts` | REQ-2, test:vocab-maint | Fixture index run populates counts; re-index updates deltas; no-open-vocab collections emit no DDL |
| C2 | Candidate lookup service | `field-vocab.ts` | REQ-3, test:vocab-candidates | "nike jacket" returns stored `NIKE` variants ranked; missing table → empty map |
| C3 | Grounded schema + prompt + cache key | `nlq.ts` | REQ-1, REQ-3, test:nlq-grounded | Candidate change → new cache key; no-open-vocab collection prompt byte-identical |
| C4 | Post-parse guardrail (map-or-drop) | `nlq.ts` | REQ-4, test:guardrail | Invented value maps to nearest stored; unmappable drops to semantic; empty-hard-filter impossible (property test) |
| C5 | `lexical_query` wiring into lex CTE + gate | `nlq.ts`, `search.ts` | REQ-5, test:lex-corrected | Typo fixture: corrected tsquery hits; skip-NLQ/degraded paths use raw q (SQL snapshot) |
| C6 | Rewrite service + ladder step + response annotation | `query-rewrite.ts`, `search.ts` | REQ-6, test:rewrite-ladder | Empty gate → one guarded retry; OOD/floor-cut queries never rewrite; no recursion |
| C7 | Explain/trace + eval metrics (zero-result rate, Hit@10) | `search.ts`, `eval/run.ts` | REQ-7, test:trace-grounding | Trace shows parsed→mapped; artifact carries new metrics per type |
| C8 | Gate run: typo + brand + tail fixtures vs baseline; record artifact | `evals/`, `examples/fashion-search/` | REQ-8, cmd:gate | Committed artifact meets all REQ-8 gates |

## 9. Validation and Testing

### 9.0 Validation Contract

| ID | Source | Assertion |
|----|--------|-----------|
| REQ-1..8 | §3 | As stated |
| test:vocab-maint / test:vocab-candidates | §9.1 | Vocab lifecycle + lookup |
| test:nlq-grounded / test:guardrail | §9.1 | Grounded schema, cache key, map-or-drop |
| test:lex-corrected | §9.1 | Corrected lexical surface incl. fallback paths |
| test:rewrite-ladder | §9.1 | Recovery preconditions incl. honest-zero preservation |
| test:trace-grounding | §9.1 | Observability surfaces |
| cmd:gate | §9.3 | REQ-8 thresholds on committed artifact |

### 9.1 Fail-to-Pass Tests
As per the contract. Notable semantics:
- `test:guardrail` — property: for any parsed open-vocab value, the compiled filter matches
  ≥ 1 stored row's value or is absent.
- `test:rewrite-ladder` — the adversarial OOD suite ("laptop" on a clothing corpus) still
  returns zero (floor-cut ≠ gate-empty), proving no junk resurrection.

### 9.2 Regression Tests (Pass-to-Pass)
- `bun test packages/server` incl. NLQ prompt/SQL snapshots for no-open-vocab collections
  (REQ-1) and the tenancy/dedup/cutoff suites.
- `bun run bench` — unchanged nDCG@5 for non-typo fixtures.

### 9.3 Validation Commands

```bash
bun test packages/server --filter "vocab|grounded|rewrite"
bun examples/fashion-search/eval-search.ts --config baseline
bun examples/fashion-search/eval-search.ts --config grounded
jq '{mean10:.metrics.meanAt10, zero:.metrics.zeroResultRate, hit10:.metrics.hitAt10}' evals/runs/*grounded*.json
bun examples/fashion-search/eval-search.ts --fixture evals/search-queries-typo.json --config grounded
```

## 10. Security Considerations

Vocab values are vendor-authored catalog strings injected into the NLQ prompt — a prompt-
injection surface. Structural mitigations: values are rendered as a quoted enum list (data
position, not instruction position); the parse output for those fields is schema-enum-
constrained and REQ-4 clamps any escape to vocab membership; filter compilation remains fully
parameterized. The rewrite call sees only the user query. Scoped collections scope the vocab
lookup so tenant A's vendor names never appear in tenant B's prompts (REQ-2).

## 11. Rollback and Abort Criteria

- Abort if: C8 shows grounded filters *reducing* recall on brand queries (over-constraining —
  the LLM applying a candidate the query didn't mean). The guardrail then inverts: ship REQ-4
  (map-or-drop) alone without prompt injection (Alt B posture), re-gate, and record both
  artifacts.
- Abort if: the rewrite step resurrects junk on the adversarial suite in any calibration run —
  raise the cosine guard once (0.6→0.7); a second failure removes C6 from the release (the
  grounding chunks stand alone).
- Rollback: all chunks are additive and independently revertible; the vocab table drops with
  config removal; REQ-1 guarantees untouched collections never moved.

## 12. Open Questions

- Q1: Should `lexical_query` also feed the FTS *gate* for the phonetic branch, or only the
  ranking tsqueries? **Proposal:** both (one string, one behavior), measured by the
  multilingual goldens (`ml-01…ml-05`) staying green.
- Q2: Vocab granularity for multi-word values — store raw values only, or also word-grams for
  better partial matching ("nike sportswear" vs query "nike")? **Proposal:** raw values only in
  v1; trigram similarity already handles substrings adequately at these cardinalities.
- Q3: Session context (broad→narrow refinement, Walmart-style) — follow-up RFC once this
  lands; the prompt seam this RFC creates (candidates block) is where prior-query context
  would slot.
- Q4 — RESOLVED as requirements (2026-07-18, owner decision after human testing):
  - **REQ-13: remove the short-query NLQ skip.** `shouldSkipNlq`'s ≤2-token heuristic cost
    "red dress" its `colors: red` constraint (black garments at ranks 7-8 via the color-blind
    dense leg; human-test session 2026-07-18). The 7-day parse cache makes the skip's saving
    one cold parse per query per week — negligible vs the constraint gap on the highest-volume
    query class. NLQ runs for every query; `nlq.enable === false` remains the opt-out.
    (Interaction: the multi-aspect D1/F1 skip-to-first routing rule keys off the same
    heuristic — with the skip removed, short queries get real parses and route normally;
    degraded parses still fall back to first-aspect-only.)
  - **REQ-15: progressive soft-filter relaxation.** Live finding ("red dress for a wedding",
    2026-07-18): the corpus holds exactly 3 docs matching {dresses, red, wedding guest}; the
    <3-results retry dropped ALL soft filters wholesale, so color-mismatched items filled the
    page while the trace still displayed `colors: [red]`. Relax one soft filter at a time,
    least-selective first (measured by per-filter match counts, one cheap count query), and
    stop as soon as results ≥ threshold — "red dress for a wedding" should relax to red
    dresses, never to black ones. The trace must report relaxation prominently
    (`relaxedFields` exists; surface it in appliedFilters rendering).
  - **REQ-14: deterministic enum-token layer.** A zero-LLM token matcher over declared enum
    vocabularies (+ `alsoMatch` synonyms) derives soft filters instantly — serving the cold
    first hit (before/while the LLM parse lands), degraded-parse fallback, and as a guardrail
    the LLM cannot miss. Belt and suspenders with REQ-13, both cheap.
