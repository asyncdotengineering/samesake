# Roadmap

The goal: **the enrichment + fast-search toolkit anyone can replace their ecommerce search with —
especially multi-vendor marketplaces — with DX as the moat.** Postgres + pgvector only, two
containers in production, BYO models.

Canonical source with full reasoning and evidence:
[`docs/stage-fit-audit-and-iron-out-plan.md`](./docs/stage-fit-audit-and-iron-out-plan.md).

## P0 — correctness & honesty *(shipped)*

The product's claims are now true:

- ✅ Generic `removeDocuments` on every surface (in-process, HTTP, CLI)
- ✅ Filtered-recall eval, pgvector 0.8 iterative index scans, `halfvec` by default
- ✅ Vertical-neutral core (`shopSearch`; fashion is a template, enforced by a grep-gate test)
- ✅ Honest eval judge: 4-class ESCI rubric, judge/enrich model-family separation, content-hashed
  judge version, minted cross-family baseline
- ✅ One env contract: `SAMESAKE_DATABASE_URL` / `SAMESAKE_API_KEY`, no fallback aliases

## P1 — adoption path *(in progress)*

Remove every reason a greenfield adopter bounces:

- CI gate: typecheck + sdk/server suites + the three release-gate examples on a fresh pgvector
  container
- OSS trust surface: CONTRIBUTING, SECURITY, this roadmap, root `test`/`lint` scripts,
  [`docs/production.md`](./docs/production.md)
- `bunx samesake init`: zero-to-first-search in ≤ 10 minutes (config + docker-compose + server
  template + seeded catalog)
- Shipped provider adapters (Gemini, OpenAI, Voyage/Cohere) for `embed`/`generate`/`rerank` — BYO
  stays, but the default stops being "hand-write the glue"
- Result-cutoff strategies + honest zero-results (threshold / score-drop / category-coherence) —
  bad results are worse than an honest empty page
- Multilingual lexical leg: per-collection FTS language config + cross-script
  normalisation/phonetic primitives in product search

## P2 — the marketplace wedge

The differentiated bet no incumbent OSS alternative has:

- Tenancy model for collections (`scopes` → scoped column + mandatory filter)
- Cross-vendor offer dedup: same product from N vendors → one result with N offers (re-aiming the
  existing entity-resolution engine)
- Enrichment upgrades with proven ROI: ANN-retrieved few-shots, tiered extraction, enrich version
  lineage, image-captions-as-text
- Staged-rollout routing (zero-results → low-results → all queries) — the actual "replace your
  incumbent search incrementally" motion
- Training-pair export so adopters with traffic can fine-tune their BYO models

## Explicit non-goals (challenged and rejected)

LTR/learned rankers (no click data at any installation), SPLADE/ColBERT, a second storage dialect,
an internal job queue, personalization/behavioral CF, semantic IDs, generative carousels, checkout,
precision micro-optimization as a conversion play, and a BM25 lexical extension (dropped 2026-07-18
— product-search incumbents don't use BM25 and no viable Postgres extension fits our deployment
targets; see `rfcs/rfc-bm25-lexical-leg.md` §0 and the [lexical-scoring guide](./apps/docs/src/content/docs/guides/lexical-scoring.md)).
