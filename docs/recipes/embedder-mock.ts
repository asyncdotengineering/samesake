// Embedder: deterministic mock for tests.
//
// Install: (nothing — pure JS + node:crypto)
// Env:     (none)
//
// Same text → same vector. No network, no API keys, no rate limits, no cost.
// Use this in test setups when you want to exercise the matcher's logic
// against a real Postgres without spending money or risking flakes from
// the upstream LLM service.
//
// Vectors are normalised to unit length so cosine similarity stays in
// [-1, 1] and the SQL math behaves like with real embeddings.
import { createHash } from "node:crypto";
import type { EmbedFn, ParseFn } from "@samesake/server";
import { ParsedProductSchema } from "@samesake/server";

export const mockEmbed: EmbedFn = async ({ text, dim }) => {
  const seedHex = createHash("sha1").update(text).digest("hex").slice(0, 8);
  let s = parseInt(seedHex, 16) || 1;
  const v: number[] = new Array(dim);
  for (let i = 0; i < dim; i++) {
    // xorshift32 — deterministic, no external entropy
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s = s | 0;
    v[i] = ((s & 0xffff) / 0xffff) * 2 - 1; // ∈ [-1, 1]
  }
  // Normalise to unit length
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return v.map((x) => x / norm);
};

// Deterministic parse stub — returns a valid ParsedProduct for any input.
// Use when your test corpus has parse-shape entities (medications, products)
// and you want the parse path to exercise without calling an LLM.
export const mockParse: ParseFn = async ({ text }) => {
  return ParsedProductSchema.parse({
    brand: null,
    brand_normalised: null,
    item: text,
    item_canonical: text.toLowerCase().trim(),
    variant: null,
    size_value: null,
    size_unit: null,
    internal_code: null,
    namespace_prefix: null,
    parser_confidence: 0.8,
  });
};
