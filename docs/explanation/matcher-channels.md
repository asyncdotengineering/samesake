---
title: How the matcher scores candidates
description: Why samesake combines five (or seven) signal channels per match, why noisy-OR is the right combiner, when each channel dominates, and what the math is actually doing.
---

# How the matcher scores candidates

Every time you call `matcher.match({...})`, samesake doesn't ask "is this query similar to that row?" — singular. It asks five or more separate questions, in parallel, then combines the answers. The number you get back as `combined` is a calibrated agreement between independent signals, not a vector distance. This page is about *why* that's the shape, why those signals, and what happens when one of them is missing.

## Why more than cosine?

Cosine similarity over text embeddings is the obvious answer for fuzzy name matching. It's also a deceptively bad answer on its own.

Embedding models live in semantic space. "Saman Perera" and "Nimal Silva" embed at cosine ≈ 0.4 not because they're *similar* in the sense that matters — they aren't the same person — but because they share the semantic neighbourhood of "Sri Lankan name." Gemini's `gemini-embedding-001` gives two unrelated company names like "Anchor Foods (Pvt) Ltd" and "Sunlight Distribution Co" a cosine of ~0.83, because both occupy the "South Asian SME company name" cluster. If we threshold on cosine alone, every customer in a Sri Lankan shop looks like a potential dupe of every other customer in the same shop.

The right question isn't "are the embeddings close?" The right question is: **what's the evidence that THIS query and THAT row are the same real-world entity?** Evidence comes in different forms. A matching phone number is overwhelming evidence; semantic similarity is suggestive; phonetic equivalence is supporting; character-level overlap is corroborating; a previously-confirmed alias is decisive. None of these by itself is enough; together they make a judgment.

So the matcher carries five channels for people-shape entities and adds two more for product/inventory parse-shape entities, and combines them via probabilistic-OR. Each channel asks one specific question.

## The five people-shape channels

For entities like `supplier`, `customer`, `patient`, `cashbook_entry` — anything whose primary text is a name — the matcher carries:

### `phoneEq`: did the phone number match exactly?

The most authoritative signal samesake has. If two records share a phone number — in a country where each person has one — they are almost certainly the same person. The default weight is 1.0, calibrated so that a phone match alone pushes `combined` to ~1.0 regardless of what cosine says. This is intentional: if the cashier types "Mr Anil" but reads "+94771234567" off the receipt, the matcher should find "Saman Perera" with that phone and not care that the names look nothing alike. The bookshop tutorial's Step 7 demonstrates exactly this: the second `matcher.match` call with `opts: { phone: ... }` resolves on phone alone, names irrelevant.

The weight isn't really about how to balance phone against other channels — it's about how hard a phone match should suppress the rest of the noisy-OR product. Setting `phoneExact` weight to 1.0 is a way of saying "this is dispositive."

### `cosine`: how semantically similar is the text?

This is the workhorse for fuzzy matching across spelling, transliteration, abbreviation, and cross-script. "Nimal Sylva" → "Nimal Silva" works because the embedding sees them as ~0.8 cosine close; "Amma" → "අම්මා" works because Gemini knows the cross-script equivalence. Default weight 0.6, which means at the noisy-OR formula's saturation point (cosine 1.0) it contributes 0.6 toward `combined`.

Cosine is the dominant channel for distinct-name fuzzy matching, but it's also where the cross-similarity trap lives. The matcher needs the OTHER channels to provide ground-truth signal when cosine is too generous.

### `trigram`: do the character n-grams overlap?

Postgres's `pg_trgm` extension provides character-level overlap scoring, completely independent of any model. Default weight 0.25 — supporting evidence, not decisive. Trigram is what catches a typo that the embedding model smoothed over. It's also what works when cosine fails on very short strings (the embedding model has too little signal in three characters to differentiate "ABC" from "AXC").

For Latin-script-only entities, trigram is a useful belt-and-braces channel. For Sinhala or Tamil text where character overlap doesn't carry the same semantic weight, the bookshop config opts in with `latinOnlyPartial: true` so trigram skips when the query is non-Latin.

### `phoneticEq`: do the soundex/metaphone codes match?

Indic-soundex (for South Asian languages), classical soundex (for Latin English), or metaphone — depending on what the entity declared. This catches sound-equivalent spelling variants the embedding might miss when both forms are uncommon in the training data. "Senaratna" vs "Senaratne" share the same phonetic hash; "K. Mendis" vs "Mendis K" don't survive embedding well but ring true phonetically. Default weight 0.2 — corroborating evidence that occasionally rescues a recall miss.

