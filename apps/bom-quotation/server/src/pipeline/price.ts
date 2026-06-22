// Layer 5 — the company pricing-rules engine. Deterministic + auditable: every
// number on the quote traces to a rule in data/pricing-rules.json. Lift-and-shift
// is "edit that JSON"; this engine never changes.
import { catalog } from "../config.ts";
import type { MatchedLine, QuoteLine, CustomerRef } from "../../../shared/types.ts";
import type { RulePack } from "../rulepack/schema.ts";

const partByCode = new Map(catalog().map((p) => [p.code, p]));

const pct = (x: number): string => `${Math.round(x * 1000) / 10}%`;
const round = (x: number, d: number): number => {
  const f = 10 ** d;
  return Math.round(x * f) / f;
};

/** Price a single matched line. Requires `m.chosen` (caller filters matched lines). */
export function priceLine(m: MatchedLine, customer: CustomerRef, rules: RulePack["pricing"]): QuoteLine {
  const chosen = m.chosen!;
  const part = partByCode.get(chosen.code)!;
  const trace: string[] = [];
  const list = part.listPrice;

  const markup = rules.categoryMarkup[part.category] ?? 0;
  const brand = rules.brandMargin[part.brand] ?? 0;
  const baseFactor = 1 + markup + brand;
  if (markup) trace.push(`+${pct(markup)} ${part.category} handling`);
  if (brand) trace.push(`${brand > 0 ? "+" : ""}${pct(brand)} ${part.brand} margin`);

  const tier = rules.tiers[customer.tier];
  let discount = tier?.discount ?? 0;
  if (tier?.discount) trace.push(`-${pct(tier.discount)} ${tier.label}`);

  const qtyBreak = rules.qtyBreaks
    .filter((b) => (b.category === "*" || b.category === part.category) && m.line.qty >= b.minQty)
    .sort((a, b) => b.extraDiscount - a.extraDiscount)[0];
  if (qtyBreak) {
    discount += qtyBreak.extraDiscount;
    trace.push(`-${pct(qtyBreak.extraDiscount)} qty ≥ ${qtyBreak.minQty}`);
  }

  const unitPrice = round(list * baseFactor * (1 - discount), rules.priceDecimals);
  const lineTotal = round(unitPrice * m.line.qty, rules.priceDecimals);

  return {
    lineNo: m.line.lineNo,
    code: part.code,
    description: part.description,
    brand: part.brand,
    qty: m.line.qty,
    unit: part.unit,
    listPrice: list,
    discount,
    unitPrice,
    lineTotal,
    leadDays: part.leadDays,
    priceTrace: trace,
    status: m.status,
  };
}
