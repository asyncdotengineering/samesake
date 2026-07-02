# RFC: Cross-vendor offer dedup — one canonical result, N offers

**Category:** New Feature (re-aims an existing subsystem)
**Author:** Claude Fable 5 (session 2026-07-03, P2 stand)
**Date:** 2026-07-03
**Status:** Draft — proposals committed, ready for kickoff
**Reviewers:** mithushancj
**Related:** `docs/stage-fit-audit-and-iron-out-plan.md` §3 P2-2 · `docs/system-behavior-spec.md` (verified system map) · `docs/notes/iron-out-stand-implementation-notes.md` (P2-1 tenancy design) · `docs/research/mices/README.md` (DoorDash: dedup is load-bearing for multi-vendor) · commit `f83f5f7` (P2-1 tenancy)

---

## 1. Problem Statement

On a multi-vendor marketplace, N sellers list the same physical product with different titles,
photos, and prices. Search treats them as N unrelated documents, so a results page shows the same
product N times: perceived selection collapses, price competition is invisible, and duplicates
crowd out genuinely different products. This degrades *as the marketplace succeeds* — more sellers
means more duplicates.

Success looks like: search over a dedup-enabled collection returns **one hit per physical
product**, and each hit carries an `offers` array (the member listings' vendor/price/availability
fields). Concretely, post-implementation these invariants hold:

- A query matching a product listed by 3 vendors returns 1 hit with `offers.length === 3`.
- Distinct products are never merged (precision over recall: an uncertain pair is a suggestion,
  not an auto-link).
- Collections without `dedup` config behave byte-identically to today (eval `topIds` unchanged).
- Clusters never span tenancy scopes (P2-1 walls hold).

## 2. Background

