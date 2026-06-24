// Deterministic regression tests for the pricing core — no LLM, no DB. These pin the parts a
// wrong quote actually comes from: which prefix rule fires, the formula result, and the totals
// assembly. The live `bun run quote` smoke (15/16) covers the LLM matching layer; this is the
// part that can (and must) be locked down in CI.
import { describe, expect, test } from "bun:test";
import { loadPackFromYaml } from "../src/rulepack/load.ts";
import { priceLineFromRules } from "../src/pipeline/price-rules.ts";
import { buildQuotation, type QuotePricing } from "../src/pipeline/quote.ts";
import { strategyFor } from "../src/pipeline/strategy.ts";
import type { NormalizedBomLine, CustomerRef, Company, QuoteLine, MatchedLine } from "../../shared/types.ts";
import type { Matcher } from "../src/catalog.ts";

const customer: CustomerRef = { id: "c1", name: "Test Co", tier: "contractor-a" };
const company: Company = { name: "X", registration: "R", address: "A", phone: "P", email: "e@x", currency: "LKR", logoText: "X" };

const line = (over: Partial<NormalizedBomLine>): NormalizedBomLine => ({
  lineNo: 1, description: "", source: "xlsx", normalized: "", qty: 1, unit: "nos",
  unitFactor: 1, category: "other", specs: {}, notes: [], ...over,
});

describe("prefix pricing — rule match + formula (deterministic)", () => {
  const pack = loadPackFromYaml("electrical-mep-prefix");

  test("right rule fires, formula is exact", () => {
    // 3-core 2.5mm² copper cable → 30*cores + csaMm2*cores*44 = 90 + 330 = 420
    const cable = priceLineFromRules(
      line({ category: "cable", specs: { conductor: "copper", cores: 3, csaMm2: 2.5 }, qty: 100, unit: "m" }), customer, pack);
    expect(cable?.listPrice).toBe(420);

    // 32A single-pole MCB → 650 + ratingA*4 = 778
    const mcb = priceLineFromRules(line({ category: "breaker", specs: { poles: "SP", ratingA: 32 } }), customer, pack);
    expect(mcb?.listPrice).toBe(778);
  });

  test("off-domain line matches no rule (→ review, never silently priced)", () => {
    expect(priceLineFromRules(line({ category: "other", normalized: "smoke detector" }), customer, pack)).toBeNull();
  });

  test("strategy prices matched lines + routes the rest to review", async () => {
    const lines = [
      line({ lineNo: 1, category: "cable", specs: { conductor: "copper", cores: 3, csaMm2: 2.5 }, qty: 100, unit: "m" }),
      line({ lineNo: 2, category: "breaker", specs: { poles: "SP", ratingA: 32 } }),
      line({ lineNo: 3, category: "other", normalized: "smoke detector" }),
    ];
    const { priced, matched } = await strategyFor(pack).price(lines, { matcher: {} as Matcher, customer, pack });
    expect(priced.length).toBe(2);
    expect(matched.filter((m) => m.status === "matched").length).toBe(2);
    expect(matched.filter((m) => m.status === "unmatched").length).toBe(1);
    expect(priced.map((p) => p.listPrice).sort((a, b) => a - b)).toEqual([420, 778]);
  });
});

describe("buildQuotation totals (deterministic)", () => {
  const pricing: QuotePricing = { taxes: [{ label: "VAT", rate: 0.18 }], priceDecimals: 2, validityDays: 14 };
  const ql = (lineTotal: number): QuoteLine => ({
    lineNo: 1, code: "(rule)", description: "", brand: "", qty: 1, unit: "nos",
    listPrice: lineTotal, discount: 0, unitPrice: lineTotal, lineTotal, leadDays: 0, priceTrace: [], status: "matched",
  });
  const day = new Date("2026-01-01T00:00:00Z");

  test("subtotal + VAT + grand total", () => {
    const q = buildQuotation([ql(1000), ql(500)], [], company, customer, pricing, "Q-1", day);
    expect(q.totals.subtotal).toBe(1500);
    expect(q.totals.taxes[0]!.amount).toBe(270); // 1500 × 0.18
    expect(q.totals.grandTotal).toBe(1770);
    expect(q.lines.length).toBe(2);
  });

  test("unresolved lines surface as a note + in the unresolved list", () => {
    const unresolved: MatchedLine[] = [{ line: line({}), status: "review", chosen: null, alternatives: [], confirmedByUser: false }];
    const q = buildQuotation([ql(100)], unresolved, company, customer, pricing, "Q-2", day);
    expect(q.unresolved.length).toBe(1);
    expect(q.notes.some((n) => /confirm/i.test(n))).toBe(true);
  });
});
