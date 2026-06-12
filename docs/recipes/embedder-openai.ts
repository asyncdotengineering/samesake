// Embedder: Vercel AI SDK + OpenAI.
//
// Install: bun add ai @ai-sdk/openai
// Env:     OPENAI_API_KEY
//
// Models you can declare in your entity config:
//   model: "text-embedding-3-small", dim: 1536   ← cheap default
//   model: "text-embedding-3-small", dim: 768    ← truncated for storage
//   model: "text-embedding-3-large", dim: 3072   ← strongest
import { embed } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { EmbedFn } from "@samesake/server";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY ?? "",
});

export const embedFn: EmbedFn = async ({ text, model, dim }) => {
  const { embedding } = await embed({
    model: openai.textEmbedding(model),
    value: text,
    providerOptions: {
      // OpenAI's text-embedding-3-* support output-dimension truncation
      // (Matryoshka). Pass `dimensions` to truncate. Ada-002 ignores it.
      openai: { dimensions: dim },
    },
  });
  return Array.from(embedding);
};
