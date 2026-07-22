# @samesake-examples/cloudflare-backend

This is one peer backend, not a privileged backend. It runs the same
`createEnricher` and `createSearch` engine over a local SQLite file (the D1
shape) and embedded, on-disk LanceDB. The same engine also runs over Postgres
and any other backend that implements the ports.

The example implements `EnrichStore` in `d1-enrich-store.ts`, `Retriever` in
`lance-retriever.ts`, `DedupCandidateProvider` in `lance-candidates.ts`, and
`VocabProvider` in `d1-vocab.ts`. The candidate provider unions a LanceDB
hybrid probe with a D1 exact-key probe, then computes trigram and cosine scores
in JavaScript. The retriever renders `ConstraintPredicate[]`, executes vector
and lexical legs, and fuses them with RRF K=60.

`gemini`, `768`, and `fashion` are examples, not defaults. This harness uses
deterministic stubs: no network, no live model, and no database URL.

## Run

```bash
bun install
cd examples/cloudflare-backend
SAMESAKE_DATABASE_URL= bun run src/run.ts
bun test
```

The run writes `evidence.json` containing two enriched rows, all resolve
decisions (including the cross-vendor GTIN `1001` cluster), and search ids and
scores. The test repeats the complete flow against fresh temporary SQLite and
LanceDB directories.
