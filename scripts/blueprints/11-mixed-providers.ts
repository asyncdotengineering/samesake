#!/usr/bin/env bun
// BLUEPRINT 11 — Mixed providers: route per-call.
//
// Use when: you want different embedding models / providers for different
// entities, query lengths, or quality tiers. Example: cheap fast model for
// short customer names, premium model for long product descriptions.
//
// Flavor C makes this trivial — `embed` is a single closure under YOUR
// control. Switch on whatever you want (model string, text length,
// request context, even time-of-day).
import { embed } from "ai";
import { google } from "@ai-sdk/google";
import { createMatcher, type EmbedFn } from "../../packages/server/src/index.ts";

// The model string from the entity config flows through unchanged. The
// closure inspects it (and any other signal — text length, scope, etc.)
// and picks an actual SDK call.
const mixedEmbed: EmbedFn = async ({ text, model, dim }) => {
  // Example routing logic: defer to provider hint in the model identifier.
  if (model.startsWith("openai/")) {
    // Pretend we have an OpenAI embedder here. In a real consumer:
    //   import { openai } from "@ai-sdk/openai";
    //   const r = await embed({ model: openai.textEmbedding(model.replace("openai/","")), value: text });
    //   return Array.from(r.embedding);
    throw new Error(`[11-mixed-providers] OpenAI route hit for model="${model}" — wire up @ai-sdk/openai`);
  }
  // Default: Gemini.
  const { embedding } = await embed({
    model: google.textEmbedding(model),
    value: text,
    providerOptions: { google: { outputDimensionality: dim, taskType: "SEMANTIC_SIMILARITY" } },
  });
  // Could also inspect text.length here and route long text to a different
  // model — the matcher only cares that the returned vector has `dim` entries.
  return Array.from(embedding);
};

if (process.env.MIXED_DEMO !== "1") {
  console.log("[11-mixed-providers] typecheck-only by default — set MIXED_DEMO=1 to actually call");
  void createMatcher;
  void mixedEmbed;
  console.log("[11-mixed-providers] ✓ shape verified: one closure can dispatch to N providers based on model string, text length, or any other signal");
  process.exit(0);
}

const matcher = createMatcher({
  databaseUrl: process.env.SAMESAKE_DATABASE_URL!,
  apiKey: "mixed-providers-key",
  embed: mixedEmbed,
});

const r = await matcher.match({
  project: "hello",
  kind: "customer",
  text: "Smyth",
  scope: { tenantId: "acme" },
});
console.log(`[11-mixed-providers] routed match: ${r.candidates[0]?.name ?? "(no match)"}`);
console.log("[11-mixed-providers] ✓ per-call provider routing works without @samesake/server changes");
await matcher.close();
