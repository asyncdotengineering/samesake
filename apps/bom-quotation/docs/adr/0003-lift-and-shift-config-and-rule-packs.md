# ADR-0003: Company config as data; serializable rule packs + catalog-less pricing

**Status:** Partially accepted — JSON config is **Accepted** and shipped; serializable
DB-stored rule packs and catalog-less pricing are **Proposed**
([asyncdotengineering/samesake#60](https://github.com/asyncdotengineering/samesake/issues/60)).

## Context

The product goal is "the same engine, any distributor" — not a tool built for one shop.
That means everything company-specific has to be configuration, not code. Running the
design past the real-customer lens surfaced two pressures:

1. **Config-as-code is a wall for the customer.** The matching specs, the synonym
   canonicalization, and the trade knowledge started life in TypeScript (`match.ts`,
   `normalize.ts`). That's fine for the maintainers and impossible for a distributor's
   ops person, who shouldn't need a developer and a redeploy to add a brand synonym or
   change a margin.

2. **Not everyone has a catalogue.** A common customer carries 8000+ products, runs no
   inventory system, and won't build one. They price by *attribute rules of thumb*
   ("any 3-core 2.5 mm² Cu cable ≈ X/m"), not a part-by-part lookup. Matching against a
   catalogue they don't maintain is the wrong shape.

## Decision

**Accepted and shipped:** all per-company specifics live in three plain files —
`data/company.json` (branding), `data/catalog.json` (products), `data/pricing-rules.json`
(tiers, markups, brand margins, quantity breaks, taxes, thresholds). The engine reads
them and never changes; swapping the files re-targets the whole app.

**Proposed (issue #60):** promote that idea into a single serializable **rule pack** —
attributes, synonyms/canonicalization, matching config, and pricing — authored as YAML,
validated, and **stored in the database** so it is runtime-editable without a deploy.
Pricing becomes a strategy interface with two implementations: the current **catalog**
strategy and a new **prefix-rules** strategy that prices straight from attribute rules
with no catalogue. Strong default packs ship so nobody starts from a blank page.

## Consequences

**Positive**
- A distributor adapts the app by editing data, not code — no developer, no redeploy.
- The catalog-less strategy serves the large no-inventory segment that the catalogue
  model excludes.
- Defaults mean the first run pays off immediately (the value-now property).

**Negative / costs**
- A config schema and a generic interpreter to design, validate, and maintain — more
  surface than hardcoded logic.
- Prefix-rule prices need a **safe** expression evaluator (whitelisted arithmetic over
  attributes, never `eval`), since packs come from the database.
- A migration: the hardcoded `HARD`/`canonPole`/electrical-prompt logic must move into
  the pack behind regression tests that pin today's behaviour.

## Alternatives considered

- **Code-per-company** — a fork or config-in-TS per customer. Doesn't scale, needs a
  developer for every change, and can't be edited at runtime. Rejected.
- **Catalogue-only forever** — simplest, but structurally excludes the no-inventory
  customer. Rejected as too narrow for the product goal.
