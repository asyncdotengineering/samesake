# ADR-0004: Rule pack implementation — format, storage, strategies, formula safety

**Status:** Accepted (implements [ADR-0003](./0003-lift-and-shift-config-and-rule-packs.md);
[issue #60](https://github.com/asyncdotengineering/samesake/issues/60))

## Context

ADR-0003 decided the domain should be editable data, not code, with a catalogue-less pricing
option. This records the concrete implementation choices made while building it.

## Decisions

1. **Format: YAML authored, zod-validated, JSON in the DB.** Packs are written as YAML
   (readable, comment-friendly) and validated by a single zod schema on the way in and out.
   The validated object is plain JSON, so the same schema covers both file-loaded and
   DB-loaded packs.

2. **Storage: a `bom_rule_packs` table keyed by company, loaded on boot.** A company's saved
   pack overrides the bundled default and decides whether a catalogue is loaded at all. The
   pack is read/replaced through `GET`/`PUT /api/rulepack`; an invalid pack is rejected (400),
   never stored. A `BOM_RULEPACK` env var selects a bundled file pack for the CLI/dev.

3. **Two pricing strategies, kept as separate self-contained paths.** `catalog` (samesake
   entity resolution → list price; unchanged) and `prefix-rules` (attribute rules → formula
   price; no catalogue). They are *not yet* unified behind one `PricingStrategy` interface —
   a deliberate choice so the catalogue path stayed byte-for-byte untouched while the new
   path was built and verified. Unifying them is a later, safe refactor.

4. **A tiny, safe formula evaluator — never `eval`.** Prefix-rule `perUnit` values may be
   formulas (`"30 * cores + csaMm2 * cores * 44"`). Because packs can originate from the
   database, formulas are untrusted input. They are evaluated by a hand-written
   recursive-descent parser over a whitelist of `+ - * / ( )` and attribute identifiers;
   anything else throws. No `eval`/`Function`. A formula referencing a missing attribute
   fails the line to review rather than guessing.

5. **The catalogue path is the regression anchor.** Moving the hard-spec gates, the
   canonicalization, and the thresholds into the pack must not change catalogue behaviour. A
   test pins the sample BOM to 15/16 matched and grand total LKR 284,981.21; it held across
   every commit.

## Consequences

**Positive**
- Pricing and matching logic are editable data with a clear schema and a validating API.
- The catalogue-less strategy serves the no-inventory customer with no part list to maintain.
- Untrusted formulas are safe by construction.

**Negative / deferred**
- Two pricing paths mean a little duplicated assembly logic until they're unified (ADR-0003
  #60 C7).
- The LLM normalization prompt still carries electrical trade-knowledge; matching and pricing
  read the pack, but that last corner is hardcoded (ADR-0003 #60 C6).

## Alternatives considered

- **JSON-authored packs** — fine for the DB, but worse to write by hand (no comments, fussy
  quoting). YAML in, JSON stored.
- **A general expression library / `Function`** for formulas — rejected: unnecessary power and
  an injection risk for DB-sourced strings. A 40-line whitelisted parser is safer and enough.
- **One unified pricing interface up front** — would have meant editing the working catalogue
  path before the new path existed; chose to protect the regression first and unify later.
