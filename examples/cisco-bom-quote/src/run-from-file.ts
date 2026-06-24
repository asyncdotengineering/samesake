// End to end from a real file: read a Cisco CCW .xlsx export → classify → price → quotation.
// This is the productized path (run.ts uses a frozen copy of the data; this reads the export).
//
// Run: bun run src/run-from-file.ts /path/to/Cisco_Estimate.xlsx
import { parseCiscoExport } from "./parse-export.ts";
import { classify } from "./classify.ts";
import { POLICY, type Kind } from "./rules.ts";

const path = process.argv[2];
if (!path) {
  console.error("usage: bun run src/run-from-file.ts <cisco-export.xlsx>");
  process.exit(1);
}

const round = (n: number) => Math.round(n * 100) / 100;
const usd = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const KINDS: Kind[] = ["product", "service", "subscription"];

const lines = parseCiscoExport(path);
const roll: Record<Kind, { count: number; cost: number; customer: number }> = {
  product: { count: 0, cost: 0, customer: 0 },
  service: { count: 0, cost: 0, customer: 0 },
  subscription: { count: 0, cost: 0, customer: 0 },
};
const review: string[] = [];
const discountFlags: string[] = [];

for (const line of lines) {
  const c = classify(line.partNumber);
  if (!c.confident) review.push(line.partNumber);
  // self-check: the export's own discount should match the discount our kind implies
  if (line.ciscoDiscountPct && POLICY.ciscoDiscountPct[c.kind] !== line.ciscoDiscountPct) {
    discountFlags.push(`${line.partNumber} (${c.kind} expects ${POLICY.ciscoDiscountPct[c.kind]}%, file says ${line.ciscoDiscountPct}%)`);
  }
  const r = roll[c.kind];
  r.count++;
  r.cost = round(r.cost + line.netCost);
  r.customer = round(r.customer + line.netCost * (1 + POLICY.margin[c.kind]));
}

console.log(`\nRead ${lines.length} line items from ${path.split("/").pop()}\n`);
console.log("  Bucket         lines     Cisco cost     margin    DCSL price");
console.log("  " + "-".repeat(62));
let cost = 0;
let quote = 0;
for (const k of KINDS) {
  const r = roll[k];
  cost = round(cost + r.cost);
  quote = round(quote + r.customer);
  console.log(`  ${k.padEnd(13)} ${String(r.count).padStart(5)}   ${usd(r.cost).padStart(13)}   ${(POLICY.margin[k] * 100 + "%").padStart(5)}   ${usd(round(r.customer)).padStart(12)}`);
}
console.log("  " + "-".repeat(62));
console.log(`  ${"TOTAL".padEnd(13)} ${String(lines.length).padStart(5)}   ${usd(cost).padStart(13)}   ${" ".padStart(5)}   ${usd(quote).padStart(12)}\n`);
console.log(`  Needs review (no rule matched): ${review.length}${review.length ? " — " + review.join(", ") : ""}`);
console.log(`  Discount mismatches:            ${discountFlags.length}${discountFlags.length ? " — " + discountFlags.join("; ") : " (classification agrees with the file)"}\n`);
