# Multi-aspect major implementation notes

## Restated goal

Implement the approved multi-aspect retrieval RFC on `feat/multi-aspect-major`: named embedding
columns, evidence-row MaxSim retrieval, NLQ aspect routing, per-aspect explain/eval attribution,
the grounded offline example, fashion configuration conversion, and complete spaces deletion.
Completion means C1-C8 and C10 are implemented and tested; C9's live fashion gate and latency
runs remain explicitly out of scope.

## Load-bearing assumptions

- Existing worktree edits to `rfcs/rfc-multi-aspect-retrieval.md` and
  `docs/stage-fit-audit-and-iron-out-plan.md` predate this task and remain untouched.
- The major-version deletion applies to every active spaces symbol in SDK/server core and its
  producers, consumers, fixtures, examples, and tests; unrelated historical changelog/research
  prose is not runtime surface.
- Single-key embedding behavior is preserved by retaining the first key's `embedding` column and
  legacy SQL/DDL branches; additional aspects use `emb_<name>`.
- Skip-NLQ and degraded parses use the first declared aspect only, per D1. Similar-mode text
  queries use all configured aspect weights; image-only queries use the visual aspect vector.
- C9 live-corpus gate, latency, and image-fixture parity runs are not executed in this branch.

## Decisions and deviations

This file is updated as implementation discovers concrete repository constraints. No compatibility
layer or silent workaround is permitted.
