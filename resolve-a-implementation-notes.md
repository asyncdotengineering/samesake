# resolve-a — Fellegi-Sunter resolve core (Cut 1)

## Goal restatement
Ship a pure, trainable F-S `resolve` module under `packages/enrich/src/resolve/`, additive only — no live path rewiring. Seed m/u reproduce baseline link decisions on the spike's decisive cases; a hand-written FIT model in tests documents the trainability lever.

## Decisions
- **seedModel m/u** = spike NAIVE profile (exact huge Bayes factor; else levels weak).
- **seedModel autoLink/suggest** = F-S Pr thresholds `0.5` / `0.1`, not the linear-blend scale (`cfg.autoLink` 0.9). Different units; mapping 1:1 would mis-band exact-key Pr≈0.75 as "suggest".
- **clusterByComponents** filters singletons (length > 1 only) so sub-tau pairs "yield none".
- **graphology** + **graphology-components** installed; used for connected components as specified.

## Not done (out of scope)
- Live cutover of `dedup.ts` / `cluster.ts` / match path
- m/u training loop (u-sampling / EM)
- Persisted incremental union-find (named as scale seam in doc-comment only)

## Verification
- typecheck, enrich 39, server 316, bom-quotation 19, neutrality 1, purity (no store symbols in resolve/)
