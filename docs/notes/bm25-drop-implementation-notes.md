# BM25 drop implementation notes

## Restated goal

Remove BM25 from planned/future-facing repository documentation while preserving the RFC as an
explicit decision record, preserving the lexical A/B fixture as the regression gate, and adding
the public explanation page for issue #88. This is documentation-only; no code or archived
evidence is to be rewritten.

## Assumptions and decisions

- The docs framework exposes Markdown/MDX files by filesystem route plus frontmatter, so the new
  guide does not require a sidebar/config edit; those files are outside the requested scope.
- Existing untracked `docs/research/` and `rfcs/` content belongs to the user and is preserved.
- The historical RFC body and its §13 review findings remain unchanged except for the required
  status and new §0 decision block; old implementation details remain factual archive material.

## Execution line

1. Apply the six specified text edits and add the guide.
2. Run the allowlist and no-planned-work grep gates; inspect every result.
3. Build `apps/docs` with its declared `bun run build` script.
4. Record command output hashes in `.handoff/proof-bm25-drop.json`, then write the sentinel last.

## Verification notes

The allowlist grep returns exactly the eleven expected files: the decision RFC, its two RFC
cross-references, the roadmap, the two updated architecture/audit docs, the two factual/archive
docs, the research notes, the archived implementation notes, and the new guide. The line-based
no-planned-work filter still emits historical proposal lines inside `rfc-bm25-lexical-leg.md`
(including §13's preserved findings) and continuation lines of §0 cross-references; these are
intentional archive/decision-record material and not active plans. The non-RFC active docs contain
only dropped/decision/fixture wording after manual inspection.

The docs build generated `/guides/lexical-scoring/index.html` and completed successfully. The
handoff proof passed both normal and strict verification (`8 claims verified, 12 assertions
satisfied`). An unrelated `.gitignore` change adding `ROADMAP.local.md` was present during the
final reconciliation and was preserved.

## Deviations / blockers

- None.
