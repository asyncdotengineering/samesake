// Live wiring smoke for the aspects query path against a (possibly partially backfilled)
// corpus: routing, per-aspect legs, MaxSim, explain. Not a relevance gate.
import { COLLECTION, PROJECT, createFashionMatcher, productsCollection } from "./samesake.config.ts";

const matcher = createFashionMatcher();
await matcher.migrate();
await matcher.apply(PROJECT, { entities: [], collections: [productsCollection] });

const queries = [
  "black floral dress for a beach wedding", // should route visual + facets
  "nike",                                   // skip-NLQ → doc only
  "casual linen shirt for office",          // facets routing
];

for (const q of queries) {
  const t0 = Date.now();
  const res = await matcher.searchExplain(PROJECT, COLLECTION, { q, limit: 5 });
  const ms = Date.now() - t0;
  const legs = res.docs[0]
    ? Object.entries(res.docs[0].aspect_ranks ?? {})
        .map(([name, a]) => `${name}:${a.rank ?? "-"}`)
        .join(" ")
    : "no hits";
  console.log(`[smoke] "${q}" ${ms}ms hits=${res.docs.length} parsed_aspects=${JSON.stringify((res.parsed as Record<string, unknown> | undefined)?.aspects ?? null)} top_legs={${legs}} fts_rank=${res.docs[0]?.fts_rank ?? "-"}`);
}
console.log("[smoke] done");
