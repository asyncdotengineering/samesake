# midday-pr-history.md — what the merged PRs reveal (companion to midday-matcher-analysis.md)

**Method:** searched `gh pr list --state merged --search "matching|inbox|embedding|enrich|trigram"` on `midday-ai/midday` since 2024. Read every PR body, file diff, and commit chain for the 12 most relevant. Cross-referenced with the migrations + code in the static-snapshot analysis.
**Date:** 2026-05-17.

The merged-PR history shows what the static code snapshot can't: **how they got to today's matcher, what they tried first, when they reversed course, and how the production-shaping shows up over 18 months**. This is the engineering culture, made legible.

---

## 1. Three eras of the midday matcher

### Era 1 — Initial matching (Jul 29 2025, PR #547 "Better matching and filter", +296/-22)
The earliest dedicated matching PR. Tiny — basic filter improvements + a simple matcher. No embeddings. No team learning.

### Era 2 — The "let's try embeddings" experiment (Aug 27 2025, PR #558 "Matching (WIP)", **+8,107/-260**)
The big embedding-adoption PR. Eight thousand lines added. They built:
- `transaction_embeddings` and `inbox_embeddings` side tables
- HNSW vector indexes
- Separate worker queue (`embeddings` queue) + processor (`embed-inbox`)
- An `embedding_score` column on `transaction_match_suggestions`
- A `embed-inbox` job that ran BEFORE matching could happen — match was gated on embedding readiness

This is the era where every new inbox item had to be embedded before matching could proceed. The matcher's `calculateInboxSuggestions` actively checked "is this item embedded yet?" before running.

### Era 2.5 — Team-pair learning (Aug 29 2025, two PRs)
- PR #580 "Add merchant pattern" (+615/-218)
- PR #591 "Feature/merchant pattern" (+418/-86)

Two PRs in two days that introduced the **per-team pair-history learning**:
- `fetchTeamPairHistory` cached query
- `computeAliasScore` (positive boost on previously-confirmed pairs)
- `computeDeclinePenalty` (subtractive on previously-declined pairs)
- `computeMerchantPatterns` (auto-match-on-second-confirmation gate)

This was added on TOP of the embedding-based scorer. It survived the rewrite (Era 3) intact — **only the embedding channel was removed; the per-team learning was the keeper.**

### Era 3 — The deterministic V2 rewrite (Mar 4 2026, PR #827 "New matching", **+4,299/-3,762**)
**Seven months after embeddings shipped, they ripped them out.** The Cursor Bugbot summary on the PR is unambiguous:

> *"Inbox matching is reworked to a deterministic, embedding-free V2 flow. Worker jobs (`process-attachment`, `slack-upload`, `whatsapp-upload`) now trigger `batch-process-matching` directly (no `embed-inbox` dependency), and the entire `embed-inbox` processor plus the separate `embeddings` queue/config are removed. … `calculateInboxSuggestions` no longer gates on embedding readiness, matching now uses unified scoring fields (including `nameScore`) and `word_similarity` retrieval."*

The file diff of this single PR:

**DELETED:**
- `apps/worker/src/processors/inbox/embed-inbox.ts` (167 lines)
- `packages/jobs/src/tasks/inbox/embed-inbox.ts` (135 lines)
- `apps/worker/src/queues/embeddings.config.ts` (74 lines)
- `apps/worker/src/processors/embeddings/index.ts` (17 lines)
- `apps/worker/src/queues/embeddings.ts` (16 lines)
- The embedding trigger from `slack-upload.ts` (-27) and `whatsapp-upload.ts` (-26)
- 661 lines from `docs/inbox-matching.md` (documentation rewrite to match)
- **1,049 net lines from `transaction-matching.ts`** (1,748 deleted, 699 added) — the matcher itself got SIMPLER by removing the embedding-aware code paths

**ADDED:**
- `packages/db/src/scripts/matching-progress.ts` (**1,580 lines**) — a script for tracking matching progress
- `packages/db/src/scripts/matching-eval-db.ts` (**677 lines**) — a database evaluation script
- 250 lines added to `transaction-matching.ts` utils (new scorers)
- New unit tests for the bidirectional matcher
- Two migrations: `0030_add_transaction_trgm_indexes.sql` + `0031_add_matching_indexes.sql`

The thing to notice: **they wrote 2,257 lines of evaluation tooling as part of the rewrite**. The decision to rip out embeddings wasn't a hunch — it was backed by purpose-built telemetry scripts that let them measure before deciding.

