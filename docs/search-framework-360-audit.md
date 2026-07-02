# Search Framework 360 Post-Fix Audit

## Objective

Perform a rigorous post-fix audit of the `samesake` search framework after the relevance fixes.

The goal is to verify that the fixes are principled, framework-safe, multilingual-safe, and industry-general. Do not merely check that the original repro queries improved. Actively look for hacks, shortcuts, overfitting, and regressions.

This is a framework audit, not just a fashion demo audit.

## Core Questions

Answer these with evidence:

1. Did the fixes solve the original relevance problems without hard-coded hacks?
2. Did any fix overfit to the original repro queries, products, or fashion terminology?
3. Did any fix degrade multilingual search or non-English queries?
4. Did any fix make the framework too fashion-specific?
5. Did any fix harm search quality for other industries such as electronics, furniture, grocery, beauty, tools, books, or B2B catalog search?
6. Did any fix introduce brittle thresholds, hidden assumptions, or data-shape dependencies?
7. Are duplicate handling, relevance gating, embeddings, reranking, and calibration still generic framework features rather than playground-only patches?

## Strict Rules

- Do not print secrets from `.env`.
- Do not commit unless explicitly instructed.
- Do not rely on the original repro queries only.
- Do not accept query-specific or product-specific logic as a valid fix.
- Do not accept English-only assumptions unless explicitly documented and justified.
- Do not accept fashion-only assumptions inside framework code.
- Do not change code unless you find a clear regression, shortcut, or unsafe implementation.
- If you do change code, keep changes minimal, generic, and covered by tests.

## Phase 1: Diff Audit

Inspect all changes made in the previous fix pass.

Run:

