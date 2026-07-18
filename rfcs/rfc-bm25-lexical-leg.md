# RFC: BM25 lexical leg — selectable per channel, eval-gated

**Category:** New Feature (measure-gated change to existing code)
**Author:** Claude Fable 5 (session 2026-07-16, issue triage)
**Date:** 2026-07-16
**Status:** Dropped (2026-07-18) — kept as decision record
**Reviewers:** mithushancj
**Related:** GitHub issue [#88](https://github.com/asyncdotengineering/samesake/issues/88) §1 · `docs/architecture/full-scale-fashion-search.md` (L2 "Deferred — measure-first BM25 bake-off") · `docs/stage-fit-audit-and-iron-out-plan.md` ("the one genuine quality ceiling") · `packages/server/src/core/search.ts` (lex CTE) · baseline SHA `02af1f8`

---

## 0. Decision (2026-07-18)

BM25 is dropped per review findings F2/F3/F6 (§13) and the owner's decision. Product-search-native
engines do not use BM25; `pg_textsearch` requires PG 17+, is unavailable on Neon/Supabase/RDS,
and its current release has open data-corruption issues (#426/#427). This RFC remains a record;
no BM25 extension path or production scorer will be built.

What survives is C1–C2, re-scoped to a lexical A/B fixture comparing `ts_rank_cd` with
`ts_rank(..., 2|4)` on a length-varied product corpus; it requires no extension and is wired as a
permanent regression gate. The public “why not BM25” guide answers issue #88.

Revisit only if the fixture shows a material lexical loss on a length-varied product corpus.

## 1. Problem Statement

The lexical channel orders candidates with `ts_rank_cd` over `websearch_to_tsquery`
(`packages/server/src/core/search.ts:383-390`). `ts_rank_cd` is cover-density ranking: it has no
term-frequency saturation (BM25 `k1`) and no document-length normalization (BM25 `b`). On
length-varied corpora, long keyword-dense documents over-rank and short on-topic documents lose to
long diffuse ones. Issue #88 names this the single biggest hesitation before adopting samesake as a
primary index: "the lexical leg is the part adopters most expect to behave like a
Lucene/Elasticsearch BM25 out of the box, and today it measurably won't."

This repo had already deferred BM25 deliberately — `docs/architecture/full-scale-fashion-search.md`
L2: "measure-first, then bake-off (`pg_search` vs `vchord_bm25` vs tuned `ts_rank`);
deployment-gated." Issue #88 is external adopter evidence that changes the calculus: the hesitation
is real and pre-adoption, so the *measurement infrastructure* (the A/B fixture) and the *selectable
path* must exist now. The measure-first principle is honored by sequencing: the fixture ships first
(C1–C2), and flipping any default remains gated on its result.

Success:

- A collection can declare `scorer: "bm25"` on its FTS channel and get true BM25 ordering
  (IDF + TF saturation + length normalization) on the lexical leg.
- Collections that do not opt in produce **byte-identical SQL** to today.
- A lexical-only nDCG@10 fixture compares `ts_rank_cd` vs BM25 on a length-varied corpus and runs
  as a permanent gate, so the lexical leg can never silently regress.
- The tradeoff and the fallback for environments without a BM25 extension are documented.

### 1.1 Non-Goals / Out of Scope

- Non-goal: changing the default scorer. `ts_rank_cd` stays the default until the fixture proves
  BM25 wins on relevance (deployment/default decision, not this RFC).
- Non-goal: replacing RRF fusion or touching the semantic/spaces/recency legs.
- Non-goal: a pure-SQL BM25 implementation (DF-stats table + tsvector unnesting). Evaluated and
  rejected for v1 (§2.2 Alt C); revisit only if extension-less BM25 becomes a hard adopter
  requirement.
- Non-goal: BM25 for the entity-match path (`match.ts`) or dedup trigram channels.
- Deferred: `vchord_bm25` and ParadeDB `pg_search` as additional providers behind the same config
  knob (the interface reserves the seam; v1 ships one provider).
- Deferred: scale-sweep latency numbers for the BM25 index — that belongs to
  `rfcs/rfc-scale-proof-benchmarks.md`, which must include the BM25 leg in its grid once this lands.

## 2. Background

**Current lexical leg** (`search.ts:363-392`): the `lex` CTE gates candidates with the OR-rewritten
tsquery (recall) and ranks with a two-tier `ORDER BY ts_rank_cd(fts, andTsq) DESC,
ts_rank_cd(fts, orTsq) DESC [, ts_rank_cd(fts_phon, phonTsq) DESC]`, `LIMIT 150`. The AND-first
tier exists *because* `ts_rank_cd` has no IDF — without it, partial matches on common words could
outrank full matches. The `fts` column is a generated tsvector with `setweight(...,'A')` over
`fts_src_a` and `'B'` over `fts_src` (`collections-schema-gen.ts:208-220`), GIN-indexed. The
optional phonetic sub-signal (`fts_phon`) rides the same CTE.

**Fusion**: rank (not score) feeds RRF (`weight / (60 + rank)`, `search.ts:434-437`), so swapping
the ordering function does not disturb score calibration downstream — only the *order* of the 150
lexical candidates changes. This makes the scorer swap unusually low-risk.

**Extension landscape** (verified 2026-07-16):

- **`pg_textsearch`** (Tiger Data / Timescale, github.com/timescale/pg_textsearch): PostgreSQL
  license (permissive), **PG 17–18 only** (no 15/16 support — re-verified 2026-07-18 against the
  README; the earlier "15–18" claim was wrong). `CREATE INDEX ... USING bm25(col) WITH
  (text_config='english', k1=1.2, b=0.75)`; query `ORDER BY col <@> 'terms'` returning
  **negative** BM25 (ASC index scans). Indexes a raw text column or expression (partial and
  expression indexes supported). The pre-filtering pattern this RFC depends on — an unrelated
  WHERE gate with `<@>` ordering — is documented (the BM25 index supplies corpus statistics even
  when it does not drive the scan). Limitations: no phrase queries (positions not stored; README
  documents an over-fetch + `ILIKE` post-filter emulation), no faceting operators (facet-filter
  pushdown is an open PR, #408). On PG 18 the embedded index-name form is spelled
  `'idx_name:query text'::bm25query` (or `to_bm25query('text','idx_name')`) — **not**
  `col:index_name <@> q` — and lets the score be computed in SELECT expressions.
  **Maturity caveat (2026-07-18):** latest tagged release v1.3.1; two open, unresolved
  data-corruption issues on the v1.3.1/PG18 write path (#426, #427, both filed 2026-07-13), plus
  #410 (upgrade insert failures) and #376 (non-deterministic ranking on the concurrent-build
  path). **Managed availability:** Timescale/Tiger Cloud only — not Neon, not Supabase, not RDS;
  everywhere else means self-hosted Postgres.
- **`pg_search`** (ParadeDB): mature BM25 covering index (`@@@`, `paradedb.score()`), AGPL-3.0.
  **Neon dropped it for new projects as of 2026-03-19** (neon.com/docs/extensions/pg_search),
  recommending `lakebase_text` or self-hosted ParadeDB. AGPL is an adoption barrier for a
  framework whose users self-select their Postgres.
- **`lakebase_text`** (Neon-only): BM25 index "fully compatible with tsvector" — relevant to
  Neon-hosted adopters but not portable.

### 2.1 Terminology

- **Scorer:** the ORDER BY function of the lexical CTE. Today implicitly `ts_rank_cd`; this RFC
  makes it a declared property of the FTS channel.
- **Provider:** the Postgres extension that implements a scorer. v1: `pg_textsearch` for
  `"bm25"`; built-in FTS for `"ts_rank_cd"`.

### 2.2 Alternatives Considered

- **Alt A — ParadeDB `pg_search` as the v1 BM25 provider:** most feature-complete (phrases, fuzzy,
  boosting). Rejected for v1: AGPL-3.0 license friction for adopters, and shrinking managed-PG
  availability (Neon deprecation). Remains a candidate second provider behind the same knob.
- **Alt B — tuned `ts_rank` normalization flags:** `ts_rank_cd(fts, q, 2|4)` adds length division.
  Rejected: still no IDF and no TF saturation; it is length-dampened cover density, not BM25, and
  would not answer the adopter's ask. (It is, however, the documented no-extension fallback — §10
  of the docs chunk.)
- **Alt C — pure-SQL BM25 over the existing tsvector:** maintain per-lexeme document frequencies +
  a doc-length column, score via `unnest(tsvector)` joins. Rejected for v1: correct BM25 ordering
  must apply at *candidate selection* (before `LIMIT 150`), so the score must be computable for
  every row matching the OR gate — a per-row lateral unnest join at that position is a planner
  hazard at 100k+ docs, and the DF table adds write-path maintenance. The extension does this in
  the index where it belongs.
- **Alt D — external engine (Elastic/Tantivy sidecar) via CDC:** rejected here; it is the
  documented scale escape hatch beyond a few million SKUs (`full-scale-fashion-search.md:160`),
  not a lexical-relevance fix.

### 2.3 Drawbacks and Tradeoffs

- A new optional native extension dependency: adopters on managed PG without `pg_textsearch` cannot
  use `scorer: "bm25"` (they keep the default and lose nothing they have today). `apply` must fail
  actionably, and docs must state the fallback.
- Two lexical code paths to test. Contained: the divergence is one CTE's ORDER BY + one index DDL.
- pg_textsearch stores no positions → `websearch_to_tsquery` phrase quotes influence the *gate*
  (tsquery still evaluates phrases) but not the *BM25 ordering*. Acceptable: gate keeps phrase
  precision; ordering ranks by term relevance.

## 3. Strict Requirements

- REQ-1: `FtsChannel` accepts `scorer?: "ts_rank_cd" | "bm25"` (default `"ts_rank_cd"`).
  Collections omitting it produce byte-identical SQL and DDL to SHA `02af1f8`.
- REQ-2: With `scorer: "bm25"`, the lex CTE keeps today's candidate **gate** semantics unchanged —
  `fts @@ orTsq` (and the phonetic OR when declared) — and orders candidates by BM25 score over
  the lexical surface, replacing the two-tier `ts_rank_cd` ORDER BY. The AND-tier hack is not
  emulated: BM25's IDF makes it redundant (§2 Background).
- REQ-3: `apply` on a `scorer: "bm25"` collection creates the BM25 index over the expression
  `coalesce(fts_src_a,'') || ' ' || coalesce(fts_src,'')` with `text_config` mapped from the
  collection's `language` (same regconfig vocabulary), and `k1`/`b` from optional channel fields
  (defaults k1=1.2, b=0.75).
- REQ-4: When `scorer: "bm25"` is declared and the extension is absent, `apply` fails with an
  actionable error naming the extension, the `CREATE EXTENSION` command, and the documented
  fallback. Search never silently degrades to a different scorer.
- REQ-5: `searchExplain` reports the active lexical scorer per query (`weights` block gains
  `lexicalScorer`), so eval channel-attribution can distinguish the two paths.
- REQ-6: A lexical-only A/B fixture (`evals/lexical-bm25-ab.json`, length-varied corpus) computes
  nDCG@10 for both scorers in one run and is wired as a threshold gate; it lives in CI once a
  baseline is recorded (issue #88 acceptance: "keep the ablation in CI").
- REQ-7: The phonetic sub-signal (`fts_phon`) continues to work identically under both scorers
  (it stays tsvector-based in both gate and its rank tier position after the BM25 score).
- REQ-8: Docs state the tradeoff table (ts_rank_cd vs BM25), the extension prerequisites, and the
  recommended fallback for environments without a BM25 extension.

## 4. Interface Specification

### 4.1 Config surface — FTS channel scorer

- **Location:** `packages/sdk/src/types.ts` (`FtsChannel`, `SearchChannelDef`)
- **Signature:**

```ts
export type FtsChannel<F extends string> = {
  kind: "fts"; fields: F[]; weight: number;
  /** Lexical ordering function. "bm25" requires the pg_textsearch extension. Default "ts_rank_cd". */
  scorer?: "ts_rank_cd" | "bm25";
  /** BM25 term-frequency saturation. Only valid with scorer:"bm25". Default 1.2. */
  bm25K1?: number;
  /** BM25 length normalization. Only valid with scorer:"bm25". Default 0.75. */
  bm25B?: number;
};
```

- **Behavior:** validated at `createMatcher`/`apply` config parse; `bm25K1`/`bm25B` present without
  `scorer: "bm25"` is a config error.
- **Error cases:** unknown scorer string rejected by schema; extension-absent handled at apply
  (REQ-4), not at parse.

### 4.2 Capability probe

- **Location:** `packages/server/src/core/db-utils.ts`
- **Signature:** `hasBm25Extension(ctx: MatcherCtx): Promise<boolean>` — one cached
  `SELECT 1 FROM pg_extension WHERE extname = 'pg_textsearch'` per process.
- **Behavior:** used by apply (hard error) and by `samesake doctor` (advisory).

### 4.3 Schema generation

- **Location:** `packages/server/src/core/collections-schema-gen.ts`
- **Convention:** for each collection whose search def carries an FTS channel with
  `scorer: "bm25"`, emit after the GIN index:

```sql
CREATE INDEX IF NOT EXISTS c_<coll>_bm25_idx ON <schema>.c_<coll>
  USING bm25 ((coalesce(fts_src_a,'') || ' ' || coalesce(fts_src,'')))
  WITH (text_config='<language>', k1=<bm25K1>, b=<bm25B>);
```

- **Behavior:** dropping `scorer: "bm25"` from config drops the index on next apply (same
  add/remove diffing as other declared indexes). Changing `k1`/`b`/`language` rebuilds it
  (destructive-migration note, mirroring the existing `language` caveat in
  `packages/sdk/src/types.ts:534-541`).

### 4.4 Lexical CTE (query side)

- **Location:** `packages/server/src/core/search.ts` (`runHybridQuery`, lex CTE builder)
- **Signature (internal):** `buildLexCte(opts: { scorer, lang, qRef, phonTsq, table, where, k1, b }): string`
  — extracted from the inline template so both variants are unit-testable as strings.
- **Behavior:** `ts_rank_cd` variant emits exactly today's SQL (regression-locked by string
  snapshot test). `bm25` variant emits the gate + BM25 ORDER BY (§7).
- **Error cases:** none new at runtime; a missing index surfaces as a Postgres error naming the
  operator — apply-time REQ-4 makes this unreachable in practice.

## 5. Architecture and System Dependencies

### 5.1 Structural Changes
- `packages/sdk/src/types.ts` — channel type (§4.1).
- `packages/server/src/core/collections-schema-gen.ts` — conditional BM25 index DDL (§4.3).
- `packages/server/src/core/search.ts` — lex CTE branch (§4.4); explain `lexicalScorer` (REQ-5).
- `packages/server/src/core/db-utils.ts` — capability probe (§4.2).
- `evals/lexical-bm25-ab.json` + `examples/fashion-search/eval-lexical-ab.ts` — the gate (§9).
- `packages/server/docs` guide page — tradeoff + fallback (REQ-8).

### 5.2 Service and Library Dependencies
- Optional: `pg_textsearch` (PostgreSQL license) on the target database, **PG 17–18**.
  No new npm dependencies. Pin a version only after the open v1.3.1 corruption issues
  (#426/#427) land fixes; until then the BM25 path is dev/eval-grade, not write-heavy-prod-grade.

### 5.3 Data and Schema Changes
- New expression index per opted-in collection (§4.3). No column changes, no data migration.
  Index build memory/time on large tables: parallel build supported by the extension; the scale
  RFC measures it.

### 5.4 Network and Performance Considerations
- Query-time: BM25 ordering replaces two `ts_rank_cd` calls; with the embedded-index-name syntax
  the score computes off the index's statistics. Validate with `EXPLAIN (ANALYZE)` on the fixture
  corpus that the lex CTE does not regress >20% in p95 vs ts_rank_cd at 5k docs (cmd:lex-latency).
- Write-path: one extra index maintained per opted-in collection (memtable architecture;
  throughput measured in the scale RFC).

## 6. Pseudocode

```
FUNCTION buildLexCte(scorer, ...):
    andTsq = websearch_to_tsquery(lang, unaccent(q))
    orTsq  = or_rewrite(andTsq)
    gate   = "fts @@ orTsq" [+ " OR fts_phon @@ phonTsq" when phonetic]

    IF scorer == "ts_rank_cd":                      # today's SQL, verbatim
        order = "ts_rank_cd(fts, andTsq) DESC, ts_rank_cd(fts, orTsq) DESC"
                [+ ", ts_rank_cd(fts_phon, phonTsq) DESC"]
    ELSE:                                           # bm25
        surface = "(coalesce(fts_src_a,'') || ' ' || coalesce(fts_src,''))"
        order = surface + " <@> unaccent(q) ASC"    # negative BM25: smaller = better
                [+ ", ts_rank_cd(fts_phon, phonTsq) DESC"]   # phonetic keeps its tier

    RETURN "lex AS (SELECT id, row_number() OVER (ORDER BY " + order + ") AS rn
            FROM table WHERE (" + gate + ") AND " + where + " LIMIT 150)"

FUNCTION applyCollection(def):
    IF ftsChannel(def).scorer == "bm25":
        IF NOT hasBm25Extension(ctx):
            FAIL "collection '<name>' declares scorer:\"bm25\" but the pg_textsearch
                  extension is not installed. Run: CREATE EXTENSION pg_textsearch;
                  or remove scorer to keep the built-in ts_rank_cd lexical ranking
                  (tradeoffs: docs/guides/lexical-scoring)."
        EMIT bm25 index DDL (§4.3)
```

## 7. Code Blueprint

```ts
// packages/server/src/core/search.ts (inside runHybridQuery, replacing the inline lex CTE)
const fts = ftsChannelDef(def); // resolved channel incl. scorer, k1, b
if (hasFts && qRef) {
  const lang = ftsLanguage(def);
  const andTsq = `websearch_to_tsquery('${lang}', unaccent(${qRef}))`;
  const orTsq = `nullif(replace(${andTsq}::text, '&', '|'), '')::tsquery`;
  const phonTsq = phonActive ? /* unchanged */ : null;
  const gate = `fts @@ ${orTsq}${phonTsq ? ` OR fts_phon @@ ${phonTsq}` : ""}`;

  const order =
    fts.scorer === "bm25"
      ? // pg_textsearch: negative BM25, ASC. Surface must textually match the index expression.
        `(coalesce(fts_src_a,'') || ' ' || coalesce(fts_src,'')) <@> unaccent(${qRef}) ASC` +
        (phonTsq ? `, ts_rank_cd(fts_phon, ${phonTsq}) DESC` : "")
      : `ts_rank_cd(fts, ${andTsq}) DESC, ts_rank_cd(fts, ${orTsq}) DESC` +
        (phonTsq ? `, ts_rank_cd(fts_phon, ${phonTsq}) DESC` : "");

  ctes.push(`lex AS (
    SELECT id, row_number() OVER (ORDER BY ${order}) AS rn
    FROM ${table}
    WHERE (${gate}) AND ${where}
    LIMIT ${CANDIDATES}
  )`);
  rankLegs.push({ cte: "lex", alias: "l", weight: weights.fts });
}
```

```ts
// packages/server/src/core/collections-schema-gen.ts (after the fts GIN index emit)
if (bm25Channel) {
  statements.push(
    `CREATE INDEX IF NOT EXISTS ${ident(`c_${coll}_bm25_idx`)} ON ${table}
       USING bm25 ((coalesce(fts_src_a,'') || ' ' || coalesce(fts_src,'')))
       WITH (text_config='${ftsLanguage(def)}', k1=${bm25Channel.bm25K1 ?? 1.2}, b=${bm25Channel.bm25B ?? 0.75})`
  );
}
```

Attribution: index/operator syntax from `timescale/pg_textsearch` README (verified 2026-07-16).

## 8. Incremental Task Breakdown

| ID | Chunk | Files | Grounding (REQ/test) | Acceptance criteria |
|----|-------|-------|----------------------|---------------------|
| C1 | Length-varied lexical fixture: 60+ docs (short titles ↔ spec-dump descriptions), 20 graded queries | `evals/lexical-bm25-ab.json` | REQ-6 | Fixture loads; grades cover both short-doc-wins and long-doc-wins cases |
| C2 | A/B runner: same corpus, lexical-only weights, both scorers, nDCG@10 side-by-side + threshold gate | `examples/fashion-search/eval-lexical-ab.ts` | REQ-6, cmd:lex-ab | Run emits artifact to `evals/runs/`; exits non-zero on regression vs recorded baseline |
| C3 | Config: `scorer`/`bm25K1`/`bm25B` on FtsChannel + validation | `packages/sdk/src/types.ts`, schema validation | REQ-1, test:config-scorer | Invalid combos rejected; omitted scorer → identical parsed config |
| C4 | Capability probe + apply DDL + actionable failure | `db-utils.ts`, `collections-schema-gen.ts` | REQ-3, REQ-4, test:apply-bm25 | Apply with extension creates index; without it fails with the §6 message |
| C5 | Lex CTE branch + SQL snapshot lock for the default path | `search.ts`, `packages/server/test` | REQ-2, REQ-7, test:lex-sql-snapshot | Default-path SQL string byte-identical to pre-change snapshot; bm25 path orders by `<@>` |
| C6 | Explain `lexicalScorer` + eval channel attribution passthrough | `search.ts`, `eval/run.ts` | REQ-5, test:explain-scorer | Explain payload names the scorer; eval artifact records it |
| C7 | Docs: tradeoff table, extension setup, fallback guidance | docs guide page | REQ-8 | Page states ts_rank_cd fallback + Alt B normalization option |
| C8 | Run C2 against a live PG with pg_textsearch; record baseline artifact; wire gate into CI test set | `evals/runs/`, CI config | REQ-6, cmd:lex-ab | Committed baseline; CI red on future lexical regression |

## 9. Validation and Testing

### 9.0 Validation Contract

| ID | Source | Assertion |
|----|--------|-----------|
| REQ-1..8 | §3 | As stated |
| test:config-scorer | §9.1 | Invalid scorer combos rejected; defaults inert |
| test:apply-bm25 | §9.1 | DDL emitted with extension; actionable error without |
| test:lex-sql-snapshot | §9.1/§9.2 | Default lex CTE SQL byte-identical pre/post |
| test:explain-scorer | §9.1 | `lexicalScorer` present and correct in explain |
| cmd:lex-ab | §9.3 | A/B runner produces per-scorer nDCG@10 and gates |
| cmd:lex-latency | §9.3 | p95 lex-CTE latency (bm25) ≤ 1.2× ts_rank_cd at 5k docs |

### 9.1 Fail-to-Pass Tests
- `test:config-scorer` — `bm25K1` without `scorer:"bm25"` rejected; valid config round-trips.
- `test:apply-bm25` — apply against a PG **with** the extension emits the index; against one
  **without** it, fails with the message naming `CREATE EXTENSION pg_textsearch`.
- `test:lex-sql-snapshot` — `buildLexCte({scorer:"bm25"})` contains `<@>` and no `ts_rank_cd(fts,`.
- `test:explain-scorer` — searchExplain on both variants reports the scorer.

### 9.2 Regression Tests (Pass-to-Pass)
- `bun test packages/server` (full suite; includes the default-path SQL snapshot).
- `bun run bench` (`examples/fashion-search/bench-retrieval.ts`) — unchanged nDCG@5 on the
  unbiased fixtures for non-opted-in configs.

### 9.3 Validation Commands

```bash
# env: PG with pg_textsearch installed (docker: timescale/pg_textsearch image or local build)
psql "$DATABASE_URL" -c "CREATE EXTENSION IF NOT EXISTS pg_textsearch;"
bun examples/fashion-search/eval-lexical-ab.ts            # emits evals/runs/lexical-ab-<ts>.json
jq '.scorers | {ts_rank_cd: .ts_rank_cd.ndcgAt10, bm25: .bm25.ndcgAt10}' evals/runs/lexical-ab-*.json
# EXPLAIN check: bm25 ordering present, gate preserved
psql "$DATABASE_URL" -c "EXPLAIN SELECT id FROM <schema>.c_<coll> WHERE fts @@ websearch_to_tsquery('english','linen shirt') ORDER BY (coalesce(fts_src_a,'') || ' ' || coalesce(fts_src,'')) <@> 'linen shirt' LIMIT 150;"
```

## 10. Security Considerations

No new attack surface: the query string continues to flow only through parameterized refs
(`${qRef}`) into `websearch_to_tsquery`/`unaccent`/`<@>`; `k1`/`b` are validated numbers
interpolated into DDL only (apply-time, config-authored, same trust level as existing
`language`). The extension runs with database-owner privileges like pgvector — documented as a
prerequisite adopters install knowingly.

## 11. Rollback and Abort Criteria

- Abort if: pg_textsearch cannot compute the `<@>` score under the existing `WHERE fts @@ ...`
  gate (planner refuses expression evaluation off-index on PG < 18) — the design assumption
  (§5.4) breaks; stop and re-evaluate with the ORDER-BY-only index-scan shape (over-fetch +
  gate as post-filter) before writing more code.
- Abort if: C8's fixture shows BM25 **losing** to ts_rank_cd on the length-varied corpus — the
  feature still ships (adopter-selectable), but the docs recommendation and any default-flip
  discussion stop; record the artifact and surface it on issue #88.
- Rollback: remove `scorer` from the collection config and re-apply (drops the index); the
  default path is untouched by construction (REQ-1).

## 12. Open Questions

- Q1: Primary BM25 provider — `pg_textsearch` vs ParadeDB `pg_search`. Tradeoff: permissive
  license + simplicity vs feature depth (phrases, boosting) + AGPL + shrinking managed-PG reach.
  **Proposal:** `pg_textsearch` for v1; keep `scorer` string extensible (`"bm25"` resolves to the
  detected provider) so `pg_search`/`vchord_bm25` can be added without config breakage.
- Q2: Weighted surfaces under BM25 — the A/B setweight distinction is lost in a single
  concatenated expression. Tradeoff: single index simplicity vs field boosting fidelity.
  **Proposal:** v1 concatenates (title-first order retained); if C8 shows title under-weighting,
  calibrate by repeating `fts_src_a` once in the expression (bounded by BM25 TF saturation) —
  a one-line DDL change, eval-gated.
- Q3: Should `mode: "intent"`'s keyword cap (`KEYWORD_TIEBREAK * cosine`, `search-query.ts:55`)
  be revisited when BM25 is active? Tradeoff: a trustworthy lexical leg arguably deserves more
  than tiebreaker weight vs re-litigating validated mode defaults. **Proposal:** out of scope;
  file as a calibrate-search experiment after C8's baseline exists.

## 13. Review findings (2026-07-18 validation pass)

Verified against the code at `02af1f8` and the live pg_textsearch repo/docs. §2's extension
facts were corrected in place (PG 17–18 not 15–18; embedded-syntax spelling; maturity and
managed-availability caveats). Additional findings execution MUST address:

- **F1 — normalization mismatch in the BM25 surface (REQ-3/§4.3/§7).** The `fts` column
  normalizes both sources through `samesake_normalise` (accents/case/punct folding,
  `collections-schema-gen.ts:216-217`), but the proposed BM25 index expression concatenates the
  **raw** `fts_src_a`/`fts_src` and the query side applies only `unaccent(q)`. Docs containing
  "café" would tokenize differently across the gate (normalized tsvector) and the scorer (raw
  text) — and BM25's own corpus statistics would split accented/unaccented token variants. Fix:
  wrap both the index expression and the query text in `<sys>.samesake_normalise(...)`, exactly
  mirroring the fts column. The index expression and the ORDER BY expression must stay
  textually identical for the planner to use the index.
- **F2 — deployment-target reality.** pg_textsearch is unavailable on Neon/Supabase/RDS and
  needs PG 17+. If the fashion-marketplace deployment runs managed Postgres (Neon per current
  app setups), `scorer:"bm25"` cannot ship there at all — the A/B fixture (C1–C2, runnable
  against a local Docker PG) is unaffected, but the "selectable path" only serves self-hosted /
  Tiger Cloud adopters today. The C8 CI gate needs a pinned Docker image with the extension.
- **F3 — maturity gate.** Two open data-corruption issues on the v1.3.1 write path (#426/#427,
  filed 2026-07-13). Add to §11 abort criteria: do not recommend `scorer:"bm25"` for
  write-heavy production until those issues are fixed in a tagged release; the eval fixture and
  the config surface can still land (measurement infra is the point of this RFC).
- **F4 — framing correction.** Issue #88 is authored by the repo owner (octalpixel), i.e. it is
  a self-authored adoption-readiness audit, not third-party adopter evidence. The asks remain
  valid and well-argued, but §1's "external adopter evidence that changes the calculus" premise
  should not be cited as independent demand.
- **F5 — claim-check on `ts_rank_cd`.** Verified: the current two-tier lex CTE
  (`search.ts:383-390`) matches the RFC's description byte-for-byte, and `ts_rank_cd` is used
  without normalization flags (no length normalization active). The RFC's §2 characterization is
  accurate; Alt B correctly notes flags `2|4` exist as the no-extension fallback.
- **F6 — the premise deserves a challenge: product-search incumbents do not use BM25**
  (verified against official docs, 2026-07-18). Algolia explicitly rejects TF-IDF/BM25 in favor
  of an 8-criteria tie-breaking sort (typo→geo→words→filters→proximity→attribute→exact→custom),
  arguing term frequency is meaningless in short structured product records. Typesense's
  `_text_match` has no IDF and no length normalization. Meilisearch ranks by ordered
  bucket-sort rules (words/typo/proximity/attribute/exactness). Only the Lucene-lineage engines
  (Elasticsearch/OpenSearch) default to BM25 — and their e-commerce guidance layers
  function_score boosts on top and fuses hybrid via RRF. Samesake's existing AND-coverage-first
  two-tier ordering + setweight(A/B) + RRF is philosophically the Algolia/Meilisearch design,
  not a poor man's Lucene. Consequence: issue #88's ask is best read as a *perception/checkbox*
  gap plus one measurable pathology (long keyword-dense descriptions over-ranking short titles)
  — exactly what the C1–C2 fixture measures. The fixture is therefore the deliverable that
  matters; the pg_textsearch provider chunks (C3–C5) should not proceed until the fixture
  proves ts_rank_cd actually loses on a product corpus. If it wins or ties, the right ship is a
  documented "why not BM25" positioning page citing the fixture artifact + the incumbent
  precedent, with `scorer: "bm25"` remaining a deferred bake-off.
- **Verdict: SOUND with amendments — and re-scoped by F6.** The leg-swap design (gate
  unchanged, ORDER BY swapped, rank-based RRF isolating calibration) is architecturally correct
  and unusually low-risk, and the measure-first sequencing honors the repo's own deferral.
  Execution order: C1–C2 (fixture) first and gating; C3+ conditional on the fixture's verdict;
  provider choice swappable (Q1's provider-resolution seam) given F2/F3.
