import { describe, expect, test } from "bun:test";
import { MockEmbeddingModelV3, MockLanguageModelV3, MockRerankingModelV3 } from "ai/test";
import { aiSdkEmbedder, aiSdkGenerator, aiSdkReranker } from "../src/ai-sdk.ts";

describe("aiSdkEmbedder", () => {
  test("bridges an AI SDK embedding model and forwards providerOptions", async () => {
    let seenOptions: unknown;
    const model = new MockEmbeddingModelV3({
      doEmbed: async ({ providerOptions }) => {
        seenOptions = providerOptions;
        return { embeddings: [[0.1, 0.2]], warnings: [] };
      },
    });
    const embed = aiSdkEmbedder(model, {
      providerOptions: ({ dim, taskType }) => ({
        google: { outputDimensionality: dim, ...(taskType ? { taskType } : {}) },
      }),
    });
    const v = await embed({ text: "hi", model: "m", dim: 2, taskType: "RETRIEVAL_QUERY" });
    expect(v).toEqual([0.1, 0.2]);
    expect(seenOptions).toEqual({
      google: { outputDimensionality: 2, taskType: "RETRIEVAL_QUERY" },
    });
  });

  test("rejects image inputs (AI SDK embed is text-only)", async () => {
    const model = new MockEmbeddingModelV3({});
    const embed = aiSdkEmbedder(model);
    expect(embed({ image: { url: "http://x/y.jpg" }, model: "m", dim: 2 })).rejects.toThrow(
      "text-only"
    );
  });
});

describe("aiSdkGenerator", () => {
  test("bridges generateObject with a JSON schema", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        content: [{ type: "text" as const, text: '{"color":"red"}' }],
        warnings: [],
      }),
    });
    const generate = aiSdkGenerator(model);
    const out = await generate({
      prompt: "what color?",
      schema: { type: "object", properties: { color: { type: "string" } } },
    });
    expect(out).toEqual({ color: "red" });
  });
});

describe("aiSdkReranker", () => {
  test("maps ranking back to candidate ids", async () => {
    const model = new MockRerankingModelV3({
      doRerank: async () => ({
        ranking: [
          { index: 1, relevanceScore: 0.9 },
          { index: 0, relevanceScore: 0.2 },
        ],
      }),
    });
    const rerankFn = aiSdkReranker(model);
    const out = await rerankFn({
      query: "q",
      candidates: [
        { id: "a", text: "red shoes", data: {}, score: 0.03 },
        { id: "b", text: "blue dress", data: {}, score: 0.02 },
      ],
      topK: 2,
    });
    expect(out).toEqual([
      { id: "b", score: 0.9 },
      { id: "a", score: 0.2 },
    ]);
  });
});
