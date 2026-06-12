// Embedder: Voyage AI (no SDK — raw fetch).
//
// Install: (nothing — uses native fetch)
// Env:     VOYAGE_API_KEY
//
// Models you can declare in your entity config:
//   model: "voyage-3-large", dim: 1024    ← strongest multilingual
//   model: "voyage-3",       dim: 1024    ← cheaper
//   model: "voyage-3-lite",  dim: 512     ← fastest
//
// Voyage cares about `input_type` — query vs document. samesake passes
// "query" at match time and "document" at upsert time.
import type { EmbedFn } from "@samesake/server";

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";

interface VoyageResponse {
  data: Array<{ embedding: number[] }>;
}

export const embedFn: EmbedFn = async ({ text, model, dim, inputType }) => {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) throw new Error("VOYAGE_API_KEY not set");

  const body: Record<string, unknown> = {
    input: [text],
    model,
    output_dimension: dim,
  };
  if (inputType) body.input_type = inputType;

  const r = await fetch(VOYAGE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`voyage ${r.status}: ${await r.text()}`);
  const json = (await r.json()) as VoyageResponse;
  const first = json.data[0];
  if (!first) throw new Error("voyage: empty response");
  return first.embedding;
};
