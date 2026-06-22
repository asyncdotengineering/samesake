import type { PricingRules, QuoteLine, QuoteTotals } from "../../../shared/types.ts";

const round = (x: number, d: number) => {
  const f = 10 ** d;
  return Math.round(x * f) / f;
};

export function computeTotals(
  lines: QuoteLine[],
  rules: PricingRules,
  currency: string
): QuoteTotals {
  const subtotal = round(
    lines.reduce((s, l) => s + l.lineTotal, 0),
    rules.priceDecimals
  );
  const listTotal = lines.reduce((s, l) => s + l.listPrice * l.qty, 0);
  const discountTotal = round(listTotal - subtotal, rules.priceDecimals);
  const taxes = rules.taxes.map((t) => ({
    label: t.label,
    rate: t.rate,
    amount: round(subtotal * t.rate, rules.priceDecimals),
  }));
  const grandTotal = round(
    subtotal + taxes.reduce((s, t) => s + t.amount, 0),
    rules.priceDecimals
  );
  return { subtotal, discountTotal, taxes, grandTotal, currency };
}

export function formatMoney(amount: number, currency: string): string {
  return `${currency} ${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
