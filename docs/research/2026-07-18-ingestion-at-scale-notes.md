# Ingestion at scale — research synthesis (2026-07-18)

Distilled from five research passes run during the C9 gate night: CocoIndex deep-dive
(incremental engine), Python-space comparators (Timescale pgai Vectorizer, LlamaIndex,
Haystack, dlt, Airbyte/Meltano), TS-space patterns (LlamaIndex.TS, Mastra, worker pools,
graphile-worker claim mechanics, SDK batch facts), e-commerce catalog-side patterns
(Shopify/Woo/Google Merchant/Mirakl + Algolia/Typesense/Meilisearch/Elastic bulk APIs), and
embedding rate-limit engineering (provider facts + limiter design). Trigger: measured backfill
of 5.5k docs at 64–82 docs/min exposed the ingestion layer as the production bottleneck
(100k SKUs ≈ 26h at that rate; ICP is 100k–1M).

## Verdict in one paragraph

Nobody in either ecosystem ships a drop-in answer for a Postgres-native TS framework — but the
patterns have fully converged, and every element is portable to plain Postgres + TypeScript
with no new infrastructure: **claim-based multi-process workers over a queue/pending table
(`FOR UPDATE SKIP LOCKED`), per-stage `(input_hash, logic_version)` fingerprints for granular
invalidation, provider-ceiling-sized embed batching behind a dual RPM+TPM limiter, per-item
dead-letter isolation, async provider Batch APIs for bulk backfills (50% cheaper, separate
quota pool), NDJSON intake with per-item receipts on the catalog side, and shadow-build +
atomic swap for full reindexes.** CocoIndex proves the incremental core but keeps truth in a
local LMDB sidecar (disqualifying); pgai Vectorizer proves the whole worker/queue/dead-letter
shape natively in Postgres; the TS ecosystem (LlamaIndex.TS, Mastra) has caching but no
fan-out — bring-your-own is the norm, so building it is differentiation, not NIH.

## The converged architecture (each element with its strongest precedent)

1. **Claim-based sharding, not ID ranges, not threads.** N independent worker *processes*
   (Bun.spawn / `--shard` CLI) each loop a claim query on the existing pending predicate:
   `SELECT ... FOR UPDATE SKIP LOCKED LIMIT batch` + `UPDATE ... claimed_by/claimed_at
   RETURNING` (graphile-worker's `batchGetJobs`, verbatim mechanism; pgai adds
   `pg_try_advisory_xact_lock` dedup + a LATERAL join to the live row so stale queue entries
   embed fresh data). Stale-claim reaper (claimed_at > N min → back to pending) covers
   crashes. **The claim table IS the durability checkpoint** — kill everything, restart,
   nothing is lost; callers wanting orchestration wrap shard launches in Inngest/Trigger.dev
   on their own infra (matches the ROADMAP "no internal job runner" stance exactly).
