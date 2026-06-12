# midday-matcher-analysis.md — what midday-ai/midday does, line-by-line

**Repo:** [`midday-ai/midday`](https://github.com/midday-ai/midday) — "Your AI-Powered Business Assistant" for freelancers. The matching feature is branded **Magic Inbox**: receipts emailed in or uploaded → automatically attached to the corresponding bank transaction.
**Size:** ~46 MB git, monorepo with 30+ packages. Bun + TypeScript + Drizzle + Postgres + Trigger.dev + Supabase.
**What I read:** every match-related file in `packages/db` + `packages/jobs` + `packages/categories` + key migrations. ~3,000 lines of TS, ~500 lines of SQL.
**Goal of this doc:** harvest what they got right, name what they tried and abandoned, derive concrete deltas to our plan.

---

## 1. Executive summary

Midday solves a **different but adjacent** problem to ours: matching **incoming receipts to outgoing bank transactions** (one-to-one, time-bounded). Our problem is **matching extracted names to existing customer/supplier/asset records** (one-to-many, no time anchor). Despite the surface difference, the architectures rhyme: same Gemini stack, same hybrid-scoring shape, same per-team telemetry-driven retune story.

Five non-obvious lessons buried in their code:

1. **They tried transaction-level embeddings and DROPPED them.** Migration `0032_drop_transaction_embeddings.sql` drops `transaction_embeddings` and `inbox_embeddings` tables outright, plus the `embedding_score` column on `transaction_match_suggestions`. Migration `0035_drop_unused_vector_indexes.sql` drops two HNSW indexes citing **"0 scans"** in their comments. **They shipped embeddings, watched them earn nothing, and ripped them out.** For *transaction-to-receipt* matching, trigram + amount + currency + date is enough. The only place they kept embeddings is on **category names** (semantic-similarity routing) — same scale as our `units_alias` problem, not entity resolution. **For our problem (cross-script Sinhala/Tamil), embeddings still earn their keep — but their experience is a warning: validate the channel pays for itself before locking it in.**

2. **F1-optimised per-team threshold calibration is live in production.** Not a "we'll tune later" comment — actual code (`getTeamCalibration`, `optimizeThresholdFromFeedback`) that re-fits the auto-link threshold every 5 minutes per team based on confirm/decline outcomes over the last 90 days. Caps adjustments at ±3% per cycle. Requires minimum sample sizes (5 confirmed, 5 declined). **This is the formalised version of what we hand-wave as "telemetry retune at week 2".**

3. **Decline penalty + alias score from team pair-history.** Names that this team previously confirmed together get a positive score boost; names they previously declined together get a penalty. Computed at query time from a cached 5-minute `transactionMatchSuggestions` rollup. **The matcher learns per-team without retraining.**

4. **Bidirectional matching with claim-tracking** prevents double-assignment. Forward phase (new tx → inbox candidates) marks claimed inbox IDs. Reverse phase (pending inbox → tx candidates) excludes already-claimed transaction IDs. Same machinery we sketched for the import-flow waves, but applied to the day-to-day matching path.

5. **Score channels are first-class columns**, not packed into a JSONB. `transaction_match_suggestions` has `amount_score`, `currency_score`, `date_score`, `name_score`, plus a `confidence_score` and a `match_details jsonb` for everything else. **Transparency** is explicit: the table is queryable by score component, the UI can show "we matched on amount and date but the name was a stretch", and the F1 optimiser reads these columns directly. Our `match_candidate.components` jsonb is more flexible but less queryable.

---

## 2. The architecture (one picture)

```
┌──────────────────────────────────────────────────────────────────────────┐
│  INBOUND: receipts via Gmail/Outlook OAuth (packages/inbox/providers/*)  │
│           OR direct upload via dashboard                                 │
└──────────────────────────┬───────────────────────────────────────────────┘
                           │
                           ▼
            ┌──────────────────────────────┐
            │  packages/jobs/...inbox/     │
            │  process-attachment.ts       │
            │  (extract amount/date/vendor)│
            └──────────────┬───────────────┘
                           │
                           ▼
            ┌──────────────────────────────┐
            │  inbox row created           │
            │  status='pending'            │
            └──────────────┬───────────────┘
                           │
                           ▼
            ┌──────────────────────────────────────────────┐
            │  triggerSmartMatching()                       │
            │  (smart-matching.ts) decides:                 │
            │    new transactions? → bidirectional          │
            │    specific inbox? → batch-process            │
            │    otherwise → fallback to batch              │
            └──────────────┬───────────────────────────────┘
                           │
            ┌──────────────┼──────────────┐
            ▼                              ▼
┌──────────────────────────┐   ┌──────────────────────────────┐
│ match-transactions-      │   │ batch-process-matching        │
│ bidirectional.ts          │   │ (loop over inbox IDs;         │
│                           │   │  calls calculateInbox-        │
│ PHASE 1 — forward:        │   │  Suggestions per row)         │
│   for each new tx:        │   └──────────────┬───────────────┘
│     findInboxMatches()    │                  │
│     persist + notify      │                  │
│                           │                  │
│ PHASE 2 — reverse:        │                  │
│   for each pending inbox: │                  │
│     calculateInbox-       │                  │
│     Suggestions()         │                  │
│     persist + notify      │                  │
└──────────────┬────────────┘                  │
               │                                │
               └────────────────┬───────────────┘
                                ▼
            ┌──────────────────────────────────────────────┐
            │  findMatches() / findInboxMatches()           │
            │  (transaction-matching.ts, ~1100 lines)       │
            │                                               │
            │   1. getTeamCalibration() — per-team          │
            │      thresholds, 5-min cached                 │
            │   2. fetchTeamPairHistory() — alias + decline │
            │      data, 5-min cached                       │
            │   3. SQL pre-filter: date-window +            │
            │      currency-or-trigram-or-base-currency     │
            │      + no existing attachment +               │
            │      no pending suggestion + LIMIT 30         │
            │      [SET LOCAL pg_trgm.word_similarity_      │
            │       threshold = 0.3]                        │
            │   4. TS re-score each candidate:              │
            │      - calculateNameScore (Jaccard+contain    │
            │        +prefix+concat+alias)                  │
            │      - calculateAmountScore (VAT-aware,       │
            │        cross-currency-aware)                  │
            │      - calculateCurrencyScore                 │
            │      - calculateDateScore (per inboxType,     │
            │        Net-7/15/30/60/90 windows)             │
            │      - scoreMatch (weighted combine,          │
            │        cross-currency known-vendor bias,      │
            │        exact-amount floors)                   │
            │   5. Sort by confidence; skip dismissed;      │
            │      return top.                              │
            └──────────────────────┬───────────────────────┘
                                   ▼
            ┌──────────────────────────────────────────────┐
            │  persistInboxSuggestionWorkflow()             │
            │  Drizzle TX:                                  │
            │    - createMatchSuggestion (insert row)       │
            │    - matchTransaction (link inbox → tx        │
            │      if auto_matched)                         │
            │    - updateInbox status                       │
            └──────────────────────┬───────────────────────┘
                                   ▼
            ┌──────────────────────────────────────────────┐
            │  triggerMatchingNotification (Slack/email)    │
            └──────────────────────────────────────────────┘

DAILY CRON:
            ┌──────────────────────────────────────────────┐
            │  no-match-scheduler.ts (cron "0 2 * * *")     │
            │  Inbox items pending > 90 days → status='no_match' │
            └──────────────────────────────────────────────┘

SEPARATE PATH (kept embeddings):
            ┌──────────────────────────────────────────────┐
            │  enrich-transaction.ts                        │
            │  Gemini 2.5 Flash-Lite → legal entity name +  │
            │  category. Updates merchantName, categorySlug │
            │  on transactions.                             │
            └──────────────────────────────────────────────┘

            ┌──────────────────────────────────────────────┐
            │  packages/categories/embeddings.ts            │
            │  Gemini embedding-001 @ 768d for category     │
            │  semantic similarity (assigns category by     │
            │  cosine against canonical categories).        │
            └──────────────────────────────────────────────┘
```

---

## 3. The matcher schema

The `transaction_match_suggestions` table is the source of truth. Drizzle definition (paraphrased):

```ts
transaction_match_suggestions {
  id              UUID PK
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()

  // Core relationship
  team_id         UUID NOT NULL
  inbox_id        UUID NOT NULL
  transaction_id  UUID NOT NULL

  // Per-channel scores — first-class columns, NOT in JSONB
  confidence_score  numeric(4,3) NOT NULL    // 0..1, 3 decimals
  amount_score      numeric(4,3)
  currency_score    numeric(4,3)
  date_score        numeric(4,3)
  name_score        numeric(4,3)

  // Match context
  match_type    text NOT NULL    // 'auto_matched'|'high_confidence'|'suggested'
  match_details jsonb            // freeform: scores object, source, criteria, calculatedAt

  // User feedback
  status         text NOT NULL DEFAULT 'pending'
                                  // 'pending'|'confirmed'|'declined'|'expired'|'unmatched'
  user_action_at TIMESTAMPTZ
  user_id        UUID
}

// Index added in 0031 for the calibration + history queries
CREATE INDEX transaction_match_suggestions_team_status_created_idx
  ON transaction_match_suggestions (team_id, status, created_at DESC);
```

Companion table:

```ts
inbox {
  ...
  status text  // 'pending'|'analyzing'|'suggested_match'|'matched'|'no_match'|...
  transaction_id UUID nullable
  display_name text
  amount numeric
  currency text
  base_amount numeric        // converted to team base currency
  base_currency text
  date date
  type text                  // 'invoice'|'expense'|'other'
  website text               // domain extracted from email or vendor URL
  invoice_number text
  ...
}

// Trigram index for the reverse-match SQL (added in 0031)
CREATE INDEX idx_inbox_display_name_trgm
  ON inbox USING GIN (display_name gin_trgm_ops);
```

**What's missing on transactions** (after the 0032 cleanup):
- No `embedding` column
- No `embedding_score` on `transaction_match_suggestions`
- The dropped `transaction_embeddings` + `inbox_embeddings` side tables

**What's on transactions** (kept):
- `fts_vector tsvector` (Postgres full-text search) — `GENERATED ALWAYS AS` from multiple columns
- A GIN trigram index on `merchant_name` ascending
- Composite indexes by `(team_id, date)`, `(team_id, category_slug)`, etc.

---

## 4. The matching algorithm — line-by-line

### 4.1 Pre-filter SQL (drizzle, in `findMatches`)

Per query, inside a transaction so the local trigram threshold doesn't leak:

```ts
await tx.execute(sql`SET LOCAL pg_trgm.word_similarity_threshold = 0.3`);

return tx.select({...}).from(transactions).where(and(
  eq(transactions.teamId, teamId),
  eq(transactions.status, "posted"),
  sql`${transactions.date} IS NOT NULL`,

  // Date window — different for invoices vs expenses
  inboxItem.type === "invoice"
    ? sql`${transactions.date} BETWEEN
          ${inboxItem.date}::date - INTERVAL '90 days'
          AND ${inboxItem.date}::date + INTERVAL '123 days'`
    : sql`${transactions.date} BETWEEN
          ${inboxItem.date}::date - INTERVAL '90 days'
          AND ${inboxItem.date}::date + INTERVAL '30 days'`,

  // Exclude transactions already attached to a receipt
  notExists(tx.select({id: transactionAttachments.id})
              .from(transactionAttachments)
              .where(/* same tx */)),

  // Exclude transactions with a pending suggestion
  notExists(tx.select({id: transactionMatchSuggestions.id})
              .from(transactionMatchSuggestions)
              .where(/* same tx, status='pending' */)),

  // OR over three candidate criteria
  or(
    // (a) same currency + amount within 25%
    and(
      eq(transactions.currency, inboxItem.currency || ""),
      sql`ABS(ABS(${transactions.amount}) - ${inboxAmount})
          < GREATEST(1, ${inboxAmount} * 0.25)`
    ),
    // (b) trigram word_similarity on either name OR merchantName
    sql`(${inboxItem.displayName} %> ${transactions.name}
       OR ${inboxItem.displayName} %> ${transactions.merchantName})`,
    // (c) same BASE currency + base-amount within 15%
    and(
      eq(transactions.baseCurrency, inboxItem.baseCurrency || ""),
      sql`${transactions.baseCurrency} IS NOT NULL`,
      sql`ABS(ABS(COALESCE(${transactions.baseAmount}, 0)) - ${inboxBaseAmount})
          < GREATEST(50, ${inboxBaseAmount} * 0.15)`
    )
  ),

  // Exclude already-claimed transactions (passed in from bidirectional)
  excludeTransactionIds && excludeTransactionIds.size > 0
    ? sql`${transactions.id} NOT IN (${...})`
    : undefined,
))
.orderBy(
  // Best name match first
  sql`GREATEST(
    word_similarity(${inboxItem.displayName}, ${transactions.name}),
    word_similarity(${inboxItem.displayName}, ${transactions.merchantName})
  ) DESC`,
  // Then by amount proximity
  sql`ABS(ABS(${transactions.amount}) - ${inboxAmount})
      / GREATEST(1.0, ${inboxAmount})`,
  // Then by date proximity
  sql`ABS(${transactions.date} - ${inboxItem.date}::date)`,
)
.limit(30);
```

Takeaways:
- **30-candidate cap** before scoring. We use 5 in match_party.
- **Three OR'd criteria** — amount-OR-name-OR-base-currency — broadens recall before strict scoring narrows it.
- **`SET LOCAL` for the trigram threshold** — per-query tuning without a global change. Same pattern we use for `hnsw.ef_search`.
- **`notExists` for "no pending suggestion" + "no existing attachment"** is the deduplication primitive.
- **Order by composite secondary keys** even before scoring, so the limit picks the best 30 not a random 30.

### 4.2 Per-candidate scoring (TypeScript, in `findMatches`)

For each of the 30 candidates, compute 4 channel scores + the combined confidence. ~110 lines of code per candidate. Highlights:

**Name score (`calculateNameScore`, lines 288–359):**
- `normalizeNameTokens()`: NFD normalisation + strip diacritics + lowercase + replace punctuation + tokenise + drop tokens matching a company-suffix denylist (`COMPANY_SUFFIXES = {inc, llc, ltd, ab, gmbh, …}` — 28 suffixes covering EU + APAC).
- 4 sub-scores, pick `max`:
  - **Jaccard token overlap**: `|A ∩ B| / |A ∪ B|`
  - **Substring containment**: if one normalised name is a substring of the other → 0.85
  - **Prefix match**: if first significant token matches → 0.6
  - **Concatenated match**: handles "ElevenLabs" vs "Eleven Labs" → 0.95 if equal, 0.8 if contained
- Plus an **alias score** boost from team pair-history (see 4.4)
- Plus an **invoice number boost**: if the inbox carries an invoice number AND that number appears in the searchable text of the transaction → 0.95
- Plus a **domain token boost**: if the inbox has a vendor website AND the domain token appears in the transaction text → 0.88

No embeddings. Everything is string-level. Works because their target is English/European business names.

**Amount score (`calculateAmountScore`, lines 136–218):**

Same-currency tiered:
- diff = 0 → 1.0
- diff ≤ 1% → 0.98
- diff ≤ 2% → 0.95
- diff ≤ 5% → 0.85
- diff ≤ 10% → 0.6
- diff ≤ 20% → 0.3
- else → 0
- **VAT escape hatch**: if `ratio - 1` is within 1.5% of one of 12 common VAT rates (0.05, 0.06, 0.07, 0.075, 0.08, 0.10, 0.12, 0.19, 0.20, 0.21, 0.22, 0.25), score 0.88

Cross-currency:
- If both sides have a base currency and they match, score via `baseAmount` diff, with tiered tolerance by amount size:
  - avg ≥ 5000 → tight: 0.95 / 0.75 / 0.5 / 0.3
  - smaller → looser: 0.9 / 0.8 / 0.65 / 0.45 / 0.25

**Currency score (`calculateCurrencyScore`, lines 220–237):**
- Same currency → 1.0
- Different currencies but same base → 0.7
- Otherwise → 0.3
- Either null → 0.5

**Date score (`calculateDateScore`, lines 431–504):**
The most domain-aware piece. Different scoring for invoices vs expenses.

For invoices (payment expected AFTER invoice date):
- Net 30: signed diff 24–38 days → 0.98 (Net 30 + 3-day bank delay)
- Net 60: 55–68 days → 0.96
- Net 90: 85–98 days → 0.94
- Net 15: 10–20 days → 0.95
- Net 7: 3–11 days → 0.93
- Immediate: 0–6 days → 0.99
- Extended payment up to 123 days: linear decay from 0.9 to 0.7
- Advance payment (paid before invoice): up to 10 days early → 0.85

For expenses (receipt AFTER transaction is normal):
- 1–4 days (adjusted for 3-day banking delay) → 0.99
- 5–10 days → 0.95
- ≤ 33 days → 0.9
- ≤ 63 days → 0.8
- ≤ 93 days → 0.7
- Receipt *before* transaction up to 10 days → 0.85

Standard proximity fallback for everything else: 0 days → 1.0, ≤1 → 0.95, ≤3 → 0.85, ≤7 → 0.75, ≤14 → 0.6, ≤30 → linear decay 1→0.3, beyond → 0.1.

### 4.3 Combined score (`scoreMatch`, lines 371–429)

```ts
function scoreMatch({
  nameScore, amountScore, dateScore, currencyScore,
  isSameCurrency, isExactAmount, declinePenalty = 0
}): number {
  // Cross-currency with strong name match: vendor is identified,
  // amount differences are FX noise. Shift weight to date.
  const isCrossCurrencyKnownVendor = !isSameCurrency && nameScore >= 0.8;
  const amountWeight = isCrossCurrencyKnownVendor ? 20 : 30;
  const dateWeight   = isCrossCurrencyKnownVendor ? 25 : 15;
  // nameWeight=10, currencyWeight=5 always.
  const totalWeight = 10 + amountWeight + dateWeight + 5;  // = 60 always

  const weightedBase =
    (nameScore   * 10
   + amountScore * amountWeight
   + dateScore   * dateWeight
   + currencyScore * 5)
    / totalWeight;

  let confidence = weightedBase;

  // Exact-amount FLOORS — a strong amount match guarantees a minimum score
  if (isExactAmount && nameScore >= 0.5 && dateScore >= 0.7) {
    confidence = Math.max(confidence, 0.92);
  } else if (isExactAmount && nameScore >= 0.3 && dateScore >= 0.5) {
    confidence = Math.max(confidence, 0.85);
  } else if (isExactAmount && isSameCurrency && dateScore >= 0.6) {
    confidence = Math.max(confidence, 0.78);
  }

  // Cross-currency additive boost (small)
  if (!isSameCurrency && nameScore >= 0.5 && amountScore >= 0.6 && dateScore >= 0.3) {
    confidence = Math.max(confidence, confidence + 0.05);
  }

  // PENALTIES — multiplicative
  if (nameScore === 0) confidence *= 0.55;
  if (dateScore < 0.2) confidence *= 0.65;

  // Decline penalty (learned)
  if (declinePenalty > 0) confidence -= declinePenalty;

  return Math.max(0, Math.min(1, confidence));
}
```

**Key insights:**
- It's a **weighted sum**, NOT a probabilistic OR. Our plan uses probabilistic OR with RRF as A/B alternative. Theirs is simpler and easier to reason about.
- **Weights are static base weights, but reshape dynamically** for cross-currency cases.
- **Exact-amount produces a FLOOR**, not just a high score — a guaranteed minimum confidence if name and date are even modest. This is conceptually a "gate" similar to our brand/size+unit gates for products.
- **Hard penalties** for zero name or near-zero date. These act as soft gates.
- **Decline penalty is subtractive**, not multiplicative. Learned per-pair from team history.

### 4.4 Per-team learning — `fetchTeamPairHistory` + alias/decline scoring

The team's match history is cached for 5 minutes. Structure (paraphrased):

```ts
type TeamPairHistoryRow = {
  status: 'confirmed'|'declined'|'unmatched',
  confidenceScore: number,
  createdAt: string,
  inboxName: string,
  transactionName: string,
  merchantName: string,
};

// Keyed by normalised pair "inboxName|merchantName"
type TeamPairHistoryMap = Map<string, TeamPairHistoryRow[]>;
```

When scoring a candidate:
- `computeAliasScore(history, normInbox, normTx)`: if (normInbox, normTx) appears as 'confirmed' in history, return a positive score that boosts `nameScore`.
- `computeDeclinePenalty(history, normInbox, normTx)`: if (normInbox, normTx) appears as 'declined' in history, return a penalty that gets subtracted from confidence.
- `computeMerchantPatterns(history, normInbox, normTx)`: pattern that promotes the match to `auto_matched` if the team has confirmed this pair before.

**This is the feedback loop we said "let's add later".** They have it. It's per-team. It's queryable from the suggestion table. No retraining needed.

### 4.5 Per-team threshold calibration — `getTeamCalibration` + `optimizeThresholdFromFeedback`

```
Every 5 minutes per team:
  1. Load last 90 days of transaction_match_suggestions
     where status IN ('confirmed','declined','unmatched')
  2. If fewer than 5 samples → fallback to defaults
     (suggested=0.6, auto=0.9)
  3. F1-sweep: try thresholds from 0.25 to 0.90 in steps of 0.01
     For each threshold:
       tp = predicted_positive AND actual_positive (confirmed)
       fp = predicted_positive AND actual_negative (declined+unmatched)
       fn = predicted_negative AND actual_positive
       precision = tp / (tp+fp)
       recall    = tp / (tp+fn)
       f1        = 2pr/(p+r)
       (prefer higher precision on ties)
  4. Cap adjustment to ±3% per cycle (MAX_ADJUSTMENT)
  5. Require min samples (8 confirmed for conservative, 5 for normal)
  6. Cache for 5 minutes
```

Caps + sample minimums prevent runaway adjustment. The actual `auto_matched` decision uses *both* the confidence threshold AND a name-floor (`nameScore >= 0.5`) — the threshold alone doesn't promote to auto-match.

**This is the most sophisticated piece of code in the codebase.** Worth lifting wholesale.

---

## 5. What they tried and removed (the most important part)

### Migration `0032_drop_transaction_embeddings.sql`

```sql
DROP TABLE IF EXISTS transaction_embeddings;
DROP TABLE IF EXISTS inbox_embeddings;
ALTER TABLE transaction_match_suggestions DROP COLUMN IF EXISTS embedding_score;
```

**Three lines.** Three dropped tables/columns. The git history tells the story: they built a 5-channel scorer (name + amount + currency + date + embedding), shipped it, observed in production, and decided the embedding channel didn't pay for itself for receipt↔transaction matching.

Why? Probably:
- The OTHER four channels (name trigram + amount + currency + date) carry enough signal.
- The vendor names on receipts ↔ bank transactions are predominantly English / Latin script.
- Bank statements have a fixed vocabulary; their text doesn't drift.
- Embedding costs were not justified by the marginal precision gain.

### Migration `0035_drop_unused_vector_indexes.sql`

```sql
-- Drop unused HNSW vector index on document_tag_embeddings (86 MB, 0 scans)
-- Queries look up by slug, not by vector similarity
DROP INDEX CONCURRENTLY IF EXISTS document_tag_embeddings_idx;

-- Drop unused HNSW vector index on transaction_category_embeddings (5 MB, 0 scans)
DROP INDEX CONCURRENTLY IF EXISTS transaction_category_embeddings_vector_idx;
```

**The comments are gold.** They tracked `idx_scan` from `pg_stat_user_indexes`, found indexes with 0 scans after some shipping period, and dropped them. **Engineering discipline most teams don't practice.** Saved 91 MB of disk + write amplification on every update.

**Implication for our plan:** Build the observability into our plan from day 1. Track `idx_scan` per HNSW index. Plan an audit at week-4 and week-12 to drop indexes that aren't earning their keep. Our `match_candidate.components` jsonb already records which channels fired; correlate that with which indexes those channels query.

### Where they KEPT embeddings: `packages/categories/embeddings.ts`

The only embedding usage that survived:
- `gemini-embedding-001` @ 768d, task type `SEMANTIC_SIMILARITY`
- Used for assigning a transaction to a category (`software`, `travel`, `meals`, etc.) by cosine against the canonical category embeddings
- Small fixed vocabulary (~25 categories)
- Computed once per category, not per transaction

This is **closer to our `units_alias` problem** (normalising free-text to a small canonical set) than to entity resolution. The fact that they kept embeddings here and dropped them on transactions matters: **embeddings shine when the corpus has high vocabulary drift; they don't earn their cost when both sides come from a constrained vocabulary (like bank-feed transaction names).**

---

## 6. What's similar to our plan

| Area | Midday | Our plan | Verdict |
|---|---|---|---|
| Embedding model | `gemini-embedding-001` @ 768d | Same | ✅ Aligned |
| Parse / enrichment LLM | `gemini-2.5-flash-lite` | Same | ✅ Aligned (we converged on Flash-Lite via cost analysis; they did via experience) |
| Match-candidate table | First-class status + scores | `match_candidate` (theirs more queryable; ours more flexible) | Worth re-examining |
| Status state machine | pending → analyzing → suggested → confirmed/declined/unmatched/expired | Same vocabulary | ✅ Aligned |
| Per-tenant scope | `team_id` everywhere | `ownerId` everywhere | ✅ Same shape |
| Bidirectional matching | Yes, with claim-tracking | Implicit in our wave-based import | They do it for every match; we do it for imports |
| Auto-link / suggest / ask triple | Yes (`auto_matched`/`high_confidence`/`suggested`/`no_match_yet`) | Yes (`autolink`/`suggest`/`ask`) | ✅ Aligned |
| Cached calibration / pair history per team | 5-min TTL | Stub | They have the algorithm; we don't |
| Stack | Bun + Drizzle + Postgres + Trigger.dev + Supabase | Bun + Prisma + Postgres + Cloudflare Queues + Supabase | Same overall shape |

---

## 7. What's different, and what we should steal

### 7.1 Steal: F1-optimised threshold calibration

We have a TODO: "tune thresholds from telemetry at week 2". They have **production code** that does this every 5 minutes per team. Algorithm in §4.5.

**Concrete delta:** Move our Phase 6 "telemetry retune" from "manual analysis after 2 weeks" to "auto-calibrated per-tenant every 5 minutes once we have ≥ 20 labelled samples (5 confirmed + 5 declined)". Cap at ±3% per cycle. Lift `getTeamCalibration` near-verbatim into RFC 03 Phase 6.

### 7.2 Steal: pair-history-driven alias score + decline penalty

We have a `name_alias` table for confirmed aliases. We don't have:
- A **decline penalty** that gets subtracted when the user has previously declined a specific (query, candidate) pair.
- An **alias score boost** computed from historic confirmations at match time (rather than only via exact `name_alias` hit).
- A **per-pair pattern** that triggers auto-match-on-second-confirmation.

**Concrete delta:** Extend RFC 03's `match_party` (and RFC 04's `match_asset`) with three additional scoring inputs computed from `match_candidate.outcome`:
- `alias_score` (positive boost when pair has confirms in history)
- `decline_penalty` (subtractive when pair has declines)
- `pattern_can_auto_match` (boolean — has this pair been confirmed ≥ N times?)

