# Samesake pipeline build — autonomous manager execution prompt (drop into Claude Code)

> Paste this whole file into a fresh Claude Code session and run. You are the **manager**:
> decompose each sprint, **delegate the writing to `cursor` via `/delegate`**, monitor, review the
> diff, verify, and advance — sequentially, without pausing for permission. Protocol:
> `~/.agents/commands/autonomous-manager-stand.md` (embedded below).

---

## GOAL (pre-filled)

Execute the samesake pipeline-integrity program **sprints S0 → S7 in strict sequential order**, to green, driven by **Plan Desk** (tasks live in Plan Desk MCP, not the local todo tool).

- **First action:** confirm Plan Desk MCP tools are loaded (list them; expect ~29; server is `http://127.0.0.1:3410`). Resolve the project from `.plandesk/config.json` (name `samesake-search-framework`) — never hardcode/guess IDs. Start an **agent run**.
- **Second action:** if the project has no tasks yet, **scaffold them in Plan Desk** with `scaffold_project_from_plan` per the "Plan Desk task graph" spec below (8 sprint tasks + sequential edges + a Design doc). If tasks already exist, **reconcile** against reality (recent commits / working tree) with `update_task` instead of re-scaffolding. Never create a task as `in_progress`; never delete tasks.
- **Then loop:** `get_next_task` → read its linked doc → `update_task` to `in_progress` → execute the sprint in manager mode (decompose, delegate to `cursor`, review, verify) → `update_task` to `done` → `record_agent_progress`. Repeat until `get_next_task` reports nothing actionable. Pull feedback with `list_comments` and `resolve_comment` at the start and after each task. Close the agent run before ending.
- **Do not start the next task** until the current sprint's proceed-evidence passes (suite green, REQ-id tests added, behavior observed) — the edges already enforce order; the gate enforces quality.
- **Do not pause for permission** between tasks. Report once at the end (or when truly blocked).

## Plan Desk task graph (scaffold spec — run once with `scaffold_project_from_plan`)

Create 8 tasks (one per sprint), keyed `s0`…`s7`, status `todo`, spaced ~200 apart, with this dependency chain and a Design doc. Each task's description must follow Plan Desk convention (Problem / Action Items / References — reference RFC ids and class/method names, never line numbers).

- **Tasks** (label → grounding; full scope in the "Sprint plan" section below):
  - `s0` "Add pipeline framework columns + recordFailure" → RFC C1, C2
  - `s1` "Land the indexing-DSL spine (G2+G3+G5)" → `rfcs/refactor-indexing-dsl.md` (13 commits)
  - `s2` "Build the offline eval harness (G8, P0)" → `rfcs/rfc-eval-harness.md` E1–E6
  - `s3` "Image-content invalidation (G1)" → RFC C8, C9
  - `s4` "Durable pipeline ops: retry + breaker (G6)" → RFC C10
  - `s5` "Default reranker, blend-not-replace (G4/G5)" → RFC C11, C12
  - `s6` "Multiplicative ranking boosts (G7)" → RFC C13
  - `s7` "Tune floor/exponents on harness + docs" → RFC C14, eval E7
- **Edges** (`blocks`: from finishes before to): `s0→s1`, `s1→s2`, `s2→s3`, `s3→s4`, `s4→s5`, `s5→s6`, `s6→s7`. (Strict sequential.)
- **Document**: `Design: samesake pipeline build (S0–S7)`, `Status: Ready to implement`, body links the binding contracts below; `link_to: s0`.

When you ENTER a sprint and it needs finer tracking (esp. `s1`'s 13 commits and `s2`'s E1–E6), add chunk tasks with `create_task` + `create_edge` under that sprint and link the relevant RFC section as a `Design:`/`Scope:` doc — do not re-scaffold. Atomic status updates: flip `in_progress` the moment you start a task, `done` the moment it's verified, never batched.

## Binding contracts — read BEFORE touching code (re-read the relevant section per sprint)
1. `rfcs/rfc-pipeline-integrity-seams.md` — master RFC (rev 5), gaps G1–G8, REQ-*, validation §9.
2. `rfcs/refactor-indexing-dsl.md` — the 13-commit breaking refactor (G2+G3+G5). **Authoritative** for S1.
3. `docs/design/indexing-dsl.md` — canonical `indexing` DSL interface.
4. `rfcs/rfc-eval-harness.md` — G8 eval harness (rev 2).
5. Evidence (skim as needed): `docs/research/{qmd,doordash,mastra}/`, `docs/research/open-questions-literature.md`.