2. **worker_threads only for the synchronous CPU step.** Nearform (Piscina's own authors):
   threads only pay for *synchronous* CPU work; async I/O in threads is pure overhead.
   Samesake's 98%-CPU single-loop pin is serialization of sync transform work with async
   I/O — the fix is process shards for the pipeline + (optionally) a small thread pool
   (~cpus) per shard for tokenize/normalize only. Bun's `node:worker_threads` is officially
   *partial* and Piscina-on-Bun is unverified → prefer process sharding; it also gives crash
   isolation.
3. **Dual fingerprints for granular invalidation** (CocoIndex's core, the fix for
   "definition change re-flags all 5,512 rows"): every derived stage (enrichment, each
   surface, each embedding column, evidence set) stores `(input_hash, logic_version)`;
   logic_version = hash of {prompt, model, template, manually-bumped stage version} — no AST
   hashing needed. Apply diffs per-stage: a `visual` model change re-flags only the visual
   column; unchanged stages skip via the existing leaf-level embed cache (we already have
   CocoIndex's best trick — `embed(text)` memoization — in `samesake_embed_cache`).
   LlamaIndex gets the same effect emergently (config is part of the cache key); Haystack has
   nothing (proof this must be engineered deliberately).
4. **Batch-first embed layer.** Micro-batching accumulator per (provider, model): coalesce
   concurrent single-item calls, flush on count OR token-budget OR idle-timer (pgai's
   dual-limit batching: 2,048 chunks AND 300k tokens, whichever binds). Gemini footgun:
   multi-input `embedContent` FUSES inputs into one embedding — per-item vectors require
   `batchEmbedContents` (sync; array cap undocumented — probe empirically, start ~100) or
   `asyncBatchEmbedContent`. Poison isolation: binary-split retry for sync batches
   (CocoIndex `RetryWithSmallerBatch`); async Batch APIs return per-item errors so retry
   only failed ids. Provider ceilings: OpenAI 2,048 items/300k tokens; Cohere 96 texts;
   Vercel `embedMany` auto-chunks but `maxParallelCalls` defaults to **Infinity** — always
   set it.
5. **Two paths, never one:** realtime (new SKU → embed in seconds, via limiter+micro-batch)
   vs **bulk (>~10k SKUs → provider async Batch API: Gemini `asyncBatchEmbedContent` /
   OpenAI Batch, 50% price, 24h SLA, SEPARATE quota pool — zero pressure on realtime
   budget)**. A 1M-SKU onboarding is a batch-file workflow (upload JSONL → poll → download),
   not a faster loop.
6. **Dual-budget rate limiter, Postgres-coordinated.** RPM and TPM are independent budgets
   everywhere; the binding one flips with payload shape. No off-the-shelf TS lib does
   multi-process Postgres coordination (bottleneck = Redis) → hand-roll a
   `rate_limit_windows(provider, model, window_start, requests_used, tokens_used)` atomic
   check-and-reserve (checked per batch dispatch, not per SKU), `cockatiel` for policy
   composition. 429 order: provider hint first (Gemini: `error.details[].RetryInfo.retryDelay`
   in the BODY, not a header; OpenAI: `x-ratelimit-reset-*`, no Retry-After) → full-jitter
   exponential backoff (AWS canonical) → AIMD concurrency (halve on 429, +1 per clean
   window). Counters: retries by reason, throttle-wait ms, effective RPM/TPM vs ceiling,
   batch-size histogram. (Tonight's lesson institutionalized: silent retries cost an hour of
   misdiagnosis.)
7. **Per-item dead-letter, not just a watchdog.** pgai's `vectorizer_errors` table (typed
   errors, exponential `retry_after`, park after max retries) is the mature form of the
   per-doc timeout we shipped tonight. Promote: failures land in a replayable table with
   reason; the queue never blocks.
8. **Multi-row writes.** One `INSERT ... VALUES (...)xN ON CONFLICT DO UPDATE` per completed
   batch inside the claim transaction (evidence rows included). COPY doesn't fit the
   claim/complete loop; multi-row upsert does, idempotently.

## Catalog-side (connectors + catalog-sync) recommendations

- **Shopify:** add a Bulk Operations path for initial/large pulls (GraphQL `bulkOperationRunQuery`
  → poll → stream JSONL; outside their rate limiter; 5 concurrent ops on API 2026-01) — the
  current `/products.json?limit=250` loop is explicitly not the tool for six-figure SKU pulls.
  Steady state: `products/*` webhooks (at-least-once, dedup on `X-Shopify-Webhook-Id`, ordering
  NOT guaranteed across topics) + Shopify's own mandated pattern: periodic `updated_at`-filtered
  reconciliation sweep.
- **WooCommerce — product decision needed:** the auth-free Store API (`wc/store/v1`) samesake
  polls cannot filter `modified_after`; only authenticated `wc/v3` can (cap 100/page).
  Recommendation: support keys where granted (true incrementality) with fingerprint-diff as
  the universal auth-free fallback — the fingerprint layer (element 3) doubles as the
  incremental signal for any source without a native modified cursor.
- **Bulk NDJSON intake endpoint** on catalog-sync (one product/event per line) — the industry
  transport (Shopify bulk export, Merchant feeds, Typesense/Elastic bulk all speak
  JSONL/NDJSON); a Shopify bulk download should stream straight in. `syncCatalogEvent` today
  is single-event only.
- **Per-item ingest receipts** (`{id, status, error?}` per line — Typesense's model, HTTP 200
  with per-line success flags) — cheap given per-row queue state.
- **Atomic swap for full re-embeds:** shadow columns/collection + flip, the
  Algolia/Meilisearch/Elastic consensus — this is the missing embedding-model migration
  mechanism already flagged in the retrieval notes.
- **Variant vocabulary:** `item_group_id` + color/pattern/material as the visually
  distinguishing dimensions (Google Merchant canon) — the join key for deciding when variants
  get their own visual-aspect rows.
- **Vendor onboarding is a data-quality funnel, not transport** (Mirakl): staged validation
  with a canary batch before full rollout — samesake's enrichment quality gates are exactly
  this; productize the canary-batch flow in onboarding docs.

## Verification gaps (smoke-test before hardcoding)

1. Gemini sync `batchEmbedContents`: max array size (undocumented) and whether one call = 1
   RPM tick (inferred from OpenAI's model, unconfirmed).
2. Gemini sync batch partial-failure semantics (per-item errors vs whole-call failure) —
   decides whether binary-split retry is needed on the sync path.
3. Piscina/tinypool on Bun (worker_threads officially partial) — only relevant if the CPU
   pool is pursued; process sharding avoids it.
4. Content API for Shopping sunsets 2026-08-18 → target Merchant API for any Google-feed work.

## What tonight already shipped vs what the chunk builds

Shipped on `feat/multi-aspect-major` during the gate night: bounded concurrency (env-tunable),
per-doc timeout watchdog, rolling pool (no barrier), timing instrumentation (temporary).
Measured: 64→82 docs/min single process, ceiling = single event loop + call-per-text.

**The "ingest-at-scale" chunk (delegatable, needs its own RFC):**
- REQ-sketch: claim-table + SKIP LOCKED shard workers with reaper (1); dual-fingerprint
  stage tracking replacing whole-collection `reindexRequired` (3); micro-batch embed layer +
  `embedBatch` BYO-adapter capability with single-call fallback (4); bulk-path via Gemini
  async Batch API behind the same intake (5); Postgres dual-budget limiter + retry policy +
  counters (6); dead-letter table superseding the watchdog-only path (7); multi-row upserts
  (8); Shopify bulk-op connector + NDJSON intake + receipts (catalog side); shadow+swap
  re-embed migration primitive. Acceptance: 100k-doc synthetic backfill ≥ 1,500 docs/min on
  8 shards (stub embedder), zero lost rows across kill/restart, eval-neutral (topIds
  unchanged on the standing corpus).
- Sequencing: lands with/behind the scale RFC (its ingest-throughput REQ-4 publishes the
  numbers); after the C9 gate verdict; prerequisite for any 100k+ marketplace onboarding.