Cached 5 min per team in the matcher service. Re-queries `match_candidate` rolled up by `(normalise_name(query_text), normalise_name(candidate.name))` pairs.

### 7.3 Steal: First-class score columns on `match_candidate`

Their `transaction_match_suggestions` has `amount_score`, `currency_score`, `date_score`, `name_score`, `confidence_score` as **typed numeric columns**, with `match_details jsonb` for everything else. We have everything in `components jsonb`.

**Trade-off:**
- Theirs is queryable (`SELECT AVG(name_score) WHERE status='declined'`).
- Ours is flexible (new channels don't require a migration).

**Concrete delta:** Move the **stable, named channels** (cosine, trgm, phonetic, alias_hit, phone_eq) into first-class columns on `match_candidate`. Keep `components jsonb` for experimental / new channels (rrf_score, experimental gates). Best of both worlds.

### 7.4 Steal: `SET LOCAL pg_trgm.word_similarity_threshold = 0.3` pattern

We've used `SET LOCAL hnsw.ef_search = 200`. Same idiom for trigram. Per-query tuning without affecting global state.

**Concrete delta:** Document this in RFC 02 §7.1 as the standard pattern for any pg_trgm-using function. Also add to RFC 04's `match_asset`.

### 7.5 Steal: Honest index-usage audit cadence

Their migration `0035` is the model. Build into our plan: at **week 4** and **week 12** post-launch, run:

```sql
SELECT indexrelname, pg_size_pretty(pg_relation_size(indexrelid)) AS size,
       idx_scan, idx_tup_read
FROM pg_stat_user_indexes
WHERE schemaname='public'
ORDER BY idx_scan ASC, pg_relation_size(indexrelid) DESC;
```

Any index with `idx_scan = 0` and size > 1 MB gets a "drop or justify" review. **Add to RFC 03 Phase 6 (telemetry retune) as a hard checklist item.**

### 7.6 Steal: VAT-aware (or domain-aware) amount scoring

Their amount-score function knows about VAT rates and lets `Amount × 1.20` match `Amount × 1.00` because it recognises a 20% VAT rate. Beautiful domain-aware cleverness.

**Concrete delta for products:** Add domain-aware tolerances to our size+unit gate. E.g., `500ml` matches `500ml ±5%` (rounding tolerance for measured liquids); `1 dozen` matches `12 pcs`; `1kg` matches `1000g`. We already have `units_alias` for the unit normalisation; add a tolerance config per family in `units_alias`.

### 7.7 Steal: Domain token + invoice number boost

Their `findMatches` boosts `nameScore` to 0.95 if the inbox's `invoice_number` appears in the candidate's text, and to 0.88 if the inbox's website domain token appears. **Cheap, deterministic, high-precision.**

**Concrete delta:** For our cashbook extraction path, add similar boosts:
- If the extracted text contains a phone number (regex), match against `customer.number` / `supplier.number` exact → score 0.99.
- If the extracted text contains a recognisable internal-code pattern, match against `asset.internal_code` exact → score 1.0 (already in our plan for products).
- If the extracted text contains a unique handle / shop-code from the merchant's own naming convention, route via `owner_naming_convention`.

### 7.8 Worth examining (but not adopting blindly): no embeddings on transactions

Their negative result is the cautionary tale. But:
- Their transaction text is mostly English/Latin company names.
- Our text is **Sinhala / Tamil / English code-mixed with emoji** (see investigation §2.2).
- The cross-script case (`sugar` ≈ `සීනි` ≈ `sini`) is exactly what trigram CAN'T do and embeddings CAN.

**Concrete delta:** Keep our embedding plan, but add a **week-4 ablation check**: query `match_candidate.components` to see how often the `cosine` score was the *decisive* factor (i.e., the match would have failed without it). If the answer is < 5%, we should ourselves drop the HNSW index and the embedding columns to save disk + write amplification. The signal is in our own data.

### 7.9 Worth examining: no embeddings, just `pg_trgm` for the name channel

Their entire matcher uses pg_trgm `%>` operator (word_similarity) for name matching. No HNSW. No vector lookup. Just trigram + smart scoring + per-team learning.

This is the **strong argument for "we might not need pgvector at all"** — at least not for the people side. Our customer/supplier names are 60–70% Latin/transliterated (per investigation §2.2). Trigram + phonetic + alias might be enough.

**Concrete delta:** Add an A/B branch at RFC 03 Phase 3. With the embedding backfill done, also run the matcher WITHOUT the cosine channel and measure precision/recall on the Ranathunga corpus. If cosine adds < 5 points of precision @ auto-link, we **should** drop it and follow midday's path. If it adds > 10 points, keep it. In between, judgement call.

### 7.10 Worth examining: Trigger.dev vs Cloudflare Queues

They use Trigger.dev (open source, schemaTask wrappers, built-in retries, dead-letter, dashboards, concurrency limits per task). We chose Cloudflare Queues for native integration.

**Trade-off:**
- Trigger.dev: better DX, built-in observability, schema validation per task, runs anywhere.
- Cloudflare Queues: no new vendor, native to our existing Workers, free tier-friendly.

**Concrete delta:** Stand by our choice for now (no vendor surface; aligns with Cloudflare-native investment); but note Trigger.dev as a strong fallback if Cloudflare Queues operational surface gets thorny. **Their `schemaTask({ id, schema, queue: { concurrencyLimit: 5 }, maxDuration: 120, run: ... })` shape is worth aping in our own Queue consumer typing.**

### 7.11 Don't adopt: full-text search (`fts_vector`) on transactions

They have a `tsvector GENERATED ALWAYS AS` column on transactions for the search UI. We have separate concerns; we don't need this for matching.

---

## 8. Concrete deltas to our plan (the punch-list)

In priority order:

| # | Delta | Lands in |
|--:|---|---|
| 1 | **F1-optimised per-team threshold calibration** as a SQL helper + 5-min cache. Lift `getTeamCalibration` + `optimizeThresholdFromFeedback` near-verbatim. | RFC 03 Phase 6 (telemetry retune section) — graduate from "TODO at week 2" to actual code |
| 2 | **Promote stable scoring channels to first-class numeric columns** on `match_candidate`: `cosine_score`, `trgm_score`, `phonetic_score`, `alias_hit`, `phone_eq`. Keep `components jsonb` for experimental. | RFC 02 §7.1 (schema change) |
| 3 | **Alias score boost + decline penalty + pair-pattern auto-match** computed from `match_candidate.outcome` rollups. | RFC 03 §4.1 (scorer config) + new `pair_history` rollup helper |
| 4 | **`SET LOCAL pg_trgm.word_similarity_threshold = 0.3`** pattern documented as the standard for any pg_trgm using function. | RFC 02 + RFC 04 SQL function bodies |
| 5 | **Index-usage audit cadence**: week-4 + week-12 reviews of `pg_stat_user_indexes`. Drop indexes with 0 scans + > 1 MB size. | RFC 03 Phase 6 |
| 6 | **Domain-aware tolerances** in `units_alias`: per-family rounding tolerance (5% for measured liquids, exact for counts, ±1 inch for length where the input is a balloon). | RFC 04 §7.1 (units_alias seed extension) |
| 7 | **Domain token + invoice number boost** for people-side match: regex-detect phone in extracted text → score 0.99; regex-detect internal-code → match `asset.internal_code` → score 1.0. | RFC 03 §4.1 + RFC 04 (already has the internal_code gate) |
| 8 | **Embedding ablation at week 4**: query `match_candidate.components` to measure how often cosine was decisive. If < 5%, drop the HNSW index. If ≥ 10%, keep. | RFC 03 Phase 6 acceptance gate |
| 9 | **Bidirectional matching with claim-tracking** for the import flow's apply step. We had wave-based; their claim-set pattern is cleaner for the case where one batch's resolutions could collide with another tenant's concurrent import. | RFC 05 §6 (consumer logic) |
| 10 | **First-class match-type vocabulary**: align ours with `auto_matched` / `high_confidence` / `suggested` / `no_match_yet`. We currently say `autolink` / `suggest` / `ask` — rename for ecosystem familiarity. | RFC 02 + RFC 03 schemas |
| 11 | **Drop the BAML extractor as planned, AND consider dropping the embedding plan if ablation shows it doesn't earn** — the harder, honest read of midday's lesson. | RFC 03 Phase 6 hard call |
| 12 | **`schemaTask`-shaped queue consumer wrappers**: per-task schema validation, concurrency limits, maxDuration. Whether on Trigger.dev or our own Queue, the shape is right. | RFC 05 §7 |

---

## 9. Where they're more mature than us

Bluntly:

1. **They have shipped this.** Their matcher has been live for 18+ months. Our plan is on paper.
2. **They have telemetry-driven calibration.** Ours is a TODO.
3. **They have empirical negative results.** They TRIED transaction embeddings and dropped them. We've never tried matching without embeddings and might be over-engineering.
4. **They have per-team feedback loops live.** Alias score, decline penalty, pair patterns — all live in production code, not pseudo-code.
5. **They have honest index audits.** Two migrations literally named "drop unused" with the size + 0-scan justification in comments. Engineering discipline most teams skip.
6. **They have date logic that knows about Net 30 / Net 60 + banking delay.** Domain-aware date scoring. Our cashbook flow has no equivalent yet.
7. **They have legal-entity normalisation** at enrichment time (`Anthropic` → `Anthropic Inc`) via Gemini Flash-Lite. Our customer-side normalisation is just lowercase + unaccent. Worth considering for cleaner alias keys.
8. **They use Drizzle**; we use Prisma. Drizzle's raw-SQL ergonomics fit a matcher-heavy codebase better. Worth considering for the standalone matcher service.

---

## 10. Where our plan is genuinely better

Not everything midday does is right for us:

1. **Cross-script matching.** Their pg_trgm-only path would fail on `sugar ≈ සීනි`. We need embeddings; they don't.
2. **Product matching with structured parse.** They don't do this at all — they're matching receipts to transactions, not parsing a stock-list. Our RFC 04 has no equivalent in midday.
3. **Bulk import workflow.** They don't have an Excel import. Our RFC 05 is novel for them.
4. **Dedup + variant-promotion affordances.** They have no equivalent of RFC 06.
5. **The `Matcher` interface boundary.** Their matcher is hard-wired into queries; ours is a swappable interface. They couldn't extract their matcher to a service without significant refactor; we already designed for that.
6. **Indic phonetic hash.** Their normalisation drops to lowercase + diacritic strip + token Jaccard. We have Indic Soundex specifically for Sinhala/Tamil cross-script "sounds-like" matching — they don't need this; we do.

---

## 11. Practical lifts that would change my next 48 hours

If I were the contractor about to start this work, three things I'd do *right now* based on this review:

1. **Add the F1 calibrator to RFC 03 Phase 6**, with the algorithm pseudo-coded from `optimizeThresholdFromFeedback`. Make this a first-class deliverable, not a "tune later" hand-wave. ~80 lines of TS + 1 SQL query.

2. **Add the embedding-ablation gate to RFC 03 Phase 6**: "if cosine wasn't decisive in ≥ 5% of matches by week 4, file an RFC to drop the HNSW indexes." Honest engineering discipline — accept the possibility that we're wrong about embeddings.

3. **Promote 5 score channels to first-class columns** in `match_candidate`. This is a 5-minute migration that pays for itself the first time we query "what's our average phonetic_score on auto-linked matches over the last week?".

These three changes alone would move the plan from "good architecture" to "good architecture with the production wisdom of a team that's shipped it baked in."

---

## 12. The single most valuable thing I learned

> The 0035 migration message: *"Drop unused HNSW vector index on document_tag_embeddings (86 MB, 0 scans). Queries look up by slug, not by vector similarity."*

That's 14 words. It encodes:
- We shipped a vector index because the plan said to.
- We watched it in production.
- It had zero scans.
- We figured out *why* (queries look up by slug, not vector).
- We dropped it because building cost > maintenance cost.

**That's the engineering culture.** Build → measure → cut. Not build → assume → leave running. **The single most important habit to copy from midday is "measure your own infra, drop what doesn't earn, and write the comment that says why."** Bake it into our Phase 6 retune from day one.

---

## Appendix A — Files I read in full

- `packages/jobs/src/utils/smart-matching.ts` (67 lines)
- `packages/jobs/src/tasks/inbox/match-transactions-bidirectional.ts` (290 lines)
- `packages/jobs/src/tasks/inbox/no-match-scheduler.ts` (77 lines)
- `packages/jobs/src/tasks/transactions/enrich-transaction.ts` (258 lines)
- `packages/jobs/src/utils/enrichment-helpers.ts` (214 lines)
- `packages/db/src/queries/inbox-matching.ts` (478 lines)
- `packages/db/src/queries/transaction-matching.ts` (1,154 lines)
- `packages/db/src/utils/transaction-matching.ts` (504 lines)
- `packages/categories/src/embeddings.ts` (88 lines)
- Migrations `0031`, `0032`, `0035` in full
- Schema definitions for `transaction_match_suggestions`, `inbox`, `transactions`, `transaction_categories`

## Appendix B — Stack at a glance

| Component | Midday | Our plan |
|---|---|---|
| Runtime | Bun | Bun (the upstream product) |
| Framework | Hono (API), Next.js (dashboard) | Hono (API), Expo (mobile) |
| DB | Postgres (Supabase) | Postgres (Supabase) |
| ORM | Drizzle | Prisma |
| Jobs | Trigger.dev | Cloudflare Queues + Crons |
| Embeddings | gemini-embedding-001 (categories only) | gemini-embedding-001 (everywhere) |
| LLM (parse) | gemini-2.5-flash-lite | gemini-2.5-flash-lite |
| Email/inbox | Gmail + Outlook OAuth | n/a |
| OCR | Gemini multimodal | Gemini multimodal |
| Chat adapters | Slack, Telegram, WhatsApp, Sendblue | n/a |
| Storage | Supabase Storage | Supabase Storage |
