// Embedder + parser for the standalone matcher runner.
//
// @samesake/server ships ZERO AI SDK dependencies. The runner is where we
// pick a stack — here, Vercel AI SDK + Google Gemini — and wire it into
// createMatcher's `embed` and `parse` fields.
//
// To swap providers (Voyage, OpenAI, Anthropic, Ollama, sentence-transformers,
// an internal HTTP endpoint, or a deterministic stub for tests): change ONLY
// this file. createMatcher's contract is `(req) => Promise<number[]>` for embed
// and `(req) => Promise<unknown>` for parse — anything that satisfies those
// works without touching @samesake/server or any entity declaration.
import { embed, generateObject } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { EmbedFn, ParseFn } from "@samesake/server";

export function makeGeminiEmbedder(apiKey: string | undefined): EmbedFn {
  if (!apiKey) {
    return async () => {
      throw new Error(
        "[apps/matcher] GOOGLE_GENERATIVE_AI_API_KEY is not set; embedding requests will fail. " +
        "Either set the env var, or swap embedder.ts for a different provider."
      );
    };
  }
  const google = createGoogleGenerativeAI({ apiKey });
  return async ({ text, model, dim, taskType }) => {
    const { embedding } = await embed({
      model: google.textEmbedding(model),
      value: text,
      providerOptions: {
        google: {
          outputDimensionality: dim,
          taskType: taskType ?? "SEMANTIC_SIMILARITY",
        },
      },
    });
    return Array.from(embedding);
  };
}

export function makeGeminiParser(apiKey: string | undefined): ParseFn {
  if (!apiKey) {
    return async () => {
      throw new Error(
        "[apps/matcher] GOOGLE_GENERATIVE_AI_API_KEY is not set; parse requests will fail. " +
        "Either set the env var, or swap embedder.ts for a different provider."
      );
    };
  }
  const google = createGoogleGenerativeAI({ apiKey });
  return async ({ text, schema, instructions, model }) => {
    const { object } = await generateObject({
      model: google.languageModel(model ?? "gemini-2.5-flash-lite"),
      schema,
      system: instructions,
      prompt: `Input: "${text}"`,
      temperature: 0,
    });
    return object;
  };
}