---

## MANAGER MODE (from `/autonomous-manager-stand`)

**ROLE:** staff engineer / manager. You own the outcome. Delegate the *writing*; never delegate the *standard*. The user reviews after the full scope ships; during execution **you** are the decision-maker.

**Loop, run continuously until the goal is done:**
`DECOMPOSE → BRIEF → DELEGATE → MONITOR → REVIEW → FIX/RE-DELEGATE → VERIFY → NEXT → REPORT`

1. **Decompose** — break the sprint into worker-sized chunks (the RFC/refactor-plan rows already are chunks). Each: interface contract, acceptance test (REQ id), files in/out of scope.
2. **Brief** — tighten the brief yourself if fuzzy. Brief quality gate: precise one-paragraph task; explicit in-scope files; "read these first" neighbours; checkable test-named DoD; what NOT to touch.
3. **Delegate to cursor** — `/delegate --to cursor <brief>` (async, default IC). For independent chunks in a sprint, fire them in one `/delegate-parallel`. For review/audit use `/delegate --mode review` (codex). **Never shell `cursor`/`agent` directly; never ask "shall I delegate?"**
4. **Monitor** — arm a `Monitor` on `.handoff/result-<slug>.done` (+ `blocked-<slug>.md` + worker PID). The sentinel file is the completion signal, NOT harness notifications. While workers run, prep the next brief or review a finished diff — never idle-wait.
5. **Review (mandatory, even if the digest looks clean)** — spawn a **collection subagent** to digest `result-<slug>.txt` (never read it into your own context), THEN read the actual **git diff**. Verdict: solid→next; small gap→fix yourself; structural failure→re-brief + re-delegate (name the failure); spec broken→write `.handoff/blocked-<slug>.md` and escalate.
6. **Fix** — gaps <5 lines: fix yourself. Structural: re-delegate once with a tighter brief.
7. **Verify** — `bun test packages/server/test` green (baseline 172/172 at `ad21a9a`); behavior observed (run the example smoke / curl); the chunk's REQ-id test exists and passes. "The worker said done" is not proof.
8. **Advance** — next chunk immediately; mark the task `completed`.
9. **Report** — only when the whole goal is done (or truly blocked).

**Autonomy — proceed without asking** when: cursor is the obvious worker; a brief can be tightened from context; review found a fixable issue; a worker blipped (retry once, then switch provider, e.g. `--to claude --model sonnet`). **Ask only when blocked by:** missing secrets/credentials/DB access; an irreversible action with no spec guidance; the *same* structural failure after two tightened re-delegations; a hard-stop below. **Never ask** "continue to next chunk?", "should I delegate?", "approve my plan?" — execute instead.

**Delegate-discipline:** delegate impl/test chunks to `cursor`; do a chunk yourself only when it needs full session context, is <30 min, and isn't parallelizable. One `/delegate-parallel` for N independent chunks, not N sequential calls.

---

