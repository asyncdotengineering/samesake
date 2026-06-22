// Rule packs persisted in Postgres, keyed by company — so a pack is editable data at
// runtime (via the API), not a file in the repo. Validated on the way in and out.
import { sql } from "drizzle-orm";
import { createDbFromUrl } from "@samesake/server";
import { RulePackSchema, type RulePack } from "./schema.ts";

const TABLE = "bom_rule_packs";

export async function ensureTable(databaseUrl: string): Promise<void> {
  const { db, close } = createDbFromUrl(databaseUrl);
  try {
    await db.execute(
      sql.raw(
        `CREATE TABLE IF NOT EXISTS public.${TABLE} (` +
          `company text PRIMARY KEY, pack jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`
      )
    );
  } finally {
    await close();
  }
}

export async function saveRulePack(databaseUrl: string, company: string, pack: RulePack): Promise<void> {
  const valid = RulePackSchema.parse(pack); // never store an invalid pack
  const { db, close } = createDbFromUrl(databaseUrl);
  try {
    await db.execute(sql`
      INSERT INTO public.${sql.raw(TABLE)} (company, pack, updated_at)
      VALUES (${company}, ${JSON.stringify(valid)}::jsonb, now())
      ON CONFLICT (company) DO UPDATE SET pack = EXCLUDED.pack, updated_at = now()
    `);
  } finally {
    await close();
  }
}

/** The company's saved pack, or null if none/invalid (caller falls back to the default). */
export async function loadRulePackForCompany(databaseUrl: string, company: string): Promise<RulePack | null> {
  const { db, close } = createDbFromUrl(databaseUrl);
  try {
    const rows = await db.execute<{ pack: unknown }>(
      sql`SELECT pack FROM public.${sql.raw(TABLE)} WHERE company = ${company}`
    );
    if (!rows[0]) return null;
    return RulePackSchema.parse(rows[0].pack);
  } catch {
    return null;
  } finally {
    await close();
  }
}
