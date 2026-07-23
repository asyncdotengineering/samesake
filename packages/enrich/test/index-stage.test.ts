import { describe, expect, test } from "bun:test";
import { collection, f, gates, type EmbedRequest } from "@samesake/core";
import type { Embedder } from "@samesake/embed";
import { createEnricher, memoryStore } from "../src/index.ts";

const products = collection("products", {
  fields: { title: f.text() },
  embeddings: { doc: { model: "stub-model", dim: 3 } },
  enrich: {
    stages: [{ name: "extract", prompt: () => "extract", schema: () => ({ type: "object" }) }],
  },
  indexing: {
    surfaces: {
      doc: { kind: "dense", embedding: "doc", build: ({ data }) => String(data.title ?? "") },
    },
    gate: gates.always,
  },
});

describe("createEnricher index stage", () => {
  test("batches dense surfaces and returns normalized vectors on enriched rows", async () => {
    const batches: EmbedRequest[][] = [];
    const embed = Object.assign(
      async (_request: EmbedRequest) => [3, 4, 0],
      {
        many: async (requests: EmbedRequest[]) => {
          batches.push(requests);
          return requests.map(() => [3, 4, 0]);
        },
        caps: { image: false, interleaved: false, dims: "any" as const, maxBatch: 16 },
      }
    ) satisfies Embedder;
    const enricher = createEnricher({
      collection: products,
      generate: async () => ({ extracted: true }),
      embed,
      store: memoryStore(),
    });

    await enricher.upsert([
      { id: "a", data: { title: "Red shirt" } },
      { id: "b", data: { title: "Blue shirt" } },
    ]);
    const rows = await enricher.enrich();

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
    expect(batches[0]?.every((request) =>
      request.model === "stub-model" && request.dim === 3 &&
      request.taskType === "RETRIEVAL_DOCUMENT" && request.inputType === "document"
    )).toBe(true);
    expect(rows.map((row) => row.vectors?.doc)).toEqual([
      [0.6, 0.8, 0],
      [0.6, 0.8, 0],
    ]);
  });
});
