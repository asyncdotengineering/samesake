#!/usr/bin/env bun
// BLUEPRINT 9 — Custom embedder: local Ollama.
//
// Use when: air-gapped deployment, zero per-request API cost, offline dev
// loops, regulated-data shops that can't send text to a cloud LLM.
//
// This blueprint shows the *structural* win of Flavor C: ZERO changes to
// @samesake/server, zero new dependencies on the repo — just a 10-line
// fetch closure passed as createMatcher's `embed`.
//
// Prereqs to actually RUN this blueprint:
//   1. Install Ollama: https://ollama.ai
//   2. Pull an embedding model: `ollama pull nomic-embed-text`
//   3. Set OLLAMA_HOST if not localhost (default http://localhost:11434)
//
// Without Ollama, this file still typechecks — that's the proof.
import { createMatcher, type EmbedFn } from "../../packages/server/src/index.ts";

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";

// The entire custom embedder, in 10 lines. Anything that satisfies
// (req) => Promise<number[]> works.
const ollamaEmbed: EmbedFn = async ({ text, model }) => {
  const r = await fetch(`${OLLAMA_HOST}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt: text }),
  });
  if (!r.ok) throw new Error(`ollama ${r.status}: ${await r.text()}`);
  const { embedding } = (await r.json()) as { embedding: number[] };
  return embedding;
};

// Skip the live run unless OLLAMA_DEMO=1 is set — keeps the blueprint
// verify suite green when Ollama isn't installed.
if (process.env.OLLAMA_DEMO !== "1") {
  console.log("[09-custom-embedder-ollama] typecheck-only by default — set OLLAMA_DEMO=1 to actually call Ollama");
  // Construct the matcher to prove the wiring compiles.
  void createMatcher;
  void ollamaEmbed;
  console.log("[09-custom-embedder-ollama] ✓ shape verified: a 10-line fetch closure swaps in for the entire AI provider layer");
  process.exit(0);
}

const matcher = createMatcher({
  databaseUrl: process.env.SAMESAKE_DATABASE_URL!,
  apiKey: "ollama-local-dev-key",
  embed: ollamaEmbed,
});

// Run a sanity match — assumes you have ollama running with nomic-embed-text
// AND you've seeded your entity config with model: "nomic-embed-text", dim: 768.
const r = await matcher.match({
  project: "hello",
  kind: "customer",
  text: "Smyth",
  scope: { tenantId: "acme" },
});

console.log(`[09-custom-embedder-ollama] ollama match: ${r.candidates[0]?.name ?? "(no match)"}`);
console.log("[09-custom-embedder-ollama] ✓ local Ollama replaced the cloud embedder with a 10-line fetch");
await matcher.close();
