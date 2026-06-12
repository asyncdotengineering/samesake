// Parser: Vercel AI SDK + Google Gemini structured-output.
//
// Install: bun add ai @ai-sdk/google zod
// Env:     GOOGLE_GENERATIVE_AI_API_KEY
//
// Required only if your entity config declares a `parse:` block (parse-shape
// entities — medications, inventory products). The matcher passes you
// samesake's ParsedProductSchema and the system prompt; you call your LLM
// and return the structured object.
//
// Tweak `model` per-entity via ParseDef.model:
//   parse: { model: "gemini-2.5-flash-lite", instructions: "..." }
import { generateObject } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { ParseFn } from "@samesake/server";

const google = createGoogleGenerativeAI({
  apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? "",
});

export const parseFn: ParseFn = async ({ text, schema, instructions, model }) => {
  const { object } = await generateObject({
    model: google.languageModel(model ?? "gemini-2.5-flash-lite"),
    schema,
    system: instructions,
    prompt: `Input: "${text}"`,
    temperature: 0, // deterministic extraction
  });
  return object;
};
