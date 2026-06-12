# PRODUCT BIBLE — The Matcher

**Working title:** the matcher / `@samesake/core` / `reso` (final name TBD — see §1.4)
**Author of decisions:** mithushancj — independent contractor on the upstream product; building this as ad-hoc work-product.
**Status:** Pre-implementation. All architectural decisions locked. Ready to spike.
**Date:** 2026-05-17.

**Supporting documents** (read alongside this bible — none of it duplicated here):
- [`db-investigation.md`](./db-investigation.md) — live-DB analysis + the original the upstream product-internal plan (1,431 lines)
- [`prior-art-research.md`](./prior-art-research.md) — surveyed 30+ tools (academic + OSS + commercial), 4 borrowed ideas (418 lines)
- [`midday-matcher-analysis.md`](./midday-matcher-analysis.md) — line-by-line read of midday-ai/midday's matcher (737 lines)
- [`midday-pr-history.md`](./midday-pr-history.md) — 18-month PR-history narrative from midday (280 lines)
- [`rfcs/imports-and-matching/`](./rfcs/imports-and-matching/) — the upstream product-internal RFCs (will be deprecated once this service ships)

**This document is the bible.** When it disagrees with anything above, the bible wins. When code disagrees with the bible, the code is wrong — fix the code or update the bible with a written rationale.

---

## 0. The 30-second pitch

> A self-hostable, open-source entity-resolution service for the embedding era. Drop in cross-script multilingual name matching, OCR-extracted-text-to-existing-record linking, bulk-import reconciliation, and duplicate detection — with the score transparency your auditors actually want.

Built because the alternatives are wrong-shape:
- **Algolia / Typesense / Elasticsearch** are search engines (lexical-first, vector as bolt-on).
- **Pinecone / Qdrant / LanceDB** are generic vector stores (no opinion on entity resolution).
- **Splink / Zingg / dedupe** are batch-oriented academic tools (no online API).
- **Senzing / Tilores** are enterprise SaaS with closed pricing.
- **Roll-your-own pgvector + scoring code** is what every AI-app team ends up writing and re-writing.

This is the *workflow-shaped* tool for the actual problem: AI pipeline extracts text → match to existing record → confirm → learn.

---

## 1. ETHOS

### 1.1 What we ARE

