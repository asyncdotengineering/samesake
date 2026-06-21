# docs-pipeline-queues — implementation notes

## Assumptions
- Project/collection names use `"market"` / `"products"` to match marketplace-search exemplar.
- Matcher best defaults: `gemini-embedding-2`, `gemini-3.1-flash-lite`, `fashionRerank(generate)`.
- Catalog row fetchers (`fetchChangedRows`, `rowFromWebhook`) are illustrative stubs — same pattern as marketplace-search.

## Deviations
- Inngest `concurrency: 1` (integer form per Inngest docs; equivalent to `{ limit: 1 }`).
- Upstash: separate workflow routes for sync vs maintenance (clearer QStash schedule targets than one route with branching).
- Vercel: noted Workflow DevKit evolves quickly; linked official Next.js getting-started rather than pinning plugin config.

## APIs re-verified
| Platform | Source | Confirmed |
|----------|--------|-----------|
| Inngest | Context7 `/websites/inngest` | `createFunction`, `triggers: [{ cron \| event }]`, `step.run`, `serve({ client, functions })`, `concurrency` |
| Upstash | Context7 `/websites/upstash_workflow` | `serve`, `context.run`, `Client.trigger`, `client.schedules.create`, `WorkflowNonRetryableError` |
| Cloudflare | Context7 `/websites/developers_cloudflare_workflows` | `WorkflowEntrypoint`, `step.do` + retries config, `schedules` in wrangler, `env.BINDING.create` |
| Vercel | Context7 `/vercel/workflow` | `"use workflow"`, `"use step"`, `FatalError`, `sleep`, `start()` from `workflow/api` |

## Could not fully confirm in-repo
- Vercel Cron `CRON_SECRET` header behavior — documented as best practice; see Vercel cron docs.
- Exact Workflow DevKit Next.js plugin/wrangler config for v5 — page links to useworkflow.dev getting-started.

## Verification
- `cd apps/docs && bun run build` — exit 0, all 6 new pages in build output.
