---
title: Tuning channel weights per entity
description: Why samesake lets every entity declare its own scoring weights, what the defaults are calibrated for, and how to think about leaning one channel against another for your data.
---

# Tuning channel weights per entity

samesake's entity DSL has always looked like it accepted per-channel weights:

```ts
scoring: {
  channels: [
    Scorers.phoneExact({ field: "phone", weight: 1.0 }),
    Scorers.cosine({ embedding: "name_emb", weight: 0.6 }),
    Scorers.trigram({ field: "name", weight: 0.25 }),
    Scorers.aliasHit({ weight: 0.4 }),
    Scorers.phoneticEq({ phonetic: "name_phon", weight: 0.2 }),
  ],
}
```

Until `@samesake/server@0.4.3`, those numbers were silently ignored — the generated SQL hardcoded library defaults regardless of what you typed. The DSL was making a promise the implementation didn't keep. This page is about what changed, *why* per-entity weights matter, and how to reason about the trade-offs when you do start tuning.

## Why per-entity weights at all?

A single set of channel weights would work fine if every entity were the same shape. But the matcher serves wildly different domains in the same project. The bookshop's `customer` entity has names, phones, and occasional aliases — phone-exact is gold, cosine carries most fuzzy matches. The healthcare project's `medication` entity has names + parsed brand/size/code — cosine alone is dangerous (every drug name looks like every other drug name), brand gates do the real work.

If those three entities had to share weights, you'd either:
- Tune for one and watch the other two misbehave, or
- Pick a middle-of-the-road setting that's mediocre at all three.

Per-entity weights let each kind declare its own balance. A library-wide default still exists (`@samesake/server` ships with weights calibrated for "names with phones, used in SME bookkeeping" — the bookshop tutorial shape), and entities can deviate where they need to.

The deeper reason is that channel weights aren't really tuning knobs the way thresholds are. Thresholds are quantitative: "auto-link above 0.85." Weights are qualitative: "in this domain, phone matters more than name." Different domains have different priors. The DSL is the right place to encode them because the entity declaration is the only file that already knows what kind of data lives there.

## What changed in v0.4.3

The fix is invisible if you haven't been customising weights. `extractWeights(e)` walks `e.scoring.channels`, builds a per-channel map, and the SQL templates in `schema-gen.ts` substitute those values instead of constants. Library defaults are preserved exactly — every existing example config produces byte-identical SQL to before — so nothing breaks. What's new is that *typing a different number now does something*.

Two design choices worth noting:

**Omitted channels are dropped, not zero-weighted.** If your entity declares `cosine, trigram, aliasHit` but no `phoneticEq`, the noisy-OR formula in the generated SQL has three multiplier terms, not four with one zeroed. This keeps the SQL tight (no useless multiplications) and gives consumers a cleaner mental model: "omit a channel to disable it" is equivalent to "weight it 0," whichever feels natural. Both produce the same generated function.

**Re-applying regenerates the SQL.** Weights are baked into the per-project `match_<kind>()` function at apply time. If you change a weight and call `matcher.apply()` again, `CREATE OR REPLACE FUNCTION` rewrites the function body in place — no migration, no downtime, immediately visible to the next match. This is the same pattern samesake uses for entity schema changes generally.

## What each channel buys you when you lean on it

A weight isn't an importance score in isolation — it's a multiplier on a particular signal's contribution to the noisy-OR product. Raising one channel's weight makes that channel's signal carry more of the score; lowering it makes the signal contribute less, with the other channels picking up the slack. There are three useful regimes to think about:

### Cosine-dominant ("trust the embedding")

For entities where text similarity is the most reliable signal — cross-script names, free-form descriptions, anything where structured fields are unreliable or absent:

```ts
Scorers.cosine({ embedding: "name_emb", weight: 0.85 }),
Scorers.trigram({ field: "name", weight: 0.1 }),
```

What this gets you: a cosine of 0.7 pushes `combined` toward 0.6 instead of the default's 0.42. Fuzzy text matches resolve more readily; threshold tuning becomes the controlling factor for precision. What it costs: the cross-similarity trap gets sharper. Unrelated names in the same domain cluster can produce combined scores around 0.45 even without phones or aliases. You either accept more review queue items or live with the noise.

This shape is right when your data is mostly multilingual text and you'll calibrate the auto-link threshold high (0.85+) to compensate.

### Structured-dominant ("trust the fields")

For domains where exact-match fields exist and are reliable — phone numbers, NDC codes, SKUs, customer IDs:

```ts
Scorers.phoneExact({ field: "phone", weight: 1.0 }),
Scorers.cosine({ embedding: "name_emb", weight: 0.3 }),
Scorers.trigram({ field: "name", weight: 0.15 }),
```

Lowering cosine's weight tells the matcher "text similarity is suggestive, not dispositive." Phone match still dominates (the 1.0 weight makes its term go to zero in the noisy-OR product, which floors `combined` at 1.0). Text-only matches are demoted to "needs review" rather than auto-linked, because in this domain text alone shouldn't be trusted.

This is the right shape for clinical records, financial counterparties, or any domain where compliance demands evidence beyond fuzzy name similarity.

### Active-learning dominant ("trust the user")

For entities where the system starts cold (no labelled data) but has many users actively confirming matches over time:

