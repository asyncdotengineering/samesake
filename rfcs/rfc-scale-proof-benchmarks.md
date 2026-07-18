# RFC: Scale-proof benchmarks — 10k/100k/1M sweep, published curve, adoption playbook

**Category:** New Feature (eval/bench infrastructure)
**Author:** Claude Fable 5 (session 2026-07-16, issue triage)
**Date:** 2026-07-16
**Status:** Draft
**Reviewers:** mithushancj
**Related:** GitHub issue [#88](https://github.com/asyncdotengineering/samesake/issues/88) §2 + good-to-haves · `BENCHMARKS.md` (all figures at 4,555–5,052 docs) · `packages/server/src/core/eval/run.ts` (harness) · `docs/stage-fit-audit-and-iron-out-plan.md` ("100k–1M fit comfortably" — currently a projection) · `docs/architecture/full-scale-fashion-search.md` (controlled-VM bake-off pattern) · baseline SHA `02af1f8`

---

## 1. Problem Statement

Every published number is at 4,555–5,052 docs (`BENCHMARKS.md:20-58`). Issue #88: "Postgres FTS +
pgvector behave very differently across two orders of magnitude — HNSW recall/`ef` tradeoffs,
planner flips, index-build time and memory, autovacuum pressure — so confidence at production scale
is currently a **projection, not a measurement**." The repo's own audit claims 100k–1M "fit
comfortably" (`docs/stage-fit-audit-and-iron-out-plan.md:18`) with no measurement behind it. For an
index, "does ranking quality and tail latency hold as the corpus grows 20–200×?" is the
load-bearing adoption question.

Success:

- A reproducible **scale sweep** runs the same golden queries + judge against synthetic corpora at
  10k / 100k / 1M docs and reports per-scale nDCG@10, p50/p95/**p99** latency, ingest throughput,
  and index-build time + memory.
- The curve is **published in `BENCHMARKS.md`** so an adopter reads confidence at their target size.
- A **scale/adoption playbook** turns the data into guidance: corpus size → recommended `efSearch`
  / HNSW `m` / `ef_construction` → expected recall + latency band.
- The sweep is re-runnable as a gate before ranking/index changes ship (relative-degradation
  thresholds), not a one-off report.

### 1.1 Non-Goals / Out of Scope

- Non-goal: fixing anything the sweep finds (planner flips, index tuning defaults) — findings
  become their own issues; this RFC builds the measurement.
- Non-goal: multi-tenant scale (many scopes × docs) — single-scope corpus first; a scoped
  dimension is a natural follow-up axis.
- Non-goal: enrichment-quality evaluation at scale (enrichment accuracy has its own gate,
  `BENCHMARKS.md:75-101`); the sweep synthesizes enriched attributes.
- Non-goal: >1M docs. The audit places the HNSW-in-RAM wall ~10M×1536d; 1M covers the stated ICP
  (100k+ launch) with headroom.
- Removed: the formerly-deferred BM25-leg grid point — BM25 was dropped 2026-07-18
  (`rfcs/rfc-bm25-lexical-leg.md` §0); the sweep grid measures the shipped `ts_rank_cd` lexical leg
  only.

## 2. Background

**What exists.** The eval core (`packages/server/src/core/eval/run.ts:164`) already does golden
queries → `searchWithExplain` → ESCI judge (family-separation enforced, `judge.ts:101`) → metrics
(`ndcgAtK`, `mrr`, `hitAtK`, `nullRate`, constraint violations, per-channel attribution) →
timestamped artifact in `evals/runs/` → threshold gates. `SearchOpts.efSearch` is a per-query dial
(clamped 10–1000 → `SET LOCAL hnsw.ef_search`, `search.ts:513-517`). What is missing is (a) a
corpus at scale, (b) a runner that sweeps sizes × dials and captures latency percentiles +
build-time, (c) HNSW **build** params as config (today pgvector defaults m=16/ef_construction=64,
no `WITH (...)` emitted — `collections-schema-gen.ts:328-338`), and (d) the published curve.

**The label problem, learned once already.** `BENCHMARKS.md:7` post-mortem: keyword-snapshot
labels misjudge ranking changes. The sweep therefore reuses the **hand-graded golden queries**
(`evals/golden-queries-fashion-lk.json`, 55 queries) plus the unbiased `bench-retrieval.ts`
fixtures, with the LLM judge for unlabeled hits — not synthetic labels.

**The corpus-realism problem.** nDCG at 1M is only meaningful if distractors are as confusable as
real inventory, and HNSW recall is only meaningful if the vector space has real cluster geometry.
Random vectors are trivially separable; real embeddings for 1M synthetic docs cost money and rate
limits. §2.2 picks a hybrid.

### 2.1 Terminology

- **Seed corpus:** the real enriched LK fashion corpus (~5k docs, real `gemini-embedding-2`
  vectors) used as the generative source.
- **Filler docs:** synthetic products whose vectors are perturbations/interpolations of seed
  vectors — same cluster geometry, no embedding-API cost.
- **Anchor set:** docs that golden queries are graded against (seed docs carry their grades).

### 2.2 Alternatives Considered

- **Alt A — real embeddings for all 1M docs:** most faithful. Rejected as default: ~100M tokens
  through the embed API per rebuild (cost is tolerable once, but the sweep must be cheap to re-run
  as a gate); rate limits make a rebuild an overnight job. Kept as a one-off calibration run if
  Alt B's parity check fails.
- **Alt B — vector-space augmentation (chosen):** filler vectors = `normalize(v_a + α(v_b − v_a) + ε)`
  between same-category seed pairs, α∈[0.2,0.8], ε small Gaussian; filler text = template-expanded
  seed attributes (brand/color/size/price swaps from per-category pools). Validated by a **parity
  gate**: at 10k, a corpus of 5k real + 5k augmented must reproduce nDCG@10 and HNSW recall@150
  within ±2% of a 10k all-real corpus (one-time real-embed spend at the smallest scale).
- **Alt C — public dataset (e.g. Amazon ESCI products):** real text at scale. Rejected: different
  schema/enrichment shape, no LK-fashion golden-query compatibility, and licensing friction for a
  committed fixture; the golden set would need regrading from scratch.
- **Alt D — pgbench-style synthetic latency-only sweep (no relevance):** answers the tail-latency
  question but not "does ranking quality hold", which is half of issue #88's ask. Rejected as
  insufficient alone; its latency methodology is absorbed here.

### 2.3 Drawbacks and Tradeoffs

- Augmented fillers can under-represent adversarial near-duplicates; the parity gate bounds but
  does not eliminate this. Mitigation: 10% of fillers are near-clones of anchors (α<0.1) to keep
  the confusable-neighbor pressure honest.
- 1M-doc runs need a dedicated Postgres with known resources; laptop numbers are noise. The sweep
  pins a machine profile (§5.4) and stamps it into artifacts. Absolute latency is only comparable
  within a profile; nDCG is comparable everywhere.
- Committed artifacts grow `evals/runs/`; corpora themselves are generated, never committed.

## 3. Strict Requirements

- REQ-1: A deterministic corpus generator produces 10k/100k/1M-doc corpora from the seed corpus +
  a seed integer; same inputs → byte-identical corpus (embeddings included).
- REQ-2: The augmentation parity gate exists and passes before any published number: 10k
  real-vs-augmented nDCG@10 within ±2% absolute and HNSW recall@150 (vs exact scan) within ±2%.
- REQ-3: The sweep runner executes, per scale × config-point: full golden-query eval (nDCG@10 +
  existing metrics) and a latency phase (≥500 timed queries, warm; report p50/p95/p99 wall-clock,
  plus cold-start noted separately). Config-points minimally: efSearch ∈ {40, 100, 200, 400} at
  default HNSW build params, plus one tuned build-param point at 100k+ (m=24, ef_construction=128).
- REQ-4: The runner records ingest throughput (docs/sec through embed→index, enrichment
  synthesized) and HNSW index-build wall-clock + peak memory (`maintenance_work_mem`-bound) per
  scale.
- REQ-5: `CollectionEmbeddingDef` accepts optional `hnsw?: { m?: number; efConstruction?: number }`
  emitted as `WITH (m=..., ef_construction=...)` on the embedding index — required for the
  playbook to be actionable. Omitted → today's DDL byte-identical.
- REQ-6: Artifacts land in `evals/runs/scale-<size>-<ts>.json` with machine profile, pgvector
  version, config-point, and all metrics; a summary table is generated for `BENCHMARKS.md`
  ("Scale sweep" section) by a script, not by hand.
- REQ-7: Re-run-as-gate mode: given a prior artifact set as baseline, the runner fails (non-zero)
  when nDCG@10 at any scale drops >0.02 absolute or p99 regresses >25% on the same machine
  profile.
- REQ-8: `docs/scale-playbook.md` states, per corpus size: recommended efSearch/m/ef_construction,
  measured recall + latency band, index-build time, and ingest-throughput sizing guidance —
  every number traceable to a committed artifact.

## 4. Interface Specification

### 4.1 Corpus generator

- **Location:** `evals/scale/generate-corpus.ts`
- **Signature:** `generateCorpus(opts: { seedDir: string; size: 10_000 | 100_000 | 1_000_000; seed: number; outDir: string }): Promise<CorpusManifest>`
- **Behavior:** loads seed docs + vectors; emits JSONL shards of `{ id, data, enriched, embedding }`
  (fillers flagged `synthetic: true`) + a manifest (counts, seed, category distribution, checksum).
- **Error cases:** seed corpus missing/undersized (<1k docs) → hard error; size not in the
  supported set → error (arbitrary sizes deferred).

### 4.2 Sweep runner

- **Location:** `evals/scale/run-sweep.ts`
- **Signature:** CLI — `bun evals/scale/run-sweep.ts --size 100k --config efSearch=200 [--baseline evals/runs/scale-100k-<ts>.json] [--skip-ingest]`
- **Behavior:** provisions collection (apply), bulk-ingests shards (timed), builds/validates
  indexes (timed via `pg_stat_progress_create_index` polling + wall-clock), runs eval phase then
  latency phase, writes the artifact; with `--baseline`, applies REQ-7 gates.
- **Error cases:** judge family-separation violations propagate (existing `assertJudgeFamilySeparation`);
  DB out of disk/mem → fail with the psql error and the machine-profile hint.

### 4.3 HNSW build params

- **Location:** `packages/sdk/src/types.ts` (`CollectionEmbeddingDef`), `packages/server/src/core/collections-schema-gen.ts:328-338`
- **Signature:** `hnsw?: { m?: number; efConstruction?: number }` (validated ranges: m 4–64,
  efConstruction 32–512, efConstruction ≥ 2·m per pgvector docs)
- **Behavior:** emitted into the HNSW index DDL; changing values on an existing collection is a
  destructive index rebuild (documented, mirrors `language`).

### 4.4 Recall probe

- **Location:** `evals/scale/recall.ts`
- **Signature:** `annRecallAtK(ctx, table, queries: number[][], k: number, efSearch: number): Promise<number>`
- **Behavior:** for sampled query vectors, compares HNSW top-k ids against exact
  (`enable_indexscan=off` sequential) top-k; returns mean overlap. Used by the parity gate (REQ-2)
  and playbook recall bands.

## 5. Architecture and System Dependencies

### 5.1 Structural Changes
- New `evals/scale/` (generator, runner, recall probe, BENCHMARKS table emitter).
- `packages/sdk/src/types.ts` + `collections-schema-gen.ts` — REQ-5 knob.
- `BENCHMARKS.md` — generated "Scale sweep" section; `docs/scale-playbook.md` — new.

### 5.2 Service and Library Dependencies
- Embedding API only for: seed corpus (already embedded) + the one-time 10k parity run
  (REQ-2). Judge API for eval phases (cached per query/result-set hash as today).

### 5.3 Data and Schema Changes
- Generated corpora live outside git (`evals/scale/.corpora/`, gitignored). Artifacts committed
  via the existing `evals/runs/` allowlist. No production schema changes beyond REQ-5.

### 5.4 Network and Performance Considerations
- **Pinned machine profile:** a dedicated Postgres VM (Fly, per platform rules: single
  `shared-cpu` class machine is too small for 1M×1536d HNSW-in-RAM — use a `performance-2x`/8GB
  spike machine, `auto_stop_machines = "stop"`, destroyed after the run; this is a spike test,
  never always-on). Profile (vCPU/RAM/disk, `shared_buffers`, `maintenance_work_mem`,
  `max_parallel_maintenance_workers`) stamped into every artifact.
- 1M ingest budget: batch upserts + `COPY`-style paths where available; target < 4h wall-clock
  end-to-end so the sweep is re-runnable per release.

## 6. Pseudocode

```
FUNCTION runSweep(size, configPoint, baseline?):
    corpus = generateCorpus(seedDir, size, seed=42)         # deterministic (REQ-1)
    apply(collection with configPoint.hnsw)
    t0 = now(); bulkIngest(corpus.shards); ingestDocsPerSec = size / (now()-t0)
    buildStats = timeIndexBuilds()                          # wall-clock + peak mem (REQ-4)

    FOR efSearch IN configPoint.efSearchGrid:
        eval   = runEval(goldenQueries, {efSearch})         # existing harness → nDCG@10 etc.
        recall = annRecallAtK(sampledQueryVecs, 150, efSearch)
        lat    = timedQueries(mixedQuerySet, n=500, {efSearch})   # p50/p95/p99 warm

    artifact = { machineProfile, pgvectorVersion, size, configPoint,
                 ingestDocsPerSec, buildStats, perEf: {eval, recall, lat} }
    write(evals/runs/scale-<size>-<ts>.json)

    IF baseline:
        FAIL IF any(ndcg10 < baseline.ndcg10 - 0.02)        # REQ-7
        FAIL IF sameProfile AND p99 > baseline.p99 * 1.25

FUNCTION parityGate():                                       # REQ-2, runs once before publishing
    realCorpus = embed(10k synthetic texts, real model)      # one-time spend
    augCorpus  = generateCorpus(size=10k)                    # 5k real + 5k augmented
    ASSERT |ndcg10(real) - ndcg10(aug)| <= 0.02
    ASSERT |recall150(real) - recall150(aug)| <= 0.02
```

## 7. Code Blueprint

```ts
// evals/scale/generate-corpus.ts
export async function generateCorpus(opts: GenOpts): Promise<CorpusManifest> {
  const seeds = await loadSeedDocs(opts.seedDir); // {data, enriched, embedding}[]
  const rng = mulberry32(opts.seed);
  const byCategory = groupBy(seeds, (s) => s.enriched.category);
  const out = shardWriter(opts.outDir);
  for (const s of seeds) out.write({ ...s, synthetic: false });
  for (let i = seeds.length; i < opts.size; i++) {
    const cat = weightedPick(byCategory, rng);
    const [a, b] = pickPair(cat, rng);
    const alpha = i % 10 === 0 ? 0.05 + rng() * 0.05 : 0.2 + rng() * 0.6; // 10% near-clones
    const vec = l2Normalize(lerp(a.embedding, b.embedding, alpha).map((x) => x + gauss(rng) * 0.01));
    out.write({ id: `syn_${i}`, synthetic: true, embedding: vec, ...templateExpand(a, b, rng) });
  }
  return out.finish({ seed: opts.seed, size: opts.size });
}
```

```ts
// packages/server/src/core/collections-schema-gen.ts (HNSW DDL, REQ-5)
const h = embDef.hnsw;
const withClause = h ? ` WITH (m = ${h.m ?? 16}, ef_construction = ${h.efConstruction ?? 64})` : "";
statements.push(
  `CREATE INDEX IF NOT EXISTS ${embIdx} ON ${table} USING hnsw (embedding halfvec_cosine_ops)${withClause}`
);
```

## 8. Incremental Task Breakdown

| ID | Chunk | Files | Grounding (REQ/test) | Acceptance criteria |
|----|-------|-------|----------------------|---------------------|
| C1 | HNSW build-param config knob (inert by default) | `types.ts`, `collections-schema-gen.ts` | REQ-5, test:hnsw-ddl | Omitted → DDL byte-identical; set → WITH clause emitted; ranges validated |
| C2 | Deterministic corpus generator + manifest | `evals/scale/generate-corpus.ts` | REQ-1, test:corpus-determinism | Two runs, same seed → identical checksums; category distribution ≈ seed |
| C3 | Recall probe (ANN vs exact) | `evals/scale/recall.ts` | REQ-2, test:recall-probe | Known small corpus returns recall 1.0 at efSearch=1000 |
| C4 | Parity gate run (one-time real-embed 10k) | `evals/scale/parity.ts`, artifact | REQ-2, cmd:parity | Committed artifact showing both deltas ≤ 0.02; publishing blocked until green |
| C5 | Sweep runner: ingest timing, build timing, eval + latency phases, artifact schema | `evals/scale/run-sweep.ts` | REQ-3, REQ-4, cmd:sweep-10k | 10k run end-to-end on dev machine produces complete artifact |
| C6 | Baseline-gate mode (`--baseline`) | `run-sweep.ts` | REQ-7, test:gate-mode | Doctored worse artifact → non-zero exit naming the failed metric |
| C7 | 10k/100k/1M runs on pinned VM; commit artifacts | `evals/runs/` | REQ-3, REQ-4, cmd:sweep-all | Three artifacts, same machine profile, full grids |
| C8 | BENCHMARKS table emitter + published curve | `evals/scale/emit-benchmarks.ts`, `BENCHMARKS.md` | REQ-6 | Section regenerates identically from artifacts; hand-editing not required |
| C9 | Adoption playbook from the data | `docs/scale-playbook.md` | REQ-8 | Every recommendation cites an artifact; covers 10k/100k/1M rows |

## 9. Validation and Testing

### 9.0 Validation Contract

| ID | Source | Assertion |
|----|--------|-----------|
| REQ-1..8 | §3 | As stated |
| test:hnsw-ddl | §9.1 | WITH clause emitted only when configured |
| test:corpus-determinism | §9.1 | Same seed → identical corpus checksum |
| test:recall-probe | §9.1 | Probe returns 1.0 on exhaustive settings |
| test:gate-mode | §9.1 | Regression artifact fails the run |
| cmd:parity | §9.3 | Parity deltas ≤ 0.02 |
| cmd:sweep-10k / cmd:sweep-all | §9.3 | Complete artifacts at each scale |

### 9.1 Fail-to-Pass Tests
- `test:hnsw-ddl`, `test:corpus-determinism`, `test:recall-probe`, `test:gate-mode` (as above;
  all runnable without external APIs — generator/probe tested on stub vectors).

### 9.2 Regression Tests (Pass-to-Pass)
- `bun test packages/server` — C1 must not disturb existing schema-gen snapshots for collections
  without `hnsw`.
- Existing eval harness tests (`packages/server/src/core/eval`) untouched and green.

### 9.3 Validation Commands

```bash
bun evals/scale/generate-corpus.ts --size 10k --seed 42 && bun evals/scale/generate-corpus.ts --size 10k --seed 42 --out .b \
  && diff <(shasum evals/scale/.corpora/10k/*.jsonl) <(shasum .b/*.jsonl)          # determinism
bun evals/scale/parity.ts                                                          # REQ-2 gate
bun evals/scale/run-sweep.ts --size 10k                                            # dev smoke
bun evals/scale/run-sweep.ts --size 1m --baseline evals/runs/scale-1m-<prev>.json  # gate mode
bun evals/scale/emit-benchmarks.ts --check                                          # BENCHMARKS section in sync
```

## 10. Security Considerations

No new attack surface: generator/runner are offline dev tooling against a dedicated benchmark
database; no user input reaches SQL beyond existing parameterized search paths. Seed corpus stays
external (`FASHION_DATASET_DIR` provenance rules unchanged); generated corpora are synthetic and
gitignored.

## 11. Rollback and Abort Criteria

- Abort if: the parity gate (REQ-2) cannot be brought within ±2% after one augmentation-tuning
  iteration — synthetic-vector realism is then the wrong economy; escalate to Alt A (real-embed
  100k, cap the published sweep at 100k, state 1M as extrapolated) rather than publishing numbers
  built on unvalidated fillers.
- Abort if: 1M ingest exceeds ~8h on the pinned VM — the sweep stops being re-runnable; profile
  the ingest path first (that finding is itself a deliverable for issue #88).
- Rollback: all changes are additive tooling + one inert config knob; deleting `evals/scale/` and
  reverting C1 restores baseline exactly.

## 12. Open Questions

- Q1: Latency-phase query mix — golden queries only (relevance-realistic, but 55 queries cache
  warm quickly) vs a generated 500-query mix (statistically better tails, less realistic).
  **Proposal:** generated mix stratified by the golden set's type distribution
  (keyword/attribute/use-case/price/...), with NLQ cache disabled for the timed phase, plus the
  55 golden queries reported separately.
- Q2: Where does the pinned VM live — Fly spike machine per run vs a documented local-docker
  profile. Tradeoff: reproducibility-for-others vs zero cost. **Proposal:** Fly spike machine
  (created and destroyed per sweep, auto-stop enforced) as the *published* profile; local docker
  profile supported for development smoke at 10k.
- Q3: Should p99 be a hard CI gate (REQ-7) or report-only at first? Tail latency on shared
  runners is noisy. **Proposal:** hard gate only in `--baseline` mode on matching machine
  profiles; report-only otherwise.

## 13. Review findings (2026-07-18 validation pass)

Citations verified against `02af1f8`: all `BENCHMARKS.md` figures are indeed at 4,555–5,052
docs; the audit's "100k–1M fit comfortably" is a citation-level projection with no measurement;
`efSearch` clamps 10–1000 via `SET LOCAL` (`search.ts:514-517`); HNSW DDL emits no `WITH`
clause (`collections-schema-gen.ts:328-338`); the golden set has 55 queries (the "50" in
`BENCHMARKS.md` refers to the historical parity harness). Issue #88 §2 is quoted accurately —
but note it is a self-authored audit by the repo owner, not third-party demand. Findings
execution MUST address:

- **F1 — filler text and filler vectors are decoupled (Alt B), and the eval phase feels it.**
  A filler doc's vector is an interpolation of two seed vectors, but its text is a template
  expansion — the vector is NOT the embedding of the text. The lexical leg retrieves fillers by
  text while the dense leg retrieves them by an unrelated-to-that-text vector, and the LLM judge
  grades the TEXT of whatever surfaces. Hybrid-fusion nDCG on such a corpus partially measures
  an artifact. The 10k parity gate (REQ-2) is the right control and may pass anyway (graded
  anchors dominate the metric) — but tighten the generator: template-expand text from the SAME
  seed pair (a,b) being interpolated, swapping only attributes consistent with the mix, so
  text-vector divergence is bounded. If parity still fails, that divergence is the first
  suspect. HNSW recall + latency numbers are unaffected (vector-geometry-only).
- **F2 — VM sizing is tight.** 1M × 1536d halfvec ≈ 3.1 GB of vector data + HNSW graph
  (m=16 → roughly 1–2 GB) + heap + `maintenance_work_mem` for the build. A `performance-2x`/8GB
  machine is borderline for the m=24/ef_construction=128 tuned point (index build may spill or
  OOM); use 16 GB for the 1M runs and record `maintenance_work_mem` in the profile. Fly
  platform rules (single machine, auto-stop, destroy after run) are honored by §5.4 as written.
- **F3 — latency-phase honesty requires more than disabling the NLQ cache.** Q1's proposal is
  right; also disable/flush the search result cache, report the embed-query API call time
  separately from Postgres time (at 1M the interesting tail is the DB, and a shared-API
  latency spike would pollute p99), and pin `hnsw.iterative_scan` state per config-point since
  it changes filtered-query behavior.
- **F4 — judge cost control.** The eval phase at 3 scales × ≥5 config-points re-judges only
  unlabeled hits (cache per query/result-set hash) — but at 1M the result sets will be
  dominated by unjudged synthetic fillers on every config-point change. Budget this (grades for
  synthetic docs are judge calls too) or grade fillers as a family (`syn_*` prefix) with the
  judge's family-separation guard verified to accept them.
- **F5 — REQ-5 collides with the multi-aspect RFC's C2.** Both RFCs touch the embedding-index
  DDL emit site. Land REQ-5 (the `hnsw` knob) first — it is inert and snapshot-locked — and
  rebase the aspect RFC's per-aspect index emission on top, so the `WITH` clause applies per
  aspect column.
- **Verdict: SOUND and worth doing** — it measures the load-bearing adoption question with the
  existing harness, and Alt B's economics are right. Conditional on F1's generator tightening
  and F2's VM bump; the abort criterion (escalate to real-embed 100k, state 1M as extrapolated)
  is the correct fallback and should be kept.
