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
- Candidate cache identity sorts field/value/count tuples so candidate-set changes cannot reuse a seven-day parse; aspect descriptions remain part of the existing key.
- Grounding is fail-closed only on the live retrieval path, where `retrieve` supplies the scoped vocabulary lookup; isolated parser tests may inject grounding decisions directly.
- Successful short parses now route all configured intent aspects normally; only degraded, disabled, or empty-text parsing takes the first-aspect fallback.
- `lexicalText` is selected once from a non-degraded `lexical_query` and is the sole FTS/phonetic parameter; raw `q` remains the fallback.
- Progressive relaxation probes only derived soft fields, excludes explicit fields, orders by standalone match count then field name, and retries one dropped field at a time. The ranked SQL now reports pre-floor and post-floor candidate counts so relevance-floor thinness is never relaxed.
- Typed rewrite recovery resolves once before the finishers. It uses the stage cache, rejects malformed/duplicate/original proposals, cosine-validates the first qualifying proposal, retries once with the original parsed constraints, and accepts only a strict post-cutoff hit improvement. A retry never calls NLQ again.
- The public trace records deterministic filters, grounding decisions, ordered relaxation steps, effective filters, and the rewrite record; search and explain receive the same resolved execution metadata.
- C9 runner changes add an offline fixture path and phase-tagged latency/adversarial artifacts. Live capture runs were intentionally not executed per scope.

## Verification record

- C1 focused DDL, scoped lifecycle, embed-index, and remove-document tests pass.
- Server typecheck passes after C1.
- C2/C3 NLQ and grounding tests pass, including scoped SQL shape, missing-table failure-closed behavior, custom schema candidate injection, cache invalidation, normalization, negation, ambiguity, and deterministic precedence.
- C4/C5 NLQ, routing, search-mode, multilingual, and hybrid lexical-correction tests pass; server typecheck remains clean.
- C6 live-shaped hybrid fixture passes: occasion is probed as less selective than color, dropped first, and the retry returns three red candidates without relaxing explicit filters.
- C7 focused rewrite and cutoff/hybrid/explain/observability regressions pass; the rewrite fixture proves one proposal call, one retry, and no second NLQ call.
- C8 trace-grounding coverage passes for deterministic source, grounded-value shape, effective filters, and search/explain serialization.
- C9 offline smoke `bun --cwd examples/fashion-search eval-search.ts --fixture --phase=grounded-v2` passes; no live capture was run.
- The full server regression passes at 316 tests / 0 failures. The two test-only timeout alignments cover RFC-added cold query work and existing Postgres hook contention under Bun's concurrent suite runner; no assertions were relaxed.
