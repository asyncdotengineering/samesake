# ADR-0001: Match BOM lines via samesake entity resolution

**Status:** Accepted

## Context

The core job is to turn a contractor's BOM line (`"32A SP MCB"`, `"3C x 2.5 sqmm
Cu/PVC cable"`) into the *specific* catalogue part it refers to, with a price. The
output feeds an invoice, so the cost of being subtly wrong (quoting the wrong part at
the wrong price) is much higher than the cost of being slow. The matcher therefore has
to be **confident-and-correct, or explicitly unsure** — never a quiet guess.

Three ways to do the matching were on the table:

1. **Keyword / full-text search** over the catalogue.
2. **LLM-only** matching (hand the line + catalogue to a model, ask for the part).
3. **samesake entity resolution** — `entity()` + `match()`: cosine over a description
   embedding, pg_trgm over codes/aliases, with confidence and a confirm/decline loop.

## Decision

Use **samesake entity resolution**. The catalogue is modelled as an `entity("part")`;
each normalized BOM line is resolved via `matcher.match()`, returning ranked candidates
with a combined confidence. On top of that we add:

- **Hard-spec gating** — discriminating attributes (rating, poles, CSA, cores, size,
  watt, ways) must not conflict, or the candidate is rejected regardless of text
  similarity.
- **Three confidence buckets** — auto-match / human-review / no-match.
- **Confirm/decline feedback** — a human override teaches the matcher for next time.

## Consequences

**Positive**
- Robust to trade shorthand (semantic side) *and* to codes/part numbers/prefixes
  (trigram side) — the two cover each other's blind spots.
- Confidence is first-class, which is what makes the honest "ask a human / no match"
  behaviour possible.
- Spec gating makes auto-matching safe against variant mix-ups (18 W vs 24 W, 32 A vs
  40 A) — the single most important correctness property for a quote.
- Built-in learning loop via `confirm`.

**Negative / costs**
- The catalogue must be embedded up front (`setup`), and re-embedded when it changes.
- Confidence thresholds need **calibration** to the embedding's score distribution
  (see the thought-process doc — first run was 1/16 before calibration).
- The normalization step is an LLM call, so match outcomes vary slightly run-to-run;
  the review bucket is the designed mitigation.

## Alternatives considered

- **Keyword/FTS only** — weak exactly where it matters: synonyms ("ELCB"→"RCCB") and
  codes tokenize poorly. The repo's own retrieval bench shows FTS-only nDCG ~0.4 on
  vocab-mismatch queries.
- **LLM-only** — no grounded confidence, a real hallucination risk on a number that
  becomes a price, and a per-line cost. We use the LLM for *normalization* (where it
  excels) and let samesake do the grounded resolution.
