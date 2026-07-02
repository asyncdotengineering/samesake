# search-intent-similar — scratchpad

Goal: search frame robust to intent filtering + NOT keyword-biased; "similar" = genuine
visual + semantic similarity, not keyword matching. Change any packages as needed.

## Evidence (already gathered, this session)
- repro-similar.ts: default RRF (fts=1,cos=1) → keyword-decoy tee ranks #1 for "black dress";
  text-cosine is itself word-contaminated. Fix needs fts≈0 for similarity.
- eval-configs-lk.ts: intent OK at default(0.67); fts=0 regresses exactness (q3 1.0→0.33);
  fts=0.3 tiebreaker holds intent (0.67) AND recovers q3. keyword-only craters use-case intent.
  ⇒ no single global weight serves both ⇒ MODE is required.
- shouldSkipNlq: ≤2-token text queries skip NLQ → intent rides channels there.
- Framework already has image-only weighting (agent-tools imageOnlyWeights, fashion buildWeights)
  but the TEXT path is keyword-biased and there is no text "similar".

## Design (final)
`mode: "intent" | "similar"`, resolved = opts.mode ?? (image ? "similar" : "intent").
parseSearchWeights(def, override, mode, hasImage) adjusts the BASE (overrides still win):
- !hasImage → zero image-kind space segment weights (cross-modal text = noise; H3 guard)
- similar → fts = 0
- intent  → if cosine>0: fts = min(fts, 0.3*cosine) [tiebreaker]; if !hasImage: spaces leg = 0
KEYWORD_TIEBREAK = 0.3 (eval-backed).

## Backlog
- [ ] core: export SearchMode; add to types
- [ ] server: SearchOpts.mode; thread into retrieve + parseSearchWeights
- [ ] server: parseSearchWeights mode transform + imageSpaceNames helper
- [ ] server: findSimilarProducts → mode "similar" (findProducts optional mode param)
- [ ] server: HTTP search/explain bodies accept mode
- [ ] example: enable visual space by default (mode makes it intent-safe); pass modes in evals
- [ ] unit test: parseSearchWeights mode transform
- [ ] build core+server dist (examples resolve dist, not src)
- [ ] verify: repro-similar (similar mode fixes decoy), eval-configs-lk (intent mode ≥ default),
      visual image-similarity demo, bun test, typecheck
- [ ] docs: README + docs site mode section

## Doing
(none)

## Done
- [x] core: export SearchMode
- [x] server: SearchOpts.mode; thread into retrieve + parseSearchWeights; pure-image cosine drop
- [x] server: parseSearchWeights mode transform + imageSpaceNames helper
- [x] server: findSimilarProducts → mode "similar"
- [x] server: HTTP search/explain bodies accept mode + result-cache key includes mode
- [x] example: visual space ON by default; dropped redundant style space (HNSW dim fix); modes in evals
- [x] unit test: parseSearchWeights mode transform (7 pass)
- [x] build core+server dist
- [x] verify: repro-similar (similar fixes decoy), repro-visual (visual buries text decoy),
      eval-configs-lk (intent mode == old default), bun test 157/0, typecheck clean
- [x] docs: README modes section + spaces note; CHANGELOG
- [x] cleanup: dropped throwaway DB projects (repro_*, lk_cfg*)
