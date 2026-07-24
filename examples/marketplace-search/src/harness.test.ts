import { describe, expect, test } from "bun:test";
import { runHarness } from "./run.ts";

const url = process.env.SAMESAKE_DATABASE_URL;
const describeIf = url ? describe : describe.skip;

describeIf("marketplace-search (enrich → resolve → facets → search on Postgres)", () => {
  test("cross-vendor dedup clusters, facets count, search returns hits", async () => {
    const r = await runHarness(url);
    // The two GTIN-1001 listings (Footlocker + Amazon) link into one product.
    expect(r.clustered).toBe(true);
    // Facets return per-value counts for the sidebar (Nike appears twice).
    const brand = (r.facets as { brand?: { values: { value: string; count: number }[] } }).brand;
    expect(brand?.values.find((v) => v.value === "Nike")?.count).toBe(2);
    // Search returns hits.
    expect(r.searchIds.length).toBeGreaterThan(0);
  });
});
