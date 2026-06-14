---
title: Build a bookshop customer matcher in 10 minutes
description: A guided walkthrough that takes you from an empty directory to a working entity-resolution matcher that resolves "Nimal Sylva" to "Nimal Silva", recognises a customer by phone number, isolates customers across shop branches, and learns from one confirmation.
---

## What you will build

By the end of this tutorial we will have a fresh Bun project with samesake's three packages installed, our own `embedder.ts` wired to Google Gemini, a typed entity config for `customer` (name + phone + email scoped per shop branch), three seeded customers, and a script that:

- Resolves the typo `"Nimal Sylva"` to `"Nimal Silva"` at combined `0.644`
- Resolves the phone number `+94771234567` to `"Saman Perera"` with `phoneEq=true`
- Confirms that a customer scoped to one shop is **invisible** when we search a different shop
- Records one confirmation and watches the next match jump to `0.710` with `aliasHit=true`

Everything runs in-process. We will never start an HTTP server.

## Prerequisites

- [Bun](https://bun.sh) 1.3 or newer
- Postgres 15 or newer, with the `vector`, `pg_trgm`, `unaccent`, and `fuzzystrmatch` extensions available
- A Google Gemini API key from [aistudio.google.com](https://aistudio.google.com/app/apikey)

## Step 1: Create the project

In a terminal, create a new directory and initialise it with Bun:

```bash
mkdir bookshop && cd bookshop
bun init -y
```

You will notice Bun creates `package.json`, `index.ts`, `tsconfig.json`, and `node_modules/` with `typescript` already installed.

## Step 2: Install samesake + an embedding stack

Add the three samesake packages plus your chosen embedding stack. We pick Vercel AI SDK + Google Gemini here; you could equally pick OpenAI, Voyage, Ollama, or any other library — @samesake/server has zero opinions about which one. See [`docs/recipes/`](./recipes/) for copy-paste alternatives.

```bash
bun add samesake @samesake/cli @samesake/server ai @ai-sdk/google
```

You will see Bun report `5 packages installed`. The `@samesake/core` binary lands at `node_modules/.bin/samesake`.

## Step 3: Configure environment variables

Create a `.env` file in the project root with your database URL, the schema name samesake will use for its system tables, and your Gemini API key:

```bash
cat > .env <<'EOF'
SAMESAKE_DATABASE_URL=postgresql://localhost:5432/samesake_dev
SAMESAKE_SCHEMA=bookshop_sys
GOOGLE_GENERATIVE_AI_API_KEY=your-gemini-key-here
EOF
```

Replace `your-gemini-key-here` with the actual key. You will use these three variables in every step that follows.

## Step 4: Run the system migrations

Apply samesake's system DDL to your Postgres before writing any application code:

```bash
bunx samesake migrate --schema=bookshop_sys
```

You will see something like:

```
Applying samesake system DDL to schema 'bookshop_sys'...
✓ migrations applied in 68ms
```

This creates four system tables (`samesake_projects`, `samesake_embed_cache`, `samesake_parse_cache`, `samesake_units_alias`) and three SQL functions (`samesake_normalise`, `samesake_phonetic`, `samesake_unit`) inside the `bookshop_sys` schema. The command is idempotent — run it again and it will report success in roughly the same time without changing anything.

## Step 5: Author your embedder

Create `embedder.ts` — the function @samesake/server will call to turn text into a vector. This is YOUR file in YOUR project; you pick the LLM stack:

```ts title="embedder.ts"
import { embed } from "ai";
import { google } from "@ai-sdk/google";
import type { EmbedFn } from "@samesake/server";

export const embedFn: EmbedFn = async ({ text, model, dim, taskType }) => {
  const { embedding } = await embed({
    model: google.textEmbedding(model),
    value: text,
    providerOptions: {
      google: {
        outputDimensionality: dim,
        taskType: taskType ?? "SEMANTIC_SIMILARITY",
      },
    },
  });
  return Array.from(embedding);
};
```

You will notice this file is the ONLY place that knows you're using Google Gemini. To switch providers later — OpenAI, Voyage, Ollama, a custom internal endpoint — you'd change just this file. @samesake/server is provider-agnostic; the contract is `(req) => Promise<number[]>`.

## Step 6: Declare the customer entity

Create `samesake.config.ts` with our customer entity:

```ts title="samesake.config.ts"
import { entity, fields, Scorers } from "@samesake/core";

export const customer = entity("customer", {
  fields: {
    name: fields.text({ required: true }),
    phone: fields.text({ optional: true }),
    email: fields.text({ optional: true }),
  },
  scopes: ["shopId"],
  embeddings: {
    name_emb: { source: "name", model: "gemini-embedding-001", dim: 768 },
  },
  phonetic: {
    name_phon: { source: "name", algorithm: "indic-soundex" },
  },
  scoring: {
    channels: [
      Scorers.phoneExact({ field: "phone", weight: 1.0 }),
      Scorers.cosine({ embedding: "name_emb", weight: 0.6 }),
      Scorers.trigram({ field: "name", weight: 0.25, latinOnlyPartial: true }),
      Scorers.aliasHit({ weight: 0.4 }),
      Scorers.phoneticEq({ phonetic: "name_phon", weight: 0.2 }),
    ],
  },
});
```

You will notice the embedding declaration is pure data: `model: "gemini-embedding-001", dim: 768`. There is no bundled provider factory. The matcher does not care what service sits behind `"gemini-embedding-001"`; your `embedder.ts` decides that.

You will also notice that every `Scorers.*` channel references a field, embedding, or phonetic block we just declared. If you change `embedding: "name_emb"` to `"nam_emb"` (a typo), TypeScript will immediately complain: `Type '"nam_emb"' is not assignable to type '"name_emb"'`. This is the type-safe DSL doing its job.

## Step 7: Write the application

Create `app.ts` — the entire matcher flow in one file:

```ts title="app.ts"
import { createMatcher } from "@samesake/server";
import { customer } from "./samesake.config";
import { embedFn } from "./embedder";

const matcher = createMatcher({
  databaseUrl: process.env.SAMESAKE_DATABASE_URL!,
  apiKey: "bookshop-local-dev-key",
  schema: process.env.SAMESAKE_SCHEMA ?? "public",
  embed: embedFn,
  migrate: "manual",
});

const applied = await matcher.apply("bookshop", [customer]);
console.log(`▸ apply: ${applied.appliedStatements} DDL stmts → schema ${applied.schema}`);

const seedItems = [
  { id: "c1", scope: { shopId: "colombo-fort" }, data: { name: "Saman Perera", phone: "+94771234567", email: "saman.p@example.com" } },
  { id: "c2", scope: { shopId: "colombo-fort" }, data: { name: "Nimal Silva", phone: "+94712345678", email: null } },
  { id: "c3", scope: { shopId: "kandy" }, data: { name: "Anoma Fernando", phone: "+94774445566", email: "anoma.f@example.com" } },
];
for (const item of seedItems) {
  await matcher.upsertOne({ project: "bookshop", entity: customer }, item);
}
console.log(`▸ upsert: ${seedItems.length} customers seeded`);

const m1 = await matcher.match({
  project: "bookshop",
  kind: "customer",
  text: "Nimal Sylva",
  scope: { shopId: "colombo-fort" },
});
const top = m1.candidates[0];
console.log(`▸ match "Nimal Sylva" → ${top?.name} (combined ${top?.combined.toFixed(3)})`);

const m2 = await matcher.match({
  project: "bookshop",
  kind: "customer",
  text: "Different Name",
  scope: { shopId: "colombo-fort" },
  opts: { phone: "+94771234567" },
});
console.log(`▸ match by phone → ${m2.candidates[0]?.name} (phoneEq=${m2.candidates[0]?.components.phoneEq})`);

const m3 = await matcher.match({
  project: "bookshop",
  kind: "customer",
  text: "Anoma Fernando",
  scope: { shopId: "colombo-fort" },
});
const leaked = m3.candidates.find((c) => c.name === "Anoma Fernando" && c.combined > 0.55);
console.log(`▸ tenant isolation: searching colombo-fort for a Kandy customer → ${leaked ? "LEAKED" : "isolated"}`);

if (top) {
  await matcher.confirm({
    project: "bookshop",
    kind: "customer",
    queryText: "Nimal Sylva",
    scope: { shopId: "colombo-fort" },
    chosenEntityId: top.entityId,
  });
  const m4 = await matcher.match({
    project: "bookshop",
    kind: "customer",
    text: "Nimal Sylva",
    scope: { shopId: "colombo-fort" },
  });
  console.log(`▸ after confirm → aliasHit=${m4.candidates[0]?.components.aliasHit}, combined=${m4.candidates[0]?.combined.toFixed(3)}`);
}

await matcher.close();
```

You will notice the `createMatcher` call has one new field (`embed: embedFn`) and one fewer (no `providers:`). Same shape; the AI stack is fully owned by your `embedder.ts`.

You will notice every method call is fully typed end-to-end — `matcher.match` accepts the input shape we expect and returns `MatchResult` with `candidates[].combined` as a number.

## Step 8: Run the application

Execute the script:

```bash
bun --env-file=.env app.ts
```

You will see the following output (exact `combined` numbers may vary by a few thousandths because cosine distance against Gemini embeddings is not perfectly deterministic):

```
▸ apply: 10 DDL stmts → schema project_bookshop
▸ upsert: 3 customers seeded
▸ match "Nimal Sylva" → Nimal Silva (combined 0.644)
▸ match by phone → Saman Perera (phoneEq=true)
▸ tenant isolation: searching colombo-fort for a Kandy customer → isolated
▸ after confirm → aliasHit=true, combined=0.710
```

You should notice three things in this output:

1. The fuzzy match for `"Nimal Sylva"` lands on `"Nimal Silva"` at `0.644`. The cosine similarity carried it across the typo.
2. The phone lookup ignored the wrong name `"Different Name"` and resolved purely on the phone number, with `phoneEq=true` flipping the score above `0.55`.
3. The same query `"Nimal Sylva"` jumped from `0.644` to `0.710` after the single `confirm()` call. The matcher recorded the alias and the alias-hit channel fired on the next match.

## Step 9: Verify in Postgres

Open `psql` and look at what samesake created on your behalf:

```bash
psql samesake_dev -c "\\dn" | grep -E "bookshop_sys|project_bookshop"
```

You will see two new schemas:

```
 bookshop_sys     | mithushancj
 project_bookshop | mithushancj
```

The first (`bookshop_sys`) was created by `samesake migrate` in Step 4 and holds the system tables shared across every project. The second (`project_bookshop`) was created by `matcher.apply` in Step 7 and holds your customer data plus the auto-generated `match_customer()` SQL function that powers Step 8.

List the tables inside `project_bookshop`:

```bash
psql samesake_dev -c "\\dt project_bookshop.*"
```

You will see six relations: the `entity_customer` table with your three customers, the `entity_customer_match` sidecar with embeddings and phonetic hashes, plus the four per-project system tables (`name_alias`, `match_candidate`, `pair_history`, `scope_thresholds`). The alias you confirmed in Step 8 is in `name_alias`:

```bash
psql samesake_dev -c "SELECT alias, alias_normalised, entity_id FROM project_bookshop.name_alias;"
```

You will see:

```
   alias    | alias_normalised | entity_id
------------+------------------+-----------
 Nimal Sylva| nimal sylva      |         2
```

That is the one row that explains why the second match in Step 8 jumped above `0.7`.

## What you learned

- The full samesake consumer flow takes three packages, five files, and six commands.
- `samesake migrate` is the deploy-step entry point — the only command that needs the database directly. Everything else flows through `createMatcher`.
- `embedder.ts` is the only place that knows what LLM you're using. Swap it for OpenAI / Voyage / Ollama / a mock — no other file changes.
- The `entity()` DSL gives you compile-time validation of every cross-reference between fields, embeddings, phonetic blocks, and scoring channels.
- One `createMatcher` instance exposes three surfaces (`matcher.match()` for in-process, `matcher.fetch` for Web-standard HTTP, `matcher.app` for Hono composition). This tutorial used only the first.
- Tenant isolation comes from the `scopes: ["shopId"]` declaration, not from any application-layer filter you write.
- One `matcher.confirm()` call writes a row to `name_alias` and a row to `pair_history`, which causes the alias-hit channel to fire on the next match. This is the active-learning loop.

## Next steps

- Browse [`docs/usage-patterns.md`](./usage-patterns.md) to see the other 10 deployment shapes — mounting the matcher in an existing Hono app, deploying to Cloudflare Workers, running standalone on Bun or Node, mixing HTTP and in-process calls on the same matcher, swapping in Ollama for offline use, deterministic test stubs, and per-call provider routing.
- Browse [`docs/recipes/`](./recipes/) for copy-paste `embedder.ts` / `parser.ts` files for every common provider (Gemini, OpenAI, Voyage, Ollama, mock).
- Look at [`examples/hello/`](../examples/hello/) for a richer schema — three entities with people-shape and parse-shape scoring, active-learning feedback, dedup, variants, and calibration.
- Read [`docs/quickstart-search.md`](./quickstart-search.md) if you also need collection search.
- When you are ready to release, run the local gates in [`docs/release.md`](./release.md).