Samesake carries a quarantined entity-resolution engine (`entity()`/`matcher.match`) — 2,000+
lines of candidate generation, weighted channel scoring, calibrated thresholds, and
confirm/decline feedback — whose only consumer is `apps/bom-quotation`
(`docs/system-behavior-spec.md` §10.1). The stage-fit audit's verdict: keep the *capability*,
re-aim it at marketplace offer-dedup (`docs/stage-fit-audit-and-iron-out-plan.md` §1, "Entity
resolution product"). This RFC is that re-aim.

What exists and is reused:

- **Group collapse in the search path.** `CollectionSearchDef.variantGroup` collapses hits to the
  best-RRF item per group value — `diversifyHits` keeps the first (highest-fused-score) hit per
  non-empty group key (`packages/server/src/core/search.ts`, `diversifyHits`; wired in `search()`
  with a deepened `RERANK_POOL` so collapse chooses from real candidates). Dedup reuses this
  mechanism unchanged; the cluster id is just another group field.
- **Threshold semantics.** The entity engine's two-band model — `autoLink` (merge without asking)
  and `suggest` (queue for a human) with `suggest <= autoLink`, both in [0,1] — is proven
  (`packages/server/src/core/match.ts`, `resolveThresholds` / `setScopeThresholds`). Dedup adopts
  the same two-band contract with per-collection static config (no `scope_thresholds` table in
  v1; see Q3).
- **Candidate-generation primitives.** `pg_trgm` similarity, embedding HNSW ANN, and exact-value
  equality are all installed and used by the entity path (`packages/server/src/core/schema-gen.ts`
  match-candidate SQL). Collections already have the HNSW index on `embedding`
  (`collections-schema-gen.ts`, `c_<coll>_emb_idx`).
- **Tenancy (P2-1, `f83f5f7`).** `scope_<key>` columns + mandatory scope on every surface. Dedup
  candidates are constrained to equal scope columns; clusters cannot cross tenants by
  construction.
- **Enrichment as the normalizer.** Messy vendor titles are already normalized into comparable
  attributes by the enrich pipeline (`docs/system-behavior-spec.md` §4) — this is what makes
  scoring tractable (same lesson as the entity path).

What is deliberately NOT reused: the entity tables (`entity_<kind>`, `match_candidate`,
`pair_history`, `scope_thresholds`), the 9 entity HTTP routes, and the alias/penalty feedback
machinery. Mirroring collection rows into an entity kind means two tables, a sync pipeline, and a
consistency problem (rejected shape; see Q1). Dedup is a **collection concern**: cluster state
lives as columns on the collection table.

Interface shapes considered (single-shot; the space is narrow because `variantGroup` collapse
fixes the read side): (a) collection-local columns + config — chosen; (b) entity-kind mirror —
rejected above; (c) search-time-only fuzzy grouping (no persisted clusters) — rejected: O(page ×
candidates) latency per query, non-deterministic pagination, no human feedback loop.

## 3. Strict Requirements

- REQ-1: `CollectionDef.dedup` declares channels (`exactKey`, `trigram`, `cosine`) with weights,
  an `autoLink` threshold, an optional `suggest` threshold, and `offerFields`. Collections
  without it are bit-for-bit unaffected on every surface.
- REQ-2: `matcher.dedup(project, collection, opts?)` incrementally clusters rows that are
  indexed (`pipeline_status='ready' AND indexed_at IS NOT NULL`) and not yet clustered
  (`product_group IS NULL`). Idempotent; re-running with no new rows is a no-op.
- REQ-3: A row joins an existing cluster only when its best candidate scores `>= autoLink`;
  scores in `[suggest, autoLink)` create a persisted suggestion instead; below `suggest`
  (or when `suggest` is unset) the row founds its own cluster. Precision bias is a contract:
  uncertain pairs are never auto-merged.
- REQ-4: An `exactKey` channel match (e.g. equal non-empty `gtin`) short-circuits to auto-link
  regardless of other channel scores. Empty/null key values never match.
- REQ-5: Candidates are generated only within the same tenancy scope (all `scope_<key>` columns
  equal). A cluster spanning two scopes must be impossible, not just unlikely.
- REQ-6: When `dedup` is declared, search collapses on the cluster id by default (existing
  `diversifyHits` path; `opts.diversify: false` opts out per query) and each collapsed hit
  carries `offers`: one entry per **ready** cluster member, restricted to `offerFields` + `id`,
  fetched in a single batched query per page. `offers: false` in SearchOpts skips attachment.
- REQ-7: Human loop: suggestions are listable; `confirmGroup` merges a suggested pair (sets the
  row's `product_group`, marks the suggestion confirmed); `splitGroup` evicts a row into a fresh
  cluster and records the decline so re-runs do not re-suggest the same pair.
- REQ-8: Deleted/quarantined rows drop out of `offers` automatically (offers query filters on
  ready-visibility, same predicate as search).
- REQ-9: HTTP + CLI parity for: run dedup, list clusters, list suggestions, confirm, split —
  auth'd like every other collection route.
- REQ-10: `matcher.dedup(project, collection, { rebuild: true })` clears all cluster state for
  the collection (groups + unconfirmed suggestions) and re-clusters from scratch. Confirmed and
  declined suggestion decisions survive a rebuild and are replayed.

## 4. Interface Specification

### 4.1 `CollectionDedupDef` (SDK)

- **Location:** `packages/sdk/src/types.ts` (adjacent to `CollectionSearchDef`)
- **Signature:**

```ts
export interface CollectionDedupDef {
  /** Scoring channels; weighted sum normalized by total weight → [0,1]. */
  channels: DedupChannelDef[];
  /** Best-candidate score at/above which a row auto-joins the candidate's cluster. */
  autoLink: number;                 // (0,1]
  /** Scores in [suggest, autoLink) persist a suggestion for human review. Unset = no suggestions. */
  suggest?: number;                 // (0, autoLink]
  /** Declared fields copied onto each offer entry (e.g. ["vendor","price","available"]). */
  offerFields: string[];
  /** Cluster-id column name. Default "product_group". */
  groupField?: string;
}

export type DedupChannelDef =
  | { kind: "exactKey"; field: string }                    // decisive: equal non-empty values auto-link (REQ-4)
  | { kind: "trigram";  field: string; weight: number }    // pg_trgm similarity on a declared text field
  | { kind: "cosine";   weight: number };                  // doc-embedding cosine (first embeddings key)
```

- **Behavior:** validated at `apply` time — channel fields must be declared collection fields;
  `groupField` must not collide with a declared field; at least one weighted channel or one
  `exactKey` required; thresholds range-checked.
- **Error cases:** invalid config throws at `apply` with the offending field named (same style as
  `collectionScopes` validation in `collections-schema-gen.ts`).

### 4.2 `makeDedupService` (server)

- **Location:** `packages/server/src/core/dedup.ts` (new)
- **Signature:**

```ts
dedup(project: string, collection: string, opts?: {
  limit?: number;          // max rows to process this run (default 500)
  rebuild?: boolean;       // REQ-10
}): Promise<{ processed: number; autoLinked: number; founded: number; suggested: number }>

dedupClusters(project: string, collection: string, opts?: {
  scope?: Record<string, string>;  // mandatory when the collection declares scopes
  minMembers?: number;             // default 2
  limit?: number;                  // default 100
}): Promise<{ clusters: Array<{ group: string; members: Array<Record<string, unknown>> }> }>

dedupSuggestions(project, collection, opts?: { scope?; limit? }):
  Promise<{ suggestions: Array<{ id: string; candidateGroup: string; score: number }> }>

confirmGroup(project, collection, input: { id: string; group: string; scope?: Record<string,string> }):
  Promise<{ confirmed: true }>

splitGroup(project, collection, input: { id: string; scope?: Record<string,string> }):
  Promise<{ group: string }>   // the fresh cluster id the row now founds
```

- **Behavior:** see Section 6. All read/write methods resolve scope via `resolveScope`
  (`core/scope.ts`) — mandatory on scoped collections, rejected on unscoped ones (identical
  contract to search/remove, P2-1).
- **Error cases:** unknown collection; `dedup` on a collection without `dedup` config throws
  `collection "<name>" declares no dedup config`; `confirmGroup` with a group that has no ready
  member throws.

### 4.3 Schema additions (per dedup-enabled collection)

- **Location:** `packages/server/src/core/collections-schema-gen.ts`
- Columns on `c_<coll>`: `product_group text` (or `groupField` name), `dedup_score real`,
  `dedup_checked_at timestamptz`.
- Indexes: btree on the group column; `gin (<field> gin_trgm_ops)` for each `trigram` channel
  field; btree on each `exactKey` field (skip if one exists via `filterable`).
- Suggestions table per project schema (created with the collection DDL):

```sql
CREATE TABLE IF NOT EXISTS <schema>.c_<coll>_dedup_suggestions (
  row_id text NOT NULL,
  candidate_group text NOT NULL,
  score real NOT NULL,
  status text NOT NULL DEFAULT 'open',   -- open | confirmed | declined
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (row_id, candidate_group)
);
```

- Migration: **adding** `dedup` to an existing collection is additive (nullable columns +
  indexes + table). **Changing channels/thresholds** is a plan note (re-run
  `dedup({rebuild:true})` to apply); **removing** `dedup` is destructive (columns dropped).

### 4.4 Search response addition

- **Location:** `packages/server/src/core/search.ts`
- `SearchOpts.offers?: boolean` (default true when the collection declares `dedup`).
- `SearchHit.offers?: Array<Record<string, unknown>>` — each entry: `{ id, ...offerFields }`
  plus scope keys on scoped collections. `SearchResult` shape otherwise unchanged.

### 4.5 HTTP routes (app-builder) and CLI

- `POST /v1/projects/:p/collections/:c/dedup` — body `{ limit?, rebuild? }` → run result.
- `GET  /v1/projects/:p/collections/:c/dedup/clusters?minMembers=&limit=&scope.<k>=`
- `GET  /v1/projects/:p/collections/:c/dedup/suggestions?scope.<k>=`
- `POST /v1/projects/:p/collections/:c/dedup/confirm` — body `{ id, group, scope? }`
- `POST /v1/projects/:p/collections/:c/dedup/split` — body `{ id, scope? }`
- CLI: `samesake dedup --project --collection [--rebuild]`,
  `samesake dedup-clusters --project --collection [--scope k=v]`,
  `samesake dedup-suggestions|dedup-confirm|dedup-split` (same flag style as `remove`).

## 5. Architecture and System Dependencies

### 5.1 Structural Changes

- New: `packages/server/src/core/dedup.ts` (service), `c_<coll>_dedup_suggestions` table,
  three columns + indexes on dedup-enabled collection tables.
- Modified: `packages/sdk/src/types.ts` (defs), `collections-schema-gen.ts` (DDL + validation),
  `collections-migrate.ts` (additive/destructive rules), `search.ts` (collapse default + offers
  attachment), `createMatcher.ts` (service wiring + public methods), `app-builder.ts` (5 routes),
  `packages/cli/src/index.ts` (4 commands).
- Deleted: nothing. The entity engine is untouched (it keeps serving bom-quotation); this RFC
  reuses its *patterns*, not its tables.

### 5.2 Service and Library Dependencies

No new dependencies. `pg_trgm` (installed by `migrate()`), pgvector HNSW (exists), postgres-js.
No LLM calls anywhere in the dedup path — scoring is SQL + arithmetic (cheap, deterministic).

### 5.3 Data and Schema Changes

Section 4.3. All DDL flows through the existing `apply` path with its destructive-op guard.

### 5.4 Network and Performance Considerations

- Clustering: one candidate-generation query + one write per processed row, batched
  `limit` rows per run (default 500). Candidate query unions three index-backed probes
  (exactKey btree, trigram GIN top-20, HNSW top-20) — no seq scans.
- Search: offers add exactly **one** batched query per page
  (`WHERE <group> = ANY($1) AND <visibility> [AND scope…]`), only when the page contains
  clustered hits. Bounded by `page_size × max_cluster_size`; no per-hit queries.
- Greedy incremental clustering is order-dependent (insertion order decides which row founds a
  cluster). Acceptable: cluster *membership* converges regardless of leader identity, and
  `rebuild` exists for drift.

## 6. Pseudocode

```
FUNCTION dedup(project, collection, opts):
    def = collectionDef(project, collection); REQUIRE def.dedup
    IF opts.rebuild:
        UPDATE table SET group=NULL, dedup_score=NULL, dedup_checked_at=NULL
        DELETE suggestions WHERE status='open'
    rows = SELECT id, scopeCols, channelFields, embedding
           FROM table
           WHERE group IS NULL AND pipeline_status='ready' AND indexed_at IS NOT NULL
           ORDER BY ingested_at
           LIMIT opts.limit
    counters = {processed:0, autoLinked:0, founded:0, suggested:0}
    FOR row IN rows:
        cands = candidates(row)                 -- one SQL, scope-equal, excludes row.id:
                                                --   exactKey probes ∪ trigram top-20 ∪ ANN top-20,
                                                --   only rows already clustered OR ready
        best = NULL
        FOR c IN cands:
            IF exactKeyMatch(row, c): score = 1.0            -- REQ-4 short-circuit
            ELSE: score = Σ(weight_i × channel_i(row, c)) / Σ(weight_i)
            best = max(best, {c, score})
        targetGroup(c) = c.group ?? c.id        -- unclustered candidate founds its own cluster lazily
        IF best.score >= def.dedup.autoLink:
            IF best.c.group IS NULL: SET best.c.group = best.c.id   -- found leader first
            IF declined(row.id, targetGroup(best.c)): fall through to found-own   -- REQ-7 memory
            ELSE: SET row.group = targetGroup(best.c); counters.autoLinked++
        ELSE IF def.dedup.suggest AND best.score >= def.dedup.suggest:
            UPSERT suggestion(row.id, targetGroup(best.c), best.score) WHERE not declined/confirmed
            SET row.group = row.id; counters.suggested++     -- suggested rows still found their own
        ELSE:
            SET row.group = row.id; counters.founded++
        SET row.dedup_score = best.score, row.dedup_checked_at = now()
    RETURN counters

FUNCTION channel_trigram(row, c, field):  RETURN similarity(normalise(row[field]), normalise(c[field]))
FUNCTION channel_cosine(row, c):          RETURN 1 - (row.embedding <=> c.embedding)     -- from ANN probe
FUNCTION exactKeyMatch(row, c):           RETURN ∃ exactKey ch: row[ch.field] non-empty AND row[ch.field] = c[ch.field]

FUNCTION attachOffers(hits, def, scopeCols):          -- in finishSearch, after cutoff+collapse
    groups = distinct non-null hit[groupField]
    IF groups empty OR opts.offers === false: RETURN
    members = SELECT id, offerFields, scopeCols, groupField FROM table
              WHERE groupField = ANY(groups) AND visibility [AND scope]
    FOR hit IN hits: hit.offers = members[hit.group]  -- includes the hit's own row

FUNCTION confirmGroup(id, group):   SET row.group = group;  suggestion.status = 'confirmed'
FUNCTION splitGroup(id):            old = row.group; SET row.group = row.id;
                                    UPSERT suggestion(id, old, score=row.dedup_score, status='declined')
```

Decision points worth naming: (1) suggested rows still found their own cluster — they appear as
separate results until a human confirms, which is the precision-first behavior REQ-3 demands;
(2) the decline memory is the suggestions table itself (status `declined`), checked by both the
suggester and the auto-linker, so neither re-merges what a human split (REQ-7, REQ-10).

## 7. Code Blueprint

```ts
// packages/server/src/core/dedup.ts
import type { CollectionDedupDef, CollectionDef } from "@samesake/core";
import type { MatcherCtx } from "../types.ts";
import { collectionTableName } from "./db-utils.ts";
import { resolveScope, appendScopeSql } from "./scope.ts";
import { sanitiseIdent } from "./schema-gen.ts";
import { searchResultCache } from "./search-cache.ts";

export function makeDedupService(ctx: MatcherCtx, projectsService: ProjectsService) {
  async function dedup(projectSlug: string, collectionName: string, opts: DedupRunOpts = {}) {
    const { def, table, cfg } = await resolveDedup(projectSlug, collectionName);
    const group = sanitiseIdent(cfg.groupField ?? "product_group");
    if (opts.rebuild) await rebuildState(table, group);

    const rows = await ctx.storage.client("dedup").unsafe(
      `SELECT id, ${selectCols(def, cfg)} FROM ${table}
       WHERE ${group} IS NULL AND pipeline_status = 'ready' AND indexed_at IS NOT NULL
       ORDER BY ingested_at LIMIT $1`, [opts.limit ?? 500]);

    for (const row of rows) {
      const cands = await candidates(table, def, cfg, row);   // one UNION query, scope-equal
      const best = scoreBest(cfg, row, cands);                // exactKey → 1.0 short-circuit
      await assign(table, group, cfg, row, best);             // link | suggest | found (Section 6)
    }
    searchResultCache.invalidateProjectCollection(projectSlug, collectionName);
    return counters;
  }
  // dedupClusters / dedupSuggestions / confirmGroup / splitGroup per Section 4.2
  return { dedup, dedupClusters, dedupSuggestions, confirmGroup, splitGroup };
}
```

```sql
-- candidates(row): one round trip, all probes index-backed, scope-pinned (REQ-5)
WITH probe AS (
  SELECT id FROM <table>
   WHERE gtin = $gtin AND gtin <> '' AND id <> $id AND <scopeEq>            -- per exactKey channel
  UNION
  SELECT id FROM <table>
   WHERE <scopeEq> AND id <> $id AND title % $title                          -- pg_trgm, GIN-backed
   ORDER BY similarity(title, $title) DESC LIMIT 20
  UNION
  (SELECT id FROM <table>
    WHERE <scopeEq> AND id <> $id AND embedding IS NOT NULL
    ORDER BY embedding <=> $vec::halfvec LIMIT 20)
)
SELECT d.id, d.<group>, d.<channelFields>,
       similarity(d.title, $title)            AS trgm_title,
       1 - (d.embedding <=> $vec::halfvec)    AS cos
FROM <table> d JOIN probe USING (id)
WHERE d.pipeline_status = 'ready';
```

```ts
// packages/server/src/core/search.ts — finishSearch, after cutoff (offers ride the final page)
// and in search(), when def.dedup && no explicit variantGroup:
//   variantGroup = def.dedup.groupField ?? "product_group"   (collapse via existing diversifyHits)
async function attachOffers(r: Retrieval, hits: SearchHit[]): Promise<void> {
  const cfg = r.def.dedup; if (!cfg) return;
  const group = sanitiseIdent(cfg.groupField ?? "product_group");
  const groups = [...new Set(hits.map(h => h[group]).filter(Boolean))] as string[];
  if (!groups.length) return;
  const scoped = appendScopeSql(`${group} = ANY($1) AND (pipeline_status = 'ready' OR pipeline_status IS NULL)`,
                                [groups], r.scopeCols);
  const cols = ["id", group, ...cfg.offerFields.map(sanitiseIdent)].join(", ");
  const rows = await ctx.storage.client("offers").unsafe(
    `SELECT ${cols} FROM ${collectionTableName(r.project.schema_name, r.collectionName)} WHERE ${scoped.where}`,
    scoped.params);
  const byGroup = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) push(byGroup, String(row[group]), pick(row, cfg.offerFields));
  for (const h of hits) if (h[group]) h.offers = byGroup.get(String(h[group])) ?? [];
}
```

Attribution: candidate-probe shape mirrors the entity match-candidate SQL
(`packages/server/src/core/schema-gen.ts`); threshold semantics mirror `match.ts`
`resolveThresholds`; collapse is the existing `diversifyHits` (`search.ts`).

## 8. Incremental Task Breakdown

| ID | Chunk | Files | Grounding (REQ/test) | Acceptance criteria |
|----|-------|-------|----------------------|---------------------|
| C1 | SDK: `CollectionDedupDef` + `DedupChannelDef` + `dedup` on CollectionDef; JSDoc contracts | `packages/sdk/src/types.ts` | REQ-1 | sdk builds; type-safety test compiles a dedup config |
| C2 | Schema-gen: columns, group btree, trgm GIN per trigram channel, exactKey btree, suggestions table; config validation; migrate rules (add=additive, remove=destructive, channel-change=note) | `collections-schema-gen.ts`, `collections-migrate.ts` | REQ-1, REQ-4 prereq, `cmd:apply-dedup` | apply on a dedup collection creates columns+indexes+table (information_schema assert); invalid configs throw named errors |
| C3 | Candidate SQL + channel scoring (pure fn) + exactKey short-circuit | `core/dedup.ts` | REQ-4, REQ-5, `test:dedup-scoring` | unit tests: weighted sum, exactKey=1.0, empty-key never matches |
| C4 | Assignment loop: link/suggest/found, decline memory, rebuild, counters; service + `matcher.dedup` wiring | `core/dedup.ts`, `createMatcher.ts` | REQ-2, REQ-3, REQ-7, REQ-10, `test:dedup-cluster` | integration: 3 messy same-product listings cluster; distinct products don't; idempotent re-run processes 0 |
| C5 | Search: collapse default from `dedup.groupField`; `attachOffers` post-cutoff; `SearchOpts.offers` | `core/search.ts` | REQ-6, REQ-8, `test:offers` | 1 hit + offers.length=3; quarantined member absent from offers; `offers:false` skips |
| C6 | Human loop: clusters/suggestions/confirm/split service methods | `core/dedup.ts` | REQ-7, `test:dedup-review` | suggest-band pair listed; confirm merges; split evicts + never re-suggested after re-run |
| C7 | HTTP routes + CLI commands | `app-builder.ts`, `packages/cli/src/index.ts` | REQ-9, `cmd:http-dedup` | route-level test: run+clusters+confirm via `matcher.fetch`; CLI help updated |
| C8 | Tenancy walls + neutrality proofs | `test/dedup.test.ts` | REQ-5, REQ-1, `test:dedup-scope`, `cmd:eval-neutral` | identical titles in two scopes never cluster; dedup-less collection: full suite green + eval topIds 67/67 identical |
| C9 | Docs (marketplace guide section, reference), changeset, plan-doc §2 entry | `apps/docs/...`, `.changeset/` | — | docs build green; changeset minor core+server |

## 9. Validation and Testing

### 9.0 Validation Contract (assertion IDs)

| ID | Source | Assertion (behavior-independent) |
|----|--------|----------------------------------|
| REQ-1..10 | §3 | As stated |
| test:dedup-scoring | §9.1 | Channel math unit tests green |
| test:dedup-cluster | §9.1 | Adversarial cluster/no-cluster integration green |
| test:offers | §9.1 | Collapse + offers attachment green |
| test:dedup-review | §9.1 | Suggest/confirm/split lifecycle green |
| test:dedup-scope | §9.1 | Cross-scope clustering impossible |
| cmd:apply-dedup | §9.3 | DDL assertions via information_schema |
| cmd:http-dedup | §9.1 | Route-level lifecycle via `matcher.fetch` |
| cmd:eval-neutral | §9.3 | Fashion eval topIds 67/67 identical to `p2tenancy` baseline |

### 9.1 Fail-to-Pass Tests

`packages/server/test/dedup.test.ts` (mirror the deterministic hash-embed pattern of
`tenancy.test.ts` — identical-token titles → cosine ≈ 1, disjoint → ≈ 0):

- `test:dedup-scoring` — pure `scoreBest` unit tests (weights, short-circuit, null keys).
- `test:dedup-cluster` — vendors A/B/C list "Silicone Case iPhone 15 Black" with messy title
  variants + equal `mpn` → one cluster; a genuinely different product founds its own; re-run
  processes 0.
- `test:offers` — search returns 1 hit for the clustered product, `offers.length === 3` with
  declared fields only; quarantine one member → offers.length 2; `offers:false` → no `offers`.
- `test:dedup-review` — pair scoring in the suggest band appears in suggestions; `confirmGroup`
  merges (search now returns 1 hit); `splitGroup` evicts and a `dedup()` re-run does not re-link
  or re-suggest that pair.
- `test:dedup-scope` — scoped collection, identical listings in scope v1 and v2 → two clusters,
  never one; `dedupClusters` without scope rejected.

### 9.2 Regression Tests (Pass-to-Pass)

- Full suite: `bun test packages/sdk packages/server packages/providers` (313 tests at baseline).
- Release-gate examples: `bun run examples:hello-search examples:hello-spaces examples:quickstart`.

### 9.3 Validation Commands

```bash
# DDL landed (env: SAMESAKE_DATABASE_URL)
psql "$SAMESAKE_DATABASE_URL" -c "SELECT column_name FROM information_schema.columns
  WHERE table_name='c_listings' AND column_name IN ('product_group','dedup_score');"

# Retrieval neutrality for dedup-less collections (env: GEMINI_API_KEY, OPENAI_API_KEY, Neon)
cd examples/fashion-search && bun --env-file=../../.env eval-search.ts --phase=p2dedup
# then: per-query topIds must be 67/67 identical to evals/runs/2026-07-02T21-56-59-647Z-search-p2tenancy.json
```

## 10. Security Considerations

No new attack surface class: all new routes sit behind the existing Bearer auth; all SQL is
parameterized with identifiers passed through `sanitiseIdent` (same discipline as P2-1); scope
enforcement reuses `resolveScope`, so the tenancy guarantees extend to every dedup surface
(REQ-5, and `confirm`/`split` cannot move rows across scopes because the scope-resolved WHERE
pins them). `offers` exposes only declared `offerFields` — never raw `data` — so a collection
owner controls exactly what cross-vendor data a search response reveals.

## 11. Rollback and Abort Criteria

- Abort if: dedup-less collections show ANY diff in the fashion eval topIds (cmd:eval-neutral) —
  the feature must be provably inert when unconfigured; stop and re-triage rather than adjust
  the baseline.
- Abort if: the full suite regresses and the fix attempt fails once — symptom-patch rule; stop
  and re-triage.
- Rollback: revert the commits; for a deployed collection, `dedup({rebuild:true})` is not needed
  — dropping the `dedup` config via `apply --allowDestructive` removes columns/table; search
  falls back to uncollapsed behavior automatically.

## 12. Open Questions

- Q1: Cluster state location — collection-local columns vs entity-kind mirror.
  Tradeoff: locality/simplicity vs reusing entity tables verbatim.
  **Proposal:** collection-local (Section 2 rationale: no sync pipeline, no dual schema).
- Q2: Canonical representative — search-time RRF winner vs elected/merged canonical record.
  Tradeoff: zero election machinery vs stable card identity across queries.
  **Proposal:** RRF winner in v1. The card is whatever hit won retrieval for *this query*, offers
  attach to it. Merged canonical records (cluster-level enrichment) are a named non-goal until
  offer-dedup proves demand.
- Q3: Threshold storage — static per-collection config vs entity-style `scope_thresholds` table
  with runtime calibration. Tradeoff: simplicity vs per-tenant tuning.
  **Proposal:** static config in v1; the entity calibration pattern is the known upgrade path.
- Q4: When clustering runs — explicit `matcher.dedup()` stage vs automatic tail of embed-index.
  Tradeoff: caller orchestration (consistent with ingest→enrich→index staging and the
  inline-pipelines-no-job-runner verdict) vs zero-config freshness.
  **Proposal:** explicit stage in v1, documented in the pipeline guides next to enrich/index.
- Q5: Offer ordering — unspecified vs declared sort. Tradeoff: API surface vs client work.
  **Proposal:** v1 returns offers unordered (client sorts by price); add
  `dedup.offerSort` only on demand.

## Way forward (execution plan for a fresh session)

1. Fresh session, paste the kickoff below. Context needed beyond this RFC: none — grounding
   files are cited inline; the tenancy test (`test/tenancy.test.ts`) is the style template.
2. Order is C1→C9; C3+C4 are the risk core (do them early, verify with the deterministic tests
   before touching search); C8's eval-neutrality gate is the last hard proof before docs.
3. Baseline: suite 313/313, examples ×3 green, eval baseline `p2tenancy` (67 queries), at
   commit `f83f5f7` + the RFC commit.
4. Local tests hit Neon (~5s-timeout flakes — rerun before diagnosing); rebuild `packages/sdk`
   after SDK type changes and server before running examples (dist resolution).
5. After landing: release (changesets local flow per RELEASING.md), then P2-3 (enrichment ROI
   upgrades) per the plan doc.
