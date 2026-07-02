# S2 eval harness — implementation notes

## Decisions
- **File-based judge cache** at `evals/.cache/grades.json` (RFC Q2): zero-infra, matches dev-loop; key = `sha1(judgeVersion|query|candidate.text)`.
- **Playground promotion**: `search-relevance.ts` now delegates to `makeLlmJudge` (graded ≥1 kept) instead of duplicating binary rubric.
- **Threshold gate**: `constraintViolationRate` aggregate = mean per-query violation count (threshold `0` = no violations tolerated on average).

## Root causes fixed
- Eval-cache test asserted `calls === 0` on re-run; correct assertion is total calls unchanged (`1`), not zero.

## Unverified
- Live 50-query E6 run: `GEMINI_API_KEY` absent in this environment — dry-run only.

## Commits (E1–E6)
Land in order on `feat/pipeline-integrity-s0-s7`.
