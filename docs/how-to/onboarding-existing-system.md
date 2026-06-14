---
title: Onboarding samesake into an existing system
description: A step-by-step operational playbook for adding samesake to a production application — schema design through bootstrap through cut-over through ongoing sync. Audience: engineers integrating the matcher into a system that already has data.
---

# Onboarding samesake into an existing system

This guide is the operational playbook for a team that has:

- An existing application with a production database
- Entities in that database that need fuzzy / cross-language matching (customers, suppliers, products, parties, etc.)
- Some volume of historical data already accumulated
- Users actively creating + editing entities now

…and wants to add samesake to handle the matching, without disrupting what's already running.

The path has **four phases**. Skip ahead to whichever one you're on:

1. **[Prepare](#phase-1-prepare)** — schema design, AI wiring, database setup, threshold strategy
2. **[Bootstrap](#phase-2-bootstrap-the-initial-data-load)** — load every existing entity into the matcher's index before going live
3. **[Go live](#phase-3-go-live-cut-over)** — add the matcher to read paths; switch on forward sync
4. **[Keep in sync](#phase-4-keep-everything-in-sync)** — outbox + worker, plus updates, deletes, reconciliation, calibration

Plus an [operational concerns](#operational-concerns) appendix.

Worked references in this repo: [`examples/hello/`](../../examples/hello/) (match smoke), [`examples/quickstart/`](../../examples/quickstart/) (smallest entity config), and [`examples/hello-search/`](../../examples/hello-search/) (collection search smoke).

---

## Phase 1: Prepare

### 1.1 Pick a deployment shape

samesake exposes the matcher through one factory with three surfaces (in-process function calls, a Web-standard `fetch` handler, and a mountable Hono `app`). You have 11 deployment shapes available — see [usage-patterns.md](../usage-patterns.md) for the full table.

For most existing systems, two shapes cover 99% of cases:

- **Mounted inside your existing app** (pattern 3 / 4) — your service already has Hono / Express / Fastify; mount the matcher's routes inside, share connections, call `matcher.match()` in-process for hot paths. See [`scripts/blueprints/03-mounted-hono.ts`](../../scripts/blueprints/03-mounted-hono.ts).
- **Standalone HTTP service** (pattern 2 / 5 / 7) — the matcher runs as its own process. Your app talks to it over HTTP. Use when you have multiple consumers, want service-level isolation, or want to scale matcher and app independently.

Decide before designing entities, because the answer affects how you wire `embed` and `parse`.

### 1.2 Pick AI providers (embed + parse)

samesake doesn't bundle any LLM SDK. You supply two functions:

- **`embed`** — required. Turns a string into a vector. Used for every match query and every entity ingest.
- **`parse`** — required only if any entity has a `parse:` block. Extracts structured fields (brand, size, code) from product/asset names.

[`docs/recipes/`](../recipes/) has copy-paste starters for Vercel AI SDK + Gemini / OpenAI / Voyage, local Ollama, and a deterministic stub for tests. Pick one based on:

- **Cost per match.** Embed calls dominate; parse is rarer but more expensive per call. Gemini's `gemini-embedding-001` at $0.000025 / 1K input chars is the cheapest reasonable default.
- **Multilingual support.** If your data spans scripts (Sinhala / Tamil / Hindi / Arabic / Chinese), Gemini and Voyage are stronger than OpenAI on cross-script.
- **Latency.** Embeds are ~50–200ms; parse is ~1–3s. Cache hit rates dominate after the first weeks.
- **Data-residency requirements.** Air-gapped or regulated? Use Ollama with `nomic-embed-text` locally. See [`docs/recipes/embedder-ollama.ts`](../recipes/embedder-ollama.ts).

You can mix providers: route short text to Gemini, long text to a stronger model, tests to a deterministic stub. See blueprint 11 ([`scripts/blueprints/11-mixed-providers.ts`](../../scripts/blueprints/11-mixed-providers.ts)).

### 1.3 Database setup

The matcher needs a Postgres database with `pgvector`, `pg_trgm`, `unaccent`, and `fuzzystrmatch` extensions. Two architectures:

**Option A — Matcher gets its own database** (recommended).

```
your_app_db                matcher_db
├── customers              ├── samesake_projects
├── orders                 ├── samesake_embed_cache
├── ...                    ├── samesake_parse_cache
                           └── project_<your_slug>.entity_<kind>, etc.
```

Pros: clean isolation, the matcher's vector indexes don't compete with your app's queries, easier to back up / migrate independently, cleaner versioning.

Cons: one more database to operate; cross-DB joins impossible (rarely needed in practice).

**Option B — Shared database, separate schema**.

```
your_app_db
├── public.customers, orders, ...
├── samesake_sys.*            ← matcher's system tables
└── project_<your_slug>.*     ← per-project entity tables
```

Pros: one DB to operate, app and matcher can transact together (rare but useful for some sync patterns).

Cons: vector and trigram indexes live in the same instance as your transactional tables — watch for contention. Backups grow large. Migrations get tangled.

Pick Option A unless you have a specific reason not to. The schema names below assume A; for B, replace `samesake_dev` with your app DB and use `SAMESAKE_SCHEMA=samesake_sys` (or similar) to namespace.

### 1.4 Design your entity declarations

For each thing in your data that needs fuzzy matching, declare an entity in your `samesake.config.ts`. The decision tree:

```
Is this a person / counterparty / supplier-type thing
(matched by name, occasionally phone)?
   → people-shape entity
   → fields: name, phone?, email?, address?, ...
   → embeddings: { name_emb: { source: "name", model, dim } }
   → phonetic: { name_phon: { source: "name", algorithm: "indic-soundex" } }
   → scoring: phoneExact + cosine + trigram + aliasHit + phoneticEq

Is this an inventory item / SKU / product
(has internal structure: brand, size, code)?
   → parse-shape entity
   → fields: name, unit?, qty?, price?, ...
   → parse: { model: "gemini-2.5-flash-lite" }
   → embeddings: { item_emb, full_emb } (TWO cosines — see explanation/matcher-channels.md)
   → scoring: internalCodeExact + sizeUnitGate + brandGate + 2x cosine + trigram + aliasHit

Is this a record with strong unique identifier
(invoice_no, NDC, SKU)?
   → people-shape but with the identifier as a regular field
   → If identifier match should auto-link → use phoneExact-style channel
   → If identifier match should short-circuit → use internalCodeExact + shortCircuit:true
```

The [explanation docs on channels](../explanation/matcher-channels.md) cover why each channel exists. Once you've picked the shape, your declarations look like the [hello example entities](../../examples/hello/samesake.config.ts) — 3 different kinds in one project, each tuned to its data.

### 1.5 Decide scopes

`scopes` is the per-entity multi-tenancy boundary. Every record carries a `scope` JSON; matches only return rows in the same scope.

- **Single-tenant app** — `scopes: ["tenant_id"]` (always one tenant, but declare it anyway for future-proofing)
- **Multi-tenant SaaS** — `scopes: ["org_id"]` or `scopes: ["workspace_id"]`
- **Multi-tenant with sub-scopes** — `scopes: ["org_id", "shop_id"]` (a customer of org A's shop X is invisible to org A's shop Y)
- **Cross-tenant matching** (deduplication across tenants) — leave scopes empty `scopes: []`

Once chosen, this is hard to change without a re-apply + reseed. Pick conservatively — over-scoping is easy to relax later; under-scoping leaks data between tenants.

### 1.6 Initial threshold strategy

samesake has two thresholds per scope:

- **`autoLinkThreshold`** — above this, the matcher considers the top candidate auto-resolvable (`r.resolved` is set). Default 0.92.
- **`suggestThreshold`** — above this, the candidate appears in `r.candidates`. Default 0.55.

For a new system without labelled history, you can't calibrate yet. Set sensible defaults at boot via the wildcard scope (`{}`):

```ts
import { ENTITIES, ENTITY_KINDS } from "./samesake.config";

await matcher.apply("your_project", ENTITY_KINDS.map((k) => ENTITIES[k]));

const SHAPE_DEFAULTS = {
  // parse-shape — products + invoices benefit from stricter cutoffs
  inventory_item: { auto: 0.85, suggest: 0.55 },
  invoice:        { auto: 0.85, suggest: 0.55 },
  // people-shape — depends on whether you expect multilingual data
  // (see docs/explanation/tuning-channel-weights.md for empirical tuning)
  customer:       { auto: 0.85, suggest: 0.55 },
  supplier:       { auto: 0.85, suggest: 0.55 },
};

for (const [kind, t] of Object.entries(SHAPE_DEFAULTS)) {
  await matcher.setScopeThresholds({
    project: "your_project", kind, scope: {},
    autoLink: t.auto, suggest: t.suggest,
  });
}
```

These will be wrong-by-some-amount for your data. The plan is to calibrate them later (Phase 4.7) once you have real `confirm()` / `decline()` history.

### 1.7 Run pre-deployment migrations

samesake's system tables (caches, the projects registry, the alias / pair-history / scope-thresholds tables) need to exist before the app starts. Run them as a separate deploy step:

```bash
# In your CI pipeline, before booting the app
bunx samesake migrate --schema=samesake_sys
```

Or programmatically from a deploy script:

```ts
import { prepareMigrations } from "@samesake/server";

await prepareMigrations({
  databaseUrl: process.env.MATCHER_DB_URL!,
  schema: "samesake_sys",  // same one your app will use
});
```

This creates the system DDL (4 tables + 3 SQL functions) inside `samesake_sys`. Idempotent — safe to run on every deploy. Use `migrate: "manual"` on your app's `createMatcher` after this so the app doesn't try again on startup.

---

## Phase 2: Bootstrap the initial data load

This is where most onboardings get nervous, and it's actually the simplest phase. Your goal: every existing entity in your DB ends up in the matcher's per-project entity tables (with embeddings, phonetic hashes, etc.) before you switch on matching.

### 2.1 Decide what counts as "the initial data"

Decide your snapshot boundary. Options:

- **Hard cut-off** (preferred): "everything in `customers` as of timestamp T." Take the snapshot, load it, then turn on forward sync starting at T.
- **Rolling load with sync running**: turn on forward sync first (writes new entities into a queue), then backfill. The queue absorbs concurrent writes; you reconcile at the end.

For a system that's actively being written to, the rolling-load approach is gentler. For a quiet migration window, the hard cut-off is simpler. Either works.

### 2.2 Backfill via `upsertBatch`

samesake's `matcher.upsertBatch` accepts an array of items and runs the parse + embed + insert flow per row. For people-shape entities this is fast (embed only). For parse-shape entities this is slow (parse + 2× embed per item) — budget accordingly.

Batch sizes:

```ts
const BATCH = 50;
for (let i = 0; i < customers.length; i += BATCH) {
  const slice = customers.slice(i, i + BATCH);
  await matcher.upsertBatch(
    { project: "your_project", entity: customer },
    slice.map((row) => ({
      id: String(row.id),                  // your DB's primary key — preserved as external_id
      scope: { tenant_id: row.tenant_id },
      data: {
        name: row.name,
        phone: row.phone,
        email: row.email,
        // any other entity fields you declared
      },
    }))
  );
  console.log(`backfilled ${i + slice.length} / ${customers.length}`);
}
```

Key points:

- **Use your existing PK as `id`** — samesake stores it as `external_id` and you keep your foreign keys intact. Don't generate new IDs.
- **Set `id` always** — without it, `upsertBatch` inserts duplicates on retry. With it, retries idempotent-update the existing row.
- **Idempotent on retry** — if a backfill batch fails halfway, re-run from the same offset. The matcher's `ON CONFLICT (external_id) DO UPDATE` handles it cleanly.

### 2.3 Track progress + handle errors

Bootstrap a few-million-row DB will take hours. Track it:

- Log progress every batch
- Persist the offset to a separate table (`samesake_backfill_state`) so you can resume after a crash
- Tail the embed cache hit rate (it should be 0% for the backfill since these are first-time embeddings)
- Watch your AI provider's rate limits — Gemini's free tier is ~15 req/min, the paid tier is 1000+ req/min; provision accordingly

For parse-shape entities, parsing dominates cost. If you have 100K SKUs and Gemini parse is ~$0.0001/call, that's ~$10 for the backfill. Plan for it.

### 2.4 Validate the index post-load

After backfill completes, do a sanity sweep:

```sql
-- Count check: matcher row count must match your source
SELECT count(*) FROM project_<slug>.entity_customer;
-- → should equal SELECT count(*) FROM your_app.customers

-- Spot check: a known customer is queryable
SELECT * FROM project_<slug>.match_customer(
  '{"tenant_id":"t1"}'::jsonb,
  'a known customer name',
  '<embedding vector>'::vector,
  NULL,  -- no phone hint
  5      -- limit
);
```

Or programmatically:

```ts
const r = await matcher.match({
  project: "your_project",
  kind: "customer",
  text: "a known customer name",
  scope: { tenant_id: "t1" },
});
console.assert(r.candidates[0]?.entityId === "<expected id>");
```

Sample 20–50 known rows from your DB and verify each resolves to itself at high confidence. If something's off, fix it before going live.

### 2.5 What to do if the backfill is huge

For >1M rows, two acceleration patterns:

- **Embeddings in parallel batches**: spin up 5–10 backfill workers with disjoint offset ranges. Each worker has its own DB connection; the embed cache deduplicates anyway.
- **Skip parse-shape backfill until needed**: parse-shape entities (medications, products) can be backfilled with `parse: ` left as a stub initially. Existing rows live in the entity tables without parsed fields; queries against them get parsed at match time and the parsed fields get filled on first hit via `matcher.upsertOne` from your app. The matcher will surface them in matches based on cosine + name; just less precise.

---

## Phase 3: Go live (cut-over)

The bootstrap is done. Now you switch your app's read + write paths to involve the matcher.

### 3.1 Two cut-over patterns

**Parallel-run (recommended for high-stakes systems).**

1. Your app's existing code keeps working unchanged.
2. Add `matcher.match()` calls to your write paths in **shadow mode** — call the matcher, log what it would have done, but use your old logic. Compare results offline for a week.
3. When you trust the matcher, flip the flag — the matcher's decision becomes authoritative.

This is essential for production systems where a bad matcher decision (auto-linking the wrong customer) has irreversible business consequences.

**Direct cut-over.**

1. Deploy code that uses the matcher's decision.
2. Watch metrics like a hawk for the first 24h.
3. Have a feature flag that reverts to old logic if anything looks off.

Use direct cut-over for non-critical paths (search-as-you-type, suggested-customer dropdowns) where wrong matches are recoverable.

### 3.2 Add the matcher to your write paths

Wherever your app creates a new entity, you have a decision: is this actually a new customer, or did someone re-enter an existing one?

```ts
// In your "create customer" handler:
const r = await matcher.match({
  project: "your_project",
  kind: "customer",
  text: req.body.name,
  scope: { tenant_id: req.user.tenant_id },
  opts: { phone: req.body.phone },
});

if (r.resolved) {
  // Top candidate is above the auto-link threshold.
  // Don't create a new customer — link this transaction to r.resolved.entityId.
  await createOrderForCustomer(r.resolved.entityId, req.body.order);
  return res.json({ linked: true, customerId: r.resolved.entityId });
}

if (r.candidates.length > 0) {
  // Ambiguous — surface candidates to the user.
  return res.status(409).json({
    suggestion: r.candidates,
    message: "Did you mean one of these?",
  });
}

// Genuinely new — create + ingest into the matcher.
const newId = await createCustomerInYourDB(req.body);
await matcher.upsertOne(
  { project: "your_project", entity: customer },
  { id: newId, scope: { tenant_id: req.user.tenant_id }, data: req.body }
);
return res.json({ created: true, customerId: newId });
```

The `match → resolved/candidates/new` decision tree is the heart of every consumer integration.

### 3.3 Wire up forward sync

Every write that goes into your app's DB also needs to land in the matcher's index. There are three patterns; for production we **strongly recommend the outbox pattern**. See Phase 4.

---

## Phase 4: Keep everything in sync

After cut-over, your app keeps creating + editing + deleting entities. The matcher's index must follow. This is forever; do it right.

### 4.1 The outbox pattern (recommended)

> **Why this and not write-through?** A direct sync RPC inside your write path means: matcher down → your app can't write. Outbox means: matcher down → writes queue up and drain when it's back. Same final state, no coupling between your app's availability and the matcher's.

The shape:

1. Every write to your entity tables ALSO writes a row to an `outbox` table — both in the same transaction.
2. A background worker drains the outbox, calls `matcher.upsertOne` for each row, marks it drained.
3. Failed drains stay un-drained (with the error logged) and retry on the next tick.

Schema:

```sql
CREATE TABLE outbox (
  id           bigserial PRIMARY KEY,
  entity_kind  text NOT NULL,
  action       text NOT NULL,                -- 'upsert' | 'delete'
  external_id  text NOT NULL,
  scope_json   jsonb NOT NULL,
  data_json    jsonb NOT NULL,
  enqueued_at  timestamptz DEFAULT now(),
  drained_at   timestamptz,
  error        text
);
CREATE INDEX outbox_pending ON outbox(enqueued_at) WHERE drained_at IS NULL;
```

The schema above is the canonical reference.

### 4.2 Two ways to write to the outbox

**Application-managed** (cleanest):

```ts
// Wrap your entity write + outbox enqueue in one transaction.
await db.transaction(async (tx) => {
  await tx.insert(customers).values({ name, phone, email });
  await tx.insert(outbox).values({
    entity_kind: "customer",
    action: "upsert",
    external_id: newId,
    scope_json: { tenant_id },
    data_json: { name, phone, email },
  });
});
```

Visible, debuggable, fully under your control.

**Trigger-based** (zero app-code changes):

```sql
CREATE OR REPLACE FUNCTION outbox_enqueue_customer()
RETURNS trigger AS $$
BEGIN
  INSERT INTO outbox(entity_kind, action, external_id, scope_json, data_json)
  VALUES ('customer', TG_OP::text,
          NEW.id::text, jsonb_build_object('tenant_id', NEW.tenant_id),
          to_jsonb(NEW));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER customer_outbox_trg AFTER INSERT OR UPDATE ON customers
FOR EACH ROW EXECUTE FUNCTION outbox_enqueue_customer();
```

Pros: works for ANY write to the table, including from migrations, manual SQL, third-party tools. Pros: no app code changes per entity.

Cons: less visible; trigger debugging is harder than function debugging; hard to handle "skip sync for this special case."

**Pick application-managed unless you have writes that bypass your app code** (legacy admin tools, manual SQL, third-party imports). In those cases, triggers are the only safe path.

### 4.3 The sync worker

A small process / goroutine / Node worker that polls the outbox and drains it:

```ts
async function syncWorker() {
  while (true) {
    const pending = await db.select().from(outbox)
      .where(isNull(outbox.drained_at))
      .orderBy(asc(outbox.id))
      .limit(50);

    if (pending.length === 0) {
      await sleep(500);  // safety tick; LISTEN/NOTIFY wakes us sooner
      continue;
    }

    for (const row of pending) {
      try {
        if (row.action === "upsert") {
          await matcher.upsertOne(
            { project: "your_project", entity: ENTITIES[row.entity_kind] },
            { id: row.external_id, scope: row.scope_json, data: row.data_json }
          );
        } else if (row.action === "delete") {
          // No matcher.delete() yet — manual SQL until samesake adds it
          await matcherDb.execute(sql`
            DELETE FROM ${sql.identifier(`project_your_project`)}.${sql.identifier(`entity_${row.entity_kind}`)}
            WHERE external_id = ${row.external_id}
          `);
        }
        await db.update(outbox).set({ drained_at: new Date() })
          .where(eq(outbox.id, row.id));
      } catch (e) {
        await db.update(outbox).set({ error: e.message.slice(0, 500) })
          .where(eq(outbox.id, row.id));
      }
    }
  }
}
```

For instant wake (zero-latency drain), use Postgres `LISTEN`/`NOTIFY`:

```ts
// In your outbox enqueue tx:
await tx.execute(sql`NOTIFY outbox_changed`);

// In your sync worker setup:
await rawDb.listen("outbox_changed", () => drainOutbox());
```

The sync worker is a standard pattern — any language/framework can implement it.

### 4.4 Handling updates (re-embed on change)

When your app updates an entity (e.g., a customer corrects their name), the matcher's stored embedding goes stale. The outbox pattern handles this naturally: every UPDATE on your customers table writes an `upsert` outbox row, the sync worker calls `matcher.upsertOne`, and the matcher overwrites the row's embedding.

**Watch for**: skipping the outbox enqueue on irrelevant updates (e.g., updating only `last_login_at`). If a field isn't part of the matcher's embedding source or scope, the update doesn't need to sync. Either:
- Skip the outbox enqueue conditionally (app-managed: easy)
- Use trigger-based with `WHEN (NEW.name IS DISTINCT FROM OLD.name OR ...)` clauses (trigger-managed: SQL-y)

The naive "every update enqueues" is fine for correctness; it just wastes some embed calls.

### 4.5 Handling deletes

When you delete an entity in your app, the matcher's row should also go. Two options:

- **Hard delete**: outbox writes a `delete` row; sync worker `DELETE FROM project_X.entity_Y WHERE external_id = ...`. Cleanest, but breaks `aliasHit` history for that entity (any prior confirmations point to a now-missing row).
- **Soft delete**: keep a `deleted_at` column on your entity tables, exclude soft-deleted rows from queries with a scope filter (add `deleted_at IS NULL` to your matcher.match's scope). samesake doesn't natively support this; you'd need to overload `scope` with a tombstone marker, or filter in your application after match. For most consumers hard-delete is fine.

### 4.6 Reconciliation: detecting drift

Even with the outbox, drift can happen — outbox rows that never drained, manual SQL that bypassed the outbox, partial deploys. Run a reconciliation job nightly:

```sql
-- Count drift check
SELECT
  (SELECT count(*) FROM your_app.customers WHERE tenant_id = 't1') AS app_count,
  (SELECT count(*) FROM project_your_project.entity_customer WHERE scope_tenant_id = 't1') AS matcher_count;

-- Find the missing IDs
SELECT id FROM your_app.customers WHERE tenant_id = 't1'
EXCEPT
SELECT external_id::bigint FROM project_your_project.entity_customer WHERE scope_tenant_id = 't1';
```

For each missing id, enqueue a fresh outbox row. The worker re-ingests it. Set this up as a nightly cron + alert on drift > 0.

### 4.7 Active learning: confirm/decline + calibration

Every time a user resolves an ambiguous match — clicks "this is the right customer" or "no, create a new one" — call `matcher.confirm()` or `matcher.decline()`. These calls:

- Write to `name_alias` and `pair_history` (for confirms)
- Update `match_candidate.outcome` to `'accepted'` / `'declined'` / `'ignored'` for telemetry

After a few weeks of real user resolutions, you have labelled data. Run:

```ts
const r = await matcher.calibrate({
  project: "your_project",
  kind: "customer",
  scope: { tenant_id: "t1" },
  minSampleSize: 50,  // need at least this many labelled decisions
});
console.log(`tenant t1: F1-optimal threshold ${r.threshold} (F1=${r.f1.toFixed(3)})`);
```

This grid-searches the auto-link threshold against your actual decision history and persists the F1-optimal value into `scope_thresholds`. Run it per-scope (per-tenant) so each customer base gets a threshold calibrated to its data.

Schedule this as a weekly job. The matcher gets visibly better with use without anyone touching code.

### 4.8 Updating channel weights over time

`matcher.calibrate` tunes thresholds, not channel weights. If you find a channel is consistently underweighted or overweighted in your data (a brand mismatch should kill candidates harder; phonetic should matter more for an Indian dataset), update the entity declaration's `Scorers.*({ weight: ... })` and re-deploy. Next `matcher.apply` regenerates the SQL — no migration, immediately live.

For empirical weight-tuning, see [`docs/explanation/tuning-channel-weights.md`](../explanation/tuning-channel-weights.md).

---

## Operational concerns

### Embedding cost + cache hit rates

The embed cache (`samesake_embed_cache`) is keyed on `model + dim + sha1(text)`. Same text → same cached vector. After the bootstrap and a few weeks of real traffic, cache hit rates should hit 60–90% depending on how repetitive your queries are. Monitor:

```sql
SELECT
  count(*) AS total_entries,
  pg_size_pretty(pg_total_relation_size('samesake_embed_cache')) AS size,
  count(*) FILTER (WHERE expires_at < now()) AS expired
FROM samesake_sys.samesake_embed_cache;
```

Cache TTL defaults to 90 days. If you change embedding models, the cache becomes useless overnight — plan model migrations carefully.

### Monitoring

The metrics that matter:

| Metric | Why | Where |
|---|---|---|
| `matcher.match` p50 / p99 latency | tracks LLM latency + DB latency | your APM |
| Embed cache hit rate | predicts your LLM bill | `samesake_embed_cache` row count vs total queries |
| Parse cache hit rate | tracks parse cost (parse is 10x embed cost) | `samesake_parse_cache` |
| Outbox depth (un-drained rows) | sync worker health | `SELECT count(*) FROM outbox WHERE drained_at IS NULL` |
| Outbox oldest pending age | alarm if > 5 min | `SELECT max(now() - enqueued_at) FROM outbox WHERE drained_at IS NULL` |
| Per-scope `matched_phone` / `matched_alias` / `combined-match` ratios | quality signal | `match_candidate` rows |
| Confirm rate (% of suggested resolved as "link") | active-learning signal | `match_candidate.outcome` |

Alert on outbox depth + age. Everything else is a dashboard.

### Backups + recovery

For Option-A (separate matcher DB): the matcher DB is rebuildable from your app DB. Backup it for convenience but it's not load-bearing. Worst case, drop it, run `prepareMigrations()`, run a full backfill — you're back. The only thing you lose is the embed cache (cost to rebuild ~hours of API calls).

For Option-B (shared DB): standard backup hygiene.

### Migrations between samesake versions

@samesake/server uses `CREATE TABLE IF NOT EXISTS` / `CREATE OR REPLACE FUNCTION` for its DDL. Most version upgrades require zero schema migration — just bump the dep, redeploy, the next `prepareMigrations()` call patches anything that needs patching.

For breaking changes (rare; documented in CHANGELOG) you'll re-apply your projects via `matcher.apply(...)`. The matcher does this idempotently at boot — same pattern works in any consumer.

### Disaster recovery

If the matcher's DB is corrupted or lost:

1. Run `prepareMigrations()` on the empty target DB
2. Run `matcher.apply(project, entities)` for each project (regenerates per-project SQL)
3. Run your full backfill again from your app DB
4. Set thresholds via `setScopeThresholds`
5. Replay any unsent `confirm/decline` from your app's audit log to restore active-learning state

Targeting under an hour for a 1M-row app is feasible if you parallelise the backfill.

---

## Reference implementation

Every pattern in this guide is implemented in the samesake framework in this repo. If something here is unclear, go read the corresponding file:

| Phase | What | Where |
|---|---|---|
| 1.1 | Mounted-Hono deployment | [`apps/matcher/src/index.ts`](../../apps/matcher/src/index.ts) |
| 1.2 | `embed` + `parse` wired via Vercel AI SDK + Gemini | [`apps/matcher/src/embedder.ts`](../../apps/matcher/src/embedder.ts) |
| 1.3 | Two-database setup (samesake_dev + app_dev) | `apps/matcher/src/index.ts` |
| 1.4 | 3 entity declarations (people-shape + parse-shape) | [`examples/hello/samesake.config.ts`](../../examples/hello/samesake.config.ts) |
| 1.5 | Per-tenant scoping | `scopes: ["tenantId"]` in every entity |
| 1.6 | Threshold defaults via wildcard scope | `examples/hello/run.ts` |
| 1.7 | `prepareMigrations` + `samesake migrate` CLI | [`packages/cli/src/index.ts`](../../packages/cli/src/index.ts) |
| 2.2 | Bulk upsert via CLI | `samesake seed` |
| 3.2 | Three-arm match decision (resolved / candidates / new) | [`examples/hello/run.ts`](../../examples/hello/run.ts) |
| 4.1 | Outbox schema | See §4.1 schema above |
| 4.2 | Application-managed outbox enqueue in same tx | See §4.2 code above |
| 4.3 | Sync worker with LISTEN/NOTIFY | See §4.3 code above |
| 4.7 | `matcher.calibrate` per-scope | [`packages/server/src/core/calibrate.ts`](../../packages/server/src/core/calibrate.ts) |
| 4.8 | Empirical weight tuning | [`docs/explanation/tuning-channel-weights.md`](../explanation/tuning-channel-weights.md) |

The hello example ([`examples/hello/run.ts`](../../examples/hello/run.ts)) exercises the full onboarding flow end-to-end against a live database. Treat it as the canonical "did I integrate this correctly?" test.

## What this guide deliberately doesn't cover

- **Building the matcher from source** — if you're forking samesake, start with the repo [`README.md`](../../README.md), [`docs/quickstart-search.md`](../quickstart-search.md), and [`docs/tutorial.md`](../tutorial.md).
- **Choosing between samesake and alternatives** — compare the runnable examples, package README files, and benchmark notes against your own dataset before committing.
- **The 11 deployment shapes** — covered in [`docs/usage-patterns.md`](../usage-patterns.md).
- **Why each channel exists / how scoring works** — [`docs/explanation/matcher-channels.md`](../explanation/matcher-channels.md).
- **How to write your `embed` / `parse` functions per provider** — [`docs/recipes/`](../recipes/).

This guide is the action-oriented playbook. For the *why*, follow the links.
