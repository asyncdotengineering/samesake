import { describe, expect, test } from "bun:test";
import {
  scoreEnrichment,
  type AttrSpec,
  type GoldRow,
  type PredictedRow,
} from "../src/index.ts";

const attributes: AttrSpec[] = [
  { name: "category", kind: "single" },
  { name: "colors", kind: "multi" },
];

describe("scoreEnrichment — pure scorer", () => {
  test("partial-match fixture: hand-computed micro/macro PRF + per-attribute metrics + diffs", () => {
    // Gold:
    //   p1 — category "Dress", colors ["red","blue"]
    //   p2 — category "Shirt", colors ["green"]
    // Predicted (enriched):
    //   p1 — category "dress" (✓), colors ["red","yellow"] (1 hit, 1 miss blue, 1 halluc yellow)
    //   p2 — category "pants" (miss shirt, halluc pants), colors ["green"] (✓)
    //
    // category bucket: tp=1 fp=1 fn=1 support=2 scored=2  → P=R=F1=0.5
    // colors   bucket: tp=2 fp=1 fn=1 support=3 scored=2  → P=R=F1=2/3≈0.667
    // micro totals    : tp=3 fp=2 fn=2                   → P=R=F1=0.6
    // macroF1         : (0.5 + 0.667) / 2 = 0.5835 → round 0.584
    const gold: GoldRow[] = [
      { id: "p1", title: "Product 1", labels: { category: "Dress", colors: ["red", "blue"] } },
      { id: "p2", title: "Product 2", labels: { category: "Shirt", colors: ["green"] } },
    ];
    const predicted: PredictedRow[] = [
      { id: "p1", enriched: { category: "dress", colors: ["red", "yellow"] } },
      { id: "p2", enriched: { category: "pants", colors: ["green"] } },
    ];

    const result = scoreEnrichment(gold, predicted, attributes);

    // Per-attribute metrics.
    const category = result.attributes.find((a) => a.attribute === "category")!;
    expect(category).toMatchObject({
      tp: 1, fp: 1, fn: 1, precision: 0.5, recall: 0.5, f1: 0.5, support: 2, scored: 2,
    });
    const colors = result.attributes.find((a) => a.attribute === "colors")!;
    expect(colors).toMatchObject({
      tp: 2, fp: 1, fn: 1, precision: 0.667, recall: 0.667, f1: 0.667, support: 3, scored: 2,
    });

    // Overall micro / macro.
    expect(result.overall).toEqual({
      microPrecision: 0.6, microRecall: 0.6, microF1: 0.6, macroF1: 0.584,
    });

    // Coverage.
    expect(result.coverage).toEqual({
      gold: 2, matched: 2, withEnriched: 2, missing: 0, byStatus: { unknown: 2 },
    });

    // Diffs: both products had errors.
    expect(result.diffs).toHaveLength(2);
    const p1Diff = result.diffs.find((d) => d.id === "p1")!;
    expect(p1Diff.title).toBe("Product 1");
    expect(p1Diff.status).toBeNull();
    expect(p1Diff.errors).toEqual([
      {
        attribute: "colors",
        gold: ["red", "blue"],
        predicted: ["red", "yellow"],
        missed: ["blue"],
        hallucinated: ["yellow"],
      },
    ]);
    const p2Diff = result.diffs.find((d) => d.id === "p2")!;
    expect(p2Diff.errors).toEqual([
      {
        attribute: "category",
        gold: ["shirt"],
        predicted: ["pants"],
        missed: ["shirt"],
        hallucinated: ["pants"],
      },
    ]);
  });

  test("perfect prediction yields precision=recall=f1=1 and no diffs", () => {
    const gold: GoldRow[] = [
      { id: "p1", labels: { category: "Dress", colors: ["red", "blue"] } },
      { id: "p2", labels: { category: "Shirt", colors: ["green"] } },
    ];
    const predicted: PredictedRow[] = [
      { id: "p1", enriched: { category: "dress", colors: ["red", "blue"] } },
      { id: "p2", enriched: { category: "shirt", colors: ["green"] } },
    ];

    const result = scoreEnrichment(gold, predicted, attributes);

    expect(result.overall).toEqual({
      microPrecision: 1, microRecall: 1, microF1: 1, macroF1: 1,
    });
    expect(result.attributes.every((a) => a.precision === 1 && a.recall === 1 && a.f1 === 1)).toBe(true);
    expect(result.diffs).toEqual([]);
    expect(result.coverage).toEqual({
      gold: 2, matched: 2, withEnriched: 2, missing: 0, byStatus: { unknown: 2 },
    });
  });

  test("dotted path + custom empty values are honored", () => {
    // `spec.path` reads a nested field; `spec.empty` adds "n/a" to the empty set on top of the
    // default "unknown". A predicted "unknown" or "n/a" must count as no-value (not a false positive).
    const gold: GoldRow[] = [{ id: "x", labels: { tone: "Warm" } }];
    const predicted: PredictedRow[] = [
      { id: "x", enriched: { attrs: { tone: "unknown" } } },
    ];
    const result = scoreEnrichment(gold, predicted, [
      { name: "tone", kind: "single", path: "attrs.tone", empty: ["unknown", "n/a"] },
    ]);
    // Predicted tone "unknown" → empty set → predSet is empty. Gold {warm}. So tp=0 fp=0 fn=1.
    const tone = result.attributes[0];
    expect(tone).toMatchObject({ tp: 0, fp: 0, fn: 1, precision: 1, recall: 0, f1: 0, support: 1, scored: 1 });
  });
});
