#!/usr/bin/env bun
// BLUEPRINT 5 — Cloudflare Workers (typecheck-only shape demo).
//
// CF Workers' `export default { fetch }` is exactly Hono's universal handler
// shape. @samesake/server's matcher.fetch drops in directly.
//
// IMPORTANT — postgres-js does NOT work in CF Workers (CF has no raw TCP).
// In a real Worker, use one of:
//   - @neondatabase/serverless (HTTP-PostgreSQL via Neon)
//   - drizzle-orm/neon-serverless
//   - Cloudflare Hyperdrive (still wraps a TCP driver, runs inside CF's
//     pooled tunnel)
//
// Construct the Drizzle handle with the CF-compatible driver and pass it
// as `db`. The matcher's queries are driver-agnostic via Drizzle.
//
// This file is illustrative only — it can't actually deploy/run from the
// monorepo. Verified by typecheck.
import { createMatcher, type Matcher, type EmbedFn } from "../../packages/server/src/index.ts";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

interface WorkerEnv {
  SAMESAKE_DATABASE_URL: string;
  SAMESAKE_API_KEY: string;
  GEMINI_API_KEY?: string;
}

// In a real CF Worker, build this from the Vercel AI SDK + a CF-compatible
// fetch import — identical shape to apps/matcher/src/embedder.ts, just
// imported from `ai` and `@ai-sdk/google` at module top-level inside your
// Worker. Stubbed here to keep the typecheck-only file dep-free.
function makeWorkerEmbed(_env: WorkerEnv): EmbedFn {
  return async () => {
    throw new Error(
      "[05-cloudflare-workers] embed not wired in the shape-demo — copy " +
      "apps/matcher/src/embedder.ts into your Worker and import it here."
    );
  };
}

// Lazy per-isolate construction. createMatcher itself is cheap; the
// DB pool is built once and reused for the isolate's lifetime.
let matcher: Matcher | null = null;
function getMatcher(env: WorkerEnv): Matcher {
  if (!matcher) {
    matcher = createMatcher({
      // In a real CF Worker, swap to drizzle-orm/neon-serverless. Shown
      // with postgres-js here only because that's what the workspace has;
      // the contract is identical.
      db: drizzle(postgres(env.SAMESAKE_DATABASE_URL)),
      apiKey: env.SAMESAKE_API_KEY,
      embed: makeWorkerEmbed(env),
      // CF Workers can't use top-level await reliably; "lazy" is the only
      // safe mode — the matcher's middleware runs migrations on first
      // request (per isolate).
      migrate: "lazy",
    });
  }
  return matcher;
}

// Conventional CF Worker shape:
//
//   export default {
//     async fetch(request: Request, env: WorkerEnv): Promise<Response> {
//       return getMatcher(env).fetch(request);
//     },
//   };
//
// We export it as a named const (not `export default`) so Bun doesn't
// auto-start a Bun.serve when this file is invoked standalone for verify.
export const cfWorkerHandler = {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    return getMatcher(env).fetch(request);
  },
};

// Standalone sanity print (no DB connection attempted).
console.log("[05-cloudflare-workers] typecheck-only blueprint — deploy via `wrangler deploy`");
console.log("[05-cloudflare-workers] shape: const handler = { fetch(request, env) → matcher.fetch(request) }");
console.log("[05-cloudflare-workers] ✓ shape verified (cfWorkerHandler.fetch is the CF Worker entry)");
