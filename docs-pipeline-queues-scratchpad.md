# docs-pipeline-queues scratchpad

## Done
- enrich-pipeline.mdx (parent concept + platform table)
- pipeline-in-memory.mdx
- pipeline-inngest.mdx
- pipeline-upstash.mdx
- pipeline-cloudflare-workflows.mdx
- pipeline-vercel-workflows.mdx
- astro.config.mjs sidebar group "Running the pipeline"
- docs build verified (exit 0)

## API verification (Context7)
- Inngest: triggers array, step.run, concurrency, serve from inngest/next
- Upstash: context.run, serve, Client.trigger, schedules.create, WorkflowNonRetryableError
- Cloudflare: step.do, schedules in wrangler.toml, env binding create
- Vercel: use workflow/use step, FatalError, sleep, start from workflow/api, vercel.json crons

## Flagged (not guessed)
- Vercel Workflow DevKit setup/plugin details — linked to official getting-started; start() API confirmed via Context7/gh
