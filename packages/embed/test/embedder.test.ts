import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { EmbedFn, EmbedRequest } from "@samesake/core";
import { gemini, voyage } from "../src/index.ts";

// Every test mocks globalThis.fetch — no live API calls, no network.
const originalFetch = globalThis.fetch;
const originalGeminiKey = process.env.GEMINI_API_KEY;
const originalVoyageKey = process.env.VOYAGE_API_KEY;

beforeAll(() => {
  process.env.GEMINI_API_KEY = "test-gemini-key";
  process.env.VOYAGE_API_KEY = "test-voyage-key";
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});
afterAll(() => {
  process.env.GEMINI_API_KEY = originalGeminiKey;
  process.env.VOYAGE_API_KEY = originalVoyageKey;
});

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Install a fetch mock that returns `responses` in order (last one repeats); returns the capture slot. */
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
        ]),
      ),
      body: init?.body ? JSON.parse(String(init.body)) : {},
    });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return new Response(JSON.stringify(r), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls };
}

function req(dim: number, text = "hello", taskType?: string): EmbedRequest {
  return { text, model: "gemini-embedding-2", dim, ...(taskType ? { taskType } : {}) };
}

describe("gemini embedder", () => {
  test("caps: multimodal, dim-flexible, maxBatch 100", () => {
    const e = gemini();
    expect(e.caps.image).toBe(true);
    expect(e.caps.interleaved).toBe(true);
    expect(e.caps.dims).toBe("any");
    expect(e.caps.maxBatch).toBe(100);
  });

  test("caps is frozen (immutable for the lifetime of the embedder)", () => {
    const e = gemini();
    expect(Object.isFrozen(e.caps)).toBe(true);
    expect(() => {
      (e.caps as { maxBatch: number }).maxBatch = 999;
    }).toThrow();
  });

  test("an Embedder is assignable to EmbedFn (drop-in for createSearch / createEnricher)", () => {
    const e: EmbedFn = gemini();
    expect(typeof e).toBe("function");
  });

  test("single form returns number[] of length req.dim and hits :embedContent once", async () => {
    const { calls } = mockFetch([{ embedding: { values: [0, 1, 2, 3] } }]);
    const v = await gemini()(req(4));
    expect(Array.isArray(v)).toBe(true);
    expect(v).toEqual([0, 1, 2, 3]);
    expect(v.length).toBe(4);
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toContain(":embedContent");
    expect(calls[0]!.url).not.toContain(":batchEmbedContents");
    expect(calls[0]!.headers["x-goog-api-key"]).toBe("test-gemini-key");
    expect(calls[0]!.body.outputDimensionality).toBe(4);
  });

  test("single form: per-request taskType overrides the factory default", async () => {
    const { calls } = mockFetch([{ embedding: { values: [0.1] } }]);
    await gemini({ taskType: "RETRIEVAL_DOCUMENT" })(req(1, "q", "RETRIEVAL_QUERY"));
    expect(calls[0]!.body.taskType).toBe("RETRIEVAL_QUERY");
  });

  test("single form: factory taskType applies when the request omits it", async () => {
    const { calls } = mockFetch([{ embedding: { values: [0.1] } }]);
    await gemini({ taskType: "RETRIEVAL_DOCUMENT" })(req(1, "q"));
    expect(calls[0]!.body.taskType).toBe("RETRIEVAL_DOCUMENT");
  });

  test("multimodal single: image.bytes → inline_data, no network fetch for bytes path", async () => {
    const { calls } = mockFetch([{ embedding: { values: [0.2, 0.3] } }]);
    const v = await gemini()({
      image: { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" },
      model: "gemini-embedding-2",
      dim: 2,
    });
    expect(v).toEqual([0.2, 0.3]);
    expect(calls.length).toBe(1); // the embed call only — no image fetch
    const part = (calls[0]!.body as { content: { parts: unknown[] } }).content.parts[0];
    // btoa("\x01\x02\x03") === "AQID"
    expect(part).toEqual({ inline_data: { mime_type: "image/png", data: "AQID" } });
  });

  test("many: order-preserved number[][], chunks to maxBatch (100) → ceil(N/100) batch calls", async () => {
    const N = 250; // ceil(250/100) === 3 batch calls
    const reqs = Array.from({ length: N }, (_, i) => req(2, `d${i}`));
    let callIdx = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as { requests: unknown[] }) : { requests: [] };
      const count = body.requests.length;
      const base = callIdx * 1000;
      const embeddings = Array.from({ length: count }, (_, j) => ({ values: [base + j, 1] }));
      callIdx++;
      expect(String(input)).toContain(":batchEmbedContents");
      return new Response(JSON.stringify({ embeddings }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const out = await gemini().many(reqs);
    expect(out.length).toBe(N);
    expect(callIdx).toBe(3); // exactly ceil(250/100) batch calls — not N single calls
    for (let i = 0; i < N; i++) expect(out[i]!.length).toBe(2);
    // order preserved across chunk boundaries
    expect(out[0]).toEqual([0, 1]); // chunk 0, item 0
    expect(out[99]).toEqual([99, 1]); // chunk 0, item 99
    expect(out[100]).toEqual([1000, 1]); // chunk 1, item 0
    expect(out[249]).toEqual([2049, 1]); // chunk 2, item 49
  });

  test("many: a sub-maxBatch slice issues exactly one batch call, not N single calls", async () => {
    const { calls } = mockFetch([
      { embeddings: [{ values: [1] }, { values: [2] }, { values: [3] }] },
    ]);
    const out = await gemini().many([req(1, "a"), req(1, "b"), req(1, "c")]);
    expect(out).toEqual([[1], [2], [3]]);
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toContain(":batchEmbedContents");
  });

  test("many: forwards per-request dim/taskType into each batch entry", async () => {
    const { calls } = mockFetch([
      { embeddings: [{ values: [0.1, 0.2] }, { values: [0.3, 0.4] }] },
    ]);
    await gemini().many([
      { text: "a", model: "gemini-embedding-2", dim: 2, taskType: "RETRIEVAL_DOCUMENT" },
      { text: "b", model: "gemini-embedding-2", dim: 2 },
    ]);
    const entries = (calls[0]!.body as { requests: { outputDimensionality: number; taskType?: string }[] })
      .requests;
    expect(entries[0]!.outputDimensionality).toBe(2);
    expect(entries[0]!.taskType).toBe("RETRIEVAL_DOCUMENT");
    expect(entries[1]!.outputDimensionality).toBe(2);
    expect(entries[1]!.taskType).toBeUndefined();
  });

  test("single: dim mismatch throws a diagnostic, never returns a wrong-size vector", async () => {
    mockFetch([{ embedding: { values: [1, 2, 3] } }]); // asked for dim 4, got 3
    await expect(gemini()(req(4))).rejects.toThrow(/dimension mismatch/i);
  });

  test("many: dim mismatch throws a diagnostic", async () => {
    mockFetch([{ embeddings: [{ values: [1, 2, 3] }] }]); // asked dim 4, got 3
    await expect(gemini().many([req(4)])).rejects.toThrow(/dimension mismatch/i);
  });

  test("throws a clear error when no API key is available", async () => {
    const prev = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      await expect(gemini()(req(1))).rejects.toThrow("GEMINI_API_KEY");
    } finally {
      process.env.GEMINI_API_KEY = prev;
    }
  });
});

describe("voyage embedder (provider-neutrality + capability-honesty proof)", () => {
  test("caps: text-only (image false)", () => {
    const e = voyage();
    expect(e.caps.image).toBe(false);
    expect(e.caps.interleaved).toBe(false);
    expect(e.caps.maxBatch).toBeGreaterThan(0);
  });

  test("single form throws when handed an image (does not silently embed empty text)", async () => {
    await expect(
      voyage()({ image: { url: "https://x/y.jpg" }, model: "voyage-3.5", dim: 2 }),
    ).rejects.toThrow(/image/i);
  });

  test("many form throws when any req in the batch carries an image", async () => {
    await expect(
      voyage().many([
        { text: "ok", model: "voyage-3.5", dim: 2 },
        { image: { url: "https://x/y.jpg" }, model: "voyage-3.5", dim: 2 },
      ]),
    ).rejects.toThrow(/image/i);
  });

  test("text single form: routes to /embeddings with bearer auth + output_dimension", async () => {
    const { calls } = mockFetch([{ data: [{ embedding: [0.5, 0.5] }] }]);
    const v = await voyage()({
      text: "q",
      model: "voyage-3.5",
      dim: 2,
      inputType: "query",
    });
    expect(v).toEqual([0.5, 0.5]);
    expect(calls[0]!.url).toContain("/embeddings");
    expect(calls[0]!.headers.authorization).toBe("Bearer test-voyage-key");
    expect(calls[0]!.body).toMatchObject({
      model: "voyage-3.5",
      input: ["q"],
      output_dimension: 2,
      input_type: "query",
    });
  });

  test("text many form: one batched /embeddings call carries the input array", async () => {
    const { calls } = mockFetch([
      { data: [{ embedding: [1] }, { embedding: [2] }] },
    ]);
    const out = await voyage().many([
      { text: "a", model: "voyage-3.5", dim: 1 },
      { text: "b", model: "voyage-3.5", dim: 1 },
    ]);
    expect(out).toEqual([[1], [2]]);
    expect(calls.length).toBe(1);
    expect(calls[0]!.body).toMatchObject({ input: ["a", "b"] });
  });
});
