# ADR-0002: Build the work as a chain of independent layers

**Status:** Accepted

## Context

Turning a BOM document into a priced quotation is several distinct jobs: get the lines
off the page, drop the non-orderable noise, translate trade shorthand and parse specs,
resolve each line to a part, sanity-check it, price it, and assemble the PDF. This could
be one large LLM prompt ("here's a BOM and a catalogue, return a quote") or a sequence
of small, single-purpose stages.

## Decision

Implement it as a **pipeline of independent layers**, each a small module with a narrow
contract:

```
parse → extract → normalize → match → gate → price → quote
```

Each stage takes a typed input and returns a typed output; none reaches across its
neighbours. The LLM is used only where it adds value (extraction, normalization); the
rest is deterministic code.

## Consequences

**Positive**
- **Isolatable failures.** When matching looked bad, we could ask separately whether the
  *extraction*, the *normalization*, or the *match* was at fault — and fix the right one.
  A monolithic prompt hides which step went wrong.
- **Independently testable.** Each layer can be exercised and regression-tested on its
  own (and the API surface, the CLI, and the UI all reuse the same `runPipeline`).
- **Maps to the real workflow** of a counter-person, which makes each stage easy to
  reason about and to swap (e.g. PDF parsing is one module behind one interface).
- **Determinism where it counts** — pricing and gating are plain code with a visible
  trace, not model output.

**Negative / costs**
- More glue and more types than a single function.
- Two LLM calls per quote (extract + normalize) instead of one, which is slower and
  costlier than a single prompt — accepted because the debuggability and the deterministic
  pricing are worth more than shaving a call.

## Alternatives considered

- **One mega-prompt** — fastest to write, but opaque: you cannot tell why a line is wrong,
  cannot calibrate a single step, and the price would be model output rather than auditable
  rules. Rejected on debuggability and trust grounds.
