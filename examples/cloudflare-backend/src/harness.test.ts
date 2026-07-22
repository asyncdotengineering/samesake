import { describe, expect, test } from "bun:test";
import { runHarness } from "./run.ts";

describe("D1 + LanceDB backend reference", () => {
  test("runs enrich, resolve, and search over D1 + LanceDB — no Postgres", async () => {
    // "No Postgres" is a STRUCTURAL property, not an env accident: this example
    // declares no Postgres dependency and imports no @samesake/postgres, so it
    // physically cannot open a Postgres connection. (Asserting the env var is unset
    // is meaningless — bun auto-loads the repo .env; the example never reads it.)
    const pkg = (await import("../package.json")).default as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {}).some((d) => /postgres|pgvector|drizzle/i.test(d))).toBe(false);

    const result = await runHarness({ writeEvidence: false });

    expect(result.enriched.length).toBe(10);
    expect(result.enriched.every((row) => row.enriched.gtin)).toBe(true);

    const linked = result.decisions.find((decision) => decision.rowId === "p2");
    expect(linked?.outcome).toBe("link");
    expect(linked?.group).toBe("p1");

    expect(result.page.hits.every((hit) => hit.brand === "Nike")).toBe(true);
    expect(result.page.hits[0]?.id).toBe("p1");
    expect(typeof result.page.hits[0]?.score).toBe("number");
  });
});
