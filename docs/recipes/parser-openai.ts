// Parser: Vercel AI SDK + OpenAI structured-output.
//
// Install: bun add ai @ai-sdk/openai zod
// Env:     OPENAI_API_KEY
//
// Required only if your entity config declares a `parse:` block. The matcher
// passes you samesake's ParsedProductSchema and the system prompt; you call
// your LLM and return the structured object.
//
// Tweak `model` per-entity via ParseDef.model:
//   parse: { model: "gpt-4o-mini", instructions: "..." }
//   parse: { model: "gpt-4o" }            ← stronger, more expensive
import { generateObject } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { ParseFn } from "@samesake/server";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY ?? "",
});

export const parseFn: ParseFn = async ({ text, schema, instructions, model }) => {
  const { object } = await generateObject({
    model: openai.languageModel(model ?? "gpt-4o-mini"),
    schema,
    system: instructions,
    prompt: `Input: "${text}"`,
    temperature: 0,
  });
  return object;
};
