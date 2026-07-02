# RFC: Offline LLM-as-judge eval harness for fashion search (G8)

**Category:** New Feature
**Author:** octalpixel
**Date:** 2026-06-20
**Status:** Draft (rev 2 — open questions Q1/Q3/Q4 resolved against the IR/LLM-eval literature; see `docs/research/open-questions-literature.md`)
**Reviewers:** (unassigned)
**Related:**
- Parent RFC: `rfcs/rfc-pipeline-integrity-seams.md` — this RFC details its **G8** (REQ-23–27) as a standalone, P0 deliverable. The parent depends on this harness to tune the G2 confidence floor and G7 fusion exponents.
- Research: `docs/research/doordash/LEARNINGS.md` (G8 = "single biggest missing piece"), `docs/research/mastra/README.md` (`MastraAgentRelevanceScorer` reusable as judge), `docs/research/open-questions-literature.md` (verified IR/LLM-eval citations: Zheng MT-Bench, Järvelin nDCG, RankGPT).
- Existing assets promoted: `apps/playground/lib/search-relevance.ts` (binary judge prototype), `evals/golden-queries-fashion-lk.json` (50-query golden set), `packages/server/src/core/search.ts:910` (`searchWithExplain`).
- Baseline SHA `ad21a9a` (172/172 server tests green).

---

## 1. Problem Statement

samesake has **no offline relevance feedback loop**. Every ranking, enrichment-prompt, weight, or threshold change is currently unfalsifiable: there is no traffic to A/B against, and the only relevance signal is a binary, playground-local judge (`apps/playground/lib/search-relevance.ts:61`) that filters hits at query time but produces **no measurable score**. The parent RFC's own correctness work (G2 confidence floor, G7 fusion exponents, G4 default reranker, embedding-hygiene `embed_doc` trim) cannot be proven to help or shown not to regress without a metric.

The DoorDash corpus names this the single biggest gap: a human-calibrated LLM-as-judge eval that gates changes *before* A/B is the prerequisite for iterating "at engineering speed instead of experiment speed" [`docs/research/doordash/LEARNINGS.md`].

**Success criteria:**
- S1: `runEval(project, collection, {queries, judge})` returns per-query and aggregate **Hit@K, nDCG@K, MRR, null-rate, constraint-violation-rate** + a versioned JSON artifact.
- S2: Relevance labels are **graded** (`0|1|2`) and **facet-decomposed** (category, color, occasion, gender, style, material), then aggregated — not a single opaque score.
- S3: The judge is **calibrated against a human-labeled subset** (reports precision/recall/F1 vs human) before its scores are trusted; the judge prompt + model are versioned.
- S4: A change to RRF weights / default rerank / `rankingPolicy` / enrich prompts can be **gated** on the harness: it fails if any tracked metric drops below its declared launch threshold.
- S5: The harness consumes the existing `evals/golden-queries-fashion-lk.json` and its `constraints.max_price` produces an **objective** violation metric that needs no judge.

**Non-goals:** online A/B; click-calibrated thresholds (no traffic yet); learned ranking; replacing the parent RFC's gate/compose/status work (this consumes it).

---

## 2. Background

### 2.1 What exists (verified)
- **Binary judge prototype** — `search-relevance.ts:61` `filterHitsBySemanticRelevance(query, hits, generate)`: sends ≤24 candidates (`:69`) to `generate` with a strict relevance system prompt (`:72-73`), returns the relevant-ID subset. The candidate summary (`:41-59`) already serializes the right facets (title/brand/category/type/colors/occasions/styles/material/pattern/fit/description). It is **binary and discards the grade**, lives in `apps/playground`, and produces no metric.
- **Golden set** — `evals/golden-queries-fashion-lk.json`: 50 queries with `id`, `type` (Baymard taxonomy: keyword/attribute/…), `query`, and some carry `constraints.max_price` (LKR) "to enable objective violation metrics." No relevance grades yet.
- **Search + explain** — `matcher.searchWithExplain` (`search.ts:910`) runs retrieve once and returns both hits and `SearchExplainResult` (per-channel `fts_rank`/`cosine_rank`/`spaces_rank`/`recency_rank`/`rrf_score` + `space_cosines`, `search.ts:65-86`). The harness uses `explain` to attribute wins/losses to channels.
- **BYO judge** — `GenerateFn` (`types.ts:87`) is the same contract enrichment uses; the judge is the consumer's `generate`, keeping the harness provider-agnostic.

