import { describe, expect, test } from "bun:test";
import { defaultPack, parsePack } from "../src/rulepack/load.ts";
import { rules as legacyRules } from "../src/config.ts";

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

  test("pricing matches the legacy pricing-rules.json (no behaviour drift)", () => {
    const p = defaultPack();
    const r = legacyRules();
    expect(p.pricing.tiers).toEqual(r.tiers);
    expect(p.pricing.taxes).toEqual(r.taxes);
    expect(p.pricing.qtyBreaks).toEqual(r.qtyBreaks);
    expect(p.pricing.brandMargin).toEqual(r.brandMargin);
    expect(p.matching.autoLink).toBe(r.matching.autoLink);
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
