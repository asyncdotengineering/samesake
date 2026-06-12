#!/usr/bin/env bun
// BLUEPRINT 4 — Mixed mode: same matcher instance, all three surfaces.
//
// Use when: your consumer wants HTTP for external clients (mobile, web)
// AND in-process function calls for hot paths (server-side bulk ops).
// One matcher, one connection pool, one config — exposed through both
// the .fetch handler and the function-level API simultaneously.
import { Hono } from "hono";
import { createMatcher } from "../../packages/server/src/index.ts";
import { blueprintEmbed, blueprintParse } from "./_embedder.ts";

const matcher = createMatcher({
  databaseUrl: process.env.SAMESAKE_DATABASE_URL!,
  apiKey: process.env.SAMESAKE_API_KEY ?? "dev-key-please-change",
  embed: blueprintEmbed,
  parse: blueprintParse,
  migrate: "eager",
});

const app = new Hono();

// Mount HTTP routes for external clients
app.route("/match", matcher.app);

// Add a host route that uses the SAME matcher instance via function call
// — no HTTP roundtrip, no JSON serialization, no auth-header dance.
app.get("/internal/bulk-match", async (c) => {
  // Caller is trusted (internal route); call the matcher in-process directly.
  const result = await matcher.match({
    project: "hello",
    kind: "customer",
    text: c.req.query("q") ?? "Smyth",
    scope: { tenantId: c.req.query("scope") ?? "acme" },
  });
  return c.json({
    via: "in-process function call (no HTTP)",
    topName: result.candidates[0]?.name ?? null,
    combined: result.candidates[0]?.combined ?? null,
  });
});

const PORT = Number(process.env.BLUEPRINT_PORT ?? 13003);
const server = Bun.serve({ port: PORT, fetch: app.fetch });
console.log(`[04-mixed-mode] listening on http://localhost:${PORT}`);

try {
  // 1. External client hits the mounted HTTP route
  const ext = await fetch(`http://localhost:${PORT}/match/v1/healthz`);
  const ext_body = (await ext.json()) as { status: string };
  console.log(`[04-mixed-mode] HTTP route /match/v1/healthz: ${ext_body.status}`);
  // 2. Host route uses the same matcher in-process
  const int = await fetch(`http://localhost:${PORT}/internal/bulk-match?q=Smyth&scope=acme`);
  const int_body = (await int.json()) as { via: string; topName: string };
  console.log(`[04-mixed-mode] internal route → ${int_body.via}, topName=${int_body.topName}`);
  console.log("[04-mixed-mode] ✓ same matcher, HTTP surface + in-process surface — both work");
} finally {
  server.stop();
  await matcher.close();
}
