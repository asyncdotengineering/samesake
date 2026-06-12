#!/usr/bin/env bun
// BLUEPRINT 1 — In-process, no HTTP server.
//
// Use when: your consumer is TypeScript/JavaScript in the same process
// (e.g., a CF Workers handler, a Bun script, an internal job runner).
// Fastest path — bypasses HTTP serialization, no auth header check,
// same heap as your caller.
import { createMatcher } from "../../packages/server/src/index.ts";
import { blueprintEmbed, blueprintParse } from "./_embedder.ts";

const matcher = createMatcher({
  databaseUrl: process.env.SAMESAKE_DATABASE_URL!,
  apiKey: "in-process-key-not-checked-on-function-calls",
  embed: blueprintEmbed,
  parse: blueprintParse,
});

await matcher.migrate();

// Call any service method directly. Fully typed inputs + outputs.
const result = await matcher.match({
  project: "hello",
  kind: "customer",
  text: "Smyth",
  scope: { tenantId: "acme" },
  opts: { limit: 3 },
});

console.log(`[01-in-process] top match: ${result.candidates[0]?.name} (${result.candidates[0]?.combined.toFixed(3)})`);
if (!result.candidates[0]) {
  console.error("BLUEPRINT FAILED — no candidate");
  process.exit(1);
}
console.log("[01-in-process] ✓ in-process function call works without any HTTP server");
await matcher.close();
