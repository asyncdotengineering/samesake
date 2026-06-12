# @samesake/jobs-pgboss

**Experimental** — optional pg-boss adapter for `@samesake/server`'s `JobRunner` seam. Not required for 1.0 core publish; integration tests skip unless `PGBOSS_TEST_URL` or `DATABASE_URL` points at direct Postgres (LISTEN/NOTIFY; pooled-only URLs fail).

```ts
import { createMatcher } from "@samesake/server";
import { createPgBossRunner } from "@samesake/jobs-pgboss";

const jobs = await createPgBossRunner({ connectionString: process.env.DATABASE_URL! });
const matcher = createMatcher({ databaseUrl: process.env.DATABASE_URL!, apiKey: "...", embed, jobs });
```

`run()` resolves when the job completes. pg-boss is isolated to this package.

**Neon pooled connections:** pg-boss needs a direct Postgres connection for LISTEN/NOTIFY. Use a non-pooled `DATABASE_URL` when possible.