```bash
git status --short
git diff --stat
git diff
````

Classify every changed file as one of:

* framework core;
* SDK template;
* playground config;
* playground route/API;
* tests;
* docs/scripts.

For each change, determine:

* what problem it intended to solve;
* whether it is generic or fashion-specific;
* whether it is query/product-specific;
* whether it creates multilingual risk;
* whether it creates cross-industry risk;
* whether it has tests.

Flag any of these as high risk:

* string checks for specific queries such as `night dress`, `scuba`, `wetsuit`, `saree`, or `Alice`;
* product-title-specific logic;
* hard-coded fashion categories in framework core;
* English-only token logic in framework core;
* fixed thresholds without calibration or explanation;
* relevance gates based on result title/category text only;
* duplicate collapse based only on exact English titles;
* logic that assumes every catalog has color, size, gender, style, or garment category;
* changes that make image/text hybrid search worse for non-fashion products.

## Phase 2: Search Architecture Audit

Inspect the following files and any changed related files:

```text
packages/server/src/core/search.ts
packages/server/src/core/search-query.ts
packages/server/src/core/spaces.ts
packages/server/src/core/calibrate-search.ts
packages/server/src/core/embed-index.ts
packages/sdk/src/templates/fashion.ts
apps/playground/lib/embed.ts
apps/playground/lib/samesake.ts
apps/playground/lib/embed-doc.ts
apps/playground/app/api/search/route.ts
```

For every important claim, record file path and line number.

Audit these areas:

### Relevance Gating

Check whether the no-result or relevance gate is:

* generic across domains;
* based on meaningful retrieval confidence;
* not a special case for the original queries;
* robust to multilingual queries;
* robust to short queries;
* robust to synonym queries;
* robust to misspellings;
* compatible with image search;
* compatible with hybrid retrieval;
* compatible with future rerankers.

Reject the fix if it depends mainly on English keyword overlap or fashion category names.

### RRF / Fusion

Check whether fusion still behaves correctly across:

* dense vector retrieval;
* full-text retrieval;
* spaces vector retrieval;
* reranking;
* duplicate collapse;
* no-result behavior.

Verify whether score magnitude is still discarded and whether any added confidence signal restores enough information for gating.

### Embeddings

Check whether query and document embedding task types are preserved.

Verify:

* `RETRIEVAL_QUERY` is used for query embeddings when supported;
* `RETRIEVAL_DOCUMENT` is used for document embeddings when supported;
* unsupported providers fail gracefully or ignore task type intentionally;
* no provider-specific behavior leaks into the generic framework incorrectly.

### Duplicate / Variant Handling

Check whether duplicate collapse is:

* generic;
* configurable;
* stable;
* not based only on exact English title;
* not destructive;
* compatible with variants such as size/color;
* suitable for different industries.

Examples:

* Fashion: same dress in red/blue may be variants, not duplicates.
* Electronics: same phone with different storage may be variants, not duplicates.
* Grocery: same item with different pack size may be variants, not duplicates.
* Books: paperback/hardcover/audiobook may be variants, not duplicates.

### Template Boundaries

Check whether fashion-specific logic remains inside:

```text
packages/sdk/src/templates/fashion.ts
apps/playground/*
```

and does not leak into generic framework code under:

```text
packages/server/src/core/*
```

If generic framework code now knows about dresses, colors, garments, gender, size, style, nightwear, sarees, leggings, etc., flag it.

## Phase 3: Multilingual Audit

Design and run multilingual tests or scripts.

At minimum test queries in:

* English;
* Spanish;
* French;
* German;
* Hindi or another Indic language;
* Japanese or Korean;
* Arabic or another right-to-left language.

Use semantically equivalent queries where possible.

Suggested fashion queries:

```text
red dress
vestido rojo
robe rouge
rotes kleid
लाल ड्रेस
赤いドレス
فستان أحمر
```

Suggested no-match queries:

```text
scuba diving wetsuit
traje de neopreno para buceo
combinaison de plongée
Taucheranzug
ダイビング用ウェットスーツ
بدلة غوص
```

Suggested generic commerce queries for other industries:

```text
wireless headphones
auriculares inalámbricos
casque sans fil
kabellose kopfhörer
ワイヤレスヘッドホン

office chair
silla de oficina
chaise de bureau
Bürostuhl
オフィスチェア

organic coffee beans
granos de café orgánico
grains de café bio
Bio-Kaffeebohnen
有機コーヒー豆
```

If the existing catalog is fashion-only, still test the behavior and verify the gate does not rely on English-only keyword matching. If necessary, create small in-memory or fixture-based test collections for non-fashion domains.

Record:

* query;
* language;
* expected match category;
* top result;
* whether results are relevant;
* whether the gate rejects valid non-English matches;
* whether no-match behavior is sane.

## Phase 4: Cross-Industry Generalization Audit

Create or inspect tests using small synthetic catalogs for at least three non-fashion industries.

Use tiny datasets so the behavior is easy to reason about.

Required industries:

1. Electronics
2. Furniture or home goods
3. Grocery, books, beauty, tools, or B2B parts

Example electronics fixture:

```json
[
  {
    "id": "e1",
    "title": "Wireless Noise Cancelling Headphones",
    "brand": "SoundCo",
    "category": "Electronics",
    "description": "Bluetooth over-ear headphones with active noise cancellation"
  },
  {
    "id": "e2",
    "title": "USB-C Laptop Charger 65W",
    "brand": "VoltPro",
    "category": "Electronics",
    "description": "Compact USB-C power adapter for laptops"
  }
]
```

Example furniture fixture:

```json
[
  {
    "id": "f1",
    "title": "Ergonomic Office Chair",
    "brand": "WorkWell",
    "category": "Furniture",
    "description": "Adjustable desk chair with lumbar support"
  },
  {
    "id": "f2",
    "title": "Oak Dining Table",
    "brand": "HomeRoot",
    "category": "Furniture",
    "description": "Solid oak dining table for six people"
  }
]
```

Example grocery fixture:

```json
[
  {
    "id": "g1",
    "title": "Organic Whole Bean Coffee",
    "brand": "RoastHouse",
    "category": "Grocery",
    "description": "Medium roast Arabica coffee beans"
  },
  {
    "id": "g2",
    "title": "Gluten Free Pasta",
    "brand": "PantryPlus",
    "category": "Grocery",
    "description": "Corn and rice penne pasta"
  }
]
```

Test relevant and irrelevant queries:

```text
wireless headphones
laptop charger
office chair
dining table
organic coffee
gluten free pasta
red dress
scuba wetsuit
car tires
medical stethoscope
```

Validate:

* relevant queries still return correct products;
* unrelated queries are gated or ranked safely;
* no fashion-specific requirements are imposed;
* product schemas without color/size/gender still work;
* duplicate collapse does not incorrectly merge distinct products.

## Phase 5: Hack and Workaround Detection

Search the codebase for suspicious shortcuts.

Run:

```bash
grep -RIn \
  -e "night dress" \
  -e "Alice Bodycon" \
  -e "scuba" \
  -e "wetsuit" \
  -e "saree" \
  -e "leggings" \
  -e "dress" \
  -e "fashion" \
  -e "garment" \
  -e "hardcoded" \
  -e "TODO" \
  -e "HACK" \
  -e "FIXME" \
  -e "temporary" \
  -e "threshold" \
  packages apps examples tests \
  || true
```

Also search for suspicious conditional logic:

```bash
grep -RIn \
  -e "query.includes" \
  -e "title.includes" \
  -e "category.includes" \
  -e "startsWith" \
  -e "endsWith" \
  -e "toLowerCase()" \
  -e "localeCompare" \
  packages apps examples tests \
  || true
```

Manually inspect matches. Not every match is bad. Flag only cases where the logic creates non-generic behavior.

## Phase 6: Test and Validation Audit

Inspect existing and newly added tests.

Check whether tests include:

* original repro queries;
* unrelated no-match queries;
* valid in-catalog queries;
* duplicates and variants;
* multilingual queries;
* non-fashion catalogs;
* short queries;
* misspellings;
* synonym queries;
* image search behavior if supported.

Run appropriate commands after inspecting package scripts:

```bash
bun test
bun run typecheck
bun run lint
```

If monorepo scripts differ, run the relevant package-level scripts.

If tests fail, determine whether failures are caused by the prior fix, existing repo state, missing credentials, or environment limitations.

## Phase 7: Regression Matrix

Produce a matrix like:

| Area                                  | Before Fix Issue                        | Current Behavior | Pass/Fail | Evidence |
| ------------------------------------- | --------------------------------------- | ---------------- | --------- | -------- |
| No-match gating                       | `night dress` returned ordinary dresses | ...              | ...       | ...      |
| Hub product                           | `Alice Bodycon dress` dominated         | ...              | ...       | ...      |
| Duplicate collapse                    | duplicate occupied ranks                | ...              | ...       | ...      |
| Multilingual                          | unknown                                 | ...              | ...       | ...      |
| Electronics catalog                   | not tested                              | ...              | ...       | ...      |
| Furniture catalog                     | not tested                              | ...              | ...       | ...      |
| Grocery/catalog without fashion attrs | not tested                              | ...              | ...       | ...      |

## Phase 8: Corrective Action Policy

Only implement additional fixes if the audit finds clear evidence of one of these:

* query-specific hack;
* product-specific hack;
* English-only logic in generic framework code;
* fashion-specific logic in generic framework code;
* regression for valid multilingual queries;
* regression for non-fashion catalogs;
* brittle threshold without calibration, configuration, or test coverage;
* duplicate collapse that incorrectly merges distinct variants;
* broken embedding task-type behavior.

When fixing:

* keep the fix generic;
* make it configurable where domain behavior differs;
* add tests that would fail on the hack/regression;
* avoid changing public API shape unless necessary;
* document any unavoidable tradeoff.

## Final Report

Return a concise but rigorous report with these sections:

### 1. Executive Verdict

State whether the previous fix is:

* clean and framework-safe;
* mostly clean with minor risks;
* partially hacky;
* unsafe / overfit.

### 2. Diff Review

List changed files and classify each as framework, SDK template, playground, test, or docs.

### 3. Hack / Workaround Findings

List any suspicious logic found. Include file paths and line numbers.

Explicitly state whether any query-specific or product-specific hacks were found.

### 4. Multilingual Findings

Include test queries, languages, results, and whether multilingual behavior passed.

### 5. Cross-Industry Findings

Include synthetic or existing non-fashion catalog tests and results.

### 6. Framework Boundary Findings

State whether fashion-specific logic stayed in templates/playground or leaked into generic framework code.

### 7. Corrective Changes

If changes were made, list changed files, why they were changed, and validation.

If no changes were made, say so.

### 8. Validation

Include commands run and results.

### 9. Remaining Risks

List open risks and recommended follow-ups.

### 10. Non-Goals / Safety

State:

* no secrets were printed;
* no deployment was performed unless explicitly requested;
* no query-specific hacks were added;
* no product-specific hacks were added.
