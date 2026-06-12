import { sql } from "drizzle-orm";
import { createDbFromUrl } from "@samesake/server";
import { composeEmbedDoc } from "./fashion.ts";
import { COLLECTION, PROJECT, createFashionMatcher, ensureProject } from "./samesake.config.ts";

export async function composeEmbedDocs(schemaName: string): Promise<number> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL missing");

  const { db, close } = createDbFromUrl(databaseUrl);
  const table = `${schemaName}.c_${COLLECTION}`;
  const rows = await db.execute<{
    id: string;
    data: unknown;
    enriched: unknown;
  }>(sql.raw(`SELECT id, data, enriched FROM ${table} WHERE enriched_at IS NOT NULL`));

  let updated = 0;
  for (const row of rows) {
    const data =
      typeof row.data === "string"
        ? (JSON.parse(row.data) as Record<string, unknown>)
        : (row.data as Record<string, unknown>);
    const enriched =
      row.enriched == null
        ? null
        : typeof row.enriched === "string"
          ? (JSON.parse(row.enriched) as Record<string, unknown>)
          : (row.enriched as Record<string, unknown>);
    if (!enriched) continue;

    const isApparel = enriched.is_apparel_product ?? enriched.is_apparel;
    if (isApparel === false || enriched.category === "other") continue;

    const embedDoc = composeEmbedDoc(
      { title: String(data.title ?? "") },
      {
        ...enriched,
        category: enriched.category,
        product_type: enriched.product_type,
        gender: enriched.gender,
      }
    );

    const next = { ...enriched, embed_doc: embedDoc };
    await db.execute(
      sql.raw(
        `UPDATE ${table} SET enriched = '${JSON.stringify(next).replace(/'/g, "''")}'::jsonb, enriched_at = now() WHERE id = '${String(row.id).replace(/'/g, "''")}'`
      )
    );
    updated++;
  }
  await close();
  return updated;
}

async function main() {
  const matcher = createFashionMatcher();
  const applied = await ensureProject(matcher);
  const n = await composeEmbedDocs(applied.schema);
  console.log(`composed embed_doc for ${n} products`);
  await matcher.close();
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
