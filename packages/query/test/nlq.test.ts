import { describe, expect, test } from "bun:test";
import { collection, f, Channels, gates, type CollectionDef } from "@samesake/core";
import { parseNlq, shouldSkipNlq, type ParseNlqDeps } from "../src/index.ts";

// Minimal nlq-enabled collection: a soft `colors` enum lets the deterministic
// token filter derive "red" with no generation. No embeddings, no DB, no network.
const products = collection("products", {
  fields: {
    title: f.text({ searchable: true }),
    colors: f.array(f.enum(["red", "blue", "green"] as const), {
      filterable: true,
      soft: true,
    }),
  },
  indexing: {
    surfaces: {
      fts_doc: { kind: "fts", build: ({ data }) => String(data.title ?? "").trim() },
    },
    gate: gates.always,
  },
  search: {
    channels: [Channels.fts({ fields: ["title"], weight: 1 })],
    nlq: { enable: true },
  },
}) as CollectionDef & { name: string };

describe("shouldSkipNlq", () => {
  test("false for a non-empty query against an nlq-enabled collection", () => {
    expect(shouldSkipNlq(products, "red dress")).toBe(false);
  });

  test("true for an empty query", () => {
    expect(shouldSkipNlq(products, "")).toBe(true);
  });

  test("true when nlq is not configured", () => {
    const noNlq = { ...products, search: { channels: [] } } as unknown as CollectionDef;
    expect(shouldSkipNlq(noNlq, "red dress")).toBe(true);
  });
});

describe("parseNlq", () => {
  test("returns a NlqParseResult with the stubbed semantic_query, no stageCache", async () => {
    const deps = { generate: async () => ({ semantic_query: "red dress" }) } as unknown as ParseNlqDeps;
    const result = await parseNlq(products, "red dress", deps);
    expect(result.degraded).toBe(false);
    expect(result.parsed.semantic_query).toBe("red dress");
    // deterministic soft-enum token "red" is derived without relying on generation
    expect(result.deterministicFilters).toEqual({ colors: ["red"] });
    expect(result.filters).toEqual({ colors: ["red"] });
  });

  test("generateConfigured:false returns the degraded fallback without calling generate", async () => {
    let calls = 0;
    const deps = {
      generateConfigured: false,
      generate: async () => {
        calls++;
        return {};
      },
    } as unknown as ParseNlqDeps;
    const result = await parseNlq(products, "red dress", deps);
    expect(result.degraded).toBe(true);
    expect(result.parsed.semantic_query).toBe("red dress");
    expect(result.filters).toEqual({ colors: ["red"] });
    expect(calls).toBe(0);
  });

  test("degrades to the fallback when generate throws", async () => {
    const deps = {
      generate: async () => {
        throw new Error("boom");
      },
    } as unknown as ParseNlqDeps;
    const result = await parseNlq(products, "red dress", deps);
    expect(result.degraded).toBe(true);
    expect(result.parsed.semantic_query).toBe("red dress");
  });
});
