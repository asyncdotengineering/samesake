// One-time (idempotent) catalog load: applies the entity schema and embeds every
// catalog part. Re-run after editing data/catalog.json.
import { sql } from "drizzle-orm";
import { createDbFromUrl } from "@samesake/server";
import { loadEnv, company, PROJECT } from "./config.ts";
import { makeMatcher, setupCatalog } from "./catalog.ts";

loadEnv();
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL required (set it in the repo-root .env)");
  process.exit(1);
}
if (!process.env.GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY required for embeddings");
  process.exit(1);
}

// `--reset` drops the project schema first — run it after changing the catalog
// entity shape (samesake's apply does not add columns to an existing table).
if (process.argv.includes("--reset")) {
  const { db, close } = createDbFromUrl(url);
  await db.execute(sql.raw(`DROP SCHEMA IF EXISTS project_${PROJECT} CASCADE`));
  await close();
  console.log(`reset: dropped schema project_${PROJECT}`);
}

const matcher = makeMatcher(url);
console.log(`Loading catalog for ${company().name} …`);
const { schema, parts } = await setupCatalog(matcher);
console.log(`✓ schema ${schema} — ${parts} parts loaded + embedded`);
await matcher.close();
