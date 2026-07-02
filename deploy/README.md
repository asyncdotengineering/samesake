# Deploy templates

Production runs **two things**: Postgres (with `vector`, `pg_trgm`, `unaccent`, `fuzzystrmatch`) and the matcher process (`apps/matcher` or `samesake dev`).

No Docker is required for local development or Fly deployment. An optional `Dockerfile.example` exists for teams that prefer container builds.

## Fly.io (recommended — no Docker)

1. Create a Neon (or other) Postgres database. Copy the **pooled** connection string.
2. From the repo root:

```bash
fly launch --no-deploy --config deploy/fly.toml.example
fly secrets set SAMESAKE_DATABASE_URL="postgres://..."
fly secrets set SAMESAKE_API_KEY="$(openssl rand -hex 24)"
fly secrets set GEMINI_API_KEY="..."
fly deploy --config deploy/fly.toml.example
```

The example `fly.toml` uses `shared-cpu-1x`, 256 MB RAM, and auto-stop (`auto_stop_machines = "stop"`, `min_machines_running = 0`) so idle machines cost nothing.

**Do not** attach Fly Postgres in this template — use Neon or another external provider. On Fly, use Neon's pooled URL directly.

### Optional Docker build on Fly

If your org requires a Dockerfile:

```bash
fly deploy --config deploy/fly.toml.example --dockerfile deploy/Dockerfile.example
```

## Cloudflare Workers

Mount the universal `fetch` handler — no `Bun.serve` in serverless:

```ts
import { createMatcher } from "@samesake/server";

const matcher = createMatcher({
  databaseUrl: env.HYPERDRIVE.connectionString,
  apiKey: env.SAMESAKE_API_KEY,
  embed: yourEmbedFn,
  migrate: "lazy",
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return matcher.fetch(request);
  },
};
```

- **Hyperdrive** (recommended): bind a Hyperdrive config to your Neon database.
- **Neon serverless**: pass the Drizzle handle via `createMatcher({ db, apiKey, embed })` instead of `databaseUrl`.
- Set `SAMESAKE_SERVERLESS=1` on `apps/matcher` if you also run the standalone entry — it skips `Bun.serve` when that env is set.

Workers do not run background jobs. For async enrich/index at scale, wrap the pipeline stages in your job platform (Inngest / Upstash / Cloudflare Workflows / Vercel Workflows — see the pipeline guides in `apps/docs`) or trigger index via HTTP/CLI.

## Local dev

```bash
bun run dev
# or
bun packages/cli/src/index.ts dev \
  --config examples/hello-search/samesake.config.ts \
  --project dev \
  --port 8788
```

Watches the config file and re-applies schema on change. See [`docs/production.md`](../docs/production.md) for policy, metrics, and migrations.
