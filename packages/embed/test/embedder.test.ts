import { describe, expect, test } from "bun:test";
import type { EmbedFn, EmbedRequest } from "@samesake/core";
import { createEmbedder } from "../src/index.ts";

function request(dim: number): EmbedRequest {
  return { text: "hello", model: "test-model", dim };
}

function makeEmbedder(calls: { single: number; many: number }): ReturnType<typeof createEmbedder> {
  return createEmbedder({
    single: async (req) => {
      calls.single++;
      return Array.from({ length: req.dim }, (_, index) => index);
    },
    many: async (requests) => {
      calls.many++;
      return requests.map((req, batchIndex) => Array.from({ length: req.dim }, () => batchIndex));
    },
    caps: { image: true, interleaved: true, dims: "any", maxBatch: 100 },
  });
}

describe("createEmbedder", () => {
  test("returns a callable EmbedFn with immutable capabilities", async () => {
    const calls = { single: 0, many: 0 };
    const embedder = makeEmbedder(calls);
    const asEmbedFn: EmbedFn = embedder;

    expect(await asEmbedFn(request(3))).toEqual([0, 1, 2]);
    expect(embedder.caps).toEqual({ image: true, interleaved: true, dims: "any", maxBatch: 100 });
    expect(Object.isFrozen(embedder.caps)).toBe(true);
    expect(calls).toEqual({ single: 1, many: 0 });
  });

  test("delegates many as one batch operation and preserves order", async () => {
    const calls = { single: 0, many: 0 };
    const embedder = makeEmbedder(calls);
    const requests = [request(2), request(2), request(2)];

    await expect(embedder.many(requests)).resolves.toEqual([[0, 0], [1, 1], [2, 2]]);
    expect(calls).toEqual({ single: 0, many: 1 });
  });

  test("chunks many at the declared batch limit without calling single", async () => {
    const calls = { single: 0, many: 0 };
    const embedder = createEmbedder({
      single: async (req) => {
        calls.single++;
        return Array.from({ length: req.dim }, () => 0);
      },
      many: async (requests) => {
        calls.many++;
        return requests.map((req, index) => Array.from({ length: req.dim }, () => index));
      },
      caps: { image: false, interleaved: false, dims: "any", maxBatch: 2 },
    });

    const vectors = await embedder.many([request(1), request(1), request(1), request(1), request(1)]);
    expect(vectors).toEqual([[0], [1], [0], [1], [0]]);
    expect(calls).toEqual({ single: 0, many: 3 });
  });

  test("rejects a dimension mismatch instead of returning a corrupt vector", async () => {
    const embedder = createEmbedder({
      single: async () => [1, 2],
      many: async () => [[1, 2]],
      caps: { image: false, interleaved: false, dims: "any", maxBatch: 1 },
    });

    await expect(embedder(request(3))).rejects.toThrow(/dimension mismatch/);
    await expect(embedder.many([request(3)])).rejects.toThrow(/dimension mismatch/);
  });

  test("rejects a batch response with the wrong number of vectors", async () => {
    const embedder = createEmbedder({
      single: async (req) => Array.from({ length: req.dim }, () => 0),
      many: async () => [],
      caps: { image: false, interleaved: false, dims: "any", maxBatch: 1 },
    });

    await expect(embedder.many([request(1)])).rejects.toThrow(/0 vectors for 1 requests/);
  });
});
