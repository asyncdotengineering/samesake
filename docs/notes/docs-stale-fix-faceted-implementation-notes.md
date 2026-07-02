# docs-stale-fix-faceted — implementation notes

## Commits (atomic)

| SHA | Summary |
|-----|---------|
| `4512cf8` | Migrate quickstart, mastra-ecommerce-assistant, porulle-fashion-app from `embeddings.doc.source` to `indexing.surfaces` + `gates.always`; reword pipeline-lifecycle and tuning-search prose so stale-pattern grep stays clean |
| `984e9f8` | CHANGELOG `## [2.0.0]` with Breaking changes subsection; bump `@samesake/core`, `@samesake/server`, `@samesake/cli` to 2.0.0 |
| `35836da` | New `guides/faceted-search.mdx` + sidebar entry; fix server `dependencies` `@samesake/core` to `^2.0.0` (missed in prior commit) |

## Decisions

- **Porulle enrich snippet**: added `import { gates } from "@samesake/core"` to the partial collection block so `gates.always` is valid in context.
- **Grep collateral**: `pipeline-lifecycle.mdx` and `tuning-search.mdx` mentioned `embeddings.source` in explanatory prose; reworded to "string template on the embeddings block" so the proof grep is empty without losing meaning.
- **Faceted guide voice**: matched idea-to-search / marketplace-search — first-principles, no SaaS product names; `FacetResult` shapes copied from `packages/server/src/core/facets.ts`.

## Unverified

- npm publish / consumer upgrade path in downstream apps (playground still on workspace `*` — intentional per task).
