#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createMatcher, createDbFromUrl } from "@samesake/server";
import { contact } from "./samesake.config.ts";

function loadEnv(): void {
  if (process.env.DATABASE_URL) return;
  try {
    const env = readFileSync(join(import.meta.dir, "../../.env"), "utf8");
    for (const line of env.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq);
      const val = trimmed.slice(eq + 1);
      if (key === "DATABASE_URL" || key === "SAMESAKE_DATABASE_URL") {
        process.env.DATABASE_URL ??= val;
      }
      if (key === "GOOGLE_GENERATIVE_AI_API_KEY") {
        process.env.GOOGLE_GENERATIVE_AI_API_KEY ??= val;
      }
    }
  } catch {
    /* no .env */
  }
}

function stubEmbed(text: string, dim: number): number[] {
  const out = new Array<number>(dim).fill(0);
  for (let i = 0; i < text.length; i++) out[i % dim] += text.charCodeAt(i) / 255;
  return out;
}

async function main(): Promise<void> {
  loadEnv();
  const databaseUrl = process.env.DATABASE_URL ?? process.env.SAMESAKE_DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const project = `quickstart_${Math.random().toString(36).slice(2, 8)}`;
  console.log("quickstart — match smoke (stub embed)\n");

  const matcher = createMatcher({
    databaseUrl,
    apiKey: "quickstart-key",
    migrate: "eager",
    embed: async ({ text, dim }) => stubEmbed(text, dim),
  });
  await matcher.migrate();

  const { schema } = await matcher.apply(project, { entities: [contact], collections: [] });
  const seed = JSON.parse(readFileSync(join(import.meta.dir, "seed.json"), "utf8")) as {
    items: Array<{ id: string; scope: Record<string, string>; data: Record<string, string> }>;
  };

  await matcher.upsertBatch(
    { project, entity: contact },
    seed.items.map((item) => ({
      id: item.id,
      scope: item.scope,
      data: item.data,
    }))
  );

  const match = await matcher.match({
    project,
    kind: "contact",
    text: "Priya Fernando",
    scope: { tenantId: "acme" },
    opts: { limit: 3 },
  });

  if (!match.candidates.length) {
    console.error("FAIL: expected at least one candidate after seed");
    process.exit(1);
  }

  console.log(`top candidate: ${match.candidates[0]!.name} (${match.candidates[0]!.combined.toFixed(3)})`);

  const { db, close } = createDbFromUrl(databaseUrl);
  await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
  await close();
  await matcher.close();

  console.log("\n✓ quickstart passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
