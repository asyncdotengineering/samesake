// The pipeline: document → quotation. Each layer is independently testable; this just
// wires them. Pricing is a strategy chosen by the active pack (catalog vs prefix-rules);
// the shared buildQuotation assembles totals either way.
import { parseDocument } from "./parse.ts";
import { extractLines } from "./extract.ts";
import { normalizeLines } from "./normalize.ts";
import { buildQuotation } from "./quote.ts";
import { strategyFor } from "./strategy.ts";
import { activePack } from "../rulepack/load.ts";
import type { Matcher } from "../catalog.ts";
import type { Company, CustomerRef, Quotation, MatchedLine } from "../../../shared/types.ts";

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
  company: Company
): Promise<PipelineResult> {
  const doc = await parseDocument(filePath);
  const raw = await extractLines(doc);
  const normalized = await normalizeLines(raw);
  const now = new Date();

  const pack = activePack();
  const { priced, matched } = await strategyFor(pack).price(normalized, { matcher, customer, pack });
  const unresolved = matched.filter((m) => m.status !== "matched");
  const quotation = buildQuotation(priced, unresolved, company, customer, pack.pricing, quoteNumber(now), now);
  return { quotation, matched };
}
