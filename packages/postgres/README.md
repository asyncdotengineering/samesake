# @samesake/postgres

The PostgreSQL reference backend for samesake. It implements the `Retriever`,
`EnrichStore`, dedup candidate, and vocabulary ports, plus exact SQL facets and
the `samesake()` Tier-2 bundle.

The backend owns PostgreSQL-specific SQL. `@samesake/core`, `@samesake/enrich`,
and `@samesake/query` remain store-free and can be composed over another backend.