### 2.2 What the research prescribes
- **Graded labels** `{0: irrelevant, 1: moderate, 2: highly relevant}` (DashCLIP started 700K human → fine-tuned GPT → 32M pairs) and **facet decomposition** (cuisine/prep/ingredients/dietary → for fashion: category/color/occasion/gender/style/material) [`LEARNINGS.md` T1/§Relevance].
- **Metrics**: Hit@K (retrieval), nDCG@K (graded order), MRR; stratify head/torso/tail; position-weighted (DoorDash WPR) [evaluate-search-result-pages].
- **Calibrate the judge vs humans first** (precision/recall/F1), iterate until thresholds met; offline + online share one rubric/judge [simulation-flywheel, building-doordash-assistant].
- **Null/low-result rate** is a first-class metric [content-embeddings, −3.65% null-search].
- **Launch thresholds, not vibes**: each metric has a pre-declared threshold; every threshold must be met before a change ships [offline-llms].
- **Mastra** ships exactly this judge as `MastraAgentRelevanceScorer` behind `RelevanceScoreProvider`; samesake's judge can be the **same** function used for the G4 reranker [`docs/research/mastra/README.md`].

### 2.3 Design decisions
- **One judge, two consumers.** The same `RelevanceJudge` powers (a) this eval harness and (b) the G4 default reranker, so calibration effort is shared. (Footnote: rejected a bespoke eval-only judge — duplicate calibration surface.)
- **Two label sources, deliberately separated.** (1) *Objective* checks from golden-set `constraints` (price/exclude) — deterministic, no judge, no calibration risk. (2) *Subjective* graded relevance from the judge. Report them separately so a judge regression can't mask a constraint regression.
- **Judge calls are cached** by `sha1(judgeVersion | query | candidate_rerank_doc)`, reusing the embed-cache pattern (`embed.ts:8-25`), so re-runs over an unchanged golden set are cheap.

---

## 3. Strict Requirements

