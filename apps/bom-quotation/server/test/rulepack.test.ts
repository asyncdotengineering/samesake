import { describe, expect, test } from "bun:test";
import { defaultPack, parsePack } from "../src/rulepack/load.ts";

describe("rule pack — default electrical-mep", () => {
  test("loads + validates", () => {
    const p = defaultPack();
    expect(p.vertical).toBe("electrical-mep");
    expect(p.pricing.strategy).toBe("catalog");
  });

  test("preserves today's matching gates + thresholds (regression anchor)", () => {
    const p = defaultPack();
    expect(p.matching.hard).toEqual(["ratingA", "poles", "csaMm2", "cores", "sizeMm", "watt", "ways"]);
    expect(p.matching.autoLink).toBe(0.55);
    expect(p.matching.suggest).toBe(0.38);
  });

  test("pricing values (regression anchor — the pack is the single source)", () => {
    const p = defaultPack();
    expect(p.pricing.tiers["contractor-a"]!.discount).toBe(0.18);
    expect(p.pricing.tiers["retail"]!.discount).toBe(0);
    expect(p.pricing.taxes).toEqual([{ label: "VAT", rate: 0.18 }]);
    expect(p.pricing.priceDecimals).toBe(2);
    expect(p.pricing.validityDays).toBe(14);
    expect(p.pricing.qtyBreaks).toContainEqual({ category: "cable", minQty: 500, extraDiscount: 0.05 });
  });

  test("rejects a prefix-rules pack with no rules", () => {
    expect(() =>
      parsePack({
        vertical: "x",
        attributes: [],
        matching: { hard: [], weights: { cosine: 1, trigram: 0 }, autoLink: 0.5, suggest: 0.3 },
        pricing: { strategy: "prefix-rules", tiers: {}, taxes: [] },
      })
    ).toThrow();
  });
});
