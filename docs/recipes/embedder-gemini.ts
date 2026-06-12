// Embedder: Vercel AI SDK + Google Gemini.
//
// Install: bun add ai @ai-sdk/google
// Env:     GOOGLE_GENERATIVE_AI_API_KEY
//
// Models you can declare in your entity config:
//   model: "gemini-embedding-001", dim: 768   ← cheap, fast, multilingual
//   model: "text-embedding-004",   dim: 768   ← previous gen
import { embed } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { EmbedFn } from "@samesake/server";

const google = createGoogleGenerativeAI({
  apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? "",
});

export const embedFn: EmbedFn = async ({ text, model, dim, taskType }) => {
  const { embedding } = await embed({
    model: google.textEmbedding(model),
    value: text,
    providerOptions: {
      google: {
        outputDimensionality: dim,
        taskType: taskType ?? "SEMANTIC_SIMILARITY",
        // Other taskType options: "RETRIEVAL_QUERY" / "RETRIEVAL_DOCUMENT"
        // / "CLASSIFICATION" / "CLUSTERING" / "QUESTION_ANSWERING".
      },
    },
  });
  return Array.from(embedding);
};
