---
title: Deployment
description: How to run samesake in production — six paths, with the actual gotchas each one has.
---

## What you're deploying

Two processes:

- **samesake matcher** — Bun + Elysia HTTP server. **Pure stateless** — no in-process workers, no queues, no long-lived background polling. Image is ~75 MB. Scales horizontally to N replicas with zero coordination.
- **Postgres** — holds everything: per-project entity tables, embed cache (90-day TTL), alias history, pair history, scope thresholds, parse cache. **Needs the four extensions:** `vector ≥ 0.8`, `pg_trgm`, `unaccent`, `fuzzystrmatch`.

Bulk-import functionality (xlsx uploads, the 8-wave matcher, human resolution flow) lives in [`examples/bulk-import/`](../examples/bulk-import/) — a standalone Bun service with its own pg-boss queue + xlsx parser. It calls the matcher over HTTP. **Deploy it only if you need bulk imports**; the matcher works fine on its own for everything else.

The matcher process is horizontally scalable. Postgres is the single source of truth — back it up.

## Choose your path

| Path | Best for | Pros | Cons |
|---|---|---|---|
| [A. Docker compose on a VPS](#path-a--docker-compose-on-a-vps) | Solo / small-team production | Cheapest ($5-10/mo), no vendor lock-in, you own everything | You handle TLS, backups, monitoring yourself |
| [B. Fly.io](#path-b--flyio) | Quick managed deploy | Built-in managed Postgres, global edge, autoscale to zero | $5-30/mo; extension setup is manual |
| [C. Railway](#path-c--railway) | Click-to-deploy with a Dockerfile | Easiest UI; auto-TLS; database UI | $5+/mo; less Postgres control |
| [D. Render](#path-d--render) | Similar to Railway with free tier | Free hobby tier; managed Postgres with pgvector | Free Postgres expires after 90 days |
| [E. Hybrid — managed Postgres + Docker matcher](#path-e--hybrid--managed-postgres--docker-matcher) | Most teams in practice | Use Supabase / Neon / RDS for Postgres, run matcher anywhere | Two billing surfaces |
| [F. Kubernetes](#path-f--kubernetes) | Existing K8s shop | Fits existing tooling | Overkill for most teams; not provided as a Helm chart |

**Serverless paths** — Vercel Functions with the Bun runtime works out-of-the-box for the matcher (after the v1.2 extraction, no porting needed). See [Serverless deployment](#serverless-deployment-cloudflare-workers--vercel) below.

**Not recommended out-of-the-box** — and why:

- **Heroku** — most plans don't include `pgvector`. The `essential-0` and `mini` Postgres tiers don't support arbitrary extensions; Heroku's higher tiers do but cost more than Fly/Railway.

## Prerequisites for every path

Before deploying anywhere, have these ready:

1. **A real `SAMESAKE_API_KEY`** — generate with `openssl rand -hex 24`.
2. **A Gemini API key** from [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey). Or a Voyage / OpenAI key if you've configured those providers in your entity configs.
3. **Postgres ≥ 15** with the four extensions available.

The matcher boots clean against any Postgres that has the four extensions — its system migrations run automatically on first boot (`runSystemMigrations()` in `src/db/migrations.ts`).

## Path A — Docker compose on a VPS

Lowest friction. Get a small VPS (Hetzner CX11 €4/mo, DigitalOcean $6/mo, Linode $5/mo, Vultr $6/mo) and run:

```bash
git clone <your-fork-of-samesake> samesake
cd samesake
cp .env.example .env
# Edit .env:
#   SAMESAKE_API_KEY=<openssl rand -hex 24>
#   GOOGLE_GENERATIVE_AI_API_KEY=<your key>
# Edit docker-compose.yml:
#   POSTGRES_PASSWORD: <change from samesake_dev_password>

docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

The included `docker-compose.prod.yml` overlay adds `restart: unless-stopped` policies, requires `POSTGRES_PASSWORD` / `SAMESAKE_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` as env vars (no defaults), and binds the matcher to `127.0.0.1:3030` so it's only reachable through a reverse proxy.

### TLS via Caddy (one-line auto-HTTPS)

Install Caddy on the VPS, then `/etc/caddy/Caddyfile`:

```
samesake.yourdomain.com {
  reverse_proxy 127.0.0.1:3030
}
```

Caddy obtains and renews Let's Encrypt certificates automatically. `systemctl reload caddy` and the service is live at `https://samesake.yourdomain.com`.

### Backups

The repo ships `scripts/backup.sh` — runs `pg_dump` against the samesake container and writes a compressed dump to `./backups/`. Add to cron:

```cron
0 3 * * * cd /opt/samesake && ./scripts/backup.sh >> /var/log/samesake-backup.log 2>&1
```

Sync the `backups/` directory to S3 / Backblaze B2 / wherever — samesake doesn't ship a sync, that's your call.

### What this costs

| Component | Cost |
|---|---|
| VPS (1 vCPU / 2GB / 40GB) | $5-7/mo |
| Domain | $10-15/year |
| Gemini API | ~$0.04 per 30k embeddings; ongoing ~$2/mo at 1k matches/day with 80% cache hit |
| **Total** | **~$8-10/mo all-in** |

## Path B — Fly.io

Template ships at `fly.toml`. Real deploy:

```bash
fly launch --no-deploy --copy-config --name samesake

# Create + attach a managed Postgres in the same region
fly postgres create --name samesake-pg --org personal --region iad
fly postgres attach samesake-pg --app samesake

# ⚠️ GOTCHA: Fly's managed Postgres needs the extensions enabled manually
# as superuser BEFORE first boot, or the migration silently no-ops.
fly postgres connect -a samesake-pg
# In the psql prompt:
#   \c samesake
#   CREATE EXTENSION vector;
#   CREATE EXTENSION pg_trgm;
#   CREATE EXTENSION unaccent;
#   CREATE EXTENSION fuzzystrmatch;
#   \q

# Set secrets
fly secrets set GOOGLE_GENERATIVE_AI_API_KEY=<your-key>
fly secrets set SAMESAKE_API_KEY=$(openssl rand -hex 24)

# Deploy
fly deploy
```

The `fly.toml` template auto-stops the machine when idle and restarts on traffic — good for low-volume workloads (no charges when nothing is matching).

### Cost

| Component | Cost |
|---|---|
| `shared-cpu-1x` 512MB (auto-stop) | ~$0-3/mo |
| Managed Postgres (single node, smallest tier) | $5-7/mo |
| **Total** | **~$5-10/mo** |

Bursting to multiple machines or larger Postgres adds linearly.

## Path C — Railway

Railway auto-detects the `Dockerfile`. Steps:

1. Push the repo to GitHub.
2. New project on Railway → "Deploy from GitHub repo".
3. Add a Postgres service from the Railway marketplace — choose the **pgvector** template (Railway's standard Postgres also supports it but the pgvector template enables extensions out of the box).
4. Set env vars in the matcher service:
   - `SAMESAKE_DATABASE_URL` = Railway gives you a `DATABASE_URL` — copy/reference it
   - `SAMESAKE_PORT=3030`
   - `SAMESAKE_API_KEY=$(openssl rand -hex 24)` — generate locally first
   - `GOOGLE_GENERATIVE_AI_API_KEY=<your-key>`
5. Set `PORT` exposure on the matcher to 3030.
6. Deploy. Railway gives you `https://<service>.up.railway.app` with auto-TLS.

### Cost

Railway has a $5/mo usage credit on the hobby plan; one matcher + one Postgres typically lands at $5-15/mo depending on traffic.

### Gotchas

- Railway's standard Postgres requires `CREATE EXTENSION` to be run by the service user; the pgvector template does this for you.
- pg-boss creates its own `pgboss` schema on first boot — make sure your Postgres user has `CREATE` privilege.

## Path D — Render

Render's blueprint deploys aren't first-class for Bun yet, so use the manual path:

1. New Web Service → connect repo → environment "Docker".
2. Add a Postgres database from the Render dashboard. **Render Postgres includes `pgvector`** out of the box on every plan (including free).
3. Set env vars on the web service:
   - `SAMESAKE_DATABASE_URL` from the database "Internal Database URL"
   - `SAMESAKE_PORT=3030`
   - `SAMESAKE_API_KEY` and `GOOGLE_GENERATIVE_AI_API_KEY` as above
4. Deploy.

### Gotchas

- **Free tier Postgres expires after 90 days.** This is fine for a demo; not fine for production.
- Free tier web services spin down after 15 minutes of inactivity — the first request after spin-down takes ~30s.
- The other three extensions (`pg_trgm`, `unaccent`, `fuzzystrmatch`) are also pre-installed on Render Postgres.

## Path E — Hybrid: managed Postgres + Docker matcher

Most production teams end up here: keep the matcher cheap and portable (any container host), but pay a managed Postgres provider for backups, replicas, point-in-time recovery.

### Managed Postgres options (all support the four extensions)

| Provider | Pros | Cons | Cost |
|---|---|---|---|
| **Supabase** | Great UI, pooler, REST API on top of the same DB | Project ID is in connection string; budget for compute upgrades | Free tier with pgvector; $25+/mo paid |
| **Neon** | Branching, scale-to-zero, generous free tier | Slightly higher cold-start latency | Free tier with pgvector; $19+/mo |
| **AWS RDS** | Battle-tested; PITR; replicas | More expensive; pgvector needs to be enabled via parameter group | $15+/mo (t4g.micro) |
| **Google Cloud SQL** | Same as RDS conceptually | Same enable-extension dance | $15+/mo |
| **Crunchy Data** | Postgres-focused vendor; first-class pgvector | More expensive than the hyperscalers | $20+/mo |

### Matcher hosting

The Docker container runs anywhere — same `docker-compose.prod.yml` minus the postgres service. Or use any of paths A/B/C/D with `SAMESAKE_DATABASE_URL` pointing at the managed instance.

### Why this is most common

- Backups + PITR + replication are hard to do well yourself
- The matcher is stateless so swap hosts at will
- Bills are predictable: one Postgres line item, one container line item

## Path F — Kubernetes

No Helm chart ships. The shape is straightforward:

- **Deployment** for the matcher (replicas: 1-3; pg-boss handles cross-replica job locking via Postgres advisory locks)
- **Service** + **Ingress** (TLS via cert-manager)
- **Secret** for `SAMESAKE_API_KEY` + `GOOGLE_GENERATIVE_AI_API_KEY` + `SAMESAKE_DATABASE_URL`
- Postgres: external (managed) or in-cluster (CrunchyData PGO, Zalando postgres-operator)

If you're running 2+ matcher replicas at high volume, consider splitting one replica into a **worker-only** deployment (start the process with an env var that disables HTTP route registration) so the pg-boss worker pool doesn't contend with request handling. **This is not currently a built-in switch** — you'd need to patch `src/index.ts` to skip Elysia setup when `SAMESAKE_WORKER_ONLY=1`. PRs welcome.

## Production hardening (applies to every path)

### Secrets management

| Secret | Source | Notes |
|---|---|---|
| `SAMESAKE_API_KEY` | `openssl rand -hex 24` | Bearer auth for the API. Rotate by setting a new value and updating consumer code. |
| `GOOGLE_GENERATIVE_AI_API_KEY` | aistudio.google.com | Required for `providers.gemini.*`. |
| `VOYAGE_API_KEY` | voyageai.com | Optional — only if your entity configs use Voyage. |
| `OPENAI_API_KEY` | platform.openai.com | Optional — only if your entity configs use OpenAI. |
| `SAMESAKE_DATABASE_URL` | Your Postgres host | Use the **non-pooler** URL in production for pg-boss (advisory locks need session-level connections). |

**Never commit `.env`.** The repo's `.gitignore` covers `.env`; double-check your fork.

### Backups

samesake holds everything in Postgres. A nightly `pg_dump` is sufficient for most workloads:

```bash
./scripts/backup.sh
```

The included script dumps to a compressed file under `./backups/`. **Important:** the embed cache (~$0.50-5 to rebuild per million entries) and the pair history (the user-feedback signal you've spent months collecting) both live in Postgres. Losing the DB means losing both. Sync `./backups/` to off-host storage (S3, B2, rsync.net).

For zero-downtime backup of large databases, use `pg_basebackup` or a managed provider's PITR.

### Observability

The matcher writes structured-ish logs to stdout. No metrics endpoint ships. Cheap wins:

- **Logs** — route `stdout` to your log aggregator of choice. Fly / Railway / Render capture stdout automatically. On a VPS, `journalctl -u docker` shows everything; for structured aggregation use Loki or Datadog Agent.
- **Uptime** — point UptimeRobot / Better Stack / Cronitor at `GET /v1/healthz`. The endpoint returns 200 with Postgres version + extension list when healthy.
- **Cost dashboard** — Gemini billing lives at console.cloud.google.com. Set a budget alert at $20/mo to start; raise it if usage is real.

### TLS termination

The matcher listens HTTP only. In production, terminate TLS in front:

- **Caddy** — easiest, auto-HTTPS, one-line config (see Path A).
- **Cloudflare Tunnel** — free TLS + DDoS in front of any backend, no public IP required.
- **nginx + certbot** — classic, more config.
- **AWS ALB / GCP HTTPS LB** — if you're already on those clouds.

### Scaling

The matcher is stateless. To scale:

- **Vertical** — bump the container's CPU/memory. Most workloads fit in 512MB-1GB.
- **Horizontal** — run 2-3 replicas behind a load balancer. pg-boss's advisory-lock-based job claim works correctly across replicas (one job, one worker).
- **Beyond 3 replicas** — split into HTTP-only and worker-only processes (see Path F). Not built-in yet; PR welcome.

The actual bottleneck is usually the embedding provider (Gemini rate limits at ~1500 RPM on the free tier, much higher paid). Cache hit rates of 70-90% are normal in production once `pair_history` is populated; the bulk-import 8-wave matcher avoids the embedding API entirely for the first 5 waves.

### Rate limiting

No built-in rate limiter. Options:

- Cloudflare in front (free) — set a rule like "max 100 requests/min per IP to `/v1/match`".
- nginx `limit_req_zone`.
- Bearer-token-based limits in a sidecar.

### Migrating between hosts

The matcher's state lives entirely in Postgres. To migrate:

1. `pg_dump` from the old DB
2. `pg_restore` into the new DB
3. Confirm the four extensions exist in the new DB
4. Point the new matcher's `SAMESAKE_DATABASE_URL` at the new DB
5. Cut over

No code changes, no schema migrations — the per-project schemas dump and restore cleanly.

## Serverless deployment (Cloudflare Workers / Vercel)

Since the v1.2 extraction (pg-boss + xlsx moved to [`examples/bulk-import/`](../examples/bulk-import/)), **the matcher itself is pure stateless** — no long-lived workers, no in-process queues, no module-load-time DB polling. Serverless deploys "just work" for the matcher; if you also want bulk imports, run the example as a separate always-on container alongside.

### Path A — Vercel Functions (Bun runtime) — RECOMMENDED for serverless

Vercel ships first-party Bun runtime via `"bunVersion": "1.x"` in `vercel.json` (Fluid compute, supports the existing Elysia + postgres-js + ai-sdk stack as-is). The matcher's `app.handle(request)` is Web-standard and slots straight into Vercel's `{ fetch(request) }` handler shape.

Minimal `vercel.json` + `api/index.ts`:

```json title="vercel.json"
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "bunVersion": "1.x",
  "buildCommand": "bun build src/index.ts --target=bun --outfile=dist/server.js",
  "rewrites": [{ "source": "/(.*)", "destination": "/api" }]
}
```

```ts title="api/index.ts"
// @ts-ignore — generated by the build command above
import { app } from "../dist/server.js";

export default {
  async fetch(request: Request): Promise<Response> {
    return (app as { handle: (req: Request) => Promise<Response> }).handle(request);
  },
};
```

The `bun build --target=bun` step bundles the whole matcher into one self-contained file — this is the canonical fix for Vercel's per-file transpilation not rewriting cross-file `.ts` extension imports. Without the bundle, Vercel produces `.js` files that still contain `import "../something.ts"` and runtime fails with `ResolveMessage`.

Deploy:

```bash
vercel link --yes --project samesake
vercel env add SAMESAKE_DATABASE_URL production       # postgres://... (Neon recommended)
vercel env add SAMESAKE_API_KEY production            # openssl rand -hex 24
vercel env add GOOGLE_GENERATIVE_AI_API_KEY production
vercel deploy --prod
```

**Vercel-specific notes:**

- `bunVersion: "1.x"` is currently the only valid value (Vercel pins major; manages minor/patch automatically).
- 60s default per-request execution (configurable up to 15 min on Pro/Enterprise). `/match` typically takes 1-2 s end to end; fits comfortably.
- 50 MB bundle limit; the matcher (without `xlsx` / `pg-boss` since v1.2) lands around ~2.3 MB.
- Cold starts ~100-400 ms on Fluid compute.
- Vercel Postgres = Neon under the hood; pgvector pre-installed.
- For higher concurrency: swap `postgres-js` for `@neondatabase/serverless` (Neon's edge driver). The matcher uses standard SQL throughout — driver swap is a one-line change in `src/db/client.ts`.

### Path B — Cloudflare Workers (workerd runtime)

`workerd` runs V8 + Web standards, **not Bun**. That means more porting work — but the cold start win is significant.

Required changes:

1. **Replace `Bun.serve`'s usage and the `.listen()` chain** with a workerd-compatible adapter. Elysia ships adapters for multiple runtimes; the simplest path is a thin Hono port of the matcher routes (~250 lines for the full surface).
2. **Swap `postgres-js`** for the Neon serverless driver, OR use Cloudflare Hyperdrive (terminates Postgres connections at the edge, your Worker uses standard SQL).
3. **Cron Triggers** for periodic `/calibrate`.

Cold starts ~5-50 ms (V8 isolate). 30 s CPU per request (paid plan; 10 s free). 10 MB bundle (free) / 50 MB (paid).

**No in-tree Cloudflare adapter ships.** PRs welcome.

### Path C — Hybrid (serverless API + bulk-import container)

If you want serverless online traffic + bulk imports, deploy both:

```
  ┌─────────────────────────┐         ┌─────────────────────────────┐
  │ Vercel Function /       │         │ Bulk-import container       │
  │ Cloudflare Worker       │         │ (Fly machine $3/mo or       │
  │   matcher only          │         │  $5/mo VPS)                 │
  │   (request-response)    │         │   examples/bulk-import/     │
  └────────────┬────────────┘         │   pg-boss + xlsx + own DB   │
               │                      │   schema                    │
               │                      └──────────────┬──────────────┘
               │                                     │
               └────────────────┬────────────────────┘
                                ▼
                    ┌──────────────────────┐
                    │ Managed Postgres     │
                    │ (Supabase / Neon /   │
                    │  Render / RDS)       │
                    └──────────────────────┘
```

The bulk-import container talks to the matcher over HTTP (it doesn't share code; just hits `/match-batch` + `/confirm`). Both connect to the same Postgres for their respective schemas. This is the pattern the v1.2 extraction was designed for.

### Path D — Just use Fly auto-stop (zero porting)

If "serverless" means "I want to pay $0 when nothing's happening," Fly Machines' `auto_stop_machines = true` already does that — the matcher boots in ~1.5 s when a request lands and stops after idle. **No code changes required.** The shipped `fly.toml` already configures this.

For most workloads this is functionally serverless and costs less effort than any of the above.

### Recommendation

- **Already on Vercel?** → Path A. The matcher is now a pure stateless function and slots in cleanly.
- **Already on Cloudflare?** → Path B if cold-start latency matters; otherwise Path D (Fly auto-stop).
- **Need bulk imports too?** → Path C (serverless matcher + bulk-import container).
- **Starting fresh and "cheap when idle" is the goal?** → Path D. No porting, no extra moving parts.

## Verifying a deployment

After deploying, run these against the deployed URL:

```bash
DEPLOY_URL=https://samesake.yourdomain.com
KEY=<your SAMESAKE_API_KEY>

# 1. Health
curl -sf $DEPLOY_URL/v1/healthz | jq

# 2. Auth
curl -sf $DEPLOY_URL/v1/projects/foo/schema -H "Authorization: Bearer $KEY"
# (404 is fine here — proves auth passed and the route is wired)

# 3. Apply a schema and run a match
SAMESAKE_URL=$DEPLOY_URL SAMESAKE_API_KEY=$KEY bun examples/hello/run.ts
```

The smoke test runs against any reachable URL. If it shows `19 passed, 0 failed`, the deploy is functionally identical to local.

## Cost summary

| Workload | Self-host (Path A) | Fly.io (B) | Railway (C) | Hybrid (E) |
|---|---|---|---|---|
| Solo dev (occasional matches) | $5-10/mo | $5-8/mo | $5/mo | $5/mo |
| Small SaaS (1k matches/day) | $10-15/mo | $10-15/mo | $10-20/mo | $20-30/mo |
| Heavy use (100k matches/day) | $40-80/mo + Gemini bill | $40-100/mo | $50-150/mo | $50-100/mo |

Gemini API is usually the dominant cost above ~10k matches/day. Cache hits drive it down dramatically — `pair_history` warmup pays off fast.

## See also

- [`README.md`](../README.md) — quickstart and feature overview
- [`docs/tutorial.md`](./tutorial.md) — fifteen minutes from clone to first match
- [`docs/premise.md`](./premise.md) — what samesake is and is not
- [`Dockerfile`](../Dockerfile) — the matcher image
- [`docker-compose.yml`](../docker-compose.yml) — dev compose stack
- [`docker-compose.prod.yml`](../docker-compose.prod.yml) — production overlay
- [`fly.toml`](../fly.toml) — Fly.io template
- [`scripts/backup.sh`](../scripts/backup.sh) — pg_dump backup helper
# OBSOLETE: historical deployment notes

This document is archived for history only. It references removed server
architecture and must not be used for current deployment guidance.
