#!/usr/bin/env bun
// BLUEPRINT 7 — Plain Node.js via @hono/node-server (typecheck-only shape demo).
//
// Node doesn't have Bun.serve; Hono provides @hono/node-server as the
// adapter. matcher.fetch is the universal handler — the adapter just
// wraps it.
//
// Install in a Node consumer:
//   npm i @samesake/server @hono/node-server
//
// Then:
//   import { serve } from "@hono/node-server";
//   import { createMatcher } from "@samesake/server";
//
//   const matcher = createMatcher({
//     databaseUrl: process.env.SAMESAKE_DATABASE_URL!,
//     apiKey: process.env.SAMESAKE_API_KEY!,
//     migrate: "eager",
//   });
//
//   serve({ port: 3030, fetch: matcher.fetch });
//
// We don't depend on @hono/node-server at the repo root (it's a Node-only
// adapter; the workspace runs Bun). The shape is exactly Bun.serve's —
// `fetch: matcher.fetch` is the contract.
//
// Standalone sanity print only — no matcher constructed, no DB connection.
import type { Matcher } from "../../packages/server/src/index.ts";

// Type-check that matcher.fetch matches the serve() adapter signature.
// This is a pure type-level check — no runtime construction.
type _AssertFetchShape = Matcher["fetch"] extends (request: Request) => Promise<Response>
  ? true
  : "matcher.fetch is not a Web-fetch handler";
const _typecheck: _AssertFetchShape = true;
void _typecheck;

console.log("[07-node-server] typecheck-only blueprint");
console.log("[07-node-server]   in a real Node project:");
console.log("[07-node-server]     npm i @samesake/server @hono/node-server");
console.log("[07-node-server]     serve({ port: 3030, fetch: matcher.fetch })");
console.log("[07-node-server] ✓ shape verified — same Web-fetch contract as Bun.serve");
