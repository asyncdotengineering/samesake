import { describe, expect, test } from "bun:test";
import { runHarness } from "./run.ts";

// Requires a Postgres with pgvector. Skips cleanly when SAMESAKE_DATABASE_URL is unset.
const url = process.env.SAMESAKE_DATABASE_URL;
const describeIf = url ? describe : describe.skip;

describeIf("build-a-search-experience (guide, end to end on Postgres)", () => {
  test("budget is a hard line: ivory dress returns, 28,000 sequin dress is excluded", async () => {
    const r = await runHarness(url);
    // The ivory linen dress (12,900) is under the parsed 'under 15000' budget and returns.
    expect(r.ivoryReturned).toBe(true);
    // The sequin dress (28,000) crosses the budget — excluded by a filter, not down-ranked.
    expect(r.sequinExcluded).toBe(true);
    expect(r.ids).toContain("1");
    expect(r.ids).not.toContain("2");
    // Field columns were projected, so the hit carries its real price.
    expect(r.hits[0]?.price).toBe(12900);
  });
});
