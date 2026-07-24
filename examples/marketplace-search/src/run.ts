// Multi-vendor marketplace, end to end on Postgres: enrich → resolve (cross-vendor
// dedup) → facets → search. Requires SAMESAKE_DATABASE_URL (Postgres + pgvector).
import { samesake } from "@samesake/postgres";
import { products } from "./catalog.ts";
import { stubEmbed, stubGenerate } from "./stubs.ts";

// Two vendors list the SAME shoe (GTIN 1001) with slightly different titles; a third
// product is a singleton. resolve() should cluster the two 1001 listings into one.
const CATALOG = [
  { id: "a", data: { title: "Red Running Shoes", brand: "Nike", color: "red", price: 120, available: true, gtin: "1001", vendor: "Footlocker" } },
  { id: "b", data: { title: "Red Runing Shoe", brand: "Nike", color: "red", price: 115, available: true, gtin: "1001", vendor: "Amazon" } },
  { id: "c", data: { title: "Blue Denim Jacket", brand: "Levis", color: "blue", price: 90, available: true, gtin: "2002", vendor: "Zappos" } },
];

export interface HarnessResult {
  clustered: boolean;
  facets: Record<string, unknown>;
  searchIds: string[];
}

export async function runHarness(url = process.env.SAMESAKE_DATABASE_URL): Promise<HarnessResult> {
  if (!url) throw new Error("SAMESAKE_DATABASE_URL is required (Postgres with pgvector)");
  const app = samesake({
    url,
    schema: `mp_${Math.random().toString(36).slice(2, 10)}`,
    collection: products,
    models: { embed: stubEmbed, generate: stubGenerate },
  });
  try {
    await app.migrate();
    await app.enrich.upsert(CATALOG);
    await app.enrich.enrich();

    // Cross-vendor dedup: the two GTIN-1001 listings should link into one product.
    const decisions = await app.resolve();
    const link = decisions.find((d) => d.rowId === "a" || d.rowId === "b");
    const clustered = decisions.some((d) => d.outcome === "link");

    // Facet counts drive the refinement sidebar.
    const facets = await app.facets({ fields: ["brand", "color"] });

    const { hits } = await app.search("red shoes", { limit: 5 });
    const searchIds = hits.map((h) => String(h.id));

    return { clustered: clustered && !!link, facets, searchIds };
  } finally {
    await app.close?.();
  }
}

if (import.meta.main) {
  const r = await runHarness();
  console.log(JSON.stringify(r, null, 2));
  console.log(r.clustered ? "\nOK: the two cross-vendor listings clustered into one product." : "\nMISMATCH: no cross-vendor cluster.");
}
