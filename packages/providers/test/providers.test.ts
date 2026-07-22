import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { gemini, voyage } from "@samesake/embed";
import {
  cohereReranker,
  geminiEmbedder,
  geminiGenerator,
  geminiParser,
  openaiEmbedder,
  openaiGenerator,
  voyageEmbedder,
  voyageReranker,
} from "../src/index.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Install a fetch mock; returns the capture slot. */
function mockFetch(responses: unknown[]): { calls: Captured[] } {
  const calls: Captured[] = [];
  let i = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ])
      ),
      body: init?.body ? JSON.parse(String(init.body)) : {},
    });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    if (r instanceof Response) return r;
    return new Response(JSON.stringify(r), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls };
}

const CANDIDATES = [
  { id: "a", text: "red shoes", data: {}, score: 0.03 },
  { id: "b", text: "blue dress", data: {}, score: 0.02 },
];

describe("provider embedders", () => {
  test("delegates Gemini to @samesake/embed", () => {
    expect(geminiEmbedder).toBe(gemini);
  });

  test("delegates Voyage to @samesake/embed", () => {
    expect(voyageEmbedder).toBe(voyage);
  });
});

describe("geminiGenerator", () => {
  test("merges system+prompt, forwards responseJsonSchema, parses JSON text", async () => {
    const { calls } = mockFetch([
      { candidates: [{ content: { parts: [{ text: '{"color":"red"}' }] } }] },
    ]);
    const generate = geminiGenerator({ apiKey: "k" });
    const out = await generate({
      prompt: "parse this",
      system: "you are a parser",
      schema: { type: "object" },
    });
    expect(out).toEqual({ color: "red" });
    const body = calls[0]!.body as {
      contents: { parts: { text?: string }[] }[];
      generationConfig: Record<string, unknown>;
    };
    expect(body.contents[0]!.parts.at(-1)!.text).toBe("you are a parser\n\nparse this");
    expect(body.generationConfig.responseJsonSchema).toEqual({ type: "object" });
    expect(calls[0]!.url).toContain("gemini-3.1-flash-lite:generateContent");
  });
});

describe("geminiParser", () => {
  test("converts the zod schema to JSON Schema before calling generate", async () => {
    const { calls } = mockFetch([
      { candidates: [{ content: { parts: [{ text: '{"name":"ann"}' }] } }] },
    ]);
    const parse = geminiParser({ apiKey: "k" });
    const out = await parse({
      text: "ann",
      schema: z.object({ name: z.string() }),
      instructions: "extract the name",
    });
    expect(out).toEqual({ name: "ann" });
    const cfg = (calls[0]!.body as { generationConfig: { responseJsonSchema: { type: string; properties: Record<string, unknown> } } })
      .generationConfig;
    expect(cfg.responseJsonSchema.type).toBe("object");
    expect(Object.keys(cfg.responseJsonSchema.properties)).toEqual(["name"]);
  });
});

describe("openaiEmbedder", () => {
  test("maps model/dimensions and bearer auth", async () => {
    const { calls } = mockFetch([{ data: [{ embedding: [0.5, 0.5] }] }]);
    const embed = openaiEmbedder({ apiKey: "sk" });
    const v = await embed({ text: "hi", model: "text-embedding-3-small", dim: 2 });
    expect(v).toEqual([0.5, 0.5]);
    const c = calls[0]!;
    expect(c.url).toContain("/embeddings");
    expect(c.headers.authorization).toBe("Bearer sk");
    expect(c.body).toMatchObject({ model: "text-embedding-3-small", input: "hi", dimensions: 2 });
  });

  test("rejects image inputs with a pointer to a multimodal embedder", async () => {
    const embed = openaiEmbedder({ apiKey: "sk" });
    expect(
      embed({ image: { url: "http://x/y.jpg" }, model: "m", dim: 2 })
    ).rejects.toThrow("multimodal");
  });
});

describe("openaiGenerator", () => {
  test("uses json_schema response_format and parses message content", async () => {
    const { calls } = mockFetch([
      { choices: [{ message: { content: '{"ok":true}' } }] },
    ]);
    const generate = openaiGenerator({ apiKey: "sk" });
    const out = await generate({ prompt: "p", schema: { type: "object" } });
    expect(out).toEqual({ ok: true });
    const body = calls[0]!.body as { model: string; response_format: { type: string } };
    expect(body.model).toBe("gpt-4.1-mini");
    expect(body.response_format.type).toBe("json_schema");
  });
});

describe("rerankers", () => {
  test("voyage: maps result indexes back to candidate ids, clamps scores", async () => {
    mockFetch([
      { data: [{ index: 1, relevance_score: 1.2 }, { index: 0, relevance_score: 0.4 }] },
    ]);
    const rerank = voyageReranker({ apiKey: "vk" });
    const out = await rerank({ query: "q", candidates: CANDIDATES, topK: 2 });
    expect(out).toEqual([
      { id: "b", score: 1 },
      { id: "a", score: 0.4 },
    ]);
  });

  test("cohere: maps result indexes back to candidate ids", async () => {
    const { calls } = mockFetch([
      { results: [{ index: 0, relevance_score: 0.9 }] },
    ]);
    const rerank = cohereReranker({ apiKey: "ck" });
    const out = await rerank({ query: "q", candidates: CANDIDATES, topK: 1 });
    expect(out).toEqual([{ id: "a", score: 0.9 }]);
    expect(calls[0]!.body).toMatchObject({
      model: "rerank-v3.5",
      documents: ["red shoes", "blue dress"],
      top_n: 1,
    });
  });
});
