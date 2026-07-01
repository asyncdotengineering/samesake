import { describe, expect, test } from "bun:test";
import {
  scoreEnrichment,
  makeEvaluateEnrichService,
  type AttrSpec,
  type GoldRow,
  type PredictedRow,
} from "../src/core/evaluate-enrich.ts";

const CAT: AttrSpec = { name: "category", kind: "single" };
const GENDER: AttrSpec = { name: "gender", kind: "single" };
const COLORS: AttrSpec = { name: "colors", kind: "multi" };
const PATTERN: AttrSpec = { name: "pattern", kind: "single" };

function pred(id: string, enriched: Record<string, unknown> | null, status = "ready"): PredictedRow {
  return { id, enriched, pipeline_status: status };
}

describe("scoreEnrichment — pure scorer", () => {
  test("perfect match → P=R=F1=1 and no diffs", () => {
    const gold: GoldRow[] = [{ id: "1", labels: { category: "dresses", colors: ["red", "blue"] } }];
    const predicted = [pred("1", { category: "dresses", colors: ["red", "blue"] })];
    const r = scoreEnrichment(gold, predicted, [CAT, COLORS]);
    expect(r.overall.microF1).toBe(1);
    expect(r.overall.macroF1).toBe(1);
    expect(r.diffs).toHaveLength(0);
    expect(r.coverage).toMatchObject({ gold: 1, matched: 1, withEnriched: 1, missing: 0 });
  });

  test("hallucinated extra value → false positive, precision<1, recall=1", () => {
    const gold: GoldRow[] = [{ id: "1", labels: { colors: ["red"] } }];
    const predicted = [pred("1", { colors: ["red", "blue"] })];
    const r = scoreEnrichment(gold, predicted, [COLORS]);
    const c = r.attributes[0]!;
    expect({ tp: c.tp, fp: c.fp, fn: c.fn }).toEqual({ tp: 1, fp: 1, fn: 0 });
    expect(c.precision).toBe(0.5);
    expect(c.recall).toBe(1);
    expect(r.diffs[0]!.errors[0]!.hallucinated).toEqual(["blue"]);
  });

  test("missed value / NULL is worse than wrong → false negative, recall<1", () => {
    const gold: GoldRow[] = [{ id: "1", labels: { colors: ["red", "green"] } }];
    const predicted = [pred("1", { colors: ["red"] })];
    const r = scoreEnrichment(gold, predicted, [COLORS]);
    const c = r.attributes[0]!;
    expect({ tp: c.tp, fp: c.fp, fn: c.fn }).toEqual({ tp: 1, fp: 0, fn: 1 });
    expect(c.recall).toBe(0.5);
    expect(r.diffs[0]!.errors[0]!.missed).toEqual(["green"]);
  });

  test("enriched=null → all gold values become misses (pipeline failed to enrich)", () => {
    const gold: GoldRow[] = [{ id: "1", labels: { category: "tops", colors: ["black"] } }];
    const predicted = [pred("1", null, "quarantined")];
    const r = scoreEnrichment(gold, predicted, [CAT, COLORS]);
    expect(r.overall.microRecall).toBe(0);
    expect(r.coverage.withEnriched).toBe(0);
    expect(r.coverage.byStatus).toEqual({ quarantined: 1 });
  });

  test("'unknown' prediction counts as no value (a miss when gold has a value)", () => {
    const gold: GoldRow[] = [{ id: "1", labels: { pattern: "striped" } }];
    const predicted = [pred("1", { pattern: "unknown" })];
    const r = scoreEnrichment(gold, predicted, [PATTERN]);
    expect(r.attributes[0]!.fn).toBe(1);
    expect(r.attributes[0]!.recall).toBe(0);
  });

  test("explicitly-empty gold ([]) penalizes a hallucinated value; unlabeled key is skipped", () => {
    // colors explicitly empty (a watch), gender unlabeled (absent) → gender not scored at all.
    const gold: GoldRow[] = [{ id: "1", labels: { colors: [] } }];
    const predicted = [pred("1", { colors: ["gold"], gender: "men" })];
    const r = scoreEnrichment(gold, predicted, [COLORS, GENDER]);
    const colors = r.attributes.find((a) => a.attribute === "colors")!;
    const gender = r.attributes.find((a) => a.attribute === "gender")!;
    expect({ tp: colors.tp, fp: colors.fp, fn: colors.fn }).toEqual({ tp: 0, fp: 1, fn: 0 });
    expect(colors.precision).toBe(0);
    expect(gender.scored).toBe(0); // unlabeled → skipped, not a false positive
  });

  test("boolean attribute (is_apparel_product) scores true/false", () => {
    const IS_APP: AttrSpec = { name: "is_apparel_product", kind: "single", empty: [] };
    const gold: GoldRow[] = [
      { id: "shirt", labels: { is_apparel_product: true } },
      { id: "perfume", labels: { is_apparel_product: false } },
    ];
    const predicted = [
      pred("shirt", { is_apparel_product: true }),
      pred("perfume", { is_apparel_product: true }), // pipeline WRONGLY thinks perfume is apparel
    ];
    const r = scoreEnrichment(gold, predicted, [IS_APP]);
    const m = r.attributes[0]!;
    // shirt: tp(true). perfume: gold=false predicted=true → fp(true)+fn(false)
    expect({ tp: m.tp, fp: m.fp, fn: m.fn }).toEqual({ tp: 1, fp: 1, fn: 1 });
  });

  test("micro weights by value count; macro weights by attribute", () => {
    // category: 1 gold value, correct. colors: 4 gold values across rows, half wrong.
    const gold: GoldRow[] = [
      { id: "1", labels: { category: "dresses", colors: ["red", "blue"] } },
      { id: "2", labels: { category: "tops", colors: ["black", "white"] } },
    ];
    const predicted = [
      pred("1", { category: "dresses", colors: ["red", "green"] }), // 1 tp, 1 fp, 1 fn
      pred("2", { category: "tops", colors: ["black", "white"] }), // clean
    ];
    const r = scoreEnrichment(gold, predicted, [CAT, COLORS]);
    const cat = r.attributes.find((a) => a.attribute === "category")!;
    const col = r.attributes.find((a) => a.attribute === "colors")!;
    expect(cat.f1).toBe(1);
    expect(col.tp).toBe(3);
    expect(col.fp).toBe(1);
    expect(col.fn).toBe(1);
    // micro pools ALL attrs: category(2 tp) + colors(3 tp,1 fp,1 fn) = 5 tp, 1 fp, 1 fn
    expect(r.overall.microPrecision).toBe(0.833); // 5/(5+1)
    expect(r.overall.microRecall).toBe(0.833); // 5/(5+1)
    // macro = mean(categoryF1=1.0, colorsF1=0.75) = 0.875 > micro (small classes not down-weighted)
    expect(r.overall.macroF1).toBe(0.875);
  });

  test("missing prediction row → counted as missing, not scored", () => {
    const gold: GoldRow[] = [
      { id: "present", labels: { category: "tops" } },
      { id: "absent", labels: { category: "dresses" } },
    ];
    const predicted = [pred("present", { category: "tops" })];
    const r = scoreEnrichment(gold, predicted, [CAT]);
    expect(r.coverage.missing).toBe(1);
    expect(r.coverage.matched).toBe(1);
    expect(r.attributes[0]!.scored).toBe(1); // only the present row
  });
});

