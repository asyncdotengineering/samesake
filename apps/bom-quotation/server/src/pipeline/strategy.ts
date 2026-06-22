// One interface, two pricing strategies. Each turns normalized BOM lines into priced lines
// (+ the per-line match detail the UI shows); the shared buildQuotation() assembles totals.
import { gateLine } from "./match.ts";
import { priceLine } from "./price.ts";
import { priceLineFromRules } from "./price-rules.ts";
import type { Matcher } from "../catalog.ts";
import type { RulePack } from "../rulepack/schema.ts";
import type { NormalizedBomLine, QuoteLine, MatchedLine, CustomerRef } from "../../../shared/types.ts";

export interface PriceContext {
  matcher: Matcher;
  customer: CustomerRef;
  pack: RulePack;
}

export interface PricingStrategy {
  price(lines: NormalizedBomLine[], ctx: PriceContext): Promise<{ priced: QuoteLine[]; matched: MatchedLine[] }>;
}

/** Resolve each line to a catalog part (samesake), then price the matches. */
const catalogStrategy: PricingStrategy = {
  async price(lines, { matcher, customer, pack }) {
    const matched = await Promise.all(lines.map((l) => gateLine(matcher, l, pack)));
    const priced = matched
      .filter((m) => m.status === "matched" && m.chosen)
      .map((m) => priceLine(m, customer, pack.pricing));
    return { priced, matched };
  },
};

/** Price each line straight from the pack's attribute rules — no catalog. */
const prefixStrategy: PricingStrategy = {
  async price(lines, { customer, pack }) {
    const priced: QuoteLine[] = [];
    const matched: MatchedLine[] = [];
    for (const line of lines) {
      const ql = priceLineFromRules(line, customer, pack);
      if (ql) {
        priced.push(ql);
        matched.push({
          line, status: "matched", confirmedByUser: false, alternatives: [],
          chosen: { code: ql.code, description: line.normalized, brand: "", confidence: 1, listPrice: ql.listPrice, unit: line.unit },
        });
      } else {
        matched.push({ line, status: "unmatched", chosen: null, alternatives: [], confirmedByUser: false });
      }
    }
    return { priced, matched };
  },
};

export function strategyFor(pack: RulePack): PricingStrategy {
  return pack.pricing.strategy === "prefix-rules" ? prefixStrategy : catalogStrategy;
}
