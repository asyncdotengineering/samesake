// OpenAI adapters (plain fetch). Text-only embeddings; the generator accepts
// images as data URLs for vision-capable models.
import type { EmbedFn, GenerateFn, ParseFn } from "@samesake/server";
import { z } from "zod";
import {
  type ProviderOptions,
  fail,
  fetchWithRetry,
  makeThrottle,
  resolveKey,
  toBase64,
} from "./shared.ts";

const BASE = "https://api.openai.com/v1";
const DEFAULT_EMBED_MODEL = "text-embedding-3-small";
const DEFAULT_GENERATE_MODEL = "gpt-4.1-mini";

export function openaiEmbedder(opts: ProviderOptions = {}): EmbedFn {
  const throttle = makeThrottle(opts.minIntervalMs);
  return async ({ text, image, model, dim }) => {
    if (image) {
      throw new Error(
        "[@samesake/providers] openai embed: image embeddings are not supported — use a multimodal embedder (e.g. geminiEmbedder) for image spaces"
      );
    }
    await throttle();
    const key = resolveKey(opts, "OPENAI_API_KEY", "openai");
    const res = await fetchWithRetry(
      `${opts.baseUrl ?? BASE}/embeddings`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: model || opts.model || DEFAULT_EMBED_MODEL,
          input: text ?? "",
          dimensions: dim,
        }),
      },
      opts.retries
    );
    if (!res.ok) await fail(res, "openai embed");
    const data = (await res.json()) as { data?: { embedding: number[] }[] };
    if (!data.data?.[0]?.embedding) throw new Error("[@samesake/providers] openai embed: no embedding");
    return data.data[0].embedding;
  };
}

export function openaiGenerator(opts: ProviderOptions = {}): GenerateFn {
  return async ({ prompt, system, schema, images, model }) => {
    const key = resolveKey(opts, "OPENAI_API_KEY", "openai");

    const content: Array<
      { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
    > = [];
    for (const img of images ?? []) {
      content.push({
        type: "image_url",
        image_url: { url: `data:${img.mimeType};base64,${toBase64(img.data)}` },
      });
    }
    content.push({ type: "text", text: prompt });

    const res = await fetchWithRetry(
      `${opts.baseUrl ?? BASE}/chat/completions`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: model || opts.model || DEFAULT_GENERATE_MODEL,
          temperature: 0,
          messages: [
            ...(system ? [{ role: "system", content: system }] : []),
            { role: "user", content },
          ],
          response_format: schema
            ? { type: "json_schema", json_schema: { name: "output", schema } }
            : { type: "json_object" },
        }),
        signal: AbortSignal.timeout(60000),
      },
      opts.retries
    );
    if (!res.ok) await fail(res, "openai generate");
    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    return JSON.parse(data.choices[0]!.message.content);
  };
}

/** Entity-parse seam: same call as the generator, but the schema arrives as zod. */
export function openaiParser(opts: ProviderOptions = {}): ParseFn {
  const generate = openaiGenerator(opts);
  return async ({ text, schema, instructions, model }) =>
    generate({
      prompt: `Input: "${text}"`,
      system: instructions,
      schema: z.toJSONSchema(schema) as Record<string, unknown>,
      model,
    });
}
