// Text-only Gemini wrappers — the embed + generate functions samesake and the
// extraction/normalization layers call. Same provider the fashion example uses
// (gemini-embedding-2 @ 1536, gemini-3.1-flash-lite for generation).
import type { EmbedFn, GenerateFn } from "@samesake/server";

export const EMB_MODEL = "gemini-embedding-2";
export const GEN_MODEL = "gemini-3.1-flash-lite";
export const EMB_DIM = 1536;

// Read the key at call time, not module-load time — config.loadEnv() runs after
// this module is first imported.
function apiKey(): string {
  const k = process.env.GEMINI_API_KEY;
  if (!k) throw new Error("GEMINI_API_KEY missing");
  return k;
}

async function callGenerate(
  prompt: string,
  schema: Record<string, unknown>,
  system?: string,
  retries = 6
): Promise<unknown> {
  const KEY = apiKey();
  const parts = [{ text: (system ? `${system}\n\n` : "") + prompt }];
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEN_MODEL}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: { temperature: 0.1, responseMimeType: "application/json", responseJsonSchema: schema },
          }),
          signal: AbortSignal.timeout(120000),
        }
      );
      if (res.status === 429 || res.status >= 500) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = (await res.json()) as { candidates: { content: { parts: { text: string }[] } }[] };
      return JSON.parse(data.candidates[0]!.content.parts[0]!.text);
    } catch (e) {
      if (i === retries - 1) throw e;
      const status = (e as { status?: number }).status;
      await new Promise((r) => setTimeout(r, (status === 429 ? 15000 : 4000) * (i + 1)));
    }
  }
  throw new Error("unreachable");
}

async function callEmbed(text: string, query: boolean, dim: number, retries = 6): Promise<number[]> {
  const KEY = apiKey();
  const taskType = query ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT";
  const url = query
    ? `https://generativelanguage.googleapis.com/v1beta/models/${EMB_MODEL}:embedContent`
    : `https://generativelanguage.googleapis.com/v1beta/models/${EMB_MODEL}:batchEmbedContents`;
  const body = query
    ? { model: `models/${EMB_MODEL}`, content: { parts: [{ text }] }, taskType, outputDimensionality: dim }
    : { requests: [{ model: `models/${EMB_MODEL}`, content: { parts: [{ text }] }, taskType, outputDimensionality: dim }] };
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
      });
      if (res.status === 429 || res.status >= 500) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = (await res.json()) as { embedding?: { values: number[] }; embeddings?: { values: number[] }[] };
      const v = query ? data.embedding!.values : data.embeddings![0]!.values;
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return v.map((x) => x / norm);
    } catch (e) {
      if (i === retries - 1) throw e;
      const status = (e as { status?: number }).status;
      await new Promise((r) => setTimeout(r, (status === 429 ? 20000 : 5000) * (i + 1)));
    }
  }
  throw new Error("unreachable");
}

export const geminiEmbed: EmbedFn = async ({ text, dim, taskType, inputType }) => {
  if (!text) throw new Error("embed requires text");
  if (dim !== EMB_DIM) throw new Error(`expected dim ${EMB_DIM}, got ${dim}`);
  const query = taskType === "RETRIEVAL_QUERY" || inputType === "query";
  return callEmbed(text, query, dim);
};

export const geminiGenerate: GenerateFn = async ({ prompt, system, schema }) => {
  return callGenerate(String(prompt ?? ""), (schema ?? { type: "object" }) as Record<string, unknown>, system);
};

/** Direct structured generation for the extraction + normalization layers. */
export async function generateStructured<T>(prompt: string, schema: Record<string, unknown>, system?: string): Promise<T> {
  return (await callGenerate(prompt, schema, system)) as T;
}