describe("makeEvaluateEnrichService — reads enriched rows and scores", () => {
  test("resolves project, reads by id, scores against gold", async () => {
    const rows = [
      { id: "1", enriched: { category: "dresses", colors: ["red"] }, pipeline_status: "ready", gate_reason: null },
      // enriched delivered as a JSON string (postgres jsonb driver variance) — must parse
      { id: "2", enriched: JSON.stringify({ category: "tops", colors: ["blue"] }), pipeline_status: "ready", gate_reason: null },
    ];
    let capturedSql = "";
    let capturedParams: unknown[] = [];
    const ctx = {
      storage: {
        client: () => ({
          unsafe: async (sql: string, params: unknown[]) => {
            capturedSql = sql;
            capturedParams = params;
            return rows;
          },
        }),
      },
    } as unknown as Parameters<typeof makeEvaluateEnrichService>[0];
    const projectsService = {
      getProject: async (slug: string) => (slug === "demo" ? { slug, schema_name: "project_demo" } : null),
    } as unknown as Parameters<typeof makeEvaluateEnrichService>[1];

    const svc = makeEvaluateEnrichService(ctx, projectsService);
    const gold: GoldRow[] = [
      { id: "1", labels: { category: "dresses", colors: ["red"] } },
      { id: "2", labels: { category: "tops", colors: ["blue"] } },
    ];
    const r = await svc.evaluateEnrichment("demo", "products", { gold, attributes: [CAT, COLORS] });
    expect(r.overall.microF1).toBe(1);
    expect(r.coverage.matched).toBe(2);
    expect(capturedSql).toContain("project_demo.c_products");
    expect(capturedParams[0]).toEqual(["1", "2"]);
  });

  test("throws on unknown project and empty gold", async () => {
    const ctx = { storage: { client: () => ({ unsafe: async () => [] }) } } as unknown as Parameters<
      typeof makeEvaluateEnrichService
    >[0];
    const projectsService = { getProject: async () => null } as unknown as Parameters<
      typeof makeEvaluateEnrichService
    >[1];
    const svc = makeEvaluateEnrichService(ctx, projectsService);
    await expect(svc.evaluateEnrichment("nope", "products", { gold: [{ id: "1", labels: {} }], attributes: [CAT] })).rejects.toThrow(
      /not found/
    );

    const okProject = { getProject: async () => ({ slug: "demo", schema_name: "project_demo" }) } as unknown as Parameters<
      typeof makeEvaluateEnrichService
    >[1];
    const svc2 = makeEvaluateEnrichService(ctx, okProject);
    await expect(svc2.evaluateEnrichment("demo", "products", { gold: [], attributes: [CAT] })).rejects.toThrow(/non-empty gold/);
  });
});
