import { sql } from "drizzle-orm";
import { createDbFromUrl } from "@samesake/server";
import { runIngest } from "./ingest.ts";
import {
  COLLECTION,
  PROJECT,
  createFashionMatcher,
  ensureProject,
} from "./samesake.config.ts";

const args = process.argv.slice(2);
const argN = (name: string, dflt: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};

const SKIP_INGEST = args.includes("--skip-ingest");
const SKIP_ENRICH = args.includes("--skip-enrich");
const SKIP_INDEX = args.includes("--skip-index");
const CONCURRENCY = argN("concurrency", 12);

async function countRows(schema: string, where = "true"): Promise<number> {
  const { db, close } = createDbFromUrl(process.env.DATABASE_URL!);
  const table = `${schema}.c_${COLLECTION}`;
  const rows = await db.execute<{ count: number }>(
    sql.raw(`SELECT count(*)::int AS count FROM ${table} WHERE ${where}`)
  );
  await close();
  return Number(rows[0]?.count ?? 0);
}

async function main() {
  if (!process.env.DATABASE_URL || !process.env.GEMINI_API_KEY) {
    throw new Error("DATABASE_URL and GEMINI_API_KEY required");
  }

  const matcher = createFashionMatcher();
  await matcher.migrate();
  const applied = await ensureProject(matcher);

  if (!SKIP_INGEST) {
    console.log("== ingest ==");
    await runIngest(matcher);
  }

  const ingested = await countRows(applied.schema);
  console.log(`corpus ingested: ${ingested}`);
  if (ingested < 4000) {
    throw new Error(`expected >= 4000 products, got ${ingested}`);
  }

  if (!SKIP_ENRICH) {
    console.log(`== enrich (concurrency ${CONCURRENCY}) ==`);
    const t0 = Date.now();
    let total = 0;
    while (true) {
      const pending = await countRows(applied.schema, "enriched_at IS NULL");
      if (pending === 0) break;
      const r = await matcher.enrich(PROJECT, COLLECTION, {
        concurrency: CONCURRENCY,
        limit: pending,
      });
      total += r.enriched;
      console.log(
        `batch enriched=${r.enriched} failed=${r.failed} pending~${pending - r.enriched} (${((Date.now() - t0) / 60000).toFixed(1)} min)`
      );
      if (r.enriched === 0) break;
    }
    const enriched = await countRows(applied.schema, "enriched_at IS NOT NULL");
    const failed = ingested - enriched;
    const failRate = failed / ingested;
    console.log(`enriched ${enriched}/${ingested} (fail rate ${(failRate * 100).toFixed(1)}%)`);
    if (failRate > 0.02) {
      console.warn(`WARN: enrichment failure rate ${(failRate * 100).toFixed(1)}% exceeds 2%`);
    }
  }

  if (!SKIP_INDEX) {
    console.log("== index ==");
    const t0 = Date.now();
    let indexedTotal = 0;
    while (true) {
      const r = await matcher.index(PROJECT, COLLECTION, { limit: 500 });
      indexedTotal += r.indexed;
      console.log(`indexed batch ${r.indexed} (total ${indexedTotal}, ${((Date.now() - t0) / 60000).toFixed(1)} min)`);
      if (r.indexed === 0) break;
    }
    const indexed = await countRows(
      applied.schema,
      "indexed_at IS NOT NULL AND embedding IS NOT NULL"
    );
    console.log(`indexed ${indexed} searchable products`);
  }

  await matcher.close();
  console.log("pipeline complete");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
