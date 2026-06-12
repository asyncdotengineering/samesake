#!/usr/bin/env bun
// BLUEPRINT 6 — Vercel Edge / Next.js route handler (typecheck-only shape demo).
//
// In a Next.js project, this file lives at:
//   app/api/match/[[...path]]/route.ts
//
// The catch-all `[[...path]]` segment lets one handler serve every matcher
// endpoint (/v1/healthz, /v1/projects/:p/match, etc.). Vercel's route
// handlers expect named exports per HTTP method; matcher.fetch handles all
// methods, so we export the same handler under every method we care about.
import { createMatcher, type Matcher } from "../../packages/server/src/index.ts";
import { blueprintEmbed, blueprintParse } from "./_embedder.ts";

let matcher: Matcher | null = null;
function getMatcher(): Matcher {
  if (!matcher) {
    matcher = createMatcher({
      databaseUrl: process.env.MATCHER_DATABASE_URL!,
      apiKey: process.env.MATCHER_API_KEY!,
      embed: blueprintEmbed,
      parse: blueprintParse,
      // Edge runtimes don't support top-level await on first cold start —
      // "lazy" is the right mode (first request awaits via the matcher's
      // middleware).
      migrate: "lazy",
    });
  }
  return matcher;
}

// Conventional Next.js Edge route shape:
//
//   export const runtime = "edge";
//   export const GET = (req: Request) => getMatcher().fetch(req);
//   export const POST = (req: Request) => getMatcher().fetch(req);
//
// We expose them as named exports so the standalone bun run doesn't
// trigger an auto-served default-export.
export const runtime = "edge";
export const GET = (req: Request) => getMatcher().fetch(req);
export const POST = (req: Request) => getMatcher().fetch(req);

console.log("[06-vercel-edge] typecheck-only blueprint — deploy via `vercel deploy`");
console.log("[06-vercel-edge] shape: export const GET/POST = (req) => matcher.fetch(req)");
console.log("[06-vercel-edge] ✓ shape verified");
