// C9 gate backfill: apply the aspects schema (destructive vs the spaces-era layout) and
// populate emb_visual / facets evidence rows for the already-ingested corpus. No ingest,
// no enrich — requires only SAMESAKE_DATABASE_URL + GEMINI_API_KEY.
import { COLLECTION, PROJECT, createFashionMatcher, ensureProject } from "./samesake.config.ts";

if (!process.env.SAMESAKE_DATABASE_URL || !process.env.GEMINI_API_KEY) {
  console.error("SAMESAKE_DATABASE_URL and GEMINI_API_KEY required");
  process.exit(1);
}

const t0 = Date.now();
const matcher = createFashionMatcher();
await matcher.migrate();
const applied = await ensureProject(matcher);
console.log(`[backfill] apply done (${JSON.stringify(applied ?? {}).slice(0, 200)})`);

const res = await matcher.index(PROJECT, COLLECTION, {});
console.log(
  `[backfill] indexed=${JSON.stringify(res)} in ${Math.round((Date.now() - t0) / 1000)}s`
);