- **One Elysia service. One repo. One Postgres.** Bun + TypeScript end-to-end.
- **Self-hostable in 5 minutes** via `docker compose up`. One-click deploy to Fly.io / Railway / Cloudflare Containers.
- **Open source from day one** (Apache 2.0). All code, including the cloud-hosted version, is public.
- **Frugal.** Self-host every component we reasonably can. No vendor surface that isn't paying for itself.
- **Honest.** README says "we tried X, it cost too much, so we built Y" — and the code matches.
- **Type-safe end-to-end.** Eden (Elysia's typed HTTP client) gives consumers compile-time type safety with zero published SDK.
- **Schema-defined by the consumer.** Each deploy declares its own entity types in code; the service generates the storage + indexes + scoring from that declaration.
- **Deterministic in the middle, LLMs at the edges.** OCR / structured-parse / embedding generation → LLM. Scoring / ranking / thresholding / dedup → pure SQL + pure code. **The matcher never asks an LLM "are these the same?"**
- **Built for one consumer first** (the upstream product). The OSS quality of the codebase is a property of how it's built, not a sales pitch.
- **"Five minutes from `git clone` to first match" is the bar.** If a change makes that slower, the change is wrong. The 5-minute onboarding is the single most important DX promise; everything else is downstream of getting evaluators past the "does this thing actually work?" gate within one cup of coffee.

### 1.2 What we ARE NOT

- **Not a SaaS company.** No pricing tiers. No enterprise sales motion. No support contracts. (Cloud-hosted version may exist at cost, but it's a convenience, not a product.)
- **Not a search engine.** No relevance ranking for textual queries. No "as-you-type" autocomplete. No merchandising.
- **Not a generic vector store.** Don't use this for RAG. Don't use this for "find similar documents."
- **Not multi-language SDK matrix.** Only Eden (TypeScript). Other-language clients are someone else's PR.
- **Not a dashboard product.** `psql` + a few SQL views is the admin interface. A web dashboard exists only as an optional component.
- **Not multi-tenant SaaS (in the platform sense).** Each deploy serves one project. Multi-project shared infra is a self-host pattern, not a paid tier.
- **Not enterprise-feature-loaded.** No SAML, no RBAC, no audit logs, no compliance certifications — until someone PRs them.

### 1.3 Inspiration (cited verbatim)

The ethos is the [`elysiajs/arona`](https://github.com/elysiajs/arona) model:
- One Elysia service. One docker-compose. One README that explains what / why / how in five sections.
- Self-host every component you reasonably can.
- Be candid about why you chose what you chose ("we couldn't justify $1000/mo for kapa.ai").
- Diff-aware everything. Code as docs. No SDK matrix. No tier table.

### 1.4 Naming (TBD)

Working names ranked:
1. **samesake** — evocative, available .dev, describes what it does.
2. **Reso** — short, memorable, "resolution" intuition.
3. **Matcher** — literal, low-risk, can be renamed.

Naming decision deferred until v0.4 (first public docs commit). Until then: just call it "the matcher" in code.

---

## 2. THE ARCHITECTURE — every decision, locked

### 2.1 Service shape

- **Standalone HTTP service.** Not a library, not a Cloudflare Worker, not an embedded SQL extension. A Bun + Elysia process that consumers reach via HTTP.
- **Single-tenant per deploy by default.** One Postgres + one Elysia process = one project. Multi-project = multiple deploys OR a single deploy with project-scoped schemas (see §3.5).
- **No vendor lock-in in core.** Embeddings / parse / cache / queue are all swappable behind small interfaces. Default implementations exist; alternatives are a `config` change.
- **No `Matcher` interface in code on the consumer side** (the way the upstream product's RFCs proposed) — the **HTTP API IS the interface boundary**. Consumers use Eden against `typeof app` for typed access. Different concrete implementations of the matcher service swap at the deploy boundary, not the call-site boundary.

### 2.2 Tech stack — locked

| Layer | Choice | Rationale |
|---|---|---|
| Runtime | **Bun** | Fast cold-start; first-class TS; same as the upstream product & arona. |
| Framework | **Elysia** | Eden gives consumers typed client for free (no SDK to maintain). |
| Database | **Postgres 15+ with ParadeDB** (`pg_search` + `pgvector ≥ 0.7`) | We own this DB → can run modern pgvector with `iterative_scan`, plus BM25 native via `pg_search`. Beats the upstream product's Supabase 0.5.1 + workaround story entirely. |
| ORM | **Drizzle** | Raw-SQL ergonomics matter more than Prisma's type-magic for a matcher-heavy codebase. Matches midday's choice. |
| Cache | **Dragonfly (self-hosted) via ioredis** | What arona uses. Drop-in Redis replacement. Co-located with the service. |
| Queue | **BullMQ on Dragonfly** | Same Dragonfly instance for caching + queue. No separate vendor. (Cloudflare Queues option later if we ever deploy to CF Containers.) |
| Cron | **node-cron in-process** | Tiny service — in-process scheduling is sufficient. No separate cron infra. |
| Embeddings | **`gemini-embedding-001` @ 768d** (default) | Cheap, top of MMTEB, strong on low-resource languages. **Pluggable** — Voyage / OpenAI / BGE-M3 self-hosted are all behind a 5-method interface. |
| Parse LLM | **`gemini-2.5-flash-lite`** (default) | 5× cheaper than full Flash for structured-output tasks (same conclusion midday and we both reached). **Pluggable** — see §6.4. |
| Logging | stdout → host's log viewer (Axiom optional) | Match arona. |
| Auth | **API key in `Authorization: Bearer` header** | Per-deploy key, rotate via env var. No JWT, no OAuth, no SSO. |
| Deploy targets | Fly.io / Railway / Cloudflare Containers / any Docker host | One-click templates for each in the repo. |

### 2.3 Decisions deliberately NOT made (left to consumer)

- **Storage size limits per project** — the consumer's Postgres, the consumer's problem.
- **Rate limiting** — the consumer puts a reverse proxy (Cloudflare, Caddy) in front.
- **Multi-region deployment** — the consumer runs N copies, sticks a global load-balancer in front.
- **High availability** — the consumer uses Postgres replication / Dragonfly Sentinel as they see fit.
- **Backups** — `pg_dump`, like any other Postgres deploy.

The service is intentionally **small and unopinionated** about the surrounding infra. Like Postgres itself.

---

## 3. THE DATA MODEL

### 3.1 The per-project schema is generated from a declaration

The consumer writes a TypeScript config file. The service translates it into:
- Postgres tables under `project_<slug>.*`
- pgvector + ParadeDB indexes per the declared embeddings
- SQL functions for `match`, `dedup`, `variant_suggestions`
- Validation rules for upsert payloads

**Single source of truth: the consumer's `config/entities.ts`** (file name is convention, not enforced).

### 3.2 Standard tables per project (auto-generated)

For each declared entity type:
- `entity_<kind>` — the actual records (developer-declared fields)
- `entity_<kind>_embedding` — side table, one row per entity, holds vectors + phonetic + normalised name + `embedding_model` + `embedded_at`
  - **Why side table not columns:** keeps `entity_<kind>` clean (consumer reads this all the time); embeddings + vectors only loaded when matcher needs them. Same pattern as our `db-investigation.md` §A separation, applied automatically.

Per project, regardless of entity types:
- `name_alias` — confirmed query→entity mappings
- `import_batch` — bulk-import state machine
- `import_row` — per-row matching + resolution
- `match_candidate` — per-query candidate set + outcome telemetry (the source of truth for the F1 calibrator)
- `units_alias` — for product-shape entities only; seed with consumer's vocabulary
- `owner_naming_convention` — per-scope prefix cache (auto-detected nightly)
- `job_run` — async-job observability

### 3.3 Match telemetry: first-class columns, not jsonb

Following midday's `transaction_match_suggestions` shape ([`midday-matcher-analysis.md`](./midday-matcher-analysis.md) §3, delta #2):

```sql
match_candidate {
  id              uuid PK
  created_at      timestamptz
  scope           jsonb       -- the scope keys from the consumer's request (e.g. {tenantId: '...'})
  query_text      text NOT NULL CHECK (length(query_text) <= 500)
  query_kind      text NOT NULL    -- which entity type

  -- STABLE channel scores as first-class numeric columns (queryable)
  cosine_score    numeric(4,3)
  trgm_score      numeric(4,3)
  phonetic_score  numeric(4,3)
  alias_hit       boolean
  phone_eq        boolean

  -- Experimental + computed-after-the-fact
  components      jsonb       -- {extra: {...}, prob_or: ..., rrf: ..., ...}

  -- The candidate + outcome
  candidate_id    bigint NOT NULL
  combined_score  numeric(4,3) NOT NULL
  rank            integer NOT NULL
  outcome         text         -- 'accepted'|'rejected'|'ignored'|'autolinked'
  outcome_at      timestamptz
  source_table    text
  source_id       text
}
```

**Stable channels get columns. Experimental channels go in `components` JSON.** When a column proves valuable enough, promote it. When it becomes noise, demote it.

### 3.4 Schema declaration shape (the developer API)

```ts
import { entity, fields, Scorers, providers } from '@samesake/sdk';

export const customer = entity('customer', {
  fields: {
    name: fields.text({ required: true }),
    phone: fields.text({ optional: true }),
  },
  scopes: ['ownerId'],

  embeddings: {
    name_emb: {
      source: (e) => e.name,
      model: providers.gemini.embed001({ dim: 768 }),
    },
  },

  phonetic: {
    name_phon: {
      source: (e) => e.name,
      algorithm: 'indic-soundex',  // or 'metaphone' | 'soundex' | 'custom'
    },
  },

  normalisation: {
    strip: ['emoji', 'punctuation'],
    case: 'lower',
    unaccent: true,
  },

  scoring: {
    channels: [
      Scorers.phoneExact({ field: 'phone', weight: 1.0 }),
      Scorers.cosine({ embedding: 'name_emb', weight: 0.6 }),
      Scorers.trigram({ field: 'name', latinOnlyPartial: true, weight: 0.25 }),
      Scorers.aliasHit({ weight: 0.4 }),
      Scorers.phoneticEq({ phonetic: 'name_phon', weight: 0.2 }),
    ],
    combiner: 'probabilistic-or',  // 'rrf' | 'fellegi-sunter' | custom
    thresholds: { autoLink: 0.92, suggest: 0.55 },
  },
});

export const product = entity('product', {
  fields: {
    name: fields.text({ required: true }),
    units: fields.text({ optional: true }),
  },
  scopes: ['ownerId'],

  parse: {
    provider: providers.gemini.flashLite(),
    schema: {
      brand: 'text?',
      brand_normalised: 'text?',
      item_canonical: 'text',
      variant: 'text?',
      size_value: 'number?',
      size_unit: 'text?',
      internal_code: 'text?',
      namespace_prefix: 'text?',
    },
    cacheTtl: '90d',
  },

  embeddings: {
    item_emb: {
      source: (e, p) => `${p.item_canonical} ${p.variant ?? ''}`.trim(),
      model: providers.gemini.embed001({ dim: 768 }),
    },
    full_emb: {
      source: (e) => e.name,
      model: providers.gemini.embed001({ dim: 768 }),
    },
  },

  scoring: {
    channels: [
      Scorers.internalCodeExact({ field: 'parsed.internal_code', shortCircuit: true }),
      Scorers.sizeUnitGate({
        value: 'parsed.size_value',
        unit: 'parsed.size_unit',
        unitsAliasTable: 'units_alias',
        familyTolerance: { volume: 0.05, length: 0.0, count: 0.0 },  // VAT-style tolerances; see §4.6
      }),
      Scorers.brandGate({
        field: 'parsed.brand_normalised',
        matchBoost: 1.3,
        mismatchFactor: 0.2,
      }),
      Scorers.cosine({ embedding: 'item_emb', weight: 0.65 }),
      Scorers.cosine({ embedding: 'full_emb', weight: 0.30 }),
      Scorers.trigram({ field: 'name', weight: 0.20 }),
      Scorers.phoneticEq({ phonetic: 'item_phon', weight: 0.15 }),
      Scorers.aliasHit({ weight: 0.40 }),
    ],
    combiner: 'probabilistic-or',
    thresholds: { autoLink: 0.92, suggest: 0.55 },
  },
  ownerNamespaceDetection: { enabled: true, minRatio: 0.30, minAssets: 20 },
});
```

Call `await lk.applySchema()` and the service generates / migrates the underlying tables.

### 3.5 Multi-project on one deploy

Each project = one Postgres schema (`project_<slug>.*`) in a shared cluster. **Cross-project queries are forbidden.** Project isolation is by schema, not database. Cheap; sufficient for indie / small-team use. Enterprise-grade isolation is "one deploy per project" — same docker-compose, different DBs.

---

## 4. THE MATCHER ENGINE

### 4.1 The five-signal hybrid retrieval (people-side default)

| Signal | Source | Default weight | Notes |
|---|---|---:|---|
| Phone exact | configured field, btree | 1.0 (trump) | Optional per entity. |
| Cosine on embedding | HNSW (or IVF) | 0.6 | Primary cross-script channel. |
| Trigram on normalised name | GIN partial index, Latin-only | 0.25 | Tolerates typos / transliteration. |
| Indic phonetic hash | btree on hash | 0.20 | For Sinhala/Tamil grapheme clusters and cross-script "sounds-like". Ported from `libindic/inexactsearch`. |
| Alias hit | btree on `name_alias` | 0.4 boost | Learned from user confirmations. |

### 4.2 The combiner — two formulas, both stored

For every match call, compute both:

```
prob_or = 1 - Π(1 - wᵢ · scoreᵢ)     // hand-rolled, our default
rrf     = Σ 1/(60 + rankᵢ)            // industry standard, weight-free
```

Store both in `match_candidate.components.{prob_or, rrf}`. After 2 weeks of telemetry, A/B-test precision@auto-link under each. **Pick the winner. Drop the loser from the response shape.** Don't carry both forever. (See [`prior-art-research.md`](./prior-art-research.md) §3.4 + delta #3 from [`midday-matcher-analysis.md`](./midday-matcher-analysis.md) §8.)

### 4.3 The gates (product-side; same shape applicable elsewhere)

Gates differ from weighted channels: they can DROP or BOOST candidates outright.

| Gate | Behaviour |
|---|---|
| **Internal-code exact** | Hit → score 1.0, short-circuit return. |
| **Size+unit compatibility** | Both sides have size+unit → resolve via `units_alias` → check dimensional family → check value within family-tolerance. Mismatch → drop. Either-side null → no penalty. |
| **Brand gate** | Both sides have brand → match → ×1.3 boost (cap 1.0); mismatch → ×0.2. Either null → no effect. |
| **Variant resolution** | Matched entity has variants → second-pass against variants → return `{entityId, variantId}`. |

Gates are TS code in `core/score.ts`, not SQL. They run after the SQL pre-filter materialises the candidate set.

### 4.4 The materialised-CTE pre-filter (kept for now, dropped when ParadeDB upgrades)

```sql
WITH candidates AS MATERIALIZED (
  SELECT id, name_embedding, name_phonetic_hash, name_normalised, ...
  FROM project_X.entity_customer_embedding ce
  JOIN project_X.entity_customer cu ON cu.id = ce.customer_id
  WHERE cu.scope_ownerId = $1
)
SELECT ... FROM candidates ORDER BY name_embedding <=> $q LIMIT 5;
```

**Because we own the DB:** ParadeDB ships pgvector ≥ 0.7. We can use `SET LOCAL hnsw.iterative_scan = relaxed_order` directly. Materialised CTE is not strictly required — but we keep it for tenants where filtering by scope is much narrower than the global HNSW would handle alone. **Auto-decide:** use iterative_scan for scopes with ≥ 5,000 entities; materialise for smaller scopes.

### 4.5 Match-in-waves (for batch / import flows)

For bulk-import (and any flow scoring N candidates at once), process in progressively-loosening waves. **Lock in high-confidence matches first; defer low-confidence to user.**

| Wave | Filter | Action |
|---|---|---|
| 1 | Internal-code exact | Auto-link |
| 2 | Phone exact (people) | Auto-link |
| 3 | Normalised-name exact | Auto-link |
| 4 | Alias hit | Auto-link |
| 5 | Cosine ≥ 0.85 + gates pass | Suggest |
| 6 | Cosine 0.55–0.85 | Suggest |
| 7 | Phonetic equality alone | Suggest |
| 8 | Remainder | Ask user / create new |

Pattern adopted from IDinsight's `hindi-fuzzy-merge` ([`prior-art-research.md`](./prior-art-research.md) §3.3).

### 4.6 Domain-aware unit tolerances

VAT-aware amount matching (midday's pattern) becomes domain-aware unit matching for us. `units_alias` carries a `factor_to_canonical` AND a `family_tolerance` per family:

| Family | Default tolerance | Why |
|---|---:|---|
| `count` (pcs, dozen, …) | 0.0 (strict) | Counts are exact. |
| `volume` (ml, l, …) | 0.05 (5%) | Rounding errors on measured liquids. |
| `mass` (g, kg, …) | 0.02 (2%) | Tighter; mass is more precisely measured. |
| `length` (mm, inch, …) | 0.0 (strict) | Inch sizes for balloons, dimensions for parts. |

Consumer can override per-family in the entity declaration.

### 4.7 Learning from team history (per-scope alias score + decline penalty)

Three computed-at-query-time signals from `match_candidate.outcome` rollups (cached 5 min per scope, midday's pattern):

| Signal | Computation | Use |
|---|---|---|
| `alias_score` | If (normalised_query, normalised_candidate) pair has confirmations in history → score 0.7+ depending on count | Boost `cosine_score` and `trgm_score` |
| `decline_penalty` | If pair has declines in history → subtractive penalty | Subtracts from `combined` |
| `pair_can_auto_match` | Has been confirmed ≥ 2 times → boolean flag | Promotes match_type to `auto_matched` even at lower confidence |

Lifted near-verbatim from midday's `computeAliasScore` / `computeDeclinePenalty` / `computeMerchantPatterns`. See [`midday-matcher-analysis.md`](./midday-matcher-analysis.md) §4.4.

### 4.8 F1-optimised per-scope threshold calibration

Every 5 minutes per scope, re-fit the `autoLink` and `suggest` thresholds from the last 90 days of `match_candidate.outcome`. Sweep thresholds 0.25 → 0.90 in 0.01 steps. Pick the F1-maximising one (tie-break by precision). Cap adjustment at ±3% per cycle. Require minimum sample sizes (5 confirmed + 5 declined).

Lifted from midday's `getTeamCalibration` + `optimizeThresholdFromFeedback`. ~80 lines of TypeScript + one SQL query. **First-class part of the matcher, not a "tune later" comment.** See [`midday-matcher-analysis.md`](./midday-matcher-analysis.md) §4.5.

---

## 5. THE API SURFACE

### 5.1 HTTP routes (all under `/v1/projects/:project/...`)

```
POST   /entities/:type/upsert
POST   /entities/:type/upsert-batch
DELETE /entities/:type/:id
POST   /match                       { kind, text, scope, opts }
POST   /confirm                     { kind, queryText, chosen, offered, source }
POST   /imports                     { entityType, scope, source: { xlsx | csv | image } }
GET    /imports/:id
POST   /imports/:id/apply
GET    /duplicates                  ?entityType=customer&scope=...
GET    /variant-suggestions         ?entityType=product&scope=...
GET    /telemetry/threshold-calibration?scope=...
POST   /schema/apply                (developer-tool — applies entity declarations)
```

### 5.2 Eden client (the SDK)

```ts
import { treaty } from '@elysiajs/eden';
import type { App } from '@samesake/server';     // type-only import

const lk = treaty<App>('http://matcher.local', {
  headers: { Authorization: `Bearer ${env.SAMESAKE_KEY}` },
});

const { data, error } = await lk.v1.projects['upstream'].match.post({
  kind: 'customer',
  text: 'අම්මා',
  scope: { ownerId: 'biz_456' },
});
```

End-to-end TypeScript types via Eden. **No SDK to publish.** The Elysia route definitions ARE the SDK.

### 5.3 MCP server (for AI agents)

A separate `packages/mcp-server/` exposes the matcher as MCP tools so Claude / Cursor / other agents can use it natively:

- `samesake_match(project, kind, text, scope)` → `MatchResult`
- `samesake_confirm(project, kind, chosen, offered, source)` → ack
- `samesake_dedup(project, kind, scope)` → cluster list
- `samesake_variant_suggestions(project, scope)` → variant clusters

Optional component. Doesn't ship in the core service Docker image; separate `docker-compose.mcp.yml`.

### 5.4 The CLI (`@samesake/core`)

First-class deliverable, not an afterthought. Ships as `packages/cli/`. Installable via `bun install -g @samesake/cli`. Every command has `--help`, every command has `--json` for scripting, every destructive command requires `--yes`.

Command surface:

| Command | Purpose |
|---|---|
| `samesake init` | Scaffold `samesake.config.ts` in the current directory with a chosen template (basic, retail, crm). |
| `samesake apply` | Apply a config file to a project. Shows diff + cost estimate before confirming. Refuses incompatible changes with actionable error + 3 suggested recoveries. |
| `samesake backfill` | Bulk-load existing data (`--from=prisma:./schema.prisma --table=customer`, or `--from=json:./file.json`). Resumable. Switches provider on quota errors with `--provider=voyage`. |
| `samesake match` | Run a single match query from the CLI. Returns top-N with per-channel scores in human-readable + `--json` form. |
| `samesake explain` | Show why a specific match scored what it scored — full channel breakdown + gates + calibration context. See §5.5. |
| `samesake dedup` | Find duplicate clusters in a project. |
| `samesake variants` | Find variant-cluster suggestions in a project. |
| `samesake seed` | Load test data from a JSON file or generate synthetic. |
| `samesake eval` | Run the Ranathunga or a custom benchmark suite. Outputs precision/recall + diff vs previous run. |
| `samesake studio` | Open a local Postgres-Studio-like UI at port 3031. |
| `samesake drop-channel` | Remove a scoring channel. Shows impact (decisiveness in last 90 days) BEFORE asking for `--yes`. |
| `samesake rollback` | Revert the last applied schema change. Shows what will become orphaned. |
| `samesake pull-config` | Reverse direction: dump the matcher's current schema as a TS config file. Detects drift against your local config. |
| `samesake project list` | List projects on the matcher. |
| `samesake project drop` | Drop a project (DROP SCHEMA CASCADE; requires `--yes`). |
| `samesake cache flush` | Flush the embedding cache for a project. |
| `samesake rematch` | Re-run matching across all `import_batch` rows in a date range (after weight changes). |
| `samesake cost` | Show per-channel, per-provider LLM cost breakdown over a date range. |
| `samesake docs <topic>` | Open the relevant doc section in the terminal. |

Global env: `SAMESAKE_URL`, `SAMESAKE_KEY`, `SAMESAKE_PROJECT`.

The CLI talks to the HTTP API via Eden — meaning the CLI's command implementations ARE end-to-end-typed against the server. When a new route ships in the server, adding a CLI command for it is ~20 lines.

### 5.5 The `explain` UX — the debugging tool

The most important DX surface for entity resolution. Half the time the question is "why did this match?" — `samesake explain` answers it.

```bash
$ samesake explain --query-text="කිස්ට් ඇපල් 500" --candidate-id=12345

  Query: "කිස්ට් ඇපල් 500"
  Candidate: "කිස්ට් ඇපල් නෙක්ටා 500" (id=12345, scope=ownerId:fe3eb1db…)

  Normalised:    "kista appal 500"
  Phonetic hash: "KPL" — matches candidate's hash "KPL"  ✓

  Parsed structured fields:
    brand:             කිස්ට්   (normalised: kist)   ← MATCH (+30% boost)
    item_canonical:    apple                          (candidate: apple nectar)
    size_value:        500
    size_unit:         ml (inferred from item)        (candidate: ml)
    parser_confidence: 0.85                            (candidate: 0.92)

  Gates:
    ✓ size+unit       (500ml == 500ml; family=volume, tolerance 5%)
    ✓ brand           (match → ×1.3 boost)
    ✗ internal_code   (both null; not applied)

  Scoring channels:
    cosine (item_emb)  0.91  weight 0.65  contributes 0.59
    cosine (full_emb)  0.86  weight 0.30  contributes 0.26
    trigram            0.72  weight 0.20  contributes 0.14
    phonetic equality  true  weight 0.15  contributes 0.15
    alias hit          false weight 0.40  contributes 0.00

  Combined (probabilistic OR):   0.86
    × brand_factor (1.3):        1.0 (capped)
  Final score:                   1.0
  Decision:                      AUTO-LINK (above tenant threshold 0.92)

  Tenant calibration (last 90 days, 47 confirmed / 12 declined):
    Suggested threshold: 0.55 (default)
    Auto-link threshold: 0.94 (calibrated UP from 0.92 due to high precision)
    Sample size:         59

  Was the cosine channel decisive?
    Without cosine, combined would be: 0.71 (below auto-link)
    YES — cosine was decisive. Tracked for ablation gate.
```

Same shape available as HTTP: `POST /v1/projects/:p/explain { queryText, candidateId }` → identical breakdown as JSON.

**Design contracts:**
- Every score that goes into the decision must appear in `explain`. No hidden contributions.
- Every gate that fired must appear in `explain`. No silent rejections.
- Calibration context must appear so reviewers know what threshold the score was compared against.
- "Decisive channel" analysis answers the ablation question without a second query.

Every match the user disagrees with becomes a single CLI command (or one HTTP call) + a copy-pasteable response. **Without this, the matcher is a black box; with it, it's a system you can reason about.**

### 5.6 No GraphQL. No tRPC. No gRPC.

Plain HTTP + Eden. Match arona.

---

## 6. THE ASYNC PIPELINE

### 6.1 BullMQ on Dragonfly

Three job types:
- `import.extract` — download uploaded file, parse rows, write to `import_row`.
- `import.match` — for each pending `import_row`, run the wave matcher.
- `import.apply` — commit chosen resolutions in one Drizzle transaction.

Each job:
1. Writes `job_run` row at start (`status='running'`).
2. Wraps body in try/catch.
3. On success: updates `job_run.status='succeeded'`, `ended_at`.
4. On failure: updates `job_run`, re-throws so BullMQ retries (max 5).
5. After 5 retries: BullMQ moves to DLQ; a fail-safe handler sets `import_batch.status='failed'` and `job_run.status='dead'`.

Idempotency contract: `import_row.row_index` unique within `batch_id`; per-batch advisory lock on `apply`. Re-delivery is safe.

### 6.2 In-process cron (node-cron)

| Schedule | Job |
|---|---|
| `17 2 * * *` (daily) | `recompute-owner-naming-convention` per project |
| `17 2 * * 0` (weekly) | `units-alias-coverage-alert` per project — flag unmapped unit strings |
| `0 * * * *` (hourly) | `threshold-calibration` per scope (if ≥ 20 labelled samples) |
| `0 3 * * *` (daily) | `retention-cleanup` — drop `match_candidate` rows > 90 days |
| `0 4 * * 0` (weekly) | `index-usage-audit` — surface 0-scan + > 1 MB indexes for review |

### 6.3 Pluggable embedding + parse providers

```ts
// packages/server/src/providers/index.ts
export const providers = {
  gemini: {
    embed001: (opts) => /* ... */,
    embed2: (opts) => /* ... */,         // when v2 exits Preview
    flashLite: (opts) => /* ... */,
  },
  openai: {
    embed3small: (opts) => /* ... */,
    embed3large: (opts) => /* ... */,
  },
  voyage: {
    voyage3: (opts) => /* ... */,
    voyage3Large: (opts) => /* ... */,
  },
  selfHosted: {
    bgeM3: (opts) => /* via local API endpoint */,
    multilingualE5: (opts) => /* via local API endpoint */,
  },
} as const;
```

Provider choice is per-embedding-channel in the schema. **Default is Gemini; override per project per channel.** The the upstream product use of Voyage's 200M-free-tokens is one config swap.

### 6.4 ParseService is provider-agnostic

`parse.provider` in the schema declaration can be:
- `providers.gemini.flashLite()` — default; structured-output via `generateObject`
- `providers.openai.gpt5Mini()` — alternative
- A custom function — for deterministic regex-based parsing (the "vendor-API swap" escape valve midday took for enrichment)

**Don't lock the caller signature to Gemini specifics.** Midday's #876 PR showed why ([`midday-pr-history.md`](./midday-pr-history.md) §3) — AI pipelines for normalisation may eventually get replaced with deterministic vendor APIs.

---

## 7. THE OPERATIONS PLAYBOOK

### 7.1 Telemetry-driven everything

Five things measured continuously per scope, queryable in `psql`:

1. **Precision @ auto-link threshold** — from `match_candidate.outcome` rollup.
2. **Recall @ suggest threshold** — same source.
3. **Per-channel decisiveness** — what % of accepted matches would have failed without each scoring channel? Drives the ablation gate.
4. **Per-channel false-positive rate** — what % of rejected matches were primarily promoted by each channel? Drives weight adjustment.
5. **Index usage** — `pg_stat_user_indexes.idx_scan` per HNSW / trigram index. Drives the audit cadence.

These are surfaced in `packages/server/src/scripts/matching-progress.ts` (the script-tool, not a dashboard).

### 7.2 The week-4 and week-12 audit

At week 4 and week 12 post-launch for any deploy:

```sql
-- The midday #035 query, generalised
SELECT
  schemaname || '.' || indexrelname AS index,
  pg_size_pretty(pg_relation_size(indexrelid)) AS size,
  idx_scan,
  idx_tup_read
FROM pg_stat_user_indexes
WHERE schemaname LIKE 'project_%'
ORDER BY idx_scan ASC, pg_relation_size(indexrelid) DESC;
```

Any index with `idx_scan = 0` and size > 1 MB gets a **"drop or justify"** review. Comment the rationale in the migration that drops it. Match midday's migration-comment style:

```sql
-- Drop unused HNSW vector index on project_upstream.asset_full_embedding_idx
-- (43 MB, 0 scans over 4 weeks). Queries primarily use item_embedding;
-- full_embedding only set during parse but never queried.
DROP INDEX CONCURRENTLY project_upstream.asset_full_embedding_idx;
```

### 7.3 The embedding-ablation gate

At week 4: query `match_candidate` to compute, per scope:

> Of all matches where `outcome='accepted'`, in what % was the `cosine_score` the decisive channel (i.e. the match would have failed `combined >= autoLink` without it)?

- If < 5% → **drop the HNSW indexes and the embedding columns** for that scope (or globally). Save disk + write amplification. This is the midday lesson made concrete.
- If 5–20% → keep but monitor; cosine may earn more as data accumulates.
- If > 20% → embedding is doing real work; lean in (consider Gemini Embedding 2 swap when it exits Preview).

This gate is checked automatically by the weekly index-usage cron. If a scope's cosine-decisive rate stays below 5% for two consecutive weeks, a `job_run` row of kind `cron.ablation-alert` writes the report.

### 7.4 Idempotency safeguards on `confirm`

Following midday's PR #841 lesson: the confirm endpoint MUST be idempotent. Concurrent confirms of the same `(scope, queryText, chosenEntityId)` collapse to one alias write + one `match_candidate.outcome` update. Implementation:

```sql
INSERT INTO name_alias (scope, kind, entity_id, alias, alias_normalised, source, confidence)
VALUES (...)
ON CONFLICT (scope, kind, alias_normalised) DO NOTHING;

UPDATE match_candidate
SET outcome = $1, outcome_at = now()
WHERE id = $2 AND outcome IS NULL;  -- idempotent guard
```

Plus per-batch advisory lock for the import-apply path: `SELECT pg_advisory_xact_lock(hashtext($batch_id))`.

### 7.5 Same-day fix-up budget after big launches

When the matcher behaviour changes substantively (new scoring, new index, new gate), **reserve same-day capacity for the UI / consumer-side fix-ups**. Midday's PR #829 landed 2 hours after PR #827. Have:
- The Bun script to re-issue a stuck batch (`scripts/replay-batch.ts`).
- The SQL to mass-reset stuck `analyzing` statuses.
- The Bun script to rerun the matcher on a date range (`scripts/rematch.ts`).

All committed BEFORE the big PR lands.

### 7.6 Documentation is part of the PR

When the matcher behaviour changes, the docs change in the same PR. **Stale docs are a code smell.** Match midday's PR #827 which deleted 661 lines of `docs/inbox-matching.md` in the same commit chain as the algorithm rewrite.

### 7.7 Cursor Bugbot on every PR

Enable on the repo from day one. Free automated risk-rating + summary per commit. Doubles the value of solo PRs by giving them a structured second opinion. (For an ad-hoc contractor, this is essential — there's no team to review.)

---

## 8. THE 10-WEEK ROADMAP (solo contractor, ~10 hrs/week)

| Week | Milestone | Ships |
|---:|---|---|
| 1 | **Repo + spike** | Fresh repo with Bun + Elysia + Postgres + ParadeDB + Dragonfly in docker-compose. One entity type, one cosine scorer, end-to-end `POST /upsert` + `POST /match` working. README placeholder. |
| 2 | **Schema declaration system** | `defineEntity()` → DDL generation working. Define customer + supplier + asset (the the upstream product entities). `applySchema()` migrates the underlying tables. |
| 3 | **Match engine V1** | Hybrid scorer (cosine + trigram + alias + phonetic + phone) in TS; ParadeDB hybrid query under the hood; both `prob_or` and `rrf` stored. |
| 4 | **Embed + parse services** | Gemini wrappers with Dragonfly cache (90d TTL). `ParseService` for products (Flash-Lite, structured output). Provider abstraction in place. |
| 5 | **Upsert + confirm + alias + telemetry** | Full match lifecycle. `match_candidate` rows written. F1 calibrator running (hourly cron). |
| 6 | **the upstream product backfill + first wiring** | the upstream product's customer/supplier/asset rows pushed via `upsertBatch`. Run Ranathunga eval. Wire the upstream product's `/ai/extract-bill-receipt` to call the matcher. **First user-visible behaviour for the beta cohort.** |
| 7 | **Bulk import pipeline** | BullMQ queue + 8-wave matcher + `/imports/*` endpoints. xlsx parser. Idempotency contract. |
| 8 | **Dedup + variant suggestions** | `Matcher.dedup` + `/duplicates` and `/variant-suggestions` endpoints. |
| 9 | **Operational polish** | All crons live: namespace recompute, units coverage, threshold calibration, index audit, retention cleanup. `matching-progress.ts` script. |
| 10 | **README + (optional) public push** | Honest README in arona style. Docker-compose tested. Fly.io template tested. If you want, `git push` to a public repo. Done. |

**~100 hours of focused work over 10 weeks.** Realistic for nights-and-weekends. Same scope as arona — and arona is maintained part-time by one person.

If the upstream product wants it faster, they fund more hours. If you want it slower, slow weeks ship less. Plan is linear in time, not pretending you'll be full-time on it.

---

## 9. THE UPSTREAM PRODUCT INTEGRATION (the first customer)

Once the matcher is at v0.4+ (week 6 onward), the upstream product's 6-RFC plan collapses to **2 RFCs**:

### the upstream product RFC A — DB hygiene
Identical to the existing [`rfc-01-db-hygiene.md`](./rfcs/imports-and-matching/rfc-01-db-hygiene.md). 14 missing indexes + drop 2 redundant uniques + CI drift check. **Pure local cleanup; not matching-related.** Lands first regardless.

### the upstream product RFC B — Integrate the matcher service
- Add 3 FK columns to the upstream product's `cashbook` (`customerId`, `supplierId`, `assetId`). These are the only matching-related columns in the upstream product's DB.
- Install Eden client. Configure `SAMESAKE_ENDPOINT` + `SAMESAKE_API_KEY` env vars.
- Commit `apps/api/src/samesake/config.ts` with the customer / supplier / asset entity declarations.
- Run `samesake apply-schema` from CI on every deploy.
- One-shot backfill script: page through the upstream product's existing rows, call `upsertBatch`.
- Wire 4 endpoints (extract enrichment, cashbook save, import proxy, dedup proxy).

**No embedding columns in the upstream product's Postgres.** No matcher TS module to maintain in the upstream product. No materialised-CTE workaround. The matcher service is an infrastructure dep, like Supabase or Gemini.

Existing [`rfcs/imports-and-matching/rfc-02..06.md`](./rfcs/imports-and-matching/) are **deprecated** once this integration is wired. They're preserved as historical reference for the in-Postgres design.

---

## 10. OPEN SOURCE + BUSINESS MODEL

### 10.1 License

**Apache 2.0.** Patent grant matters for entity-resolution tooling that might land in enterprise environments. MIT is fine too; Apache is the safer pick for a tool businesses will deploy.

### 10.2 Repo structure

```
samesake/                                  ← public GitHub repo
├── README.md                              ← honest arona-style "what / why / how"
├── LICENSE                                ← Apache 2.0
├── docker-compose.yml                     ← 5-min self-host
├── fly.toml + railway.toml                ← one-click deploy templates
├── packages/
│   ├── server/                            ← the Elysia service
│   ├── sdk/                               ← the schema-definition + type helpers (treaty wrapper)
│   ├── cli/                               ← `@samesake/core` CLI (apply-schema, eval, replay, etc.)
│   ├── mcp-server/                        ← optional MCP server for AI agents
│   └── dashboard/                         ← optional admin UI (Next.js)
├── examples/
│   ├── upstream/                          ← canonical example: SME bookkeeping
│   ├── crm-multilingual/                  ← CRM with non-Latin scripts
│   └── inventory-catalog/                 ← product catalog example
├── benchmarks/
│   └── ranathunga-2025/                   ← multiNER corpus eval harness
└── docs/                                  ← end-user docs (mkdocs or similar)
```

### 10.3 Business model

**Pure open source. No paid tiers. No cloud version (initially).**

The contractor builds it for the upstream product. the upstream product deploys their instance. The code is published as open source so:
1. The contractor has reusable IP for future client work.
2. Other developers can use it.
3. The codebase stays clean (knowing it's public is a forcing function).

**A managed cloud version (`samesake.dev` or whatever) is a Phase-15+ option** if there's clear demand. Not the focus. Not the business plan. Not a tier table baked into the README.

### 10.4 IP arrangement with the upstream product

**Recommended:** the contractor owns the matcher repo under their own GitHub org. the upstream product gets a perpetual, free license to use it. the upstream product is the first reference deployment. The contractor can take on other clients who use the same matcher later, or open-source it.

**Alternative:** the upstream product owns the matcher repo; the contractor is paid to build it. Cleaner legally; less leverage for the contractor.

**To-do:** 20-minute call with whoever signs the invoices before the first commit. Lock the answer in writing.

### 10.5 Governance (when / if needed)

Pre-v1: BDFL (contractor decides).
Post-v1, if a community forms: CONTRIBUTING.md + a CODE_OF_CONDUCT + maintainers list. Standard OSS playbook. Don't preempt this.

---

## 11. THE ANTI-LIST (explicitly NOT built)

These come up in conversations; reject them with this list.

| Not building | Why |
|---|---|
| SaaS pricing tiers | Open source. No tiers. |
| Closed-source dashboard polish | All code public. |
| Enterprise features (SSO, RBAC, audit log, compliance certs) | PR-driven. Not on the roadmap. |
| Multi-language SDK matrix | Eden + raw HTTP. Other-language clients are someone else's PR. |
| Generic search engine functionality | This is entity resolution, not search. |
| Generic vector store API (`POST /vector/query`) | This is entity resolution, not a vector DB. |
| RAG / document QA features | Wrong product. |
| Multi-tenant SaaS platform features (per-tenant billing, quotas, etc.) | Self-host = your problem. Cloud version deferred to Phase 15+. |
| Built-in analytics dashboard with charts | psql + scripts/. Optional dashboard package exists but is bare. |
| Built-in feature flags | Use the host platform's. |
| In-app onboarding tutorials | Read the README. |
| Multi-region orchestration | Run N copies; put a load balancer in front. |
| Per-call usage metering for billing | Add it if/when a paid cloud version ships. |
| Email / Slack / WhatsApp integrations | Out of scope. The consumer's app handles UX. |
| OCR / extraction (we consume extracted text) | Consumers run OCR; we match the output. |
| LLM agentic orchestration | LLMs at the edges. No agents in the core. |
| Per-tenant fine-tuned rankers | Per-tenant threshold calibration is enough. Fine-tuning is over-engineering at our scale. |

---

## 12. WHEN TO REVISIT EACH DECISION (the future-triggers table)

Decisions are reversible. Triggers for revisiting are explicit so we don't drift.

| Decision | Re-evaluate when | Likely next move |
|---|---|---|
| Bun + Elysia | Performance bottleneck identifiable to runtime/framework, not algorithm | Probably stick — Elysia is fast. Only Rust-rewrite if vector ops become dominant. |
| Postgres + ParadeDB + pgvector | Vector corpus crosses 10M total OR multi-region p50 < 30ms required | LanceDB / Vectorize / Qdrant Cloud — but only behind the same HTTP API, no caller changes |
| Embeddings as default | Week-4 ablation shows < 5% decisive across scopes | Drop the embedding channel for that scope; keep for scopes that earn it |
| `gemini-embedding-001` | Sinhala/Tamil precision in production < 0.8; OR cost crosses $1k/mo | A/B with Voyage / Cohere; or self-host BGE-M3 on Modal |
| `gemini-2.5-flash-lite` for parse | Parse error rate (`parser_confidence < 0.5`) > 10% in production | Try full Flash; or replace with regex-based deterministic parser; or paid vendor API (midday-style swap) |
| BullMQ on Dragonfly | Multi-tenant queue isolation needed; cross-region deploy | Trigger.dev for managed; or per-project Dragonfly instances |
| node-cron in-process | Service replication needs cron leader-election | External cron scheduler (cron-job.org, GH Actions, Kubernetes CronJob) |
| Apache 2.0 license | A real fork emerges as a hostile competitor | Reconsider AGPL if commercial fork siphons users; unlikely |
| No paid cloud version | Inbound demand from 3+ companies asking "can we just pay you to host this" | Spin up `samesake.dev` minimal hosted version with single-tier pricing |
| Multi-project via schemas (not separate DBs) | A consumer needs hard isolation (regulatory / per-tenant DB tuning) | Document "one deploy per project" pattern; offer migration script |
| First-class scoring columns + `components` jsonb | Adding a new channel requires migration too often | Keep stable channels promoted; revisit which is "stable" annually |

---

## 13. THE PRINCIPLES

If in doubt, read this section.

1. **Frugal beats optimal.** Self-host before pay-per-use. Stay on the cheaper tier of every provider. Drop indexes that don't earn.
2. **Determinism beats AI** *where determinism is available*. Cosine on multilingual short text — keep the AI. Brand normalisation, unit canonicalisation, code matching — pure code.
3. **One reviewer, lots of automation.** Cursor Bugbot on every PR. Eden for type safety. Drizzle for raw-SQL ergonomics. Each tool replaces one form of review humans usually do.
4. **The README is the docs is the marketing.** Honest, candid, "we tried X, dropped it because Y." No buzzwords. No "AI-powered" without specifics.
5. **Migrations are tiny and self-explanatory.** One concern per migration. Drop-migrations have a comment with the rationale (size, scans, last_used_date).
6. **Telemetry from day one.** `match_candidate` writes are non-negotiable. The F1 calibrator runs from week 1 even if it falls back to defaults until samples accumulate.
7. **No path-dependent decisions.** Every committed choice has a documented revisit trigger (see §12). When the trigger fires, don't argue — re-evaluate.
8. **Built for one user first.** the upstream product is the design partner. Other users come if they come. Don't pre-build for hypothetical needs.
9. **Open source as discipline, not as business.** Public code stays cleaner. Public README stays honest. No "we'll open source it later" — start public.
10. **Reversibility over cleverness.** Every architectural choice should have a `down.sql` or a config swap or a 1-class implementation change. No load-bearing cleverness.

---

## 14. GLOSSARY

- **Entity** — any record the consumer matches against (customer, product, supplier, place, …). Developer-declared.
- **Scope** — the tenancy key(s) for a project. Developer-declared. Usually `ownerId` or `tenantId`.
- **Channel** — one signal in the hybrid scorer. Cosine, trigram, phonetic, phone, alias, gate-X.
- **Combiner** — the function that reduces channel scores to a single `combined`. Default `probabilistic-or`; alternatives `rrf` and `fellegi-sunter`.
- **Gate** — a scorer that can drop or boost candidates outright (not just contribute weight). Internal-code, size-unit, brand.
- **Wave** — one pass of the bulk-import matcher. 8 waves total, locking in high-confidence first.
- **Alias** — a confirmed mapping from a query string to an entity id, persisted in `name_alias`, used to boost future matches of the same query.
- **Decisiveness** — for a given match, the % drop in combined score if a channel were removed. Drives the ablation gate.
- **Calibration** — the F1-optimised per-scope re-fit of `autoLink` and `suggest` thresholds, hourly.
- **Project** — one deploy unit. One Postgres schema. One API key. One entity vocabulary.
- **Eden** — Elysia's type-safe HTTP client; gives consumers compile-time type safety without a published SDK.
- **ParadeDB** — Postgres extension providing native BM25 + improved pgvector integration; bundled in our docker-compose.

---

## 15. THE ONE SENTENCE

> A frugal, schema-flexible, open-source entity-resolution service: cosine + trigram + phonetic + alias + gates over Postgres + pgvector + BM25, with F1-calibrated per-tenant thresholds, idempotent confirms, and the discipline to drop channels that don't earn their cost.
