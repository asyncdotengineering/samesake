// Shared embedder + parser for all blueprints.
//
// Vercel AI SDK + Gemini. Wired ONCE so each blueprint can focus on its
// deployment shape (in-process, mounted-hono, cf-workers, vercel-edge, etc.)
// rather than re-importing AI SDKs.
//
// In a real consumer this code lives in YOUR project — e.g. a small
// `embedder.ts` next to your `createMatcher` call (see
// `examples/bookshop-onboarding/embedder.ts`).
import { embed, generateObject } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { EmbedFn, ParseFn } from "../../packages/server/src/index.ts";

const google = createGoogleGenerativeAI({
  apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? "",
});

export const blueprintEmbed: EmbedFn = async ({ text, model, dim, taskType }) => {
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

export const blueprintParse: ParseFn = async ({ text, schema, instructions, model }) => {
  const { object } = await generateObject({
    model: google.languageModel(model ?? "gemini-2.5-flash-lite"),
    schema,
    system: instructions,
    prompt: `Input: "${text}"`,
    temperature: 0,
  });
  return object;
};
