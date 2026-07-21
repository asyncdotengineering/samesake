import { describe, expect, test, setSystemTime } from "bun:test";
import type { PipelineDef, IndexingDef, CollectionDedupDef, DerivedDocContext } from "@samesake/core";
import {
  createEnricher,
  memoryStore,
  trigramSimilarity,
  type EnrichStore,
  type EnrichedRow,
} from "../src/index.ts";

// Minimal pipeline + indexing used across the suite. The stage merges its
// structured output into `enriched`; the dense surface echoes `enriched.color`
// so a gate can pass on its presence.
const dense = (build: (c: DerivedDocContext) => string) => ({ kind: "dense" as const, embedding: "default", build });
const pipeline: PipelineDef = {
  stages: [{ name: "color", prompt: () => "color?", schema: () => ({ type: "object" }) }],
};
const indexing: IndexingDef = {
  surfaces: { doc: dense((c) => String(c.enriched.color ?? "")) },
  gate: (c) => ({ index: Boolean(c.enriched.color) }),
};
const dedup: CollectionDedupDef = {
  channels: [{ kind: "exactKey", field: "sku" }],
  autoLink: 0.9,
  offerFields: [],
};
const evalAttributes = [{ name: "color", kind: "single" as const }];

describe("createEnricher — pure/default-store round trip", () => {
  test("upsert -> enrich persists merged output; second enrich is a no-op; changed data re-dirties", async () => {
    const e = createEnricher({ pipeline, indexing, dedup, evalAttributes, generate: async () => ({ color: "red" }) });

    await e.upsert([{ id: "r1", data: { title: "Shirt" } }]);
    const ready = await e.enrich();
    expect(ready).toHaveLength(1);
    expect(ready[0]!.id).toBe("r1");
    expect((ready[0]!.enriched as Record<string, unknown>).color).toBe("red");

    // Nothing dirty now → second enrich returns [].
    expect(await e.enrich()).toEqual([]);

    // Re-upsert with UNCHANGED data → still a no-op (contentHash reuse).
    await e.upsert([{ id: "r1", data: { title: "Shirt" } }]);
    expect(await e.enrich()).toEqual([]);

    // Re-upsert with CHANGED data → re-dirties; next enrich returns it.
    await e.upsert([{ id: "r1", data: { title: "Shirt2" } }]);
    const reReady = await e.enrich();
    expect(reReady).toHaveLength(1);
    expect(reReady[0]!.id).toBe("r1");
  });
});

describe("createEnricher — resolve", () => {
  test("two rows sharing an exactKey field are linked via the memoryStore candidates", async () => {
    const e = createEnricher({
      pipeline,
      indexing,
      dedup,
      evalAttributes,
      generate: async () => ({ sku: "S1", color: "red" }),
    });
    await e.upsert([
      { id: "r1", data: { title: "A" } },
      { id: "r2", data: { title: "B" } },
    ]);
    await e.enrich();

    const decisions = await e.resolve();
    expect(decisions).toHaveLength(2);
    expect(decisions.map((d) => d.rowId).sort()).toEqual(["r1", "r2"]);
    expect(decisions.every((d) => d.outcome === "link")).toBe(true);
    expect(decisions.every((d) => d.score === 1)).toBe(true);
  });

  test("throws a clear error when the store lacks candidates", async () => {
    const noCandStore: EnrichStore = {
      upsert: async () => {},
      loadDirty: async () => [],
      writeEnriched: async () => {},
      recordFailure: async () => {},
      loadRetryable: async () => [],
      markDead: async () => {},
      loadEnriched: async () => [],
      // candidates deliberately omitted
    };
    const e = createEnricher({ pipeline, indexing, dedup, generate: async () => ({}), store: noCandStore });
    expect(e.resolve()).rejects.toThrow("resolve requires a store with loadEnriched + candidates");
  });
});

describe("createEnricher — retryFailed", () => {
  test("a first-pass failure is retried to success once the backoff window elapses", async () => {
    // The shipped enrich core treats a `generate` throw as a stage-SKIP (ok:true),
    // not a failure. The only way to produce ok:false is a thrown surface build,
    // so the failure signal here is a build that throws on its first invocation
    // then succeeds — driven by a counter, not timing. See createenricher-implementation-notes.md.
    let buildCalls = 0;
    const flakyIndexing: IndexingDef = {
      surfaces: {
        doc: dense((c) => {
          buildCalls++;
          if (buildCalls === 1) throw new Error("surface-boom");
          return String(c.enriched.color ?? "");
        }),
      },
      gate: (c) => ({ index: Boolean(c.enriched.color) }),
    };

    const t0 = new Date("2024-01-01T00:00:00Z").getTime();
    setSystemTime(new Date(t0));

    const e = createEnricher({
      pipeline,
      indexing: flakyIndexing,
      generate: async () => ({ color: "red" }),
    });
    await e.upsert([{ id: "r1", data: { title: "Shirt" } }]);

    // First pass: surface build throws → ok:false → recordFailure. Row is NOT enriched.
    const first = await e.enrich();
    expect(first).toEqual([]);
    expect(buildCalls).toBe(1);

    // Immediately, the row is still in backoff (nextAttemptAt = t0 + 2s) → not retryable.
    setSystemTime(new Date(t0));
    expect(await e.retryFailed()).toEqual([]);

    // Advance past the 2s backoff → retryable → second build succeeds.
    setSystemTime(new Date(t0 + 3000));
    const retried = await e.retryFailed();
    expect(retried).toHaveLength(1);
    expect(retried[0]!.id).toBe("r1");
    expect((retried[0]!.enriched as Record<string, unknown>).color).toBe("red");

    setSystemTime(new Date()); // restore real clock
  });
});

describe("createEnricher — evaluate", () => {
  test("returns overall F1 = 1.0 when predictions match the gold set", async () => {
    const e = createEnricher({
      pipeline,
      indexing,
      evalAttributes,
      generate: async () => ({ color: "red" }),
    });
    await e.upsert([{ id: "r1", data: { title: "Shirt" } }]);
    await e.enrich();

    const result = await e.evaluate([{ id: "r1", labels: { color: "red" } }]);
    expect(result.overall.microF1).toBe(1);
    expect(result.overall.macroF1).toBe(1);
    expect(result.diffs).toEqual([]);
  });
});

describe("trigramSimilarity", () => {
  test("identical strings score 1; both-empty scores 0; disjoint strings score low", () => {
    expect(trigramSimilarity("red dress", "red dress")).toBe(1);
    expect(trigramSimilarity("", "")).toBe(0);
    expect(trigramSimilarity("red dress", "blue jeans")).toBeLessThan(0.2);
  });
});
