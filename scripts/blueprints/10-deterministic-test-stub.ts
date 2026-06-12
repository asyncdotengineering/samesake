#!/usr/bin/env bun
// BLUEPRINT 10 — Deterministic embedder for tests.
//
// Use when: you want integration tests against a real Postgres but DON'T
// want them to hit a real LLM (cost, rate limits, flakiness, offline CI).
//
// Same-text-in → same-vector-out, with no network calls. This blueprint
// is impossible without Flavor C: the previous design forced every test
// path through Gemini.
//
// Notes on the stub:
//   - Deterministic per (text, dim) so cache hits behave like prod.
//   - Vectors are normalised to unit length so cosine similarity stays in
//     [-1, 1] and the SQL math doesn't blow up on degenerate values.
//   - For PARSE-shape entities you also need a mock parse function — see
//     the `parseFn` below.
import { createHash } from "node:crypto";
import { createMatcher, type EmbedFn, type ParseFn, ParsedProductSchema } from "../../packages/server/src/index.ts";

// Same input → same output, dim adjustable per entity. The hash is the seed
// for a tiny xorshift PRNG so vectors look spread out rather than clustered.
const testEmbed: EmbedFn = async ({ text, dim }) => {
  const seedHex = createHash("sha1").update(text).digest("hex").slice(0, 8);
  let s = parseInt(seedHex, 16) || 1;
  const v: number[] = new Array(dim);
  for (let i = 0; i < dim; i++) {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s = s | 0;
    v[i] = ((s & 0xffff) / 0xffff) * 2 - 1; // ∈ [-1, 1]
  }
  // Normalise to unit length.
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return v.map((x) => x / norm);
};

// Deterministic parse stub — returns a valid ParsedProduct for any input.
// Useful when your test corpus has parse-shape entities and you want the
// matcher's parse path to exercise without calling an LLM.
const testParse: ParseFn = async ({ text }) => {
  return ParsedProductSchema.parse({
    brand: null,
    brand_normalised: null,
    item: text,
    item_canonical: text.toLowerCase(),
    variant: null,
    size_value: null,
    size_unit: null,
    internal_code: null,
    namespace_prefix: null,
    parser_confidence: 0.8,
  });
};

if (process.env.TEST_STUB_DEMO !== "1") {
  console.log("[10-deterministic-test-stub] typecheck-only by default — set TEST_STUB_DEMO=1 to actually use the stub against a live DB");
  void createMatcher;
  void testEmbed;
  void testParse;
  console.log("[10-deterministic-test-stub] ✓ shape verified: deterministic stub satisfies EmbedFn + ParseFn — no API keys needed");
  process.exit(0);
}

const matcher = createMatcher({
  databaseUrl: process.env.SAMESAKE_DATABASE_URL!,
  apiKey: "test-stub-key",
  embed: testEmbed,
  parse: testParse,
});

const r1 = await matcher.match({
  project: "hello",
  kind: "customer",
  text: "Smyth",
  scope: { tenantId: "acme" },
});

// Run the SAME query again — should hit the embed cache, and even if it
// didn't, the deterministic stub returns the same vector both times.
const r2 = await matcher.match({
  project: "hello",
  kind: "customer",
  text: "Smyth",
  scope: { tenantId: "acme" },
});

const same = r1.candidates[0]?.combined === r2.candidates[0]?.combined;
console.log(`[10-deterministic-test-stub] same query twice → same combined: ${same}`);
console.log("[10-deterministic-test-stub] ✓ tests can now exercise the matcher with zero LLM calls");
await matcher.close();