Also notable: **18 "wip" commits in 28 hours by Pontus (the founder) himself.** No multi-week feature branch with code review. One big-bang PR by the owner of the system. (Cursor Bugbot reviewed every commit automatically.)

---

## 2. The same-week aftermath (the "what production did to the rewrite" PRs)

#### PR #829 "Fix perf" (Mar 4 2026 — **same day** as #827, 2 hours later) +179/-181
The inbox UI choked on the new matching's status-update churn. Within hours of the rewrite landing:
- Replaced `ScrollArea` + full `.map()` render with **`@tanstack/react-virtual`** row virtualization
- Switched infinite pagination from intersection-observer to "near end of virtual list"
- Removed the realtime batching/invalidation mechanism, replaced with debounced refetch + in-place cache updates
- Optimistic UI for retry-matching

**Lesson:** the matcher generates more status churn than you think. UI virtualization + selective cache invalidation must accompany a high-throughput matcher.

#### PR #841 "Feature/confirm match" (Mar 9, **5 days later**) +391/-159
Production exposed concurrent-confirmation bugs:
- Made inbox matching **idempotent for grouped items** — `fetchInboxWithTransaction` guards against double-matching
- "auto-confirms any other pending suggestions that became matched as part of the group"
- Reworked search/match endpoints to use **the same unified scoring helpers** instead of separate SQL search functions

**Lesson:** the unified scorer became the contract for EVERY surface (matching, search, attachment-suggest, attach-by-typing). One scorer. No drift.

#### PR #838 "Handle errors" (Mar 9, same day as #841) +757/-716
The post-launch production-hygiene cleanup. Three migrations:
- `0033_drop_duplicate_trigram_index.sql` (4 lines)
- `0034_drop_team_limits_metrics.sql` (5 lines)
- `0035_drop_unused_vector_indexes.sql` (6 lines)

Plus:
- Added `/health/diagnose` benchmarking DB pool, Supabase JWKS, internal networking
- Added Server-Timing headers to `/trpc/*` and `/health`
- `Server-Timing` shows up in browser DevTools per request — instant ops feedback
- Banking provider `disconnected` errors classified as non-fatal
- `parseAPIError` extracts provider codes from JSON messages
- Switched several aggregates from `GROUP BY` joins to **correlated subqueries** (faster on the hot lists)
- "adjusts trigram matching to use `%>` with session-local `pg_trgm` settings" — the `SET LOCAL` pattern formalised

**Lesson:** five days of production is enough to expose three more unused indexes that should be dropped. Build the audit cadence into your operational rhythm.

---

## 3. The April reversal on AI enrichment (different system; same lesson)

#### PR #876 "Replace AI enrichment pipeline with CompanyEnrich API" (Apr 2 2026) +638/-809

The customer-enrichment pipeline (legal-entity name + category) used Exa search + Gemini in an agentic loop until April 2026. PR #876 ripped out:
- `packages/customers/src/enrichment/tools.ts` (245 lines — the Exa+Gemini agentic toolkit)
- `packages/customers/src/enrichment/verify.ts`
- The `@ai-sdk/google`, `ai`, `exa-js`, `zod` dependencies from the customers package

And replaced with:
- `packages/customers/src/enrichment/company-enrich.ts` (382 lines — a single API client to a paid vendor)

The PR body explicitly states the rationale: **"Swap out the Exa + Gemini agentic pipeline for a single structured API call to CompanyEnrich. Domain-first lookup (deterministic) with name fallback, domain validation on ambiguous matches, and proper field mapping."**

Key operational details from the diff:
- Set `attempts: 1` (no retries — paying per call now)
- Bumped timeout from 10s to 30s (the vendor API does two lookups: domain-first then name-fallback)
- Removed all AI-SDK deps from the customers package — clean cut

