import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { normalizeSchema } from "../src/core/schema-input.ts";

describe("normalizeSchema", () => {
  test("converts a zod schema to JSON Schema", () => {
    const out = normalizeSchema(z.object({ color_text: z.string(), pattern: z.string().optional() }));
    expect(out.type).toBe("object");
    expect((out.properties as Record<string, unknown>).color_text).toEqual({ type: "string" });
    expect(out.required).toEqual(["color_text"]);
  });

  test("passes a plain JSON Schema object through by reference", () => {
    const raw = { type: "object", properties: { x: { type: "string" } }, required: ["x"] };
    expect(normalizeSchema(raw)).toBe(raw);
  });

  test("throws for a non-zod Standard Schema", () => {
    const fake = { "~standard": { vendor: "valibot", version: 1 } };
    expect(() => normalizeSchema(fake)).toThrow(/valibot/);
  });
});