```ts
Scorers.cosine({ embedding: "name_emb", weight: 0.5 }),
Scorers.aliasHit({ weight: 0.7 }),
Scorers.trigram({ field: "name", weight: 0.2 }),
```

A higher `aliasHit` weight makes confirmed matches stick harder. The same query that scored 0.644 with default weights might score 0.78 once it's been confirmed once — well into auto-link territory on the second use. This is how you build a matcher that gets noticeably smarter every week.

The trade-off: if your users confirm sloppily ("close enough"), `aliasHit` amplifies their mistakes. Recall improves but precision can degrade if confirmations aren't disciplined.

## The brand-gate special case

`brandGate` doesn't take a `weight` — it takes `matchBoost` and `mismatchFactor`. The reasoning is different from the noisy-OR channels: brand isn't *evidence* that two rows are the same, it's a *constraint* that says "if the brands disagree, they probably aren't." The defaults (`1.3` boost, `0.2` factor) reflect that brand match is mildly encouraging but brand mismatch is heavily discouraging.

For consumer-facing pharmacy or product catalogues, you might want to harden the mismatch:

```ts
Scorers.brandGate({ field: "parsed.brand_normalised", matchBoost: 1.5, mismatchFactor: 0.05 }),
```

A 20× ratio between match and mismatch (1.5 / 0.05 × 20 is... well, you get the idea) makes brand mismatch effectively fatal — even a perfect text match drops below the suggest threshold. Right for any domain where confusing branded products is a safety or compliance issue.

Conversely, for an internal warehouse SKU system where brand is informational but not load-bearing, you might soften:

```ts
Scorers.brandGate({ field: "parsed.brand_normalised", matchBoost: 1.1, mismatchFactor: 0.7 }),
```

Brand match is a small positive, brand mismatch is a moderate demotion. The matcher will still surface cross-brand candidates for human review instead of excluding them outright.

## Why the library defaults are what they are

The defaults — phone 1.0, cosine 0.6, trigram 0.25, phoneticEq 0.2, aliasHit 0.4 — weren't picked by gut. They were calibrated on the original Sri Lankan SME bookkeeping data that samesake was extracted from: customer names with about 60% phone coverage, cross-script entries common, light user-confirmation history at first. On that data, those numbers produce the right auto-link / review / no-match distribution for a 0.92 auto-link threshold.

Your data isn't that data. If your phone coverage is 0%, the phoneEq channel is dead weight in your noisy-OR and you might want to remove it entirely. If your users confirm matches dozens of times per day, the aliasHit weight should rise. If your text is all English and never cross-script, you can lean harder on trigram. The defaults are a starting point, not an answer.

The right way to find your weights is to calibrate from labelled history. `matcher.calibrate()` does this for thresholds — grid-searches the F1-optimal cutoff from your match decisions. Weights themselves don't have an equivalent calibration today (it's an obvious follow-on: derive per-channel weights from logistic regression on labelled candidate features). Until that lands, manual tuning is what you have, and the new per-entity declarations are the place to do it.

## How weight changes interact with thresholds

A common pitfall: lowering a weight without lowering the threshold makes the matcher seem broken.

If you halve the cosine weight from 0.6 to 0.3, every match's `combined` drops by about 30% across the board. The 0.85 auto-link threshold that worked before now never trips. You haven't broken matching — you've just made it more conservative. The fix is to recalibrate the threshold to the new score distribution, either by hand or via `matcher.calibrate()` once you have new labelled data.

This is the kind of thing that's easy to miss when first tuning. Weights and thresholds are coupled — change one, expect to revisit the other. The two-level design (per-entity weights in the DSL, per-scope thresholds in `scope_thresholds`) is what makes both independently tunable; it's also what makes them easy to forget about each other.

## Where this design might evolve

A few things weights *don't* solve yet:

**Per-shop weights, not just per-entity.** Today weights are per-`(project, kind)`. If two shops in the same project have wildly different data patterns (one has phones, one doesn't), they share weights. Per-scope weights are a natural extension — same mechanism as `scope_thresholds`, different table — but not yet built.

**Automatic weight calibration.** Thresholds get calibrated from labelled history; weights don't. The infrastructure (match candidate telemetry, accept/decline/ignore outcomes) is there; the math (logistic regression or similar to fit channel weights from features) is not. This is the obvious next step.

**Cross-channel correlation.** Noisy-OR assumes independent channels. In reality, cosine and trigram are correlated (a low cosine usually means a low trigram). The combiner double-counts the correlated parts, slightly. For most use cases this is harmless; for tight tuning it's an inefficiency the math could improve on.

None of these are blockers. They're all tractable extensions of the current shape. The per-entity weights shipped in v0.4.3 are the floor of what was needed to make the DSL honest; the calibration story builds on top of it.

## How to think about whether tuning is worth it

For most entities, the defaults are fine. The DSL lets you change them, but you shouldn't need to until you have evidence — either users complaining about a specific class of false positive/negative, or calibration results showing one channel dominating in a way that doesn't match your data.

The signal that tuning is worth it: you have labelled history (calls to `matcher.confirm` and `matcher.decline` over weeks of real use), you've run `matcher.calibrate`, you've moved the threshold, and you're still seeing avoidable misclassifications concentrated in a way that points at one channel. That's when you reach for weights.

If you're tuning weights on day one with no labelled data, you're guessing. Better to ship with defaults, accumulate decisions, and let calibration tell you where the levers are.
