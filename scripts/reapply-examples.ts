#!/usr/bin/env bun
import { createMatcher } from "../packages/server/src/index.ts";
import { blueprintEmbed, blueprintParse } from "./blueprints/_embedder.ts";
import * as hello from "../examples/hello/samesake.config.ts";
import * as quickstart from "../examples/quickstart/samesake.config.ts";

const matcher = createMatcher({
  databaseUrl: process.env.SAMESAKE_DATABASE_URL!,
  apiKey: "reapply-key",
  embed: blueprintEmbed,
  parse: blueprintParse,
  migrate: "eager",
});

await matcher.migrate();

const projects: Array<{ slug: string; entities: Array<{ name?: string }> }> = [
  { slug: "hello", entities: [hello.customer, hello.supplier, hello.asset] },
  { slug: "quickstart", entities: [quickstart.contact] },
];

for (const p of projects) {
  const r = await matcher.apply(p.slug, p.entities as Parameters<typeof matcher.apply>[1]);
  console.log(`✓ reapplied ${p.slug}: ${r.appliedStatements} stmts → ${r.schema} (${r.entities.join(", ")})`);
}

await matcher.close();
console.log("\n✓ all example projects re-applied.");
