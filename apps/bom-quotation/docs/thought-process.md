# Thought process: how this app got designed

This is the reasoning behind the BOM→quotation app — the decisions, the dead ends, and
the things that only became obvious once we ran it on real data. It's written so that
the *why* survives, not just the *what*. The formal versions of the big calls live in
[`adr/`](./adr/).

## Starting from the problem, not the tech

The temptation with a tool like samesake in hand is to reach for "search" — it does
hybrid retrieval beautifully, so surely a BOM line is just a search query?

We sat with the actual problem first. A distributor receives a contractor's bill of
quantities and has to return a priced quotation. When a contractor writes *"32A SP MCB"*,
they are not browsing. They have a **specific product in mind** and want *that* one
quoted. The output isn't a ranked list a human will skim — it's a number on an invoice
that has to be right.

That reframed everything. This is **entity resolution** ("which catalogue part *is* this
line?"), not search ("show me some breakers"). The distinction drives the whole design:
search can be a bit wrong harmlessly; resolution that's a bit wrong charges for the wrong
part. So the system has to be *confident-and-correct or explicitly-unsure* — never a
quiet guess. (See [ADR-0001](./adr/0001-bom-matching-via-entity-resolution.md).)

samesake already has this exact machinery — `entity()` + `match()` — built for resolving
messy text to a canonical record with a confidence and a learning loop. Recognising that
we were holding the right tool by the wrong handle was the first real decision.

## Why the pipeline is a chain of small layers

We deliberately split the work into independent stages — parse, extract, normalize, match,
gate, price, quote — rather than one big prompt or one big function. (See
[ADR-0002](./adr/0002-pipeline-as-independent-layers.md).) Two reasons.

First, each stage fails in its own way and is testable on its own. When matching looked
bad, we could ask "is the *extraction* wrong, the *normalization* wrong, or the *match*
wrong?" and answer each separately. A monolith hides that.

Second, the layers map to how a human counter-person actually works: read the page, ignore
the noise, mentally translate the shorthand, recognise the part, sanity-check the specs,
apply the price book. Designing along that grain made each stage easy to reason about.

The **normalization layer** turned out to be the highest-leverage one. Trade shorthand
("3C", "sqmm", "Cu/PVC", "SP", "ELCB", "coil") is the real obstacle — both to the matcher
and to a tidy quote. Expanding abbreviations, parsing the numeric specs, and canonicalising
units so a "coil" becomes 100 metres is what lets the query and the catalogue finally
speak the same language.

## The calibration story (1/16 → 15/16)

The honest part. The first end-to-end run matched **1 of 16 lines**. Everything *ran* — it
just resolved almost nothing. The instinct was to lower the confidence threshold, but that
would have been treating the symptom.

Three real causes, found by actually looking:

1. **We had polluted the embedding.** We folded the part *code* into the same text we
   embedded for semantic matching. Codes don't carry meaning, so they dragged the
   similarity down. Splitting a clean description (for the embedding) from a separate
   search key (codes + aliases, for fuzzy character matching) was the big unlock — that
   one change took us most of the way from 1/16 to 15/16.

2. **Variants weren't gated.** An 18 W panel matched a 24 W one; a 32 A breaker drifted
   between brands. The fix wasn't a better embedding — it was promoting the *discriminating*
   attributes (wattage, ways, poles, rating) to **hard gates**: facts that must agree or the
   candidate is rejected outright. This is the rail that makes auto-matching safe.

3. **Pole notation didn't line up.** The model wrote "single pole"; the catalogue said
   "SP". An exact string compare failed. Canonicalising both sides before comparing fixed it.

The lesson worth keeping: when matching is weak, *look at why a specific good match scored
low* before reaching for the threshold. The number was a symptom; the embedding pollution
and the missing gates were the disease.

## Designing for "it has to be honest"

Because a wrong quote is worse than a slow one, several choices all point the same way:

- **Hard-spec gating** rejects incompatible variants no matter how similar the words.
- **Three confidence buckets** — auto-match, ask-a-human, no-match — rather than a single
  yes/no, so the borderline cases land in front of a person.
- **The price shows its working.** Every quote line carries a trace of which rules fired
  (`−18% Contractor Tier A`, `−2% qty ≥ 200`). A black-box number you can't defend is
  worse than no automation.

The audit (`bom-quotation-feature-audit.csv`) was part of this too — and it earned its
keep, catching a real bug the build phase missed: `/api/confirm` was passing a human-readable
code where samesake wanted an internal id, and crashed. The feature *compiled and looked
done*; only exercising it as a user would surfaced the 500.

## Lift-and-shift: the customer shouldn't learn a tool

The product goal was never "a quoting tool for one company." It was "the same engine, any
distributor." So everything company-specific — branding, products, pricing — lives in three
plain JSON files in `data/`, and the engine never changes. Swap the files, it's a different
business.

But running it past the real-customer lens exposed two gaps, and they're the most important
forward-looking decisions:

- **Not everyone has a catalogue.** Plenty of distributors carry 8000+ products, run no
  inventory system, and have no wish to build one. They price by *rules of thumb on
  attributes* ("any 3-core 2.5 mm² Cu cable ≈ X/m"), not a part-by-part lookup. Matching
  against a catalogue they don't maintain is the wrong shape for them.

- **Config-as-code is still a wall.** The matching specs and the trade-knowledge were in
  TypeScript. That's fine for us; it's impossible for the distributor's ops person, who
  shouldn't need a developer and a redeploy to add a synonym or change a margin.

Both point to the same step: make the domain — attributes, synonyms, gates, and pricing —
a **serializable "rule pack" stored in the database**, with a *catalogue-less, attribute-rule*
pricing strategy alongside the catalogue one, and strong defaults shipped so nobody starts
from a blank page. That's now built
([asyncdotengineering/samesake#60](https://github.com/asyncdotengineering/samesake/issues/60),
[ADR-0003](./adr/0003-lift-and-shift-config-and-rule-packs.md),
[ADR-0004](./adr/0004-rule-pack-implementation.md)); the practical guide is
[rule-packs.md](./rule-packs.md).

## Building the rule packs (and keeping the catalogue safe)

We built it in the order that kept the catalogue path safe the whole way. First the pack
*schema* and a default pack that was just today's config rewritten as YAML — loaded but
unused, so nothing could break. Then the new capability, catalogue-less pricing, as a
*separate* path that never touched the working catalogue code. Only then did we move the
hardcoded specs and canonicalization into the pack — with a regression test pinning the
catalogue run to 15/16 and the exact grand total, so any drift would shout immediately.

Two small decisions worth recording. The price formulas are authored as little strings
(`"30 * cores + csaMm2 * cores * 44"`), and because a pack can come from the database, those
strings are *untrusted* — so we wrote a tiny parser that evaluates the arithmetic itself and
never runs them as code. And packs live in the database keyed by company, loaded on boot:
changing your pricing is a data edit through an API, not a deploy.

What we deliberately left for later, and why: the LLM that reads and normalizes a line still
carries electrical trade-knowledge in its prompt (matching and pricing already read the pack,
so this is the last hardcoded corner); and the two pricing paths aren't yet unified behind a
single interface — kept apart on purpose, precisely so the catalogue regression stayed
untouched while the new path was built. Both are tracked in the issue rather than rushed.

## If you take one thing from this

We didn't get the matching right by being clever about embeddings. We got it right by being
honest about the *job* (resolve to a specific part, safely), splitting the work so each
failure was visible, and *looking at the actual data* when the numbers were bad instead of
tuning the knob in front of us. The cleverness was in the framing, not the model.
