// Embedder: local Ollama (offline / air-gapped / regulated data).
//
// Install: (nothing — uses native fetch)
// Setup:
//   1. Install Ollama: https://ollama.ai
//   2. ollama pull nomic-embed-text       (or mxbai-embed-large, etc.)
// Env:
//   OLLAMA_HOST (optional; default http://localhost:11434)
//
// Models you can declare in your entity config:
//   model: "nomic-embed-text",  dim: 768    ← good general-purpose
//   model: "mxbai-embed-large", dim: 1024   ← stronger
//   model: "all-minilm",        dim: 384    ← fastest / smallest
//
// No data leaves your machine.
import type { EmbedFn } from "@samesake/server";

const HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";

interface OllamaResponse {
  embedding: number[];
}

export const embedFn: EmbedFn = async ({ text, model }) => {
  const r = await fetch(`${HOST}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt: text }),
  });
  if (!r.ok) throw new Error(`ollama ${r.status}: ${await r.text()}`);
  const { embedding } = (await r.json()) as OllamaResponse;
  return embedding;
};