### `aliasHit`: has a human already confirmed this exact query → entity pair?

The active-learning channel. Every time you call `matcher.confirm()`, samesake writes a row to `name_alias` and `pair_history`. On the next match, if the normalised query text matches an alias row for the candidate, `aliasHit = true`. Default weight 0.4. This is what makes the matcher get better with use: "Nimal Sylva → Nimal Silva" at 0.644 becomes "Nimal Sylva → Nimal Silva" at 0.710 after one confirmation. The user's correction is durable, scoped to the right tenant, and stacks with the other channels.

Without this channel, every match starts fresh. With it, the matcher's accuracy on YOUR data improves the moment users start using it.

## The probabilistic-OR combiner

Once each channel has produced a number (or a boolean treated as 0/1), samesake combines them with:

```
combined = decline_factor × (1 - ∏ (1 - wᵢ × signalᵢ))
```

That `1 - ∏ (1 - ...)` shape is a noisy-OR — the same formula used in Bayesian belief networks when you have multiple independent causes of an effect. It has three properties that matter for entity resolution:

**Any strong channel can carry the match alone.** If `phoneEq` fires at weight 1.0, the corresponding term `(1 - 1.0 × 1)` is zero. Zero anywhere in a product zeros the whole product. `1 - 0 = 1`. Combined goes to 1.0 regardless of what the other channels think. Phone-match alone resolves the match.

**Multiple weak channels stack into something strong.** Two channels at 0.6 don't average to 0.6; they combine to `1 - (1 - 0.6 × 0.5)(1 - 0.6 × 0.5) = 1 - 0.49 = 0.51`. The matcher isn't asking "which channel is best?" — it's asking "given all the partial signals, how confident am I overall?" Three partial signals at 0.4 each combine to a stronger result than one signal at 0.7.

**Absence of evidence is not negative evidence.** If a channel doesn't fire — no phone provided, no phonetic match, no prior alias — its term becomes `(1 - w × 0) = 1`. Multiplying by 1 is a no-op. The match doesn't penalise the candidate for missing fields; it just stops considering that channel. A row with no phone number can still be auto-linked on name + alias-hit alone.

That last property is what makes samesake usable for sparse SME data. Most shopkeepers' customer ledgers have name for everyone, phone for half, email for almost nobody. A matcher that punished missing data would surface a constant stream of low-confidence false negatives. Noisy-OR sidesteps that entirely.

The `decline_factor` is separate: every time the user calls `matcher.decline()`, the candidate gets an exponential demotion (`exp(-0.5 × max(declines - confirms, 0))`). One decline drops `combined` by ~39%; two declines drop it by ~63%. This is the "the user has actively told us this is wrong" signal — separate from the noisy-OR because it's not evidence FOR a match, it's a multiplicative penalty against one.

## When each channel dominates

The math gets clearer if you trace which channel is doing the work for different match scenarios:

| Scenario | What carries the match | Approx `combined` |
|---|---|---|
| Phone matches; name is wildly different | `phoneEq` alone | 1.0 |
| Same name spelled identically; no phone; no history | `cosine` (≈1.0) | 0.60 |
| Fuzzy spelling ("Smyth" → "Smith"); no phone | `cosine` (≈0.85) + `trigram` (≈0.4) | 0.62 |
| Same name as before + previously confirmed | `cosine` + `aliasHit` | 0.71 |
| Phonetic match only ("Sinheratne" → "Senaratne") | `phonEq` + small `cosine` | 0.30 |
| Two unrelated company names | `cosine` ≈ 0.45 | 0.27 |
| Distinct names, just embeddings clustering | `cosine` ≈ 0.83 alone | 0.50 |

That last row is the cross-similarity trap. Cosine alone, on short strings in a same-domain cluster, can produce a `combined` around 0.50 — high enough to surface in a review queue with a low suggest threshold, but low enough that auto-linking on it would be reckless. This is the realistic ceiling for embedding-only matching and the reason samesake's defaults expect you to either supply real differentiating data (phone, brand, code) or accept that humans will resolve some queries by hand.

## The two extra channels for parse-shape entities

Inventory items, medications, invoices — things with internal structure beyond a name — get an extended combiner. They opt into parse-shape by declaring a `parse: {...}` block on the entity, which makes the matcher call your `parse` function (samesake provides the Zod schema, you provide the LLM call) before matching. The parsed fields (brand, item_canonical, size_value, size_unit, internal_code, variant) become additional channels:

### `internalCodeExact`: short-circuit to 1.0

