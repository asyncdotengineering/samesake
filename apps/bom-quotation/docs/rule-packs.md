# Rule packs: your business, written as a file you can edit

Every supplier prices a little differently. One shop matches each line to a product in
their price book. The next one has eight thousand products, no inventory system, and
prices by feel — *"three-core 2.5 copper? that's about four-twenty a metre."* Same trade,
two completely different ways of working.

A **rule pack** is how this app bends to fit either one. It's a single file that holds
everything specific to *your* business — the attributes you care about, the shorthand you
use, how you match, and how you price — and the engine reads it. Change the file, and it's
your shop. You never touch the code.

This page walks through what's in a pack and how to write one. There's a working example
in `data/rule-packs/electrical-mep.yaml` (catalog) and `electrical-mep-prefix.yaml`
(catalog-less) — open them alongside this.

## The one decision: do you have a catalogue, or just rules?

That's the fork, and a pack picks one:

- **`strategy: catalog`** — you keep a product list. Each BOM line is *recognised* as a
  specific part, and that part's list price flows into the quote. This is the right shape
  when you maintain a catalogue and want exact parts on the quote.
- **`strategy: prefix-rules`** — you *don't* keep a catalogue. Each line is priced straight
  from its attributes by a rule you wrote: *"any copper cable → this formula."* No product
  to match, nothing to maintain but the rules. This is the right shape for the 8000-product,
  no-inventory shop.

Everything else in the pack (attributes, synonyms, tiers, taxes) is shared. Only the
`pricing.strategy` and what hangs off it differ.

## Walking through a pack, top to bottom

### `attributes` — the things you measure
These are the specs the app pulls out of a line and can reason about: a cable's cores and
cross-section, a breaker's rating and poles, a luminaire's wattage. You're telling the app
"these are the facts that distinguish one product from another."

```yaml
attributes:
  - { key: csaMm2,  type: number, label: "CSA mm²" }
  - { key: poles,   type: enum,   label: "Poles", values: [SP, DP, TP, TPN, 4P] }
  - { key: watt,    type: number, label: "Wattage" }
```

### `synonyms` — your dialect, translated
Trades have shorthand, and everyone's is slightly different. This maps the variants you see
onto one canonical form, so the app isn't fooled by spelling. The keys are written without
spaces or dashes (the app strips those before looking up).

```yaml
synonyms:
  poles:
    singlepole: SP
    "1p": SP
    sp: SP
  conductor:
    cu: copper
    al: aluminium
```

Now *"single pole"*, *"1P"*, and *"SP"* all mean the same thing — to the matcher and to your
pricing rules.

### `units` — when "one" isn't one
A coil of cable isn't one metre; it's a hundred. Tell the app, and it'll do the multiplying.

```yaml
units: { coil: 100, drum: 500 }
```

### `matching` — how careful to be (catalogue mode)
The safety settings. `hard` lists the attributes that *must* agree — a 32 A line can never be
quoted as a 40 A part, no matter how similar the words. `autoLink`/`suggest` are the
confidence cut-offs: above `autoLink` it auto-matches, above `suggest` it asks you, below
that it's a no-match.

```yaml
matching:
  hard: [ratingA, poles, csaMm2, cores, sizeMm, watt, ways]
  weights: { cosine: 0.6, trigram: 0.4 }
  autoLink: 0.55
  suggest: 0.38
```

(Prefix-rules packs keep this block for consistency, but it isn't used — there's no
matching to gate.)

### `pricing` — the money
The shared part first: customer tiers and their discounts, per-category markups, per-brand
margins, quantity breaks, taxes, rounding, and how long a quote is valid. Every quote line
shows which of these fired, so the number is always defensible.

```yaml
pricing:
  strategy: catalog
  tiers:
    contractor-a: { label: "Contractor — Tier A", discount: 0.18 }
    retail:       { label: "Retail / Walk-in",    discount: 0.0 }
  taxes:
    - { label: VAT, rate: 0.18 }
  priceDecimals: 2
  validityDays: 14
```

### `pricing.rules` — pricing without a catalogue
This is the heart of the catalog-less mode. A list of rules; the **first one whose `when`
matches** a line sets its price. `perUnit` is either a flat number or a small formula over
the line's attributes.

```yaml
pricing:
  strategy: prefix-rules
  rules:
    - { label: "Cu power cable", when: { category: cable, conductor: copper }, perUnit: "30 * cores + csaMm2 * cores * 44" }
    - { label: "single-pole MCB", when: { category: breaker, poles: SP },      perUnit: "650 + ratingA * 4" }
    - { label: "switch / socket", when: { category: switch-socket },           perUnit: 380 }
```

Read the first one aloud: *"for a copper cable, charge thirty rupees per core plus
forty-four per core per square-millimetre."* For a 3-core 2.5 mm² line that's
`30×3 + 2.5×3×44 = 420` a metre. The shorthand in your head, written down once.

A `when` value can be a single value or a list (`poles: [TP, TPN, 4P]`), and it's matched
*after* canonicalization, so `poles: SP` will catch a line that came in as "single pole."

## The formula mini-language

Formulas are deliberately tiny and safe — they're only `+ - * / ( )` and your attribute
names. No functions, no code, nothing clever. (They can come from the database, so they're
treated as untrusted: the app parses them itself and never runs them as code.) If a formula
needs an attribute a line doesn't have, that line politely falls to review rather than
guessing.

## Where a pack lives, and how to change it

Two places, and the app prefers the second:

1. **A file** in `data/rule-packs/` — pick one at runtime with `BOM_RULEPACK=<name>`
   (defaults to `electrical-mep`). Good for version control and the bundled defaults.
2. **The database** — the real home for a live deployment. The app loads your company's
   saved pack on boot, and you read or replace it through the API:

   ```bash
   curl localhost:3001/api/rulepack                 # what's active now
   curl -X PUT localhost:3001/api/rulepack \        # replace it (validated; bad packs are rejected)
        -H 'content-type: application/json' -d @my-pack.json
   ```

   Save a `prefix-rules` pack and the whole app switches to catalog-less on the next boot —
   it won't even load a catalogue.

## A checklist for your first pack

1. Start from `electrical-mep.yaml` (catalogue) or `electrical-mep-prefix.yaml` (rules).
2. List the **attributes** that distinguish your products.
3. Add the **synonyms** for the shorthand your customers actually type.
4. If you keep a catalogue: set the **hard** gates and confidence thresholds. If you don't:
   write the **pricing.rules**, most specific first.
5. Set your **tiers, margins, breaks, and tax**.
6. Drop it in `data/rule-packs/` and run with `BOM_RULEPACK=...`, or `PUT` it to the API.
7. Quote a sample BOM and read the per-line price traces — they tell you which rule fired.

That's the whole idea: the parts of the job that are *yours* live in a file you can read and
edit, not in someone else's code.
