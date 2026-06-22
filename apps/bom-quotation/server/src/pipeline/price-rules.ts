// Catalog-less pricing. For distributors with thousands of products and no inventory
// system: price each BOM line straight from the pack's attribute rules — no catalog,
// no samesake match. First matching rule wins; perUnit is a number or a safe formula.
// Self-contained (does not touch the catalog path), so the catalog regression is unaffected.
import { evalFormula } from "../rulepack/formula.ts";
import { canon } from "../rulepack/canon.ts";
import type { RulePack, PrefixRuleT } from "../rulepack/schema.ts";
import type {
  NormalizedBomLine, QuoteLine, CustomerRef,
} from "../../../shared/types.ts";

const round = (x: number, d: number): number => {
  const f = 10 ** d;
  return Math.round(x * f) / f;
};
const pct = (x: number): string => `${Math.round(x * 1000) / 10}%`;

/** Numeric attributes available to a price formula. */
function formulaVars(line: NormalizedBomLine): Record<string, number> {
  const v: Record<string, number> = { qty: line.qty };
  for (const [k, val] of Object.entries(line.specs)) if (typeof val === "number") v[k] = val;
  return v;
}

function matchesWhen(line: NormalizedBomLine, when: PrefixRuleT["when"], pack: RulePack): boolean {
  for (const [k, cond] of Object.entries(when)) {
    const actual = canon(pack, k, k === "category" ? line.category : (line.specs as Record<string, unknown>)[k]);
    const ok = Array.isArray(cond)
      ? cond.map((c) => canon(pack, k, c)).includes(actual)
      : canon(pack, k, cond) === actual;
    if (!ok) return false;
  }
  return true;
}

export function priceLineFromRules(line: NormalizedBomLine, customer: CustomerRef, pack: RulePack): QuoteLine | null {
  const rule = pack.pricing.rules.find((r) => matchesWhen(line, r.when, pack));
  if (!rule) return null;
  let base: number;
  try {
    base = typeof rule.perUnit === "number" ? rule.perUnit : evalFormula(rule.perUnit, formulaVars(line));
  } catch {
    return null; // a formula that needs an attribute the line lacks → treat as no-match (review)
  }
  const trace: string[] = [`rule: ${rule.label ?? line.category}`];
  const markup = pack.pricing.categoryMarkup[line.category] ?? 0;
  if (markup) trace.push(`+${pct(markup)} ${line.category} handling`);
  const tier = pack.pricing.tiers[customer.tier];
  let discount = tier?.discount ?? 0;
  if (tier?.discount) trace.push(`-${pct(tier.discount)} ${tier.label}`);
  const qb = pack.pricing.qtyBreaks
    .filter((b) => (b.category === "*" || b.category === line.category) && line.qty >= b.minQty)
    .sort((a, b) => b.extraDiscount - a.extraDiscount)[0];
  if (qb) {
    discount += qb.extraDiscount;
    trace.push(`-${pct(qb.extraDiscount)} qty >= ${qb.minQty}`);
  }
  const unitPrice = round(base * (1 + markup) * (1 - discount), pack.pricing.priceDecimals);
  const lineTotal = round(unitPrice * line.qty, pack.pricing.priceDecimals);
  return {
    lineNo: line.lineNo, code: "(rule)", description: line.normalized, brand: "",
    qty: line.qty, unit: line.unit, listPrice: base, discount, unitPrice, lineTotal,
    leadDays: 0, priceTrace: trace, status: "matched",
  };
}
