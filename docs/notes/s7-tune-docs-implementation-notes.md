# S7 tune + docs — implementation notes

## Decisions

- **No fabricated calibration:** `GEMINI_API_KEY` absent in this environment. Kept `FASHION_CONFIDENCE_FLOOR = 0.5` and `relevanceExponent` default `1` unchanged; documented sweep procedure in `guides/eval-gate.mdx`.
- **Eval gate location:** New dedicated page (`eval-gate.mdx`) rather than only extending `tuning-search.mdx` — procedure is long and CI-specific; tuning guide links to it.
- **Integration doc pattern:** Minimal `indexing.surfaces` + `gates.always`-style inline gate (title check) replacing removed `embeddings.source` — matches `build-a-search-experience.mdx` end state.
- **`fashionRerank` lives in `@samesake/server`** (not sdk template) per S5 implementation notes — docs reference server export.

## Root cause addressed

E7/C14 closed the loop: placeholders are explicitly marked pending; `eval-judge.ts` dry-run + live gate behavior documented; lifecycle + CHANGELOG cover S0–S6 gaps G1–G8.

## Deviations

- RFC E7 acceptance cites "documented calibrated FLOOR" — satisfied as **documented procedure + pending placeholders**, not fabricated numbers (hard constraint from brief).

## Commits

- `b679f68` — placeholder comments on FASHION_CONFIDENCE_FLOOR + relevanceExponent
- `20a8312` — pipeline-lifecycle.mdx + eval-gate.mdx + sidebar
- `808c78e` — tuning-search + eval-from-snapshots updates
- `0091f77` — integration guides + porulle-fashion-app indexing DSL
- `1b3d993` — CHANGELOG [Unreleased] G1–G8
