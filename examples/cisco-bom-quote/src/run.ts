// Catalog-free quoting, end to end:
//   1. classify every Cisco line from its part number alone (no inventory log)
//   2. VALIDATE — our kind + discount must match Cisco's own bucket + disc% (proves the rules)
//   3. roll up Cisco net into Product / Service / Subscription (reproduces the estimate totals)
//   4. apply Micro Solutions margin per kind → the DCSL customer quote
//
// Run: bun run src/run.ts   (zero setup — no DB, no LLM, no catalog)
import { CISCO_BOM, type Bucket } from "../data/cisco-bom.ts";
import { classify } from "./classify.ts";
import { POLICY, type Kind } from "./rules.ts";

const round = (n: number) => Math.round(n * 100) / 100;
const usd = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const KINDS: Kind[] = ["product", "service", "subscription"];
const roll: Record<Kind, { count: number; ciscoNet: number; customer: number }> = {
  product: { count: 0, ciscoNet: 0, customer: 0 },
  service: { count: 0, ciscoNet: 0, customer: 0 },
  subscription: { count: 0, ciscoNet: 0, customer: 0 },
};

let classifyHits = 0;
let discountHits = 0;
const review: string[] = [];

for (const line of CISCO_BOM) {
  const c = classify(line.partNumber);
  if (!c.confident) review.push(line.partNumber);

  // validation against Cisco's ground truth
  if (c.kind === (line.ciscoBucket as Bucket)) classifyHits++;
  if (POLICY.ciscoDiscountPct[c.kind] === line.ciscoDiscountPct) discountHits++;

  // rollup + your margin on Cisco's net cost
  const customer = round(line.ciscoExtendedNet * (1 + POLICY.margin[c.kind]));
  const r = roll[c.kind];
  r.count++;
  r.ciscoNet = round(r.ciscoNet + line.ciscoExtendedNet);
  r.customer = round(r.customer + customer);
}

const n = CISCO_BOM.length;
console.log(`\nClassified ${n} Cisco lines from part numbers alone — no catalog.\n`);
console.log(`  Bucket match vs Cisco:   ${classifyHits}/${n}   ${classifyHits === n ? "✓" : "✗"}`);
console.log(`  Discount match vs Cisco: ${discountHits}/${n}   ${discountHits === n ? "✓" : "✗"}`);
console.log(`  Needs human review:      ${review.length}${review.length ? " (" + review.join(", ") + ")" : ""}\n`);

console.log("  Bucket         lines    Cisco net (cost)   margin    DCSL price");
console.log("  " + "-".repeat(64));
let costTotal = 0;
let quoteTotal = 0;
for (const k of KINDS) {
  const r = roll[k];
  costTotal = round(costTotal + r.ciscoNet);
  quoteTotal = round(quoteTotal + r.customer);
  console.log(
    `  ${k.padEnd(13)} ${String(r.count).padStart(5)}   ${usd(r.ciscoNet).padStart(16)}   ${(POLICY.margin[k] * 100 + "%").padStart(5)}   ${usd(r.customer).padStart(12)}`,
  );
}
console.log("  " + "-".repeat(64));
console.log(`  ${"TOTAL".padEnd(13)} ${String(n).padStart(5)}   ${usd(costTotal).padStart(16)}   ${" ".padStart(5)}   ${usd(quoteTotal).padStart(12)}`);
console.log(`\n  Cisco net cost reproduced: ${usd(costTotal)}  (estimate says $55,860.16)`);
console.log(`  Micro Solutions margin:    ${usd(round(quoteTotal - costTotal))}`);
console.log(`  DCSL customer quote:       ${usd(quoteTotal)}\n`);
