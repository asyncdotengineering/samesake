#!/usr/bin/env bun
// Proof: with v0.2's createMatcher, you can use the matcher entirely
// in-process — no HTTP server, no Bun.serve, no Hono routes. Just import
// createMatcher, pass deps, call methods.
//
// This is the answer to "can I use this without mounting a server?" — yes.
// scripts/ isn't a workspace member; use the deep workspace path. From inside
// an actual consumer project, this would simply be `from "@samesake/server"`.
import { createMatcher } from "../packages/server/src/index.ts";
import { blueprintEmbed, blueprintParse } from "./blueprints/_embedder.ts";

const m = createMatcher({
  databaseUrl: process.env.SAMESAKE_DATABASE_URL ?? "postgresql://mithushancj@localhost:5432/samesake_dev",
  apiKey: "dev-key-please-change",
  embed: blueprintEmbed,
  parse: blueprintParse,
});

// Apply migrations once (idempotent — safe to call repeatedly).
await m.migrate();

console.log("✓ matcher created in-process — no HTTP server\n");

// 1. List projects via function call (no HTTP)
const projects = await m.listProjects();
console.log(`✓ in-process: m.listProjects() → ${projects.length} projects`);
for (const p of projects.slice(0, 3)) {
  console.log(`    ${p.slug.padEnd(20)} (${p.entities.length} entit${p.entities.length === 1 ? "y" : "ies"})`);
}

// 2. Match via function call (no HTTP)
const result = await m.match({
  project: "hello",
  kind: "customer",
  text: "Smyth",
  scope: { tenantId: "acme" },
  opts: { limit: 3 },
});
console.log(`\n✓ in-process: m.match("Smyth") → ${result.candidates.length} candidates`);
for (const c of result.candidates.slice(0, 3)) {
  console.log(`    [${c.entityId}] ${c.name.padEnd(24)} combined=${c.combined.toFixed(3)}`);
}

// 3. Confirm via function call (no HTTP) — round-trips through DB
const top = result.candidates[0];
if (top) {
  await m.confirm({
    project: "hello",
    kind: "customer",
    queryText: "Smyth",
    scope: { tenantId: "acme" },
    chosenEntityId: top.entityId,
  });
  console.log(`\n✓ in-process: m.confirm() → wrote alias for "${top.name}"`);

  // Subsequent match should now hit alias-hit
  const after = await m.match({
    project: "hello",
    kind: "customer",
    text: "Smyth",
    scope: { tenantId: "acme" },
  });
  const hit = after.candidates[0]?.components.aliasHit;
  console.log(`✓ in-process: subsequent match — aliasHit=${hit} (alias loop closed without any HTTP call)`);
}

// 4. The SAME matcher ALSO exposes .fetch and .app — proving both surfaces
//    live on the same instance:
const fetchType = typeof m.fetch;
const appHasRoute = typeof m.app.route === "function";
console.log(`\n✓ Same matcher instance ALSO has m.fetch (${fetchType}) and m.app.route (${appHasRoute ? "function" : "BROKEN"})`);
console.log("  → you can use any combination: function calls, mount via Hono, expose as fetch handler.\n");

await m.close();
console.log("✓ matcher closed cleanly.");
