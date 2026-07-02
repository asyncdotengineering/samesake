---
"@samesake/cli": minor
"@samesake/server": patch
---

`samesake init [dir]` now scaffolds a complete runnable search project — catalog config,
docker-compose Postgres (pgvector 0.8 + contrib extensions), a ~20-line HTTP server, a
deterministic local embedder (no LLM key needed), a 24-product seeded catalog, and `.env` with a
generated API key. Zero to first search in four commands. The old entity-resolution
single-config-file `init --name` form is gone.

`createDbFromUrl` now silences Postgres NOTICEs (`onnotice`): idempotent `IF NOT EXISTS` DDL is
the design, and the "already exists, skipping" spam on every boot was pure noise.
