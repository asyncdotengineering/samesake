#!/usr/bin/env bun
// BLUEPRINT 3 — Mounted inside an existing Hono app.
//
// Use when: you already have a Hono app and want the matcher to live
// at /match (or wherever) inside it. The host app adds its own routes,
// middleware, auth, logger, request-id, etc. The matcher is JUST a
// sub-router.
//
// This is the mounted consumer pattern.
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

// Consumer's host Hono app (with its own custom middleware, logger,
// auth, business routes).
const app = new Hono();

// Custom middleware that runs BEFORE the matcher routes
app.use("/match/*", async (c, next) => {
  const start = Date.now();
  await next();
  console.log(`[03-mounted-hono]   middleware: ${c.req.method} ${c.req.path} → ${Date.now() - start}ms`);
});

// Mount the matcher at /match — every matcher route now lives at /match/v1/...
app.route("/match", matcher.app);

// Consumer's own business routes sit alongside
app.get("/business/hello", (c) => c.json({ from: "samesake host app" }));

const PORT = Number(process.env.BLUEPRINT_PORT ?? 13002);
const server = Bun.serve({ port: PORT, fetch: app.fetch });
console.log(`[03-mounted-hono] listening on http://localhost:${PORT}`);

try {
  // Verify business route works
  const biz = await fetch(`http://localhost:${PORT}/business/hello`);
  console.log(`[03-mounted-hono] business route: ${biz.status} ${await biz.text()}`);
  // Verify mounted matcher route works (note the /match prefix)
  const m = await fetch(`http://localhost:${PORT}/match/v1/healthz`);
  const body = (await m.json()) as { status: string };
  console.log(`[03-mounted-hono] mounted matcher /match/v1/healthz: ${body.status}`);
  console.log("[03-mounted-hono] ✓ matcher mounted as Hono sub-router with host middleware");
} finally {
  server.stop();
  await matcher.close();
}
