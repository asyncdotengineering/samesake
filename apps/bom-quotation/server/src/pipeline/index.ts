// The pipeline: document → quotation. Each layer is independently testable; this
// just wires them in order.
import { parseDocument } from "./parse.ts";
import { extractLines } from "./extract.ts";
import { normalizeLines } from "./normalize.ts";
import { gateLine } from "./match.ts";
import { assembleQuotation } from "./quote.ts";
import type { Matcher } from "../catalog.ts";
import type { Company, CustomerRef, PricingRules, Quotation, MatchedLine } from "../../../shared/types.ts";

export interface PipelineResult {
  quotation: Quotation;
  matched: MatchedLine[];
}

function quoteNumber(d: Date): string {
  const ymd = d.toISOString().slice(0, 10).replace(/-/g, "");
  const seq = Math.floor(d.getTime() % 9000) + 1000;
  return `Q-${ymd}-${seq}`;
}

export async function runPipeline(
  matcher: Matcher,
  filePath: string,
  customer: CustomerRef,
  company: Company,
  rules: PricingRules
): Promise<PipelineResult> {
  const doc = await parseDocument(filePath);
  const raw = await extractLines(doc);
  const normalized = await normalizeLines(raw);
  // Match concurrently; each gateLine is an independent samesake query + spec gate.
  const matched = await Promise.all(normalized.map((l) => gateLine(matcher, l, rules)));
  const now = new Date();
  const quotation = assembleQuotation(matched, company, customer, rules, quoteNumber(now), now);
  return { quotation, matched };
}