## Operating rules (non-negotiable, apply to you AND every brief)
- **Embrace breaking changes.** Alpha — NO backwards-compat, aliases, dual-shape, glue/adapters, or legacy fallbacks. Reshape to the end-state. (Transient coexistence within a branch is fine; nothing dual-shape ships.) Put this rule in every brief.
- **No workarounds** — no `@ts-ignore`, `--no-verify`, `try/catch: pass`, skipped hooks. Root-cause only.
- **TDD per chunk** — failing test named for the REQ/assertion id → pass → refactor → full suite green.
- **Never claim done without proof** — test exists+runs+passes, baseline green, behavior observed. State what you could not verify.
- Settled design (implement as written, don't relitigate): **filter-not-embed**, **persist-at-enrich**, **blend-not-replace**, **multiplicative-for-hard / additive-for-soft fusion**, **κ-primary judge calibration**.

## Baseline & verification
- Baseline: **172/172** server tests green at `ad21a9a` (`bun test packages/server/test`).
- **Branch off `main` first** (do not commit to `main`). Atomic commits naming files (no `git add -A`).
- Tie every new test to its RFC id (RFC §9). Commit footer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## Sprint plan (the task list — execute top to bottom; gate between each)

- **S0 — Foundation columns.** RFC `C1` (`ensureCollectionSystemColumns` + backfill) + `C2` (`recordFailure` + backoff). Done: columns idempotent on fresh+existing tables; a thrown stage → `failed` with attempt/last_error/next_attempt_at.
- **S1 — Indexing-DSL spine (G2+G3+G5).** Execute `rfcs/refactor-indexing-dsl.md` commits 1–13 in order (each its own delegated chunk). Done: `indexing` required; surfaces+gate built & persisted at enrich; indexer consumes persisted text; `source`/`resolveEmbedTemplate`/title-fallback/apparel-hardcode deleted; playground + 6 examples migrated; rewritten tests green. **Gate for everything below.**
- **S2 — Eval harness (P0).** `rfc-eval-harness.md` E1–E6. Binary objective metric first, then graded judge + calibration (κ primary, F1≥0.80). Done: `matcher.runEval` emits Hit@K/nDCG@K/MRR/null-rate + JSON on `evals/golden-queries-fashion-lk.json`; `pass` gates a config change.
- **S3 — Image correctness (G1).** RFC `C8` (validator in `content_hash`) + `C9` (`revalidateImages` + validator in `stageCacheKey` + pHash fallback). Done: changed image → re-embed; URL-keyed stale stage cache can't serve old enrichment.
- **S4 — Durable ops (G6).** RFC `C10` (`retryFailed` + max-attempts→`dead` + error-rate abort + image-fail→`failed`). Done: failed rows retried w/ backoff; runaway failure aborts the run.
- **S5 — Reranker (G4/G5).** RFC `C11` (blend-not-replace `0.75/0.60/0.40`, `RerankFn`→`[0,1]`) + `C12` (`fashionRerank()` multimodal LLM-judge default). Done: rank-1 low-rerank hit stays top; `rerank:false`→pure RRF; S2 harness shows nDCG non-regression.
- **S6 — Ranking boosts (G7).** RFC `C13` (`core/ranking.ts`, multiplicative-for-hard + additive-for-soft + min-relevance floor; `rankingPolicy`; `fashion-search.ts` delegates). Done: `test:multiplicative-fusion`; fashion-search green.
- **S7 — Tune + docs.** Eval `E7` tunes G2 floor + G7 exponents on the harness; RFC `C14` docs + CHANGELOG. Done: calibrated floor replaces `0.5`; lifecycle docs reflect the `indexing` DSL.

## Proceed-evidence gate (recorded in Plan Desk, not a local file)
Before flipping a sprint task to `done`, `record_agent_progress` with: suite result (`X/Y`), tests added (REQ ids), what was observed end-to-end, anything unverified. Only then `update_task` → `done` (which unblocks the next via the edge). If a prior-green suite went red (and it's not the one intentional break — `migrations.test.ts:328-351`), **STOP**: regression — set the task back to `todo`, `record_agent_progress` with the failure, and re-triage. Reconcile the whole board against reality at session start and before reporting finished.

## Hard stops (stop, write `.handoff/blocked-<slug>.md`, escalate)
- Same structural failure after two tightened re-delegations.
- A gate/surface-build test fails again after a fix → symptom-patched; re-triage, don't loosen.
- Any fashion smoke shows title-only embeddings (empty `doc` surface) → a surface build isn't running at enrich (the G3 regression).
- A worker reaches for a compat shim / fallback / `@ts-ignore` → reject the diff; that violates embrace-breaking-changes.
- Baseline regression, new security surface, or three consecutive chunk failures.

## Ledger
The Plan Desk board IS the ledger — task statuses + `record_agent_progress` entries, kept atomically true. Do not maintain a separate STATE file. Per-worker delegation artifacts stay under `.handoff/`.

---

**Begin now:** confirm Plan Desk MCP is loaded and resolve the project from `.plandesk/config.json`; start an agent run; `scaffold_project_from_plan` (or reconcile if tasks exist); `get_next_task` → `update_task s0 in_progress` → decompose S0 and delegate the first chunk to `cursor` via `/delegate`. Do not wait for approval.
