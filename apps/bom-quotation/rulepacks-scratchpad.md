# Rule Packs + catalog-less pricing (issue #60) — scratchpad

Mode: autonomous-stand + start-refactor. Tiny commits, each green. Regression anchor:
catalog mode must stay 15/16 + grand total LKR 284,981.21 on the sample BOM.

## Backlog (issue #60 commits)
1. RulePack zod schema + default electrical-mep.yaml (serialize current config). Loaded, unused.
2. DB table rule_packs + loader (DB else default yaml).
3. canonPole -> pack synonyms.
4. HARD + attributes from pack.
5. matching weights + thresholds from pack.
6. normalize attribute schema + synonyms from pack.
7. PricingStrategy interface; CatalogStrategy = current.
8. PrefixRuleStrategy + safe formula evaluator (no eval).
9. pipeline selects strategy; prefix-rules skips catalog match.
10. electrical-mep-prefix.yaml + sample BOM priced with NO catalog.
11. API GET/PUT /api/rulepack.
12. docs.

## Doing
(empty — see Done)

## Done
- C1 schema+default pack, C2 catalog-less prefix pricing, C3 canonicalization-from-pack, C4 DB persistence + GET/PUT API. Catalog regression held (15/16). Deferred: normalize-from-pack, strategy-interface unification, docs...
