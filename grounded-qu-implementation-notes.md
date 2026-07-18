# Grounded query understanding implementation notes

## Goal

Implement RFC v2 C1–C8 and C9 runner changes on `feat/grounded-qu`, with no live embedding or LLM calls and no fashionparity corpus database changes.

## Load-bearing assumptions

- The RFC is authoritative; the only deliberate scope deviation is C9 runner changes without live baseline, candidate, or latency captures.
- Existing local test database helpers and stub embed/generate functions are the verification boundary for implementation work.
- The base branch is `main` at the repository state present when this branch was created; no source changes are made outside the RFC chunk file lists, their tests, and required handoff artifacts.

## Execution line

C1 → C2/C3 → C4 → C5; C5/C6 → C7; C2/C3/C6/C7 → C8; C9 runner changes last; then full verification and proof.

## Decisions and deviations

- C1 treats filterable scalar `text` fields as open vocabulary; enum and array-enum fields remain governed by their declared values.
- Vocabulary counts are maintained by deleting singleton rows before decrementing larger counts, which preserves the `count > 0` invariant during visibility/status transitions.
- The existing no-open-vocabulary system-column DDL hash remains `b91e0a8053498afd693ced9e43bb8519a52cbf3ae723e372e07fab2d87abc53c`.

## Verification record

- C1 focused DDL, scoped lifecycle, embed-index, and remove-document tests pass.
- Server typecheck passes after C1.