If both the query and the candidate have a non-null `internal_code` and they're equal (NDC for medications, SKU for stockbook items), the matcher returns `combined = 1.0` without computing anything else. This isn't really a channel — it's a fast-path. Real-world reasoning: if two products share an NDC, they're the same drug, period. The whole noisy-OR doesn't apply.

### `sizeUnitGate`: a hard gate, not a multiplier

Size mismatch doesn't demote a candidate — it removes it from the result set. "Panadol 500mg" cannot match "Panadol 100mg" no matter how close the names are. The gate normalises units (mg ≈ 0.001 g; mL ≈ 0.001 L) and rejects candidates outside a small tolerance. Healthcare entity-resolution that confused 500mg with 100mg would be unsafe; this is the channel that makes confusion impossible at the SQL level.

The reasoning: some channels are evidence (add weight to a noisy-OR), others are constraints (define what's even allowed to match). Sizing is a constraint.

### `brandGate`: a multiplier with two settings

Where `sizeUnitGate` is binary (in/out), `brandGate` is a graded multiplier on the noisy-OR result. Brand match: `× 1.3` (boost — yes this is over 1.0; capped by the outer `LEAST(..., 1.0)`). Brand mismatch: `× 0.2` (heavy demotion). Brand unknown (one side has no parsed brand): `× 1.0` (no effect).

The asymmetric defaults reflect what happens in practice. "Walgreens Acetaminophen 500mg" and "Tylenol Extra Strength 500mg" have cosine close to 0.95 — both are the same drug, very similar names. The brand mismatch is the only thing telling us they're different SKUs that need different pricing, inventory, and reorder tracking. Without `brandGate`, the matcher would auto-link them. With it, the `× 0.2` demotion drops `combined` from ~0.7 to ~0.14 and the candidate is correctly excluded.

You can tune those numbers per-entity (`Scorers.brandGate({ matchBoost: 2.0, mismatchFactor: 0.05 })`) — see [Tuning channel weights](./tuning-channel-weights.md).

### Two cosines instead of one

Parse-shape entities have two embeddings — one over the parsed canonical text (`$item_canonical $variant`), one over the raw original. The matcher scores both and combines them with separate weights (0.65 / 0.30 by default). The reasoning: parsed text is normalised and brand-free, so cosine on it cleanly compares product identities; raw text preserves the messy original wording that customers and shopkeepers actually use. The two views compensate for each other's failures. A parser that mis-extracts the item canonical can still match on the full-text embedding; a query phrased very differently from the stored row can still match on the canonical.

## When this design is the wrong fit

A few cases where the multi-channel noisy-OR makes less sense:

**Pure structured matching.** If your data is "customer with primary key user_id, look up by user_id" — there's no fuzzy matching to do. samesake is overkill; a simple SELECT does it.

**Adversarial deduplication.** If the data is being actively manipulated to evade matching (e.g., fraud), noisy-OR's "any strong channel suffices" property is exploitable — one matching phone + a wildly different name should be suspicious, not auto-linked. samesake is designed for benign disagreement (typos, abbreviation, transliteration, OCR noise), not adversarial.

**Cross-entity matching.** samesake matches WITHIN an entity kind (`supplier` queries match `supplier` rows). It doesn't ask "is this `supplier` the same as a `customer` who later started supplying us?" Cross-entity matching needs a different model. If you need it, the same channels still apply — you'd just run them across kinds and probably want a different combiner.

## How this connects to the rest

The combiner formula is generated as a PostgreSQL function at `matcher.apply()` time, one function per entity kind, named `match_<kind>()`. This is what gives samesake its peculiar performance profile — the noisy-OR runs inside Postgres as a CTE pipeline, not in application code — and it's also what makes per-entity weights work cleanly: the weights you declare get baked into each entity's SQL function body. See [Tuning channel weights per entity](./tuning-channel-weights.md) for what changes when you tune them.

The thresholds that decide auto-link vs needs-review vs no-match are separate from the channels themselves — they're stored in `scope_thresholds` per `(entity_kind, scope_json)` and read at match time. See [usage-patterns.md](../usage-patterns.md) for the API surface that sets them. Calibration via `matcher.calibrate()` reads from `match_candidate` telemetry (every match writes a row there) and grid-searches the F1-optimal threshold from labelled history.

The channels themselves are stable. The way you combine them is parameterizable. The thresholds you trip on are tunable. The model behind cosine is replaceable (BYO `embed` function — see [Recipes](../recipes/)). These are different layers and they exist as different layers on purpose; you can change one without touching the others.
