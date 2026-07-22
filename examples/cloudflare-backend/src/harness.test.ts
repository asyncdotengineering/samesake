import { describe, expect, test } from "bun:test";
import { runHarness } from "./run.ts";

describe("D1 + LanceDB backend reference", () => {
  test("runs enrich, resolve, and search without a database URL", async () => {
    expect(process.env.SAMESAKE_DATABASE_URL ?? "").toBe("");
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
