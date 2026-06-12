---
title: Usage patterns — every way to consume the matcher
description: 11 runnable blueprints for the samesake matcher (createMatcher factory). Verified end-to-end via scripts/blueprints/verify.sh.
---

# Usage patterns

`@samesake/server` (v0.4+) exposes the matcher through **one factory** returning **three surfaces**:

```ts
const matcher = createMatcher({ db, apiKey, embed, parse, ... });

matcher.match(...)             // function-level (in-process, no HTTP)
matcher.fetch(request)         // Web-standard fetch handler
matcher.app                    // underlying Hono app (for .route() composition)
```

The same instance gives you all three. Pick the surface that fits your runtime — or use several at once. The 11 patterns below cover every realistic deploy/consume shape. **Each one has a runnable blueprint** in `scripts/blueprints/`; the verifier `scripts/blueprints/verify.sh` runs every pattern end-to-end against a live matcher database.

## At a glance

| # | Pattern | Runtime | Surface | When to use |
|---|---|---|---|---|
| [1](#1-in-process-no-http-server) | In-process | Any | function | Same-process consumers (CF Worker route handler, internal job) |
| [2](#2-standalone-bun-server) | Standalone Bun | Bun | `.fetch` | Long-lived service process; the `apps/matcher` pattern |
| [3](#3-mounted-in-an-existing-hono-app) | Mounted Hono | Any with Hono | `.app` + `.route()` | You already have a Hono app; add the matcher as a sub-router with shared middleware |
| [4](#4-mixed-mode-http-and-in-process-together) | Mixed mode | Bun / Node | `.app` + function | HTTP for external clients, function calls for hot internal paths — one matcher |
| [5](#5-cloudflare-workers) | Cloudflare Workers | CF Workers | `.fetch` | Edge deploy on CF |
| [6](#6-vercel-edge--nextjs-route-handler) | Vercel Edge | Vercel | `.fetch` | Edge / Next.js route handler |
| [7](#7-nodejs-via-honochono-node-server) | Node + adapter | Node 18+ | `.fetch` | Classic Node server |
| [8](#8-deploy-pipeline-migrations-postinstall-style) | Deploy-pipeline migrate | Any | `prepareMigrations()` / `samesake migrate` | Run migrations as a separate CI step BEFORE the app boots (Prisma / Drizzle Kit pattern) |
| [9](#9-custom-embedder-local-ollama) | **Custom embedder (Ollama)** | Any | function | Air-gapped, offline, zero-API-cost, on-prem regulated data |
| [10](#10-deterministic-test-stub) | **Deterministic test stub** | Any | function | Tests against real Postgres without hitting an LLM |
| [11](#11-mixed-providers) | **Mixed providers per call** | Any | function | Different model per entity / length / quality tier |

> **First time using samesake?** Walk through [`examples/bookshop-onboarding/`](../examples/bookshop-onboarding/) — built by acting as a new dev in a fresh directory and walking through this doc step-by-step. It's the verified happy-path end-to-end: `bun init` → install → write `embedder.ts` → `samesake migrate` → write entities → in-process `matcher.apply()` / `match()` / `confirm()`. ~30 lines of consumer code, all surfaces verified green.

> **Adding samesake to a system you already have in production?** See [How-to → Onboarding samesake into an existing system](./how-to/onboarding-existing-system.md) — the full playbook covering prepare → bootstrap (initial data load) → cut-over → ongoing sync via the outbox pattern → calibration over time.

> **Wondering why a match scored the way it did, or why your declared weights weren't behaving as expected?** See [Explanation → How the matcher scores candidates](./explanation/matcher-channels.md) for the channels and their combiner, and [Explanation → Tuning channel weights per entity](./explanation/tuning-channel-weights.md) for what per-entity `Scorers.*({ weight: ... })` actually does (and why it didn't, before v0.4.3).

## The config (every pattern uses the same shape)

```ts
interface MatcherConfig {
  // EITHER provide a Drizzle handle directly (mount inside an app that
  // already has one) OR a database URL (we build the postgres-js handle).
  db?: PostgresJsDatabase;
  databaseUrl?: string;

  // API key required by every HTTP route except /v1/healthz.
  // Function-level methods bypass this — they're trusted in-process.
  apiKey: string;

  // Postgres schema where the matcher's system tables + utility functions
  // live. Default "public".
  schema?: string;

  // Prefix for per-project Postgres schemas. Default "project_" →
  // project_<slug> for each applied project.
  projectPrefix?: string;

  // REQUIRED. Turn text into a vector. You bring the LLM stack — Vercel
  // AI SDK, raw fetch to Ollama, OpenAI's SDK, sentence-transformers via
  // HTTP, a deterministic stub for tests, whatever. @samesake/server has
  // zero opinions about which one. See `docs/recipes/` for copy-paste
  // starters per provider.
  embed: (req: EmbedRequest) => Promise<number[]>;

  // OPTIONAL. Required only if one of your entities has a `parse:` block
  // (parse-shape entities, e.g. medications / inventory products). If
  // missing and an entity tries to parse, throws lazily with a clear
  // "wire up parse" error.
  parse?: (req: ParseRequest) => Promise<unknown>;

  // When to apply system migrations:
  //   "lazy"   (default) — on the first HTTP request via app middleware
  //   "eager"            — synchronously inside createMatcher()
  //   "manual"           — never automatic; call matcher.migrate() yourself
  migrate?: "lazy" | "eager" | "manual";
}
```

### The two BYO-AI function contracts

```ts
interface EmbedRequest {
  text: string;          // the string to embed
  model: string;         // model identifier from your entity's EmbeddingDef
  dim: number;           // vector dimension the matcher expects back
  taskType?: string;     // opaque hint (e.g. Gemini's "SEMANTIC_SIMILARITY")
  inputType?: "query" | "document";  // some providers care (Voyage); most don't
}
type EmbedFn = (req: EmbedRequest) => Promise<number[]>;

interface ParseRequest {
  text: string;          // the string to parse
  schema: ZodSchema;     // @samesake/server-owned ParsedProductSchema
  instructions: string;  // system prompt — entity ParseDef.instructions override or default
  model?: string;        // model identifier from ParseDef.model
}
type ParseFn = (req: ParseRequest) => Promise<unknown>;
```

`embed` returns `number[]` of length `dim`. The matcher checks the length and throws clearly if it mismatches. `parse` returns an object the matcher validates against `ParsedProductSchema` — that schema is @samesake/server's because the SQL match function generation references its columns (brand, item_canonical, size_value, etc.).

## What the matcher returns

```ts
interface Matcher {
  // Function-level methods (in-process, no HTTP, no auth header check)
  match(input): Promise<MatchResult>;
  matchBatch(input): Promise<MatchBatchResult>;
  confirm(input): Promise<{ ok: true }>;
  decline(input): Promise<{ ok: true }>;
  dedup(input): Promise<{ clusters }>;
  variants(input): Promise<{ suggestions }>;
  calibrate(input): Promise<CalibrateResult>;
  explain(input): Promise<ExplainResult>;
  apply(slug, entities): Promise<ApplyResult>;
  upsertOne(ctx, item): Promise<{ id }>;
  upsertBatch(ctx, items): Promise<{ ids }>;
  listProjects(): Promise<ProjectSummary[]>;
  getProject(slug): Promise<ProjectRow | null>;
  getEntityDef(slug, kind): Promise<EntityDef | null>;

  // Universal HTTP fetch handler — drop into Bun.serve, CF, Vercel, Deno
  fetch: (request: Request) => Promise<Response>;

  // Underlying Hono app — for .route() composition
  app: Hono;

  // Lifecycle
  migrate(): Promise<void>;  // idempotent; safe to call repeatedly
  close(): Promise<void>;
}
```

---

## 1. In-process, no HTTP server

The function-level path. Use this any time your consumer is TypeScript in the same process — fastest, no serialization, no auth dance.

```ts
import { createMatcher } from "@samesake/server";
import { embedFn } from "./embedder";  // your project's embed function

const matcher = createMatcher({
  databaseUrl: process.env.MATCHER_DB!,
  apiKey: "in-process-key-not-checked-on-function-calls",
  embed: embedFn,
});

await matcher.migrate();

const result = await matcher.match({
  project: "hello",
  kind: "customer",
  text: "Smyth",
  scope: { tenantId: "acme" },
  opts: { limit: 3 },
});

console.log(result.candidates[0]?.name); // "John Smith"
await matcher.close();
```

**Runnable:** [`scripts/blueprints/01-in-process.ts`](../scripts/blueprints/01-in-process.ts) — verified.

## 2. Standalone Bun server

The classic long-lived service shape. This is what `apps/matcher` does.

```ts
import { createMatcher } from "@samesake/server";
import { embedFn, parseFn } from "./embedder";

const matcher = createMatcher({
  databaseUrl: process.env.SAMESAKE_DATABASE_URL!,
  apiKey: process.env.SAMESAKE_API_KEY!,
  embed: embedFn,
  parse: parseFn,
  migrate: "eager", // warm migrations before serving requests
});

Bun.serve({ port: 3030, fetch: matcher.fetch });
```

**Runnable:** [`scripts/blueprints/02-standalone-bun.ts`](../scripts/blueprints/02-standalone-bun.ts) — verified (hits `/v1/healthz`).

## 3. Mounted in an existing Hono app

You already have a Hono service. Mount the matcher as a sub-router at `/v1` (or any prefix). Your host app's middleware wraps the matcher's routes automatically.

```ts
import { Hono } from "hono";
import { createMatcher } from "@samesake/server";
import { embedFn, parseFn } from "./embedder";

const matcher = createMatcher({
  databaseUrl: process.env.MATCHER_DB!,
  apiKey: process.env.MATCHER_API_KEY!,
  embed: embedFn,
  parse: parseFn,
  migrate: "eager",
});

const app = new Hono();

// Your host middleware
app.use("/match/*", async (c, next) => {
  const start = Date.now();
  await next();
  console.log(`${c.req.method} ${c.req.path} → ${Date.now() - start}ms`);
});

// Mount the matcher under /match — every matcher route now lives at
// /match/v1/projects/:p/match, /match/v1/healthz, etc.
app.route("/match", matcher.app);

// Your own routes sit next to it
app.get("/business/hello", (c) => c.json({ from: "host" }));

Bun.serve({ port: 3030, fetch: app.fetch });
```

**Runnable:** [`scripts/blueprints/03-mounted-hono.ts`](../scripts/blueprints/03-mounted-hono.ts) — verified.

## 4. Mixed mode (HTTP and in-process together)

The most powerful pattern for full-stack apps. The matcher exposes its HTTP routes for external clients (mobile, browser) AND your server-side code calls the same matcher in-process for hot paths — no HTTP roundtrip, no JSON serialization, same connection pool.

```ts
import { Hono } from "hono";
import { createMatcher } from "@samesake/server";
import { embedFn, parseFn } from "./embedder";

const matcher = createMatcher({
  databaseUrl: process.env.MATCHER_DB!,
  apiKey: process.env.MATCHER_API_KEY!,
  embed: embedFn,
  parse: parseFn,
  migrate: "eager",
});
const app = new Hono();

// External HTTP surface
app.route("/match", matcher.app);

// Internal route that uses the same matcher in-process
app.get("/internal/bulk-match", async (c) => {
  // No fetch(), no JSON.stringify, no auth header — direct function call.
  const result = await matcher.match({
    project: "hello",
    kind: "customer",
    text: c.req.query("q") ?? "",
    scope: { tenantId: c.req.query("scope") ?? "default" },
  });
  return c.json({ topName: result.candidates[0]?.name });
});

Bun.serve({ port: 3030, fetch: app.fetch });
```

**Runnable:** [`scripts/blueprints/04-mixed-mode.ts`](../scripts/blueprints/04-mixed-mode.ts) — verified.

## 5. Cloudflare Workers

`matcher.fetch` is exactly CF Workers' `fetch(request, env, ctx)` shape.

**Important — postgres-js does NOT work in CF Workers** (no raw TCP). In a real Worker, use one of:
- `@neondatabase/serverless` (HTTP-PostgreSQL via Neon)
- `drizzle-orm/neon-serverless`
- Cloudflare Hyperdrive (wraps a TCP driver inside CF's pooled tunnel)

Build the Drizzle handle with the CF-compatible driver and pass it as `db`. The matcher's queries are driver-agnostic via Drizzle.

```ts
import { createMatcher, type Matcher, type EmbedFn } from "@samesake/server";
import { drizzle } from "drizzle-orm/neon-serverless";  // not postgres-js
import { neon } from "@neondatabase/serverless";
import { embed } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";

interface Env {
  DATABASE_URL: string;
  SAMESAKE_API_KEY: string;
  GEMINI_API_KEY: string;
}

// Lazy per-isolate construction (createMatcher is cheap; DB pool reused).
let matcher: Matcher | null = null;
function getMatcher(env: Env): Matcher {
  if (!matcher) {
    const google = createGoogleGenerativeAI({ apiKey: env.GEMINI_API_KEY });
    const embedFn: EmbedFn = async ({ text, model, dim, taskType }) => {
      const { embedding } = await embed({
        model: google.textEmbedding(model),
        value: text,
        providerOptions: { google: { outputDimensionality: dim, taskType: taskType ?? "SEMANTIC_SIMILARITY" } },
      });
      return Array.from(embedding);
    };
    matcher = createMatcher({
      db: drizzle(neon(env.DATABASE_URL)),
      apiKey: env.SAMESAKE_API_KEY,
      embed: embedFn,
      migrate: "lazy", // CF Workers can't do top-level await reliably
    });
  }
  return matcher;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return getMatcher(env).fetch(request);
  },
};
```

**Shape verified:** [`scripts/blueprints/05-cloudflare-workers.ts`](../scripts/blueprints/05-cloudflare-workers.ts) (typecheck-only — deploy via `wrangler deploy`).

## 6. Vercel Edge / Next.js route handler

Catch-all route handler at `app/api/match/[[...path]]/route.ts`:

```ts
import { createMatcher, type Matcher } from "@samesake/server";
import { embedFn, parseFn } from "./embedder";

let matcher: Matcher | null = null;
function getMatcher(): Matcher {
  if (!matcher) {
    matcher = createMatcher({
      databaseUrl: process.env.MATCHER_DATABASE_URL!,
      apiKey: process.env.MATCHER_API_KEY!,
      embed: embedFn,
      parse: parseFn,
      migrate: "lazy",
    });
  }
  return matcher;
}

export const runtime = "edge";
export const GET = (req: Request) => getMatcher().fetch(req);
export const POST = (req: Request) => getMatcher().fetch(req);
```

The catch-all `[[...path]]` segment makes one route handler serve every matcher endpoint (`/v1/healthz`, `/v1/projects/:p/match`, etc.).

**Shape verified:** [`scripts/blueprints/06-vercel-edge.ts`](../scripts/blueprints/06-vercel-edge.ts) (typecheck-only — deploy via `vercel deploy`).

## 7. Node.js via @hono/node-server

Node doesn't have `Bun.serve`. Hono provides `@hono/node-server` as the adapter. `matcher.fetch` is the universal handler — the adapter just wraps it.

```bash
npm i @samesake/server @hono/node-server
```

```ts
import { serve } from "@hono/node-server";
import { createMatcher } from "@samesake/server";
import { embedFn, parseFn } from "./embedder";

const matcher = createMatcher({
  databaseUrl: process.env.SAMESAKE_DATABASE_URL!,
  apiKey: process.env.SAMESAKE_API_KEY!,
  embed: embedFn,
  parse: parseFn,
  migrate: "eager",
});

serve({ port: 3030, fetch: matcher.fetch });
```

Exact same contract as `Bun.serve` — `fetch: matcher.fetch`.

**Shape verified:** [`scripts/blueprints/07-node-server.ts`](../scripts/blueprints/07-node-server.ts) (typecheck-only — `@hono/node-server` isn't a workspace dep).

## 8. Deploy-pipeline migrations (postinstall-style)

The `await matcher.migrate()` call inside your app is convenient for dev, but for production deploys you usually want **migrations as a separate step that runs BEFORE the app starts up** — the same pattern as `prisma migrate deploy`, `drizzle-kit push`, `rake db:migrate`.

Two equivalent surfaces:

### As a CLI command (CI-friendly)

```bash
# In your deploy pipeline, before booting the app:
bunx samesake migrate --db=$DATABASE_URL --schema=public
# Then deploy/start the app with migrate: "manual" so it doesn't try again
bun apps/matcher/src/index.ts
```

`samesake migrate` exits non-zero if anything fails, so CI fails the deploy before the app goes live.

### As a function (programmatic CI scripts)

```ts
import { prepareMigrations } from "@samesake/server";

await prepareMigrations({
  databaseUrl: process.env.DATABASE_URL!,
  schema: "public",
});
```

Doesn't construct a matcher, doesn't need API keys, doesn't need an `embed` function. Just opens a connection, runs the system DDL (`CREATE TABLE IF NOT EXISTS`, `CREATE FUNCTION OR REPLACE`), closes the connection. **Idempotent — safe to run on every deploy.**

### Why not `postinstall`?

npm `postinstall` fires when packages land in `node_modules` (during `npm install`). At that moment:
- The consumer's DB URL isn't known to us
- The consumer's `.env` may not be in place
- CI runners that install for build but don't deploy would fail

So `postinstall` is the wrong hook. The right one is **"deploy step"** — the place where the consumer knows the DB URL and is about to start the service.

### When `prepareMigrations()` is enough vs. when you also need per-project apply

| Concern | Run by | When |
|---|---|---|
| System DDL (`samesake_projects`, caches, utility functions) | `prepareMigrations()` / `samesake migrate` | Once per deploy. Idempotent. |
| Per-project apply (`project_<slug>.entity_<kind>`, `match_<kind>()`) | `matcher.apply(slug, entities)` / `samesake apply` | Per project, when the user adds or changes their entity config |
| Version drift (library schema changes between releases) | drizzle-kit migration files (future) | When @samesake/server adds a column to a system table |

For now: system DDL is `CREATE … IF NOT EXISTS` / `CREATE OR REPLACE`, which handles "make it exist". For drift between @samesake/server versions (e.g. adding a column), versioned drizzle-kit migration files are on the roadmap.

**Runnable:** [`scripts/blueprints/08-deploy-pipeline-migrate.ts`](../scripts/blueprints/08-deploy-pipeline-migrate.ts) — verified end-to-end.

---

## 9. Custom embedder: local Ollama

The structural win of BYO-AI. Air-gapped deployment, offline dev loop, regulated-data compliance, zero per-request API cost — all unlocked by a 10-line fetch closure:

```ts
import { createMatcher, type EmbedFn } from "@samesake/server";

const ollamaEmbed: EmbedFn = async ({ text, model }) => {
  const r = await fetch("http://localhost:11434/api/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt: text }),
  });
  const { embedding } = (await r.json()) as { embedding: number[] };
  return embedding;
};

const matcher = createMatcher({
  databaseUrl: process.env.SAMESAKE_DATABASE_URL!,
  apiKey: "ollama-key",
  embed: ollamaEmbed,
});
```

In your entity config, set the model to whatever Ollama model you pulled:

```ts
embeddings: {
  name_emb: { source: "name", model: "nomic-embed-text", dim: 768 },
}
```

**Zero changes to @samesake/server. No new dependency.** Just a closure satisfying `(req) => Promise<number[]>`.

**Runnable:** [`scripts/blueprints/09-custom-embedder-ollama.ts`](../scripts/blueprints/09-custom-embedder-ollama.ts) — typecheck by default; set `OLLAMA_DEMO=1` to actually call Ollama.

## 10. Deterministic test stub

Run integration tests against a real Postgres without hitting an LLM (cost, rate limits, flakiness, offline CI):

```ts
import { createHash } from "node:crypto";
import { createMatcher, type EmbedFn } from "@samesake/server";

const testEmbed: EmbedFn = async ({ text, dim }) => {
  // Same text → same vector. Deterministic per (text, dim).
  const seedHex = createHash("sha1").update(text).digest("hex").slice(0, 8);
  let s = parseInt(seedHex, 16) || 1;
  const v = new Array(dim);
  for (let i = 0; i < dim; i++) {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s = s | 0;
    v[i] = ((s & 0xffff) / 0xffff) * 2 - 1;
  }
  // Normalise to unit length so cosine math stays well-behaved.
  let norm = 0; for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return v.map((x) => x / norm);
};

const matcher = createMatcher({
  databaseUrl: process.env.TEST_DB!,
  apiKey: "test-key",
  embed: testEmbed,
});

// Same query twice → same combined score; no API calls.
const a = await matcher.match({ project: "x", kind: "customer", text: "Smyth", scope: { t: "1" } });
const b = await matcher.match({ project: "x", kind: "customer", text: "Smyth", scope: { t: "1" } });
console.assert(a.candidates[0]?.combined === b.candidates[0]?.combined);
```

For parse-shape entities, mock `parse` similarly:

```ts
import { ParsedProductSchema, type ParseFn } from "@samesake/server";
const testParse: ParseFn = async ({ text }) => ParsedProductSchema.parse({
  brand: null, brand_normalised: null,
  item: text, item_canonical: text.toLowerCase(),
  variant: null, size_value: null, size_unit: null,
  internal_code: null, namespace_prefix: null, parser_confidence: 0.8,
});
```

**Runnable:** [`scripts/blueprints/10-deterministic-test-stub.ts`](../scripts/blueprints/10-deterministic-test-stub.ts) — typecheck by default; set `TEST_STUB_DEMO=1` to actually run.

## 11. Mixed providers

`embed` is one closure under your control. Switch on model string, text length, scope, request context, or whatever signal you want:

```ts
import { embed } from "ai";
import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import type { EmbedFn } from "@samesake/server";

const routedEmbed: EmbedFn = async ({ text, model, dim }) => {
  // Per-entity routing by model prefix.
  if (model.startsWith("openai/")) {
    const r = await embed({ model: openai.textEmbedding(model.slice(7)), value: text });
    return Array.from(r.embedding);
  }
  // Or by text length: send long product descriptions to a premium model.
  if (text.length > 500) {
    return premiumEmbed(text, dim);  // your call
  }
  // Default: Gemini.
  const r = await embed({
    model: google.textEmbedding(model),
    value: text,
    providerOptions: { google: { outputDimensionality: dim, taskType: "SEMANTIC_SIMILARITY" } },
  });
  return Array.from(r.embedding);
};
```

Different entities can declare different models; the same `embed` closure handles all of them. @samesake/server doesn't care; the cache key includes the model so the routing decision affects cache locality cleanly.

**Runnable:** [`scripts/blueprints/11-mixed-providers.ts`](../scripts/blueprints/11-mixed-providers.ts) — typecheck-only by default; set `MIXED_DEMO=1` to actually call.

---

## Verifying yourself

```bash
scripts/blueprints/verify.sh
```

Patterns 1–4 require a running Postgres (uses `SAMESAKE_DATABASE_URL` from `.env`). Patterns 5–11 are shape-verified by default — they exercise the typecheck and print sanity messages, but don't hit external services unless you opt in (`OLLAMA_DEMO=1`, `TEST_STUB_DEMO=1`, `MIXED_DEMO=1`).

## Picking a stack for your project (concrete recommendation)

For a Bun + Hono + Cloudflare Workers + Expo stack:

- **Production matcher service:** pattern 5 (Cloudflare Workers) with Neon for Postgres. The matcher runs alongside your API, on the same edge network. Construct with `migrate: "lazy"` so cold start is fast.
- **Host API consuming the matcher:** pattern 4 (mixed mode). Inside the Worker handler, call `matcher.match({...})` directly for the hot path (lookup-by-name on customer create); expose `matcher.app` mounted at `/match/*` for the mobile client to call directly.
- **Local dev:** pattern 2 (`apps/matcher` already does this). `bun apps/matcher/src/index.ts` and you have the matcher on `:3030`.
- **Tests:** pattern 10 (deterministic stub). Zero API keys, zero network, exact reproducibility.

One library, multiple shapes, one connection pool per process — and your `embedder.ts` is the single place that knows what AI provider you're using.

## Picking an AI stack

The matcher doesn't care. Pick the one you're already comfortable with:

- **Vercel AI SDK + Gemini** — easiest start, what `apps/matcher` and `examples/bookshop-onboarding` use. See [`docs/recipes/embedder-gemini.ts`](./recipes/embedder-gemini.ts).
- **Vercel AI SDK + OpenAI** — [`docs/recipes/embedder-openai.ts`](./recipes/embedder-openai.ts).
- **Voyage AI** — high-quality multilingual, no SDK needed (raw fetch). [`docs/recipes/embedder-voyage.ts`](./recipes/embedder-voyage.ts).
- **Local Ollama** — offline / air-gapped / regulated. See pattern 9 above and [`docs/recipes/embedder-ollama.ts`](./recipes/embedder-ollama.ts).
- **Deterministic stub** — tests. See pattern 10 and [`docs/recipes/embedder-mock.ts`](./recipes/embedder-mock.ts).
