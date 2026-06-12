#!/usr/bin/env bun
// BLUEPRINT 2 — Standalone Bun server.
//
// Use when: you want a long-lived matcher service running as its own
// process (the apps/matcher pattern). Bun.serve takes the Web-standard
// fetch handler that matcher.fetch implements.
import { createMatcher } from "../../packages/server/src/index.ts";
import { blueprintEmbed, blueprintParse } from "./_embedder.ts";

const matcher = createMatcher({
  databaseUrl: process.env.SAMESAKE_DATABASE_URL!,
  apiKey: process.env.SAMESAKE_API_KEY ?? "dev-key-please-change",
  embed: blueprintEmbed,
  parse: blueprintParse,
  migrate: "eager", // warm migrations before serving the first request
});

const PORT = Number(process.env.BLUEPRINT_PORT ?? 13001);
const server = Bun.serve({ port: PORT, fetch: matcher.fetch });
console.log(`[02-standalone-bun] listening on http://localhost:${PORT}`);

// Verify by self-call (simulates an external client).
try {
  const r = await fetch(`http://localhost:${PORT}/v1/healthz`);
  if (!r.ok) throw new Error(`healthz returned ${r.status}`);
  const body = (await r.json()) as { status: string; extensions: string[] };
  console.log(`[02-standalone-bun] healthz: ${body.status} (${body.extensions.length} extensions)`);
  console.log("[02-standalone-bun] ✓ Bun.serve(matcher.fetch) works");
} finally {
  server.stop();
  await matcher.close();
}
