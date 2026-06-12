---
title: From zero to your first match in 15 minutes
description: A guided walkthrough that takes you from a freshly cloned repository to a working entity-resolution matcher that learns from your feedback.
---

## What you will build

By the end of this tutorial we will have a running samesake service that holds three contacts in a local Postgres database, matches the typo `"Preeya"` to `"Priya Fernando"` at confidence `0.569`, learns from a single confirmation, and re-matches the same typo at confidence `0.649` with `alias: ✓` on the second try.

## Prerequisites

- [Bun](https://bun.sh) 1.3 or newer
- Postgres 15 or newer, with the `vector`, `pg_trgm`, `unaccent`, and `fuzzystrmatch` extensions available
- A Google Gemini API key from [aistudio.google.com](https://aistudio.google.com/app/apikey)

## Step 1: Clone samesake and install dependencies

In a terminal, clone the repository and install dependencies:

```bash
git clone https://github.com/octalpixel/samesake.git
cd samesake
bun install
```

## Step 2: Create the local database

Create a Postgres database for samesake and enable the four extensions it needs:

```bash
createdb samesake_dev
psql samesake_dev -c "CREATE EXTENSION vector; CREATE EXTENSION pg_trgm; CREATE EXTENSION unaccent; CREATE EXTENSION fuzzystrmatch;"
```

You will see four `CREATE EXTENSION` confirmations:

```
CREATE EXTENSION
CREATE EXTENSION
CREATE EXTENSION
CREATE EXTENSION
```

## Step 3: Configure your environment

Copy the example environment file:

```bash
cp .env.example .env
```

Open `.env` and set two values:

```ini title=".env"
SAMESAKE_DATABASE_URL=postgresql://YOUR_USER@localhost:5432/samesake_dev
GOOGLE_GENERATIVE_AI_API_KEY=AIzaSy...your-key-here
```

Replace `YOUR_USER` with your local Postgres username (often the same as your shell username).

## Step 4: Start the matcher

Start the matcher in development mode:

```bash
bun run dev
```

You will see the service boot in under two seconds:

```
[samesake] matcher listening on http://localhost:3030
```

Leave this terminal running. Open a second terminal in the same directory for the remaining steps.

In the second terminal, confirm the service is healthy:

```bash
curl -s localhost:3030/v1/healthz
```

You will see Postgres and all four extensions reported:

```json
{
  "status": "ok",
  "postgres": "PostgreSQL 15.12 ...",
  "extensions": [
    "fuzzystrmatch 1.1",
    "pg_trgm 1.6",
    "unaccent 1.1",
    "vector 0.8.0"
  ],
  "uptime_seconds": 12
}
```

## Step 5: Declare your first entity

Create a new file describing a single entity type called `contact`:

```ts title="examples/quickstart/samesake.config.ts"
import { entity, fields, Scorers, providers } from "../../src/sdk";

export const contact = entity("contact", {
  fields: {
    name: fields.text({ required: true }),
    phone: fields.text({ optional: true }),
  },
  scopes: ["tenantId"],
  embeddings: {
    name_emb: { source: "name", model: providers.gemini.embed001({ dim: 768 }) },
  },
  phonetic: {
    name_phon: { source: "name", algorithm: "indic-soundex" },
  },
  scoring: {
    channels: [
      Scorers.phoneExact({ field: "phone", weight: 1.0 }),
      Scorers.cosine({ embedding: "name_emb", weight: 0.6 }),
      Scorers.trigram({ field: "name", weight: 0.25 }),
      Scorers.aliasHit({ weight: 0.4 }),
      Scorers.phoneticEq({ phonetic: "name_phon", weight: 0.2 }),
    ],
  },
});
```

You will notice that this file is plain TypeScript — the entity is described by composing helpers from the samesake SDK. Five scoring channels are declared, each producing a number that combines into the final match score.

## Step 6: Apply the schema

Tell the matcher to materialise database tables and SQL functions for this entity:

```bash
bun packages/cli/src/index.ts apply --project=quickstart --config=examples/quickstart/samesake.config.ts
```

You will see twenty DDL statements applied:

```
Applying 1 entity to project 'quickstart'...
✓ Applied schema to project_quickstart
  - 20 DDL statements
  - entities: contact
```

You will notice that the schema name is `project_quickstart` — samesake scopes every project to its own Postgres schema, so multiple projects can share one database without interfering.

## Step 7: Seed three contacts

Create a seed file with three contacts in a tenant called `acme`:

```json title="examples/quickstart/seed.json"
{
  "entityType": "contact",
  "items": [
    { "id": "k_1", "scope": { "tenantId": "acme" }, "data": { "name": "Priya Fernando", "phone": "0771112222" } },
    { "id": "k_2", "scope": { "tenantId": "acme" }, "data": { "name": "Nuwan Perera", "phone": "0773334444" } },
    { "id": "k_3", "scope": { "tenantId": "acme" }, "data": { "name": "අනූෂා සිල්වා", "phone": "0775556666" } }
  ]
}
```

Load the seed:

```bash
bun packages/cli/src/index.ts seed --project=quickstart --file=examples/quickstart/seed.json
```

You will see three rows seeded in about one to two seconds — most of that time is Gemini computing embeddings:

```
Seeding 3 contact into 'quickstart'...
✓ 3 rows seeded in 1.50s
```

## Step 8: Run your first match

Ask the matcher about a misspelt name:

```bash
bun packages/cli/src/index.ts match --project=quickstart --kind=contact --text="Preeya" --scope tenantId=acme
```

You will see exactly one candidate:

```
Top 1 candidates for "Preeya" (scope: {"tenantId":"acme"})

  1. [id=  1] Priya Fernando                        combined: 0.569   cos: 0.92   trgm: 0.16   phon: ·   alias: ·
```

You will notice three things:

- The `combined` score is `0.569` — above the suggest threshold of `0.55`, so the candidate is returned, but below the auto-link threshold of `0.92`, so the matcher is not yet confident enough to resolve automatically.
- The `cos` score is `0.92` — the multilingual embedding sees `"Preeya"` and `"Priya Fernando"` as semantically near-identical.
- The `alias` column is `·` — no human has ever confirmed this query before.

Note the `[id= 1]` in the output. We will use that id in the next step.

## Step 9: Confirm the match

Tell the matcher that yes, `"Preeya"` does mean `"Priya Fernando"`:

```bash
bun packages/cli/src/index.ts confirm --project=quickstart --kind=contact --query-text="Preeya" --chosen=1 --scope tenantId=acme
```

You will see a single line confirming the write:

```
✓ {"ok":true}
```

Behind the scenes the matcher just wrote two rows: an alias mapping `"preeya"` → entity 1, and an entry in `pair_history` recording that this pair has now been confirmed once.

## Step 10: Watch the alias take effect

Run the same match query a second time:

```bash
bun packages/cli/src/index.ts match --project=quickstart --kind=contact --text="Preeya" --scope tenantId=acme
```

You will see the same candidate, but with two visible changes:

```
Top 1 candidates for "Preeya" (scope: {"tenantId":"acme"})

  1. [id=  1] Priya Fernando                        combined: 0.649   cos: 0.92   trgm: 0.16   phon: ·   alias: ✓
```

You will notice:

- `combined` climbed from `0.569` to `0.649` — the matcher now trusts this pair more.
- `alias` flipped from `·` to `✓` — samesake recognises this query as one it has seen confirmed before.

The matcher just learned from a single click. Every subsequent search for `"Preeya"` in the `acme` tenant will surface `Priya Fernando` more confidently than the first time, with no code change and no model retraining.

## What you learned

- How to declare an entity type in TypeScript and apply it to a project schema with one command.
- How to seed records and query them with a fuzzy match, observing per-channel scores (`cos`, `trgm`, `phon`, `alias`).
- How a single `confirm` call writes an alias that boosts the next match — samesake improves with every user decision.

## Next steps

- Read [`RFC.md`](../RFC.md) for the full architectural contract.
- Read the project [`README.md`](../README.md) for the bulk-import and active-learning workflows.
- Open [http://localhost:3030/swagger](http://localhost:3030/swagger) while the matcher is running to explore every endpoint interactively.
