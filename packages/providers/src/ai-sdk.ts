// Bridge to the Vercel AI SDK (v6): wrap any AI SDK model object into
// samesake's BYO closures — the whole AI SDK provider ecosystem plugs into
// the matcher without hand-written glue.
//
//   import { google } from "@ai-sdk/google";
//   import { aiSdkEmbedder, aiSdkGenerator } from "@samesake/providers/ai-sdk";
//
//   createMatcher({
//     embed: aiSdkEmbedder(google.textEmbedding("gemini-embedding-2"), {
//       providerOptions: ({ dim, taskType }) => ({
//         google: { outputDimensionality: dim, ...(taskType ? { taskType } : {}) },
//       }),
//     }),
//     generate: aiSdkGenerator(google("gemini-2.5-flash-lite")),
//   });
//
// This module lives on its own subpath so the core adapters stay
// dependency-free; `ai` is an optional peer dependency. Note the AI SDK's
// embed() is text-only — for image spaces use a multimodal native adapter
// (geminiEmbedder) or BYO.
import { embed, generateObject, jsonSchema, rerank } from "ai";
import type { EmbeddingModel, LanguageModel, ModelMessage, RerankingModel } from "ai";
import type { EmbedFn, EmbedRequest, GenerateFn, ParseFn, RerankFn } from "@samesake/server";

type EmbedProviderOptions = Parameters<typeof embed>[0]["providerOptions"];
type JsonSchemaInput = Parameters<typeof jsonSchema>[0];

export interface AiSdkEmbedderOptions {
  /**
   * Map an embed request to AI SDK providerOptions — the place to forward
   * provider-specific knobs like Gemini's outputDimensionality/taskType.
   */
  providerOptions?: (req: EmbedRequest) => EmbedProviderOptions;
}

export function aiSdkEmbedder(model: EmbeddingModel, opts: AiSdkEmbedderOptions = {}): EmbedFn {
  return async (req) => {
    if (req.image) {
      throw new Error(
        "[@samesake/providers] aiSdkEmbedder: the AI SDK embed() is text-only — use a multimodal embedder (e.g. geminiEmbedder) for image spaces"
      );
    }
    const { embedding } = await embed({
      model,
      value: req.text ?? "",
      providerOptions: opts.providerOptions?.(req),
    });
    return Array.from(embedding);
  };
}

export function aiSdkGenerator(model: LanguageModel): GenerateFn {
  return async ({ prompt, system, schema, images }) => {
    const content: Array<
      { type: "text"; text: string } | { type: "image"; image: Uint8Array | string; mediaType?: string }
    > = [];
    for (const img of images ?? []) {
      content.push({ type: "image", image: img.data, mediaType: img.mimeType });
    }
    content.push({ type: "text", text: prompt });
    const messages: ModelMessage[] = [{ role: "user", content }];

    const { object } = await generateObject({
      model,
      system,
      messages,
      temperature: 0,
      schema: jsonSchema(schema as JsonSchemaInput),
    });
    return object;
  };
}

/** Entity-parse seam — generateObject takes the zod schema natively. */
export function aiSdkParser(model: LanguageModel): ParseFn {
  return async ({ text, schema, instructions }) => {
    const { object } = await generateObject({
      model,
      system: instructions,
      prompt: `Input: "${text}"`,
      temperature: 0,
      schema,
    });
    return object;
  };
}

export function aiSdkReranker(model: RerankingModel): RerankFn {
  return async ({ query, candidates, topK }) => {
    const { ranking } = await rerank({
      model,
      query,
      documents: candidates.map((c) => c.text),
      topN: topK,
    });
    return ranking.map((r) => ({
      id: candidates[r.originalIndex]!.id,
      score: Math.min(1, Math.max(0, r.score)),
    }));
  };
}