**This is a separate decision from the matcher rewrite (#827), but the same engineering pattern**: shipped an AI-powered approach, observed it in production, decided a deterministic alternative (with fewer dimensions of failure) was better. They paid money to a vendor to BUY determinism. Same reasoning that made them drop embeddings on the matcher.

---

## 4. The "Restore jobs" PR (Feb 23 2026, PR #793, +449/-0)

This is the most enigmatic PR. The title says "Restore" and the diff is +449/-0 (all additions, no deletions). It re-added:
- `batch-process-matching` job
- `match-transactions-bidirectional` job
- `no-match-scheduler` cron (the 90-day pending-cleanup)
- A `notification` job wrapper
- A tweak to `embed-inbox`: always reset inbox status back to `pending` after embedding (skipped or successful)

The body hints at a prior deletion: "Restores and expands Trigger.dev jobs around inbox matching." Some previous commit had nuked these jobs (probably during a Railway/Trigger migration in PR #757 "Railway", Feb 10 2026).

**Lesson:** even mature codebases lose code. Recovery PRs are normal. **Treat your jobs/processors registry as production-critical state with the same rigour as schema.**

---

## 5. The cross-currency prerequisite (Feb 24 2026, PR #797 "Base amounts", +894/-391)

Nine days before the big rewrite, midday landed the data-shape change that made #827 possible:
- Added `baseAmount` / `baseCurrency` / `baseTaxAmount` columns
- New `calculateBaseTaxAmount` utility
- **Cached + batched exchange-rate lookups**
- Batches inbox attachment inserts/updates
- Batches transaction enrichment updates
- Adds invoice query indexes
- Adjusts DB pool sizing

**The cross-currency matching logic in `scoreMatch()` (the "cross-currency known-vendor" path that shifts amount weight from 30 → 20 and date weight from 15 → 25) literally cannot work without these columns.** They sequenced the data prep BEFORE the algorithm change. **One PR per concern, in the right order.**

---

## 6. Engineering practices visible across the PR stream

1. **Cursor Bugbot on every PR.** Every PR body has the auto-generated `CURSOR_SUMMARY` with risk assessment ("Medium Risk", "High Risk"), overview, and an autofix suggestion. They've invested in PR review automation. This is a defensible ops practice — even with no human review, every PR has a structured second opinion.

2. **Founder-driven big-bang refactors.** PR #827 is the founder shipping ~28 hours of work as one PR. No multi-week feature branch with serial review. Pontus owns the matcher; he rewrites it; he ships. Followed within hours/days by 2-3 fix-up PRs (#829 perf, #841 confirm, #838 errors). **"Move fast, fix in production" — but with the discipline to immediately fix what production exposes.**

3. **Documentation rewritten as part of the change.** PR #827 deletes 661 lines of `docs/inbox-matching.md`. The doc was as much a deliverable as the code. **No stale "but the old docs say X" debt.**

4. **Drop unused things constantly.** Migrations `0032`, `0033`, `0034`, `0035` are ALL drops (transaction_embeddings, duplicate trigram index, team_limits metrics matview, unused vector indexes). 1 in every 4 migrations is removing something. **A migration log dominated by additions is a code smell; midday's is balanced.**

5. **Evaluation scripts are first-class.** PR #827 includes `matching-progress.ts` (1,580 lines) and `matching-eval-db.ts` (677 lines). These aren't tests; they're SCRIPTS for ad-hoc evaluation. **The team has tooling to ask the matcher hard questions on demand.**

6. **Migrations are tiny and explicit.** `0032` is THREE lines. `0035` is SIX lines with comments explaining the size (86 MB) and scan count (0). One concern per migration. Easy to read, easy to revert.

7. **The Drizzle stack lets them write raw SQL inline.** Their queries mix `eq()` / `and()` / `or()` with raw `sql\`...\`` template literals freely. No fighting an ORM. **For a matcher-heavy codebase, Drizzle's raw-SQL ergonomics matter more than Prisma's type-magic.**

8. **They use Trigger.dev for jobs.** Their `schemaTask` wrappers give type-validated queues with concurrency limits, max duration, and built-in observability. We chose Cloudflare Queues; functionally equivalent at our scale; their wrapper shape is worth aping.

---

## 7. The 7-month embedding-to-rejection cycle

The most important narrative timeline:

```
Aug 27 2025 — PR #558 "Matching (WIP)" — ADD embeddings, +8,107 lines
                ↓
              7 months of production
                ↓
Mar 04 2026 — PR #827 "New matching" — DROP embeddings, -3,762 lines, +4,299 lines
              (Net: -1,049 lines from transaction-matching.ts alone)
                ↓
              + 1,580 lines of matching-progress.ts (evaluation tooling)
              + 677 lines of matching-eval-db.ts (DB evaluation)
                ↓
Mar 04 2026 — PR #829 "Fix perf"  (UI churn from new matching)
Mar 09 2026 — PR #841 "Confirm match"  (idempotency for grouped items)
Mar 09 2026 — PR #838 "Handle errors"  (drop 3 more unused things; SET LOCAL formalised)
```

**Seven months of production with embeddings was needed to confidently rip them out.** Pontus didn't decide on day 30 or day 90 — he waited until the data was overwhelming. The 2,257 lines of evaluation tooling in #827 were the receipts that justified the change.

**For our plan, this is the cautionary-pacing lesson:**
- Don't expect to know whether embeddings earn their keep within 2 weeks of launch.
- Build the evaluation tooling FROM DAY ONE so you can answer "is this channel decisive?" at any time.
- Be willing to rewrite the matcher in a single big PR when the evidence is clear.

---

## 8. Specific NEW deltas to our plan from the PR history

Adding to the 12 deltas in `midday-matcher-analysis.md` §8:

| # | Delta | Lands in |
|--:|---|---|
| 13 | **Pre-position the data shape before the algorithm.** Our `cashbook.customerId` / `assetId` columns must land BEFORE the matcher tries to write to them — exactly midday's #797 → #827 sequencing. Phase 1 (schema only) → Phase 2 (algorithm) is non-negotiable. | Confirms our existing RFC sequencing. |
| 14 | **Write evaluation scripts as part of the matcher PR.** Midday landed `matching-progress.ts` (1,580 lines) + `matching-eval-db.ts` (677 lines) in the SAME PR as the algorithm. We have a Ranathunga eval harness planned for RFC 03; add a `matching-progress.ts` that surfaces per-tenant precision/recall trends from `match_candidate.outcome`. | RFC 03 Phase 6 |
| 15 | **Plan for the rewrite.** Build the `Matcher` interface boundary so that 7 months from now, if we decide to drop embeddings (or swap to LanceDB, or change models), it's a **single class-implementation swap**, not a 12-week rewrite. We already have this — call it out explicitly as the optionality reservoir. | RFC 03 §4.1 (interface) |
| 16 | **Same-day UI fix kit ready.** When the matcher starts running on production volume, the inbox/cashbook list UI may not survive the realtime status churn. Have **`@tanstack/react-virtual`** + debounced refetch + optimistic UI ready to deploy within hours. Don't ship the matcher first and discover this Monday morning. | Pre-flight checklist for the upstream product's matcher rollout |
| 17 | **Idempotency safeguards for the confirm path** — exactly midday's #841 lesson. When a user (or another worker) confirms the same match concurrently, the second confirm must be a no-op. Use a transaction + check-then-update pattern. | RFC 03 `Matcher.confirm` |
| 18 | **Cursor Bugbot (or equivalent) on every matcher PR.** Free automated risk-rating + summary per commit. Costs nothing to enable. Doubles the value of solo PRs by giving them a structured second pair of eyes. | Repo-level setting on the the upstream product fork + the standalone matcher repo |
| 19 | **Rewrite docs in the same PR.** Whenever the matcher behaviour changes substantively, the corresponding md docs change in the SAME PR. No "I'll update the docs later." Midday wiped 661 lines of stale doc in #827. | Process discipline |
| 20 | **Plan for the AI-pipeline-to-vendor-API reversal.** Midday replaced their Exa+Gemini agentic enrichment with a paid vendor API. The same fate may eventually befall our `ParseService` (Gemini Flash-Lite for product structured-parse). **Don't lock ParseService's caller signature to Gemini specifics** — make it generic enough that a deterministic vendor API (or a smaller in-house model) could replace it later. | RFC 04 `ParseService` interface |
| 21 | **Drop-and-document migrations are first-class.** Every cleanup migration in midday's history has a comment explaining what's being dropped and why (e.g. "86 MB, 0 scans"). Add this as a code-review checkpoint: **drop migrations require the rationale in a SQL comment**. Future you will be grateful. | Repo conventions |

---

## 9. Two contrasts midday's history exposes about our plan

1. **They started simple (PR #547), added complexity over 7 months (PR #558 embeddings; PRs #580/#591 team learning), then SIMPLIFIED back (PR #827).** Our plan is starting at the complex shape (5-channel hybrid scorer + embeddings + phonetic hash + parse pipeline + structured asset matching) on day one. **The midday lesson: maybe ship the simpler version first, add embeddings only if telemetry proves they're needed.** This is the Delta #8 ablation gate from the static analysis, but the PR history makes it more concrete: midday lived for 7 months without embeddings, then 7 months with, then went back. Either equilibrium worked for them; the embedding-OFF equilibrium has lower ongoing cost.

2. **Their matcher is tightly bound to their app** — it can't be extracted to a service without significant refactor. The queries are mixed with business logic in `packages/db/src/queries/transaction-matching.ts`. Ours has a `Matcher` interface boundary in code from day one. **Our architectural insurance against their fate (the 7-month re-evaluation cycle) is the interface.** When the evidence comes in 6–12 months from now, we should be able to swap implementations behind that boundary without the kind of full-week war that #827 represented.

---

## 10. The one quote that sums up the midday way

From PR #876's body, describing why they replaced AI with a paid API:

> *"Swap out the Exa + Gemini agentic pipeline for a single structured API call to CompanyEnrich. Domain-first lookup (deterministic) with name fallback, domain validation on ambiguous matches, and proper field mapping."*

Translation: **"We tried the AI-driven thing. We measured. We replaced it with the deterministic thing that costs us money but has fewer dimensions of failure."** That's the cultural value. Not anti-AI; pro-determinism where determinism is available.

This shows up in two places in their code:
1. **The matcher**: AI-embedding-channel removed; deterministic trigram+amount+currency+date scorer kept.
2. **The enrichment**: AI-agentic-pipeline removed; deterministic vendor API integration kept.

**For our plan**, the corresponding question to ask AT EACH CHANNEL is: is there a deterministic alternative that beats the AI option on long-tail behaviour? For us, the answers are:
- **Cosine over Gemini embeddings**: there is no deterministic alternative for cross-script Sinhala↔Tamil↔English. Keep.
- **Phonetic hash**: deterministic, we keep.
- **Trigram**: deterministic, we keep.
- **Phone exact match**: deterministic, we keep.
- **Alias hit**: deterministic, we keep.
- **Asset structured parse (ParseService → Gemini Flash-Lite)**: there IS a deterministic alternative (regex + lookup tables for brand normalisation + size parsing). It would be brittle but explicit. **We should ship the AI version; build the deterministic alternative as a Phase 7+ fallback; measure parse-error rate at week 12 and decide whether to switch.** This is the same trajectory midday followed for enrichment.

---

## Appendix — Full chronology, matcher-relevant only

| Date | PR # | Title | Net lines | Significance |
|---|---:|---|---:|---|
| 2024-09 → 2025-05 | various | small inbox fixes | small | Pre-matcher era |
| 2025-07-29 | #547 | Better matching and filter | +296/-22 | First matcher (basic) |
| 2025-08-22 | #564 | Notifications and activity | +4,579/-1,629 | Notifications infrastructure |
| 2025-08-27 | #558 | **Matching (WIP)** | **+8,107/-260** | **Embeddings added — Era 2 begins** |
| 2025-08-29 | #580 | Add merchant pattern | +615/-218 | Team-pair learning added |
| 2025-08-29 | #591 | Feature/merchant pattern | +418/-86 | Team-pair learning iterated |
| 2025-11-23 | #604 | Assistant v2 | +37,973/-7,983 | Chat assistant (separate concern) |
| 2025-11-25 | #647 | Revenue categories and cache | +1,867/-177 | Categories work |
| 2025-11-27 | #656 | Inbox grouping | +605/-107 | Group-by-thread/sender |
| 2025-12-09 | #663 | Worker v1.0.0 | +16,168/-2,615 | Worker rewrite (Trigger.dev?) |
| 2025-12-15 | #682 | WhatsApp | +2,873/-50 | New inbox source |
| 2026-01-19 | #719 | Customer enrichments | +554/-689 | Enrichment iteration |
| 2026-02-10 | #757 | Railway | +5,826/-5,053 | Infra migration |
| 2026-02-23 | #793 | Restore jobs | +449/-0 | Recovery from #757 deletion |
| 2026-02-24 | #797 | **Base amounts** | +894/-391 | **Cross-currency prerequisite for #827** |
| 2026-03-04 | #827 | **New matching** | **+4,299/-3,762** | **Embeddings dropped — Era 3 begins** |
| 2026-03-04 | #829 | Fix perf | +179/-181 | UI virtualization (same day) |
| 2026-03-09 | #838 | Handle errors | +757/-716 | Three drop migrations + Server-Timing |
| 2026-03-09 | #841 | Feature/confirm match | +391/-159 | Idempotency for grouped confirms |
| 2026-04-02 | #876 | **Replace AI enrichment with CompanyEnrich API** | +638/-809 | **AI → deterministic vendor swap** (different system) |

The matcher proper has been stable since March 9, 2026. Two months of production with no architecture-level changes. That's success.
