// Gemini adapters (Generative Language API, plain fetch).
// gemini-embedding-2 is multimodal: text and images land in the same space,
// so a text query and a product image are directly comparable.
import type { EmbedFn, GenerateFn, ParseFn } from "@samesake/server";
import { z } from "zod";
import {
  type ProviderOptions,
  fail,
  fetchWithRetry,
  imageToBase64,
  makeThrottle,
  resolveKey,
} from "./shared.ts";

const BASE = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_EMBED_MODEL = "gemini-embedding-2";
const DEFAULT_GENERATE_MODEL = "gemini-3.1-flash-lite";

export function geminiEmbedder(opts: ProviderOptions = {}): EmbedFn {
  const throttle = makeThrottle(opts.minIntervalMs);
  return async ({ text, image, model, dim, taskType }) => {
    await throttle();
    const key = resolveKey(opts, "GEMINI_API_KEY", "gemini");
    const m = model || opts.model || DEFAULT_EMBED_MODEL;

    let part: { text?: string; inline_data?: { mime_type: string; data: string } };
    if (image && (image.bytes || image.url)) {
      const { b64, mimeType } = await imageToBase64(image);
      part = { inline_data: { mime_type: mimeType, data: b64 } };
    } else {
      part = { text: text ?? "" };
    }

    const res = await fetchWithRetry(
      `${opts.baseUrl ?? BASE}/models/${m}:embedContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          model: `models/${m}`,
          content: { parts: [part] },
          outputDimensionality: dim,
          ...(taskType ? { taskType } : {}),
        }),
      },
      opts.retries
    );
    if (!res.ok) await fail(res, "gemini embed");
    const data = (await res.json()) as { embedding?: { values: number[] } };
    if (!data.embedding?.values) throw new Error("[@samesake/providers] gemini embed: no values");
    return data.embedding.values;
  };
}

export function geminiGenerator(opts: ProviderOptions = {}): GenerateFn {
  return async ({ prompt, system, schema, images, model }) => {
    const key = resolveKey(opts, "GEMINI_API_KEY", "gemini");
    const m = model || opts.model || DEFAULT_GENERATE_MODEL;

    const parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }> = [];
    for (const img of images ?? []) {
      const data = typeof img.data === "string" ? img.data : Buffer.from(img.data).toString("base64");
      parts.push({ inline_data: { mime_type: img.mimeType, data } });
    }
    parts.push({ text: system ? `${system}\n\n${prompt}` : prompt });

    const res = await fetchWithRetry(
      `${opts.baseUrl ?? BASE}/models/${m}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            temperature: 0,
            responseMimeType: "application/json",
            // samesake hands us standard JSON Schema (it converts zod for us), so use
            // Gemini's responseJsonSchema rather than the OpenAPI-dialect responseSchema.
            ...(schema ? { responseJsonSchema: schema } : {}),
          },
        }),
        signal: AbortSignal.timeout(60000),
      },
      opts.retries
    );
    if (!res.ok) await fail(res, "gemini generate");
    const data = (await res.json()) as { candidates: { content: { parts: { text: string }[] } }[] };
    return JSON.parse(data.candidates[0]!.content.parts[0]!.text);
  };
}

/** Entity-parse seam: same call as the generator, but the schema arrives as zod. */
export function geminiParser(opts: ProviderOptions = {}): ParseFn {
  const generate = geminiGenerator(opts);
  return async ({ text, schema, instructions, model }) =>
    generate({
      prompt: `Input: "${text}"`,
      system: instructions,
      schema: z.toJSONSchema(schema) as Record<string, unknown>,
      model,
    });
}
