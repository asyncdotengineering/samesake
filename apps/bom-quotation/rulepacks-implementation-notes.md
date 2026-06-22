# Rule Packs + catalog-less pricing (#60) — implementation notes

## What shipped (verified)
- **C1 `89d0fd2`** — `RulePack` zod schema + `data/rule-packs/electrical-mep.yaml` (today's config as data) + loader. Tests pin it to the legacy config (regression anchor).
- **C2 `5090fcf`** — catalog-less **prefix-rule pricing**: a safe formula evaluator (whitelisted arithmetic over attributes, never `eval`) + `price-rules.ts` + a pipeline branch on `pack.pricing.strategy`. `electrical-mep-prefix.yaml` prices a BOM with **no catalog** (verified 12/16 after C3; misses go to review).
- **C3 `4d131d8`** — matching is now **config not code**: the hard-spec gate list, the pole/conductor canonicalization (was `canonPole`), and the thresholds come from the pack. `canon()` reads `pack.synonyms`. Catalog mode unchanged (**15/16, LKR 284,981.21**); prefix mode 9/16→12/16.
- **C4 (this commit)** — packs **persisted in Postgres** (`bom_rule_packs`, keyed by company), loaded on boot (overriding the default and deciding whether a catalog is even needed), and editable via **`GET`/`PUT /api/rulepack`** (validated; invalid → 400). Verified: PUT a prefix pack → a fresh server boots in `prefix-rules` mode from the DB.

## Net result vs the three asks
- **Catalog-less / 8000-product, no inventory** → done: `prefix-rules` strategy prices from attribute rules, no catalog, no samesake match.
- **Serializable (YAML, not monkey-patched code)** → done: specs, synonyms, gates, thresholds, and pricing are a YAML/JSON pack; the hardcoded `HARD`/`canonPole` are gone.
- **Saved in the DB + editable** → done: `bom_rule_packs` table + GET/PUT API, loaded on boot.

## Deferred (honest — refinements, not blockers)
- **Normalization prompt still electrical-specific** (#60 C6). The matching/pricing read the pack, but the LLM extraction/normalization system prompt is hardcoded electrical knowledge. Driving it from `pack.attributes`/`pack.synonyms` is the remaining config-not-code step.
- **PricingStrategy interface not unified** (#60 C7). Catalog and prefix pricing are two self-contained paths (deliberate, to keep the catalog regression untouched) rather than one interface. A later cleanup.
- **Prefix-pack tuning** — 4 sample lines fall to review (a single-core wire whose formula wants `cores`, two accessories whose category didn't match a rule, and the genuinely off-catalogue smoke detector). These are pack-authoring details, not engine bugs; they correctly go to the review bucket.
- **No editor UI** — packs are YAML + the PUT API; a visual editor is out of scope (#60).

## Regression anchor
Catalog mode on the sample BOM must stay **15/16 matched, grand total LKR 284,981.21**. Held across C1–C4.
