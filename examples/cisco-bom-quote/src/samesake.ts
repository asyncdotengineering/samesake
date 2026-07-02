// The same bucket rollup, but through samesake — to show where it plugs in at scale.
// We push the classified lines into a samesake collection (kind as a facet, net_price as a
// range facet) and use matcher.facets() — the query-free aggregation — to roll the buckets up.
// No search query, no catalog: just classify → push → facet.
//
// Run: SAMESAKE_DATABASE_URL=… bun run src/samesake.ts
import { collection, f, Channels, gates } from "@samesake/core";
import { createMatcher } from "@samesake/server";
import { CISCO_BOM } from "../data/cisco-bom.ts";
import { classify } from "./classify.ts";

const PROJECT = "cisco-bom";
const LINES = "lines";

const lines = collection(LINES, {
  fields: {
    part_number: f.text({ searchable: true }),
    kind: f.text({ filterable: true, facet: true }),
    net_price: f.number({ filterable: true, facet: "range" }),
  },
  indexing: {
    surfaces: { fts_doc: { kind: "fts", build: ({ data }) => String(data.part_number ?? "") } },
    gate: gates.always,
  },
  search: { channels: [Channels.fts({ fields: ["part_number"], weight: 1 })], combiner: "rrf" },
});

const db = process.env.SAMESAKE_DATABASE_URL;
if (!db) throw new Error("set SAMESAKE_DATABASE_URL to run the samesake rollup");

const m = createMatcher({ databaseUrl: db, apiKey: "cisco-bom-demo-key", migrate: "eager", embed: async () => [] });
await m.migrate();
await m.apply(PROJECT, { collections: [lines] });

// classify every line and push it in (id keeps duplicates distinct)
await m.indexDocuments(
  PROJECT,
  LINES,
  CISCO_BOM.map((l, i) => {
    const kind = classify(l.partNumber).kind;
    return {
      id: `${l.partNumber}-${i}`,
      data: { part_number: l.partNumber, kind, net_price: l.ciscoExtendedNet },
      doc: l.partNumber,
      content_hash: `${l.partNumber}-${i}`,
      fields: { part_number: l.partNumber, kind, net_price: l.ciscoExtendedNet },
    };
  }),
);

// 1) per-kind counts — a terms facet on `kind`, query-free
const f1 = await m.facets(PROJECT, LINES, { facets: ["kind"] });
const counts = "values" in f1.kind ? f1.kind.values : [];

console.log("\nBucket rollup via matcher.facets() (no query, no catalog):\n");
console.log("  kind            lines    net total");
console.log("  " + "-".repeat(40));
let grand = 0;
for (const { value: kind, count } of counts) {
  // 2) net stats for this kind — a range facet carries count + avg; total = avg × count
  const fk = await m.facets(PROJECT, LINES, { filters: { kind }, facets: ["net_price"] });
  const stats = "avg" in fk.net_price ? fk.net_price : null;
  const total = Math.round((stats?.avg ?? 0) * (stats?.count ?? 0) * 100) / 100;
  grand += total;
  console.log(`  ${kind.padEnd(13)} ${String(count).padStart(5)}   $${total.toLocaleString("en-US", { minimumFractionDigits: 2 })}`);
}
console.log("  " + "-".repeat(40));
console.log(`  total net: $${grand.toLocaleString("en-US", { minimumFractionDigits: 2 })}  (estimate: $55,860.16)\n`);
console.log("Note: facets() exposes count/avg/min/max; bucket totals here are avg×count.");
console.log("A native `sum` on range facets would make this one call — a clean follow-up.\n");

await m.close();
