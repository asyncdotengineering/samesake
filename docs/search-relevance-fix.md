# Search Relevance Audit and Fix

## Objective

Complete an end-to-end audit and remediation of the deployed `samesake` playground search relevance problems.

First reproduce and characterize the issues with evidence. Then inspect live stored data and code paths, identify root causes, implement targeted fixes, validate the real search path, and produce a final report.

Do not stop after diagnosis unless blocked by missing credentials, destructive ambiguity, or conflicting requirements.

## Rules

- Do not print secrets from `.env`, especially `DATABASE_URL` or `GEMINI_API_KEY`.
- Do not commit unless explicitly instructed.
- Do not hard-code behavior for `night dress`, `Alice Bodycon dress`, or any single query/product.
- Keep changes minimal and targeted.
- Preserve existing public API shape unless a change is necessary and justified.
- Add or update tests where practical.
- Validate end-to-end behavior, not only isolated helper functions.

## Reported Issues to Audit and Fix

1. No relevance gate:
   - Query: `night dress`
   - The catalog reportedly has no nightwear, but search returns ordinary dresses.

2. Hub product:
   - `Alice Bodycon dress` reportedly appears top or near-top for many unrelated queries.

3. Uncalibrated scores:
   - Good and bad query scores overlap, so a naive fixed threshold may not separate relevant from irrelevant results.

4. Duplicate handling:
   - `Alice Bodycon dress` appears duplicated in the source corpus and may occupy multiple result slots.

5. Embedding task-type mismatch:
   - Framework code may pass query/document task types, but the playground Gemini embedding function may drop them.

## Work Plan

Run these tracks in parallel where useful:

### 1. API Reproduction

Use the deployed API:

```bash
BASE="https://playground-six-sepia.vercel.app"

for q in \
  "night dress" \
  "red dress" \
  "gym leggings women" \
  "scuba diving wetsuit" \
  "office wear" \
  "saree"
do
  echo "=== $q ==="
  curl -s -X POST "$BASE/api/search" \
    -H 'content-type: application/json' \
    -d "{\"q\":\"$q\"}" \
    | python3 -c '
import sys, json
d = json.load(sys.stdin)
for h in d.get("hits", [])[:6]:
    print(" ", h.get("id"), "|", h.get("title"), "|", h.get("category"), "|", h.get("color"))
'
done
````

Also inspect products:

```bash
curl -s "$BASE/api/products" | python3 -m json.tool | head -40
```

Record top hits, top titles, recurring products, duplicates, and whether no-match queries return irrelevant products.

### 2. Stored Data Inspection

The searched data is in Postgres table:

```text
project_playground.c_products
```

Read `DATABASE_URL` from:

```text
apps/playground/.env
```

Use it locally only. Do not print it.

From `apps/playground`, run:

```bash
cd apps/playground

bun --env-file=.env -e '
import postgres from "postgres";

const s = postgres(process.env.DATABASE_URL, { max: 1 });

const rows = await s.unsafe(`
  SELECT
    id,
    data->>''title'' AS title,
    enriched->>''category'' AS category,
    enriched->''colors'' AS colors,
    embedding IS NOT NULL AS has_embedding,
    space_vec IS NOT NULL AS has_space_vec
  FROM project_playground.c_products
  ORDER BY title, id
`);

for (const r of rows) {
  console.log(
    r.id,
    "|",
    r.title,
    "| category:",
    r.category,
    "| colors:",
    JSON.stringify(r.colors),
    "| embedding:",
    r.has_embedding,
    "| space_vec:",
    r.has_space_vec
  );
}

console.log("total:", rows.length);
await s.end();
'
```

Determine product count, duplicated titles, duplicated `Alice Bodycon dress` IDs, enriched attributes, and vector presence.

### 3. Source Corpus Check

Inspect:

```text
examples/fashion-search/datasets/lk-snapshot-subset/corpus.json
```

Run:

```bash
grep -n "Alice Bodycon dress" examples/fashion-search/datasets/lk-snapshot-subset/corpus.json
```

Verify duplicate source records and record exact line numbers and IDs.

### 4. Code Inspection

Ground every claim to file path and line number.

Inspect at least:

```text
packages/server/src/core/search.ts
packages/server/src/core/search-query.ts
packages/server/src/core/spaces.ts
packages/server/src/core/calibrate-search.ts
packages/server/src/core/embed-index.ts
apps/playground/lib/embed.ts
apps/playground/lib/samesake.ts
apps/playground/lib/embed-doc.ts
apps/playground/app/api/search/route.ts
packages/sdk/src/templates/fashion.ts
```

Look for:

* RRF fusion and whether it is rank-only.
* Whether raw score magnitude is discarded.
* Full-text soft-OR behavior.
* Mode weights.
* `KEYWORD_TIEBREAK`.
* `space_vec` construction.
* Calibration / LLM judge design.
* Whether judge model overlaps with enrichment model.
* Whether framework passes `RETRIEVAL_QUERY` and `RETRIEVAL_DOCUMENT`.
* Whether `apps/playground/lib/embed.ts` drops `taskType`.
* Whether `apps/playground/lib/samesake.ts` lacks `variantGroup`.
* How embed docs are composed.
* Whether public search endpoint omits scores.

### 5. Fix Design

Before editing, write a short implementation plan.

Consider fixes in these areas, but only implement what evidence supports:

* Add principled relevance/no-result gating.
* Preserve Gemini embedding `taskType`.
* Add duplicate or variant collapse.
* Reduce generic hub-product dominance.
* Improve tests for no-match, exact-match, unrelated-query, duplicate-collapse, and score-overlap behavior.

Avoid query-specific hacks.

### 6. Implementation

Make targeted changes. Likely files may include:

```text
apps/playground/lib/embed.ts
apps/playground/lib/samesake.ts
packages/server/src/core/search.ts
packages/server/src/core/search-query.ts
apps/playground/app/api/search/route.ts
packages/sdk/src/templates/fashion.ts
```

Only change files justified by the audit.

### 7. Validation

Run relevant checks. Inspect package scripts first, then run the appropriate commands, such as:

```bash
bun test
bun run typecheck
bun run lint
```

Validate at minimum:

```text
night dress
red dress
gym leggings women
scuba diving wetsuit
office wear
saree
```

Expected outcomes:

* `night dress` should not return ordinary dresses as confident matches if no nightwear exists.
* `red dress` should still return relevant dresses.
* `gym leggings women` should still return relevant leggings if present.
* `scuba diving wetsuit` should not return unrelated fashion items as confident matches.
* `Alice Bodycon dress` should not dominate unrelated queries.
* Duplicate products should not occupy multiple top result slots.

If full local validation requires credentials or deployment-only resources, document the blocker and provide the best available local validation.

## Final Report Format

Return:

### Audit Findings

For each symptom, mark confirmed, partially confirmed, or not confirmed, with evidence.

### Root Causes

List root causes with file paths and line numbers.

### Fixes Implemented

Include changed files, what changed, and why.

### Validation

Include commands run, test results, before/after behavior, and limitations.

### Remaining Risks

List follow-up risks such as calibration quality, production data drift, or deployment differences.

### Non-Goals

State that no secrets were printed, no query-specific hacks were added, and no deployment was performed unless explicitly requested.
