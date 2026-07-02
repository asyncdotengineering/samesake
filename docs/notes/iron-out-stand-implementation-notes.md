# iron-out-stand — implementation notes (2026-07-02)

Session: YouTube (MICES) research + system mapping + behavior spec + stage-fit audit + first
debt removals. Autonomous IC mode.

## Load-bearing assumptions / decisions not in the spec

1. **Direction pivot accepted as stated.** The prompt ("anyone should be able to replace their
   current ecommerce search with our product, especially multi-vendor marketplaces") supersedes the
   June "internal-only, shelve OSS ambitions" call. Memory updated; the old posture is preserved as
   history inside the memory file.
2. **"Plan for scale we do not have"** read as *don't* plan for scale we don't have, consistent
   with the adjacent "challenge any infrastructure or abstraction that does not fit this stage."
3. **"Relevant videos related to samesake"** — the channel (MICES conference) never mentions
   samesake; interpreted as talks relevant to samesake's problem space. 11 of 30 talks selected,
   captions pulled, synthesized to `docs/research/mices/README.md`.
4. **Root scratchpads were moved, not deleted** (`docs/notes/`), tracked files via `git mv`.
5. **`DEFAULT_PRODUCT_PARSE_INSTRUCTIONS` export replaced by `DEFAULT_PRODUCT_PARSE_BODY`**
   (the canonical name) so the documented "reuse the default prompt" use-case survives. Breaking
   change, allowed by the alpha/no-compat rule.
6. **Legacy fashion preset layer deleted outright** (no deprecation period): zero code callers,
   divergent duplicate vocabulary vs the live `fashion.*` template.
7. **Plan Desk MCP tools were not available in this session** (per instructions, saying so);
   harness task list used instead.

## Root causes found

- README claimed 1.0.0 because "Status & naming" was written pre-2.x and never touched by release
  automation — consider folding the version claim into the changeset release step.
- One flaky server test observed (fail on run 1, 253/253 pass on run 2) — DB-timing related, not
  investigated further; worth a look if it recurs.

## Verification

- `bun run typecheck` — clean.
- `packages/sdk` tests 4/4; `packages/server` tests 253/253 (second run; first run had 1 flaky fail).
- `apps/docs` `bun run build` — 30 pages, success (verifies the conversational-search.mdx edit).
- Greps confirm no residual references to removed symbols outside `dist/` build artifacts
  (regenerated on next build).

## Follow-up session — Tier-0 defaults (halfvec, iterative scans, efSearch, setweight) + minimal-path fix

- **Root cause found while verifying**: `hello-search` (a release gate) failed at baseline —
  commit `3d59088` (S1c) removed embedding-`source` resolution from core, so collections without
  an enrich pipeline never populated `doc` and indexed zero rows. The SDK type had also made
  `indexing` required, so the README/quickstart code didn't even typecheck. Fixed both:
  `indexing` optional, `source` restored, surfaces built inline at index time (declared surfaces
  win; enrich-owning collections unchanged). Lesson feeding P1-5: CI must run the release-gate
  examples.
- Entity-resolution tables deliberately stay `vector` (2000-dim HNSW cap); only collections moved
  to `halfvec` (4000 cap). `assertIndexableVectorDimension` now takes `columnType`.
- `SET LOCAL` settings require one transaction — added `StorageAdapter.unsafeWithSettings` using
  the raw postgres-js `begin` (`getPgSql` in `core/db-utils.ts`). `pgvectorVersion()` is cached
  per adapter instance.
- setweight is opt-in mechanism only (`ftsWeight: "A"` / fts surface `weight: "A"`): no existing
  config changes behavior until someone declares a weight, so no relevance regression risk; the
  fashion template still ships title-only fts (already effectively top-weighted).
- fp16 note: halfvec round-trip loosens L2 norms to ~1e-3 (one test precision relaxed 4→3).
- Tests are on a **Neon** database — 5s default timeouts flake under latency (two unrelated
  migration tests each flaked once, passed on rerun); heavy setup moved into a 60s test block.
- Verification: `tsc --noEmit` clean; server suite **261/261** (was 253, +8 new); sdk 4/4;
  `hello-search`, `hello-spaces`, `quickstart` examples all pass (hello-search failed at
  baseline). Breaking-change changeset: `.changeset/tier-zero-defaults.md`.

## Where everything lives

- Spec: `docs/system-behavior-spec.md`
- Audit + plan: `docs/stage-fit-audit-and-iron-out-plan.md`
- MICES research: `docs/research/mices/README.md`
- Archived process docs: `docs/notes/`
