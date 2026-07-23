import { describe, expect, test } from "bun:test";
import type { IndexingDef, PipelineDef } from "@samesake/core";
import { definePreset, fashion, products, type EnrichPreset } from "../src/index.ts";

const emptyPipeline = (): PipelineDef => ({ stages: [] });
const emptyIndexing = (): IndexingDef => ({ surfaces: {}, gate: () => ({ index: true }) });

describe("@samesake/presets smoke", () => {
  test("fashion is an EnrichPreset carrying the relocated members", () => {
    expect(fashion.name).toBe("fashion");
    expect(typeof fashion.fields).toBe("function");
    expect(typeof fashion.enrich).toBe("function");
    expect(typeof fashion.indexing).toBe("function");
    expect(typeof fashion.evalAttributes).toBe("function");
    expect(fashion.nlq).toBeDefined();
    expect(typeof fashion.nlq!.instructions).toBe("string");
    expect(typeof fashion.nlq!.schema).toBe("function");

    const fields = fashion.fields();
    expect(fields).toHaveProperty("colors");
    expect(fields).toHaveProperty("category");
    expect(fashion.enrich().stages.map((s) => s.name)).toEqual(["classify", "extract"]);
    expect(fashion.evalAttributes().map((a) => a.name)).toContain("category");
  });

  test("fashion honors consumer opts through the override path (never mandates)", () => {
    const fields = fashion.fields({ brandPath: "brand" });
    expect((fields.brand as { path?: string }).path).toBe("brand");
    const pipe = fashion.enrich({ titleKey: "name", imageKey: "img" });
    const imgs = pipe.stages[0]!.images!({ data: { img: "http://x/y.jpg" }, enriched: {} });
    expect(imgs).toEqual(["http://x/y.jpg"]);
  });

  test("products is a minimal domain-neutral EnrichPreset with a confidence gate", () => {
    expect(products.name).toBe("products");
    const fields = products.fields();
    for (const key of ["title", "description", "price", "brand", "category", "image_url"]) {
      expect(fields).toHaveProperty(key);
    }
    expect(products.enrich().stages.map((s) => s.name)).toEqual(["extract"]);
    expect(products.evalAttributes().map((a) => a.name)).toContain("category");
    expect(products.dedup).toBeUndefined();
    expect(products.nlq).toBeUndefined();

    const gate = products.indexing().gate;
    expect(gate({ data: {}, enriched: { confidence: 0.1 } })).toEqual({ index: false, reason: "low-confidence" });
    expect(gate({ data: {}, enriched: { confidence: 0.9 } })).toEqual({ index: true });
  });

  test("definePreset validates and returns a well-formed spec", () => {
    const spec: EnrichPreset = {
      name: "jobs",
      fields: () => ({}),
      enrich: emptyPipeline,
      indexing: emptyIndexing,
      evalAttributes: () => [],
    };
    expect(definePreset(spec)).toBe(spec);
  });

  test("definePreset rejects malformed specs", () => {
    expect(() =>
      definePreset({
        name: "",
        fields: () => ({}),
        enrich: emptyPipeline,
        indexing: emptyIndexing,
        evalAttributes: () => [],
      }),
    ).toThrow(/name/);
    expect(() =>
      definePreset({
        name: "x",
        fields: null,
        enrich: emptyPipeline,
        indexing: emptyIndexing,
        evalAttributes: () => [],
      } as unknown as EnrichPreset),
    ).toThrow(/fields/);
    expect(() =>
      definePreset({
        name: "x",
        fields: () => ({}),
        enrich: emptyPipeline,
        indexing: emptyIndexing,
        evalAttributes: () => [],
        dedup: "nope",
      } as unknown as EnrichPreset),
    ).toThrow(/dedup/);
    expect(() =>
      definePreset({
        name: "x",
        fields: () => ({}),
        enrich: emptyPipeline,
        indexing: emptyIndexing,
        evalAttributes: () => [],
        nlq: "nope",
      } as unknown as EnrichPreset),
    ).toThrow(/nlq/);
  });
});