- REQ-1: `@samesake/server` MUST export `runEval(ctx, project, collection, opts) → EvalResult` that, for each query in the set, calls `searchWithExplain` and scores the top-K hits.
- REQ-2: A `RelevanceJudge` MUST return a **graded** label `0|1|2` per `⟨query, hit⟩` plus **per-facet** sub-grades `{category,color,occasion,gender,style,material}` and a short justification. It MUST be built from the consumer's `GenerateFn` (provider-agnostic), and SHOULD be the same judge usable as the G4 reranker.
- REQ-3: The harness MUST compute, per query and in aggregate: **Hit@K, nDCG@K** (graded), **MRR**, **null-rate** (share of queries returning 0 hits above a relevance floor), and **constraint-violation rate** (objective, from golden `constraints`). Metrics MUST be reportable **stratified by query `type`** (keyword/attribute/…).
- REQ-4: The golden set MUST be loadable from `evals/*.json` (extending the existing `golden-queries-fashion-lk.json` shape) and MUST support an optional persisted grade cache / `eval_golden` artifact so judged grades are reused across runs.
- REQ-5: The judge prompt + model MUST be **versioned** (`judgeVersion` string in every artifact and cache key). Changing the judge MUST invalidate the grade cache for that version only.
- REQ-6: The harness MUST support **calibration**: given a small human-labeled subset, it MUST report judge-vs-human **precision/recall/F1** (and grade agreement / Cohen's κ) and refuse to emit "trusted" metrics until F1 ≥ a configured bar (default per Q1).
- REQ-7: The harness MUST support **launch thresholds**: a config mapping metric→min-value; `runEval` MUST return a `pass: boolean` that is false if any tracked metric is below threshold, suitable for a CI gate.
- REQ-8: Judge calls MUST be cached and batched; a re-run over an unchanged golden set + unchanged index + same `judgeVersion` MUST issue **zero** new judge calls.
- REQ-9: The harness MUST emit a machine-readable JSON artifact (per-query + aggregate + channel attribution from `explain`) to a stable path, and a short human-readable summary.
- REQ-10: The harness MUST be runnable headless (CI) and from a script in `examples/fashion-search/`; it MUST NOT require a running HTTP server (in-process `matcher` call).
- REQ-11: No new bundled LLM dependency; provider-agnostic via `GenerateFn`. No regression to `packages/server/test/*` or fashion smokes.

---

## 4. Interface Specification

### 4.1 `RelevanceJudge`
- **Location:** `packages/server/src/core/eval/judge.ts`
- **Signature:**
  ```ts
  export interface FacetGrades { category?: 0|1|2; color?: 0|1|2; occasion?: 0|1|2; gender?: 0|1|2; style?: 0|1|2; material?: 0|1|2; }
  export interface JudgedHit { id: string; grade: 0|1|2; facets: FacetGrades; reason: string; }
  export interface RelevanceJudge {
    version: string;
    grade(query: string, candidates: Array<{ id: string; text: string; data: Record<string,unknown> }>): Promise<JudgedHit[]>;
  }
  export function makeLlmJudge(generate: GenerateFn, opts?: { model?: string; version?: string }): RelevanceJudge;
  ```
- **Behavior:** builds the candidate text from each hit's `enriched.rerank_doc` (falling back to the `candidateSummary` shape at `search-relevance.ts:41-59`); one structured `generate` call per ≤N-candidate batch; returns graded + facet-decomposed labels.
- **Error cases:** a `generate` failure on a batch → that batch's hits scored `grade:0` with `reason:"judge-error"` and a logged warning; never throws the run. Malformed JSON → same.

### 4.2 `runEval`
- **Location:** `packages/server/src/core/eval/run.ts`; exposed as `matcher.runEval(...)`.
- **Signature:**
  ```ts
  export interface EvalOpts {
    queries: GoldenQuery[];           // loaded from evals/*.json
    judge: RelevanceJudge;
    k?: number;                       // default 10
    relevanceFloor?: 1|2;             // grade ≥ floor counts as "hit"; default 1
    thresholds?: Partial<Record<MetricKey, number>>;  // launch gate
  }
  export interface PerQuery { id: string; type: string; hitAtK: number; ndcgAtK: number; mrr: number;
    nullResult: boolean; constraintViolations: number; channelAttribution: Record<string,number>; }
  export interface EvalResult {
    perQuery: PerQuery[];
    aggregate: Record<MetricKey, number> & { byType: Record<string, Record<MetricKey, number>> };
    judgeVersion: string; pass: boolean; failedThresholds: Array<{ metric: string; got: number; min: number }>;
    artifactPath: string;
  }
  export function runEval(ctx: MatcherCtx, project: string, collection: string, opts: EvalOpts): Promise<EvalResult>;
  ```
- **Behavior:** per query → `searchWithExplain` → objective constraint check from `query.constraints` → judge top-K → compute metrics → aggregate (overall + `byType`) → write artifact → evaluate thresholds → `pass`.
- **Error cases:** a query whose search throws → recorded as `nullResult:true` + logged; does not abort the run (matches the corpus "null is a tracked outcome" stance).

### 4.3 `calibrateJudge`
- **Location:** `packages/server/src/core/eval/calibrate.ts`
- **Signature:** `calibrateJudge(judge, humanLabels: Array<{query:string; id:string; grade:0|1|2}>) => { precision:number; recall:number; f1:number; kappa:number; n:number }`
- **Behavior:** runs the judge over the human-labeled pairs, compares (binary at `relevanceFloor` for P/R/F1; graded for κ). **Error case:** fewer than a configured min labels → throws "insufficient calibration set".

### 4.4 Golden-set schema (extends existing)
- **Location:** `evals/*.json` (current `golden-queries-fashion-lk.json`).
- Per query: `{ id, type, query, constraints?: { max_price?, exclude_colors?, gender?, category? }, grades?: Record<productId, 0|1|2> }`. `grades` is the optional persisted judge/human cache (REQ-4).

---

## 5. Architecture and System Dependencies

### 5.1 Structural changes
- New: `packages/server/src/core/eval/{run,judge,metrics,calibrate}.ts`; `matcher.runEval` wired in the matcher factory; `examples/fashion-search/eval-judge.ts` (runnable harness over `evals/golden-queries-fashion-lk.json`).
- Promote/retire: `apps/playground/lib/search-relevance.ts`'s judge logic moves into `core/eval/judge.ts` (graded, not binary); the playground keeps a thin import. `search-relevance.test.ts` (untracked) migrates to `packages/server/test/eval-*.test.ts`.

### 5.2 Service/library dependencies
- None new. Judge = consumer `GenerateFn`. Reuses `searchWithExplain`, the embed-cache table pattern for the judge cache.

### 5.3 Data/schema changes
- Optional `samesake_eval_cache(cache_key text pk, grade jsonb, judge_version text, created_at)` (mirrors `samesake_embed_cache`), OR file-based grade cache in `evals/.cache/`. (Q2.)
- Artifact output dir `evals/runs/<timestamp>-<judgeVersion>.json` (timestamp passed in, not generated — scripts can't call `Date.now()` in workflow contexts but this is a normal Node script, so `new Date()` is fine here).

### 5.4 Performance
- Judge cost = (#queries × ceil(K / batch)) `generate` calls on first run; **0** on cached re-runs (REQ-8). 50 queries × K=10 × batch=10 ≈ 50 calls cold. Acceptable for an offline gate.

---

## 6. Pseudocode

```
FUNCTION runEval(project, collection, opts):
    results = []
    FOR q IN opts.queries:
        {hits, explain} = searchWithExplain(project, collection, {q: q.query, limit: opts.k, ...})
        violations = countConstraintViolations(hits, q.constraints)        # objective, no judge
        candidates = hits.map(h => {id, text: h.enriched.rerank_doc ?? summary(h), data})
        graded = cacheOrJudge(opts.judge, q.query, candidates)             # graded {0,1,2}+facets
        results.push({
            id:q.id, type:q.type,
            hitAtK:  any(graded, g => g.grade >= floor) ? 1 : 0,
            ndcgAtK: ndcg(graded.map(g=>g.grade), k),
            mrr:     1 / (1 + firstIndexWhere(graded, g=>g.grade>=floor)),
            nullResult: hits.length == 0 OR max(grade) < floor,
            constraintViolations: violations,
            channelAttribution: attributeWinsToChannels(graded, explain),
        })
    agg = mean(results) + groupMean(results, by=type)
    failed = [ {m,got,min} for m,min in opts.thresholds if agg[m] < min ]
    artifact = writeJson(evals/runs/..., {results, agg, judgeVersion})
    RETURN { perQuery:results, aggregate:agg, pass: failed.empty, failedThresholds:failed, artifactPath }

FUNCTION cacheOrJudge(judge, query, candidates):
    key = sha1(judge.version | query | candidate.text) per candidate
    hit, miss = splitByCache(key)
    fresh = miss.empty ? [] : judge.grade(query, miss)                     # batched generate call
    store(fresh); RETURN hit ++ fresh

FUNCTION calibrate(judge, humanLabels):
    pred = judge over humanLabels
    RETURN { precision, recall, f1 (binary at floor), kappa (graded), n }
    # caller refuses to trust metrics until f1 >= bar
```

## 7. Code Blueprint

```ts
// packages/server/src/core/eval/metrics.ts
export function ndcgAtK(grades: number[], k: number): number {
  const dcg = grades.slice(0, k).reduce((s, g, i) => s + (2 ** g - 1) / Math.log2(i + 2), 0);
  const ideal = [...grades].sort((a, b) => b - a).slice(0, k)
    .reduce((s, g, i) => s + (2 ** g - 1) / Math.log2(i + 2), 0);
  return ideal === 0 ? 0 : dcg / ideal;
}
export function mrr(grades: number[], floor: number): number {
  const i = grades.findIndex((g) => g >= floor);
  return i < 0 ? 0 : 1 / (i + 1);
}

// packages/server/src/core/eval/judge.ts — graded promotion of search-relevance.ts
export function makeLlmJudge(generate: GenerateFn, opts = {}): RelevanceJudge {
  const version = opts.version ?? "fashion-judge-v1";
  return {
    version,
    async grade(query, candidates) {
      const schema = { /* {grades:[{id, grade:0|1|2, facets:{...}, reason}]} */ };
      const out = await generate({
        model: opts.model,
        system: FASHION_JUDGE_SYSTEM,          // graded rubric: 0 irrelevant / 1 moderate / 2 highly; per-facet
        prompt: renderCandidates(query, candidates),
        schema,
      }).catch(() => null);
      return parseOrZero(out, candidates);     // judge-error → grade 0, never throw
    },
  };
}

// examples/fashion-search/eval-judge.ts
const golden = JSON.parse(readFileSync("evals/golden-queries-fashion-lk.json","utf8")).queries;
const res = await matcher.runEval(PROJECT, COLLECTION, {
  queries: golden, judge: makeLlmJudge(geminiGenerate), k: 10, relevanceFloor: 1,
  thresholds: { ndcgAtK: 0.60, nullRate: 0.10, constraintViolationRate: 0.0 },
});
console.log(res.aggregate, "pass=", res.pass);
process.exit(res.pass ? 0 : 1);   // CI gate
```

Attribution: the judge promotes `search-relevance.ts:41-90` (candidate facets + strict rubric) from binary to graded; metrics are standard; the golden set + objective `constraints` already exist in `evals/golden-queries-fashion-lk.json`.

## 8. Incremental Task Breakdown

| ID | Chunk | Files | Grounding | Acceptance criteria |
|----|-------|-------|-----------|---------------------|
| E1 | `metrics.ts`: `ndcgAtK`, `mrr`, hit@k, null-rate, constraint-violation (pure fns) | `core/eval/metrics.ts` | REQ-3, S5 | `test:eval-metrics` on fixtures returns known values |
| E2 | `judge.ts`: graded + facet `RelevanceJudge` from `GenerateFn`; promote `search-relevance.ts`; versioned | `core/eval/judge.ts` | REQ-2, REQ-5 | judge returns `0|1|2`+facets; judge-error → grade 0, no throw |
| E3 | Judge cache (key = sha1(version\|query\|text)); batch calls | `core/eval/judge.ts`, `db/` or `evals/.cache/` | REQ-8 | `test:eval-cache`: re-run issues 0 new generate calls |
| E4 | `run.ts` + `matcher.runEval`: per-query searchWithExplain → objective check → judge → metrics → aggregate(+byType) → artifact → thresholds→`pass` | `core/eval/run.ts`, matcher factory | REQ-1,3,7,9,10 | `test:eval-run` end-to-end on a seeded mini-catalog; artifact written |
| E5 | `calibrate.ts`: judge-vs-human P/R/F1/κ; refuse trust below F1 bar | `core/eval/calibrate.ts` | REQ-6 | `test:eval-calibrate` reports F1 on a labeled fixture; throws under min-labels |
| E6 | Runnable example over the 50-query golden set + CI gate exit code | `examples/fashion-search/eval-judge.ts` | REQ-10 | `bun examples/fashion-search/eval-judge.ts` prints metrics; exits nonzero below threshold |
| E7 | Wire as the gate that tunes parent-RFC G2 floor + G7 exponents; docs/CHANGELOG | parent RFC refs, `apps/docs/**`, `CHANGELOG.md` | parent REQ-27 | documented calibrated FLOOR + exponents replacing placeholders |

Sequencing: E1→E2→E3→E4 is the spine; E5 (calibration) and E6 (runner) follow; E7 closes the loop with the parent RFC. **This whole RFC is P0** — land it early so it can gate the parent RFC's other chunks.

## 9. Validation and Testing

### 9.0 Validation Contract
| ID | Source | Assertion |
|----|--------|-----------|
| REQ-1,3 | §3 | `runEval` returns per-query + aggregate Hit@K/nDCG/MRR/null-rate/violations |
| REQ-2,5 | §3 | judge graded+faceted+versioned |
| REQ-6 | §3 | calibration reports F1/κ; gates trust |
| REQ-7 | §3 | `pass` false when a metric < threshold |
| REQ-8 | §3 | cached re-run = 0 new judge calls |
| test:* | §9.1 | listed tests green |

### 9.1 Fail-to-Pass Tests (`packages/server/test/`)
- `test:eval-metrics` — `ndcgAtK`/`mrr`/hit@k on hand-computed fixtures.
- `test:eval-run` — seeded mini-catalog + 3 queries → expected metrics + artifact file written.
- `test:eval-cache` — second `runEval` over the same inputs/version issues 0 `generate` calls (spy).
- `test:eval-calibrate` — judge-vs-human fixture → expected P/R/F1; `<min` labels throws.
- `test:eval-gate-blocks-regression` — a deliberately worse `rankingPolicy` makes `pass=false`.
- `test:eval-constraint-objective` — a hit over `constraints.max_price` is counted as a violation **without** the judge.

### 9.2 Regression (Pass-to-Pass)
- Full `packages/server/test/*` (172/172 at `ad21a9a`); fashion smokes.

### 9.3 Validation Commands
```bash
bun test packages/server/test                      # incl. new eval-*.test.ts
cd examples/fashion-search && bun eval-judge.ts     # prints aggregate metrics; exit code = gate
ls evals/runs/*.json                                # artifact emitted
```

## 10. Security Considerations
- Judge sees product text + queries only (no secrets). Truncate `reason` strings in artifacts. No new network surface beyond the consumer's existing `generate`. Cache keys are content hashes (no PII).

## 11. Rollback and Abort Criteria
- Abort if: judge calibration F1 cannot clear the bar on the human set → the judge is not trustworthy; do not gate other work on its scores until the rubric/model improves (surface, don't bypass).
- Abort if: cached re-run still issues judge calls (REQ-8 broken) → cost blow-up; fix before CI adoption.
- Rollback: the harness is additive and read-only w.r.t. the index; removing `core/eval/*` and the example leaves search untouched. The grade cache is disposable.

## 12. Open Questions
- Q1: **Judge agreement bar to "trust" metrics — RESOLVED (research-backed).** The defensible bar is the **human ceiling**: strong LLM judges reach ~**85% agreement** with humans, matching human–human agreement (~81–82%) — Zheng et al., *"Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena"* (arXiv:2306.05685); see `docs/research/open-questions-literature.md` RQ3. **Cohen's κ is the primary metric** (chance-corrected; "substantial" κ ≥ 0.6), with **F1 ≥ 0.80** at `relevanceFloor=1` as a secondary binary check. Use **pointwise graded** judging (cheaper, order-independent, maps to nDCG) and **avoid same-family self-judging** (self-preference bias). Hand-label ~50–100 pairs from the golden set to calibrate. Configurable.
- Q2: **Grade cache: DB table vs file.** Tradeoff: DB matches `samesake_embed_cache` and survives across machines; file (`evals/.cache/`) is zero-infra and reviewable in git.
  **Proposal:** file-based JSON cache for now (no traffic, dev-loop tool); promote to a `samesake_eval_cache` table only if multi-machine CI needs it.
- Q3: **Judge ↔ G4 reranker unification — RESOLVED.** One `RelevanceJudge`: the G4 reranker calls `judge.grade` and **blends** the grade with RRF position (parent RFC REQ-13b, *not* sort-by-grade), the eval calls the same judge for metrics. Validated by Mastra (`MastraAgentRelevanceScorer`) and the RankGPT zero-shot result (`docs/research/open-questions-literature.md` RQ8). Shared rubric → shared calibration.
- Q4: **K and metrics/stratification — RESOLVED (research-backed).** Primary: **nDCG@10 and nDCG@20** (graded, the natural fit for 0/1/2 judge labels — Järvelin & Kekäläinen, *"Cumulated Gain-based Evaluation of IR Techniques"*, ACM TOIS 2002). Also track **Recall@50–100** to monitor first-stage/RRF health independent of the reranker, and **MRR** for known-item queries. **Stratify head/torso/tail** — by the golden set's existing `type` field now, by query-frequency tiers once query logs exist. See `docs/research/open-questions-literature.md` RQ7.
