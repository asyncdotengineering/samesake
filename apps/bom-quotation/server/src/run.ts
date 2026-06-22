// CLI: BOM file → quotation (console summary + PDF + JSON). The end-to-end proof.
//   bun server/src/run.ts [path-to-bom.xlsx|.pdf]
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { loadEnv, company, rules } from "./config.ts";
import { makeMatcher, setupCatalog } from "./catalog.ts";
import { runPipeline } from "./pipeline/index.ts";
import { renderQuotationPdf } from "./pipeline/quote.ts";
import type { CustomerRef } from "../../shared/types.ts";

loadEnv();
const url = process.env.DATABASE_URL;
if (!url || !process.env.GEMINI_API_KEY) {
  console.error("DATABASE_URL and GEMINI_API_KEY are required");
  process.exit(1);
}

const file = process.argv[2] ?? join(import.meta.dir, "../../data/sample-bom/bom.xlsx");
const customer: CustomerRef = { id: "horizon", name: "Horizon Construction (Pvt) Ltd", tier: "contractor-a" };

const matcher = makeMatcher(url);
console.log("Loading catalog …");
await setupCatalog(matcher);
console.log(`Quoting ${file}\n  customer: ${customer.name} (${customer.tier})\n`);

const { quotation, matched } = await runPipeline(matcher, file, customer, company(), rules());

for (const m of matched) {
  const tag = m.status === "matched" ? "✓" : m.status === "review" ? "?" : "✗";
  const best = m.chosen ?? m.alternatives[0];
  const chosen = best ? `${best.code} (${(best.confidence * 100).toFixed(0)}%)` : "—";
  console.log(
    `${tag} L${String(m.line.lineNo).padStart(2)}  ${(m.line.qty + " " + m.line.unit).padEnd(9)} ${m.line.normalized.slice(0, 40).padEnd(41)} → ${chosen}`
  );
}

const c = quotation.totals.currency;
console.log(`\nMatched ${quotation.lines.length}/${matched.length} · review ${quotation.unresolved.length}`);
console.log(`Subtotal ${c} ${quotation.totals.subtotal.toLocaleString()}  ·  Grand total ${c} ${quotation.totals.grandTotal.toLocaleString()}`);

const base = join(import.meta.dir, "../../data");
writeFileSync(join(base, "quote-output.pdf"), await renderQuotationPdf(quotation));
writeFileSync(join(base, "quote-output.json"), JSON.stringify(quotation, null, 2));
console.log(`\n✓ ${join(base, "quote-output.pdf")}\n✓ ${join(base, "quote-output.json")}`);
await matcher.close();
