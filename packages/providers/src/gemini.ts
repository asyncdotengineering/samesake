// Gemini adapters (Generative Language API, plain fetch).
// gemini-embedding-2 is multimodal: text and images land in the same space,
// so a text query and a product image are directly comparable.
import type { GenerateFn, ParseFn } from "@samesake/server";
import { z } from "zod";
import {
  type ProviderOptions,
  fail,
  fetchWithRetry,
  resolveKey,
} from "./shared.ts";

const BASE = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_GENERATE_MODEL = "gemini-3.1-flash-lite";

export { gemini as geminiEmbedder } from "@samesake/embed";

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
